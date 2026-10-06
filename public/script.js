console.log('网页在线聊天室\n作者：passerby.\n版本：V2026.10.04');

(() => {
    const $ = id => document.getElementById(id);

    const joinPanel = $('join-panel'), joinForm = $('join-form'), joinNick = $('join-nick');
    const chatView  = $('chat'),       onlineCount = $('online-count'), menu = $('menu');
    const nickForm  = $('nick-form'),  nickInput = $('nick-input');
    const onlineList = $('online-list');
    const box = $('box'), inp = $('inp'), inputForm = $('input-form'), inputNick = $('input-nick');
    const toastEl = $('toast');
    const tplMsg = $('tpl-msg'), tplSys = $('tpl-sys');

    /* ---------- 与后端保持一致的常量 ---------- */

    const NICK_MAX       = 16;
    const MSG_MAX        = 100;
    const SEND_COOLDOWN  = 5000;
    const RENAME_COOLDOWN = 10000;

    const store = {
        get: k => localStorage.getItem(k) || '',
        set: (k, v) => localStorage.setItem(k, v)
    };

    let clientId = store.get('chat_id');
    let myNick = store.get('chat_nick');
    let lastSeq = 0;
    let socket = null;
    let onlineUsers = [];
    let activePanel = null;
    let toastTimer = 0;
    let everConnected = false;

    /* ---------- 本地状态（用于前端冷却） ---------- */

    let lastSentAt = 0;
    let lastRenamedAt = 0;

    /* ---------- 昵称规范化（和后端 normNick 完全一致） ---------- */

    const normNick = s =>
        typeof s === 'string'
            ? [...s.trim().replace(/[<>]/g, '')].slice(0, NICK_MAX).join('')
            : '';

    const dtf = new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hourCycle: 'h23'
    });

    const fmtTime = ts => {
        const p = Object.fromEntries(
            dtf.formatToParts(ts).map(x => [x.type, x.value])
        );
        return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
    };

    const showToast = text => {
        if (!text) return;
        toastEl.textContent = text;
        toastEl.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2000);
    };

    /* ---------- 消息渲染 ---------- */

    const addMessage = data => {
        if (data.seq && data.seq <= lastSeq) return;
        if (data.seq > lastSeq) lastSeq = data.seq;

        const time = data.ts ? fmtTime(data.ts) : '';
        let node;

        if (data.type === 'system') {
            node = tplSys.content.firstElementChild.cloneNode(true);
            node.querySelector('.label').textContent = `系统消息 [${time}]:`;
            node.querySelector('.text').textContent = data.text;
            node.querySelector('.id').textContent = `ID: ${data.id}`;
        } else {
            node = tplMsg.content.firstElementChild.cloneNode(true);
            node.classList.add(data.id === clientId ? 'self' : 'other');
            node.querySelector('.nick').textContent = data.nick;
            node.querySelector('.time-mark').textContent = `[${time}`;
            node.querySelector('.id').textContent = `ID: ${data.id}`;
            node.querySelector('.text').textContent = data.text;
        }

        const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
        box.append(node);
        if (nearBottom) box.scrollTop = box.scrollHeight;
    };

    /* ---------- 在线列表 ---------- */

    const renderOnline = list => {
        const sorted = [...list].sort((a, b) =>
            a.id === clientId ? -1 :
            b.id === clientId ?  1 :
            (a.joinedAt || 0) - (b.joinedAt || 0)
        );

        const prevScroll = onlineList.scrollTop;
        onlineList.replaceChildren();

        for (const u of sorted) {
            const row = document.createElement('div');
            row.className = 'online-item';
            row.innerHTML = `<span class="online-nick ${u.id === clientId ? 'self' : 'other'}"></span>`
                          + `<span class="online-id"></span>`;
            row.children[0].textContent = u.nick;
            row.children[1].textContent = `ID: ${u.id}`;
            onlineList.append(row);
        }

        onlineList.scrollTop = prevScroll;
    };

    /* ---------- 面板切换 ---------- */

    const showChat = () => {
        box.hidden = false;
        inputForm.hidden = false;
        box.scrollTop = box.scrollHeight;
    };

    const hidePanels = () => {
        for (const el of document.querySelectorAll('[data-panel-id]')) el.hidden = true;
        for (const a of menu.querySelectorAll('[data-panel]')) a.classList.remove('active');
        activePanel = null;
    };

    const closePanels = () => {
        hidePanels();
        store.set('chat_panel', '');
        showChat();
    };

    const openPanel = which => {
        if (activePanel === which) return;
        hidePanels();
        activePanel = which;
        store.set('chat_panel', which);
        box.hidden = true;
        inputForm.hidden = true;

        const el   = document.querySelector(`[data-panel-id="${which}"]`);
        const link = menu.querySelector(`[data-panel="${which}"]`);
        if (el)   el.hidden = false;
        if (link) link.classList.add('active');

        if (which === 'online') renderOnline(onlineUsers);
    };

    menu.addEventListener('click', e => {
        const a = e.target.closest('[data-panel]');
        if (!a) return;
        e.preventDefault();
        openPanel(a.dataset.panel);
    });

    document.addEventListener('click', e => {
        if (e.target.closest('[data-close]')) closePanels();
    });

    /* ---------- 昵称 ---------- */

    const applyMyNick = nick => {
        myNick = nick;
        store.set('chat_nick', nick);
        inputNick.textContent = nick;
    };

    /* ---------- 视图切换 ---------- */

    const enterChatView = () => {
        joinPanel.hidden = true;
        chatView.hidden = false;
        box.scrollTop = box.scrollHeight;
    };

    const backToJoinView = () => {
        joinPanel.hidden = false;
        chatView.hidden = true;
    };

    /* ---------- 连接 ---------- */

    const startChat = () => {
        if (socket) return;

        socket = io();

        socket.on('connect', () => {
            socket.emit('join', { nick: myNick, cid: clientId || undefined }, res => {
                if (!res || !res.ok) {
                    // 走到这里只剩服务端兜底失败（前端已校验过的正常情况不会进这里）
                    socket.disconnect();
                    socket = null;
                    everConnected = false;
                    joinNick.value = myNick;
                    backToJoinView();
                    showToast(res && res.msg);
                    return;
                }

                if (res.cid !== clientId) {
                    clientId = res.cid;
                    store.set('chat_id', clientId);
                }
                applyMyNick(res.nick);

                if (everConnected) showToast('已重新连接');
                everConnected = true;

                enterChatView();

                const savedPanel = store.get('chat_panel');
                if (savedPanel && document.querySelector(`[data-panel-id="${savedPanel}"]`))
                    openPanel(savedPanel);
            });
        });

        socket.on('disconnect', reason => {
            if (reason !== 'io client disconnect') showToast('连接已断开');
        });

        socket.on('history', list => {
            list.forEach(addMessage);
            box.scrollTop = box.scrollHeight;
        });

        socket.on('chat', addMessage);
        socket.on('online', ({ count, list }) => {
            onlineCount.textContent = count;
            onlineUsers = list;
            if (activePanel === 'online') renderOnline(onlineUsers);
        });
    };

    window.addEventListener('pagehide', e => {
        if (!e.persisted && socket) socket.disconnect();
    });

    /* ---------- 表单提交（前端校验） ---------- */

    joinForm.addEventListener('submit', e => {
        e.preventDefault();
        const nick = normNick(joinNick.value);
        if (!nick) return showToast('昵称不能为空');
        myNick = nick;
        startChat();
    });

    nickForm.addEventListener('submit', e => {
        e.preventDefault();
        if (!socket) return;

        const nick = normNick(nickInput.value);
        if (!nick) return showToast('昵称不能为空');
        if (nick === myNick) return showToast('与当前昵称相同');

        const now = Date.now();
        if (now - lastRenamedAt < RENAME_COOLDOWN)
            return showToast('修改昵称过快');
        lastRenamedAt = now;

        socket.emit('rename', nick, res => {
            if (!res || !res.ok) {
                lastRenamedAt = 0;            // 服务端兜底拒绝则回滚冷却
                return showToast(res && res.msg);
            }
            applyMyNick(res.nick);
            nickInput.value = '';
            closePanels();
        });
    });

    inputForm.addEventListener('submit', e => {
        e.preventDefault();
        if (!socket) return;

        const t = inp.value.trim().slice(0, MSG_MAX);
        if (!t) return showToast('消息不能为空');

        const now = Date.now();
        if (now - lastSentAt < SEND_COOLDOWN)
            return showToast('发送消息过快');
        lastSentAt = now;
        inp.value = '';

        socket.emit('chat', { text: t }, res => {
            if (!res || !res.ok) {
                lastSentAt = 0;               // 服务端兜底拒绝则回滚冷却
                showToast(res && res.msg);
            }
        });
    });

    if (myNick) startChat();
    else backToJoinView();
})();
