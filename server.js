const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { Server } = require('socket.io');

const CID_RE = /^[a-z]{2}[0-9]{4}$/;
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS  = '0123456789';
const DB_FILE = path.join(__dirname, 'history.db');
const MAX_HISTORY = 100;
const KEEP_HISTORY = 100;
const TRIM_EVERY = 100;
const SEND_COOLDOWN = 5000;
const RENAME_COOLDOWN = 10000;

const newCid = () => {
    let s = '';
    for (let i = 0; i < 2; i++) s += LETTERS[crypto.randomInt(LETTERS.length)];
    for (let i = 0; i < 4; i++) s += DIGITS[crypto.randomInt(DIGITS.length)];
    return s;
};

/* ---------- 数据库 ---------- */

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
        seq     INTEGER PRIMARY KEY AUTOINCREMENT,
        ts      INTEGER NOT NULL,
        payload TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
`);

const stmt = {
    insert:  db.prepare('INSERT INTO messages (ts, payload) VALUES (?, ?)'),
    recent:  db.prepare('SELECT seq, ts, payload FROM messages ORDER BY seq DESC LIMIT ?'),
    lastSeq: db.prepare('SELECT seq FROM messages ORDER BY seq DESC LIMIT 1'),
    trim:    db.prepare(`DELETE FROM messages WHERE seq <= (
        SELECT seq FROM messages ORDER BY seq DESC LIMIT 1 OFFSET ?)`),
};

const lastRow = stmt.lastSeq.get();
let seqCounter = lastRow ? Number(lastRow.seq) : 0;

const persist = (ts, msg) =>
    Number(stmt.insert.run(ts, JSON.stringify(msg)).lastInsertRowid);

const sysText = (event, d) =>
    event === 'join'   ? `${d.nick} 进入了聊天室` :
    event === 'leave'  ? `${d.nick} 离开了聊天室` :
    event === 'rename' ? `${d.oldNick} 修改昵称为 ${d.newNick}` :
    '';

const loadRecent = (limit = MAX_HISTORY) =>
    stmt.recent.all(limit).reverse().map(r => {
        const m = JSON.parse(r.payload);
        if (m.type === 'system' && !m.text) m.text = sysText(m.event, m);
        return { ...m, seq: Number(r.seq), ts: Number(r.ts) };
    });

/* ---------- Express / Socket.IO ---------- */

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

const clients = new Map();

const allocCid = () => {
    let cid;
    do { cid = newCid(); } while (clients.has(cid));
    return cid;
};

const normNick = s =>
    typeof s === 'string'
        ? [...s.trim().replace(/[<>]/g, '')].slice(0, 16).join('')
        : '';
const validCid = cid => typeof cid === 'string' && CID_RE.test(cid);

const broadcast = msg => {
    const ts = Date.now();
    const seq = persist(ts, msg);
    seqCounter = seq;
    if (seqCounter % TRIM_EVERY === 0) stmt.trim.run(KEEP_HISTORY);
    io.emit('chat', { ...msg, ts, seq });
};

const sys = (actorId, event, extra = {}) =>
    broadcast({ type: 'system', id: actorId, text: sysText(event, extra) });

const pushOnline = () =>
    io.emit('online', {
        count: clients.size,
        list: [...clients].map(([id, v]) => ({ id, nick: v.nick, joinedAt: v.joinedAt }))
    });

/* 静默拒绝：只回 ok:false，不带 msg，提示由前端负责 */
const reject = reply => reply({ ok: false });

io.on('connection', socket => {
    let id = null;

    const myClient = () => {
        const c = clients.get(id);
        return c && c.sockets.has(socket.id) ? c : null;
    };

    socket.on('join', (payload, ack) => {
        const reply = r => ack && ack(r);
        if (id) return reject(reply);

        const nick = normNick((payload || {}).nick);
        if (!nick) return reject(reply);

        const rawCid = (payload || {}).cid;
        const cid = validCid(rawCid) ? rawCid : allocCid();
        id = cid;

        let client = clients.get(cid);
        const isNew = !client;

        if (isNew) {
            client = {
                nick, sockets: new Set(), joinedAt: Date.now(),
                lastSentAt: 0, lastRenamedAt: 0
            };
            clients.set(cid, client);
        }
        client.sockets.add(socket.id);

        socket.emit('history', loadRecent());

        if (isNew) sys(cid, 'join', { nick });
        pushOnline();
        reply({ ok: true, cid, nick });
    });

    socket.on('chat', ({ text } = {}, ack) => {
        const reply = r => ack && ack(r);
        const my = myClient();
        if (!my) return reject(reply);

        const t = (text || '').trim().slice(0, 100);
        if (!t) return reject(reply);

        const now = Date.now();
        if (now - (my.lastSentAt || 0) < SEND_COOLDOWN) return reject(reply);
        my.lastSentAt = now;

        broadcast({ type: 'text', text: t, id, nick: my.nick });
        reply({ ok: true });
    });

    socket.on('rename', (newNick, ack) => {
        const reply = r => ack && ack(r);
        const my = myClient();
        if (!my) return reject(reply);

        const nick = normNick(newNick);
        if (!nick) return reject(reply);

        const now = Date.now();
        if (now - (my.lastRenamedAt || 0) < RENAME_COOLDOWN) return reject(reply);
        if (nick === my.nick) return reject(reply);

        const old = my.nick;
        my.nick = nick;
        my.lastRenamedAt = now;
        sys(id, 'rename', { oldNick: old, newNick: nick });
        pushOnline();
        reply({ ok: true, nick });
    });

    socket.on('disconnect', () => {
        if (!id) return;
        const client = clients.get(id);
        if (!client) return;

        client.sockets.delete(socket.id);
        if (client.sockets.size > 0) return;

        clients.delete(id);
        sys(id, 'leave', { nick: client.nick });
        pushOnline();
    });
});

server.listen(8888, '0.0.0.0', () => {
    const ip = Object.values(os.networkInterfaces()).flat()
        .find(i => i.family === 'IPv4' && !i.internal)?.address || '127.0.0.1';
    console.log(`http://${ip}:8888`);
});

process.on('SIGINT', () => {
    try { db.close(); } catch {}
    process.exit(0);
});
