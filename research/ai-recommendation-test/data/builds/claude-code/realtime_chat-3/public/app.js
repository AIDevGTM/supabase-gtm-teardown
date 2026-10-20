(() => {
  'use strict';

  // -------------------------------------------------------------- Constants
  const TOKEN_KEY = 'chat.token';   // sessionStorage: survives reloads of this tab
  const NAME_KEY = 'chat.name';     // localStorage: remembered name for next time
  const GROUP_WINDOW_MS = 5 * 60 * 1000;
  const TYPING_SHOW_MS = 3500;
  const TYPING_SEND_INTERVAL_MS = 1500;
  const NEAR_BOTTOM_PX = 120;
  const RETRY_DELAY_MS = 3000;
  const BASE_TITLE = document.title;
  const URL_RE = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,:;'!?)\]}]/gi;

  // -------------------------------------------------------------- Elements
  const $ = (id) => document.getElementById(id);
  const el = {
    joinView: $('join-view'),
    joinForm: $('join-form'),
    nameInput: $('name-input'),
    joinError: $('join-error'),
    joinButton: $('join-button'),
    chatView: $('chat-view'),
    status: $('status'),
    usersToggle: $('users-toggle'),
    userCount: $('user-count'),
    userCountPanel: $('user-count-panel'),
    leaveButton: $('leave-button'),
    messages: $('messages'),
    jumpButton: $('jump-button'),
    usersPanel: $('users-panel'),
    users: $('users'),
    typing: $('typing'),
    sendError: $('send-error'),
    composer: $('composer'),
    input: $('message-input'),
    sendButton: $('send-button'),
  };

  // -------------------------------------------------------------- State
  const state = {
    token: null,
    self: null,
    es: null,
    lastMsg: null,
    typing: new Map(), // userId -> { name, timer }
    lastTypingSent: 0,
    unread: 0,
    sending: false,
    recovering: false,
  };

  // -------------------------------------------------------------- Utilities
  async function api(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    let data = null;
    if (res.status !== 204) {
      try { data = await res.json(); } catch { /* ignore */ }
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status}).`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function storage(kind) {
    try { return window[kind]; } catch { return null; }
  }
  function storeGet(kind, key) {
    const s = storage(kind);
    try { return s ? s.getItem(key) : null; } catch { return null; }
  }
  function storeSet(kind, key, value) {
    const s = storage(kind);
    try {
      if (!s) return;
      if (value == null) s.removeItem(key); else s.setItem(key, value);
    } catch { /* storage unavailable (private mode, etc.) */ }
  }

  function setToken(token) {
    state.token = token;
    storeSet('sessionStorage', TOKEN_KEY, token);
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function appendLinkified(container, text) {
    let last = 0;
    for (const match of text.matchAll(URL_RE)) {
      if (match.index > last) container.append(text.slice(last, match.index));
      const a = document.createElement('a');
      a.href = match[0];
      a.textContent = match[0];
      a.target = '_blank';
      a.rel = 'noopener noreferrer nofollow';
      container.append(a);
      last = match.index + match[0].length;
    }
    if (last < text.length) container.append(text.slice(last));
  }

  function isNearBottom() {
    const m = el.messages;
    return m.scrollHeight - m.scrollTop - m.clientHeight < NEAR_BOTTOM_PX;
  }

  function scrollToBottom() {
    el.messages.scrollTop = el.messages.scrollHeight;
    el.jumpButton.hidden = true;
  }

  function showError(node, message) {
    node.textContent = message || '';
    node.hidden = !message;
  }

  function setStatus(kind) {
    const labels = { online: 'Connected', connecting: 'Connecting…', reconnecting: 'Reconnecting…', offline: 'Offline' };
    el.status.dataset.state = kind;
    el.status.textContent = labels[kind] || kind;
  }

  function updateTitle() {
    document.title = state.unread > 0 ? `(${state.unread}) ${BASE_TITLE}` : BASE_TITLE;
  }

  // -------------------------------------------------------------- Views
  function showJoin(errorMessage) {
    el.chatView.hidden = true;
    el.joinView.hidden = false;
    showError(el.joinError, errorMessage);
    if (!el.nameInput.value) el.nameInput.value = storeGet('localStorage', NAME_KEY) || '';
    el.nameInput.focus();
    el.nameInput.select();
  }

  function showChat() {
    el.joinView.hidden = true;
    el.chatView.hidden = false;
    showError(el.sendError, '');
    el.input.focus();
  }

  // -------------------------------------------------------------- Session
  async function join(name) {
    const data = await api('/api/join', { name });
    storeSet('localStorage', NAME_KEY, data.user.name);
    setToken(data.token);
    state.self = data.user;
    if (data.limits && data.limits.maxMessageLength) el.input.maxLength = data.limits.maxMessageLength;
    showChat();
    connect();
  }

  function disconnect() {
    if (state.es) {
      state.es.close();
      state.es = null;
    }
  }

  function connect() {
    disconnect();
    setStatus('connecting');
    const es = new EventSource('/api/events?token=' + encodeURIComponent(state.token));
    state.es = es;

    const on = (type, handler) => es.addEventListener(type, (e) => {
      if (es !== state.es) return;
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      handler(data);
    });

    es.addEventListener('open', () => { if (es === state.es) setStatus('online'); });
    on('welcome', onWelcome);
    on('msg', onMessage);
    on('presence', (d) => renderUsers(d.users));
    on('typing', (d) => onTyping(d.user));

    es.addEventListener('error', () => {
      if (es !== state.es) return;
      if (es.readyState === EventSource.CLOSED) {
        // The server rejected the stream (most likely our session expired,
        // e.g. after a server restart). Get a fresh session automatically.
        disconnect();
        recoverSession();
      } else {
        setStatus('reconnecting'); // EventSource retries on its own
      }
    });
  }

  async function recoverSession() {
    if (state.recovering) return;
    state.recovering = true;
    setStatus('reconnecting');
    const name = (state.self && state.self.name) || storeGet('localStorage', NAME_KEY);
    setToken(null);
    try {
      if (!name) {
        showJoin();
        return;
      }
      await join(name);
    } catch (err) {
      if (err.status && err.status < 500) {
        showJoin(`You were disconnected. ${err.message} Please choose a name to rejoin.`);
      } else {
        setStatus('offline');
        setTimeout(() => { if (!state.token && !el.chatView.hidden) recoverSession(); }, RETRY_DELAY_MS);
      }
    } finally {
      state.recovering = false;
    }
  }

  function leave() {
    const token = state.token;
    disconnect();
    setToken(null);
    state.self = null;
    if (token) api('/api/leave', { token }).catch(() => {});
    el.messages.replaceChildren();
    el.users.replaceChildren();
    clearTyping();
    state.lastMsg = null;
    showJoin();
  }

  // -------------------------------------------------------------- Event handlers
  function onWelcome(data) {
    state.self = data.self;
    el.messages.replaceChildren();
    state.lastMsg = null;
    if (!data.history.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No messages yet — say hello! 👋';
      el.messages.append(li);
    }
    for (const msg of data.history) appendMessage(msg);
    renderUsers(data.users);
    clearTyping();
    setStatus('online');
    scrollToBottom();
  }

  function onMessage(msg) {
    const stick = isNearBottom();
    const mine = msg.kind === 'chat' && state.self && msg.user.id === state.self.id;
    const empty = el.messages.querySelector('.empty');
    if (empty) empty.remove();

    appendMessage(msg);

    if (msg.kind === 'chat') removeTyping(msg.user.id);
    if (stick || mine) scrollToBottom();
    else el.jumpButton.hidden = false;

    if (document.hidden && msg.kind === 'chat' && !mine) {
      state.unread += 1;
      updateTitle();
    }
  }

  function onTyping(user) {
    if (!user || (state.self && user.id === state.self.id)) return;
    const existing = state.typing.get(user.id);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => removeTyping(user.id), TYPING_SHOW_MS);
    state.typing.set(user.id, { name: user.name, timer });
    renderTyping();
  }

  // -------------------------------------------------------------- Rendering
  function appendMessage(msg) {
    const li = document.createElement('li');
    li.title = new Date(msg.ts).toLocaleString();

    if (msg.kind === 'system') {
      li.className = 'system';
      li.textContent = `${msg.text} · ${formatTime(msg.ts)}`;
    } else {
      const last = state.lastMsg;
      const mine = state.self && msg.user.id === state.self.id;
      const grouped = last && last.kind === 'chat' && last.user.id === msg.user.id &&
        msg.ts - last.ts < GROUP_WINDOW_MS;

      li.className = 'msg' + (mine ? ' mine' : '') + (grouped ? ' grouped' : '');

      if (!grouped) {
        const meta = document.createElement('div');
        meta.className = 'meta';
        const author = document.createElement('span');
        author.className = 'author';
        author.textContent = mine ? `${msg.user.name} (you)` : msg.user.name;
        author.style.color = msg.user.color;
        const time = document.createElement('span');
        time.className = 'time';
        time.textContent = formatTime(msg.ts);
        meta.append(author, time);
        li.append(meta);
      }

      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      appendLinkified(bubble, msg.text);
      li.append(bubble);
    }

    el.messages.append(li);
    state.lastMsg = msg;
  }

  function renderUsers(users) {
    el.userCount.textContent = users.length;
    el.userCountPanel.textContent = users.length;
    const ids = new Set(users.map((u) => u.id));
    for (const id of [...state.typing.keys()]) if (!ids.has(id)) removeTyping(id);

    const items = users.map((u) => {
      const li = document.createElement('li');
      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      avatar.style.background = u.color;
      avatar.textContent = Array.from(u.name)[0] || '?';
      avatar.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = u.name;
      li.append(avatar, name);
      if (state.self && u.id === state.self.id) {
        const you = document.createElement('span');
        you.className = 'you';
        you.textContent = '(you)';
        li.append(you);
      }
      return li;
    });
    el.users.replaceChildren(...items);
  }

  function removeTyping(userId) {
    const entry = state.typing.get(userId);
    if (!entry) return;
    clearTimeout(entry.timer);
    state.typing.delete(userId);
    renderTyping();
  }

  function clearTyping() {
    for (const entry of state.typing.values()) clearTimeout(entry.timer);
    state.typing.clear();
    renderTyping();
  }

  function renderTyping() {
    const names = [...state.typing.values()].map((t) => t.name);
    let text = '';
    if (names.length === 1) text = `${names[0]} is typing…`;
    else if (names.length === 2) text = `${names[0]} and ${names[1]} are typing…`;
    else if (names.length > 2) text = 'Several people are typing…';
    el.typing.textContent = text;
  }

  // -------------------------------------------------------------- Composer
  function autoResize() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight + 2, 160) + 'px';
  }

  async function sendMessage() {
    const text = el.input.value.trim();
    if (!text || state.sending || !state.token) return;
    state.sending = true;
    el.sendButton.disabled = true;
    try {
      await api('/api/messages', { token: state.token, text });
      el.input.value = '';
      autoResize();
      showError(el.sendError, '');
      state.lastTypingSent = 0;
    } catch (err) {
      if (err.status === 401) {
        showError(el.sendError, 'Session expired — reconnecting. Please try again in a moment.');
        disconnect();
        recoverSession();
      } else {
        showError(el.sendError, err.status ? err.message : 'Could not send — check your connection.');
      }
    } finally {
      state.sending = false;
      el.sendButton.disabled = false;
      el.input.focus();
    }
  }

  function notifyTyping() {
    const now = Date.now();
    if (!state.token || !el.input.value.trim() || now - state.lastTypingSent < TYPING_SEND_INTERVAL_MS) return;
    state.lastTypingSent = now;
    api('/api/typing', { token: state.token }).catch(() => {});
  }

  // -------------------------------------------------------------- Wiring
  el.joinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = el.nameInput.value.trim();
    if (!name) {
      showError(el.joinError, 'Please enter a name.');
      el.nameInput.focus();
      return;
    }
    el.joinButton.disabled = true;
    showError(el.joinError, '');
    try {
      await join(name);
    } catch (err) {
      showError(el.joinError, err.status ? err.message : 'Could not reach the server. Is it running?');
    } finally {
      el.joinButton.disabled = false;
    }
  });

  el.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage();
  });

  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });

  el.input.addEventListener('input', () => {
    autoResize();
    notifyTyping();
  });

  el.messages.addEventListener('scroll', () => {
    if (isNearBottom()) el.jumpButton.hidden = true;
  });

  el.jumpButton.addEventListener('click', scrollToBottom);

  el.leaveButton.addEventListener('click', leave);

  el.usersToggle.addEventListener('click', () => {
    const open = el.usersPanel.classList.toggle('open');
    el.usersToggle.setAttribute('aria-expanded', String(open));
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      state.unread = 0;
      updateTitle();
    }
  });

  // -------------------------------------------------------------- Boot
  const savedToken = storeGet('sessionStorage', TOKEN_KEY);
  if (savedToken) {
    // Resume the session from a page reload. If it has expired, the stream
    // is rejected and recoverSession() rejoins with the remembered name.
    state.token = savedToken;
    showChat();
    connect();
  } else {
    showJoin();
  }
})();
