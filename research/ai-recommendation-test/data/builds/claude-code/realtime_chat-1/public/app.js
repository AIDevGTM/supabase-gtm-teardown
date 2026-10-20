(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    joinScreen: $('join-screen'),
    joinForm: $('join-form'),
    nameInput: $('name-input'),
    chatScreen: $('chat-screen'),
    status: $('status'),
    myName: $('my-name'),
    leaveBtn: $('leave-btn'),
    usersToggle: $('users-toggle'),
    sidebar: $('sidebar'),
    users: $('users'),
    userCount: $('user-count'),
    userCountMobile: $('user-count-mobile'),
    messages: $('messages'),
    typing: $('typing'),
    messageForm: $('message-form'),
    messageInput: $('message-input'),
    sendBtn: $('send-btn'),
    error: $('error'),
  };

  const BASE_TITLE = document.title;
  const MAX_RENDERED_MESSAGES = 500;
  const TYPING_SEND_INTERVAL_MS = 2000;
  const TYPING_DISPLAY_MS = 3500;

  const state = {
    es: null,
    token: null,
    name: null,
    typing: new Map(), // name -> timeout id
    unread: 0,
    lastTypingSent: 0,
    reconnectTimer: null,
  };

  // ---------------------------------------------------------------- Join/leave

  els.nameInput.value = localStorage.getItem('chat:name') || '';

  els.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = els.nameInput.value.replace(/\s+/g, ' ').trim();
    if (!name) return;
    localStorage.setItem('chat:name', name);
    join(name);
  });

  function join(name) {
    els.joinScreen.hidden = true;
    els.chatScreen.hidden = false;
    els.myName.textContent = name;
    els.messages.replaceChildren();
    hideError();
    connect(name);
    els.messageInput.focus();
  }

  function leave() {
    clearTimeout(state.reconnectTimer);
    if (state.es) state.es.close();
    state.es = null;
    state.token = null;
    state.name = null;
    for (const t of state.typing.values()) clearTimeout(t);
    state.typing.clear();
    renderTyping();
    els.chatScreen.hidden = true;
    els.joinScreen.hidden = false;
    els.sidebar.classList.remove('open');
    els.nameInput.focus();
  }

  els.leaveBtn.addEventListener('click', leave);
  els.usersToggle.addEventListener('click', () => els.sidebar.classList.toggle('open'));

  // ---------------------------------------------------------------- Connection

  function connect(name) {
    clearTimeout(state.reconnectTimer);
    if (state.es) state.es.close();

    setStatus('connecting');
    updateSendEnabled();

    const es = new EventSource('/events?name=' + encodeURIComponent(name));
    state.es = es;

    es.addEventListener('welcome', (e) => {
      const data = JSON.parse(e.data);
      state.token = data.token;
      state.name = data.name;
      els.myName.textContent = data.name;

      // Fresh session (first join or reconnect): rebuild from server history.
      els.messages.replaceChildren();
      data.history.forEach((m) => renderMessage(m));
      renderUsers(data.users);
      scrollToBottom(true);

      setStatus('online');
      hideError();
      updateSendEnabled();
    });

    es.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'chat') clearTyping(m.name);
      const stick = isNearBottom() || m.name === state.name;
      renderMessage(m);
      scrollToBottom(stick);
      if (m.type === 'chat' && m.name !== state.name && document.hidden) {
        state.unread += 1;
        document.title = `(${state.unread}) ${BASE_TITLE}`;
      }
    });

    es.addEventListener('users', (e) => renderUsers(JSON.parse(e.data)));
    es.addEventListener('typing', (e) => showTyping(JSON.parse(e.data).name));

    es.onerror = () => {
      if (state.es !== es) return; // stale connection
      state.token = null;
      setStatus('offline');
      updateSendEnabled();
      // The browser retries automatically unless the connection was rejected
      // outright (readyState CLOSED) — in that case retry ourselves.
      if (es.readyState === EventSource.CLOSED) {
        state.reconnectTimer = setTimeout(() => connect(name), 3000);
      }
    };
  }

  function setStatus(s) {
    els.status.dataset.state = s;
    els.status.textContent =
      s === 'online' ? 'Connected' : s === 'offline' ? 'Reconnecting…' : 'Connecting…';
  }

  async function post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      try {
        const data = await res.json();
        if (data && data.error) message = data.error;
      } catch { /* non-JSON error body */ }
      throw new Error(message);
    }
    return res.json();
  }

  // ---------------------------------------------------------------- Sending

  els.messageForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = els.messageInput.value.trim();
    if (!text || !state.token) return;

    els.sendBtn.disabled = true;
    try {
      await post('/message', { token: state.token, text });
      els.messageInput.value = '';
      autosize();
      hideError();
    } catch (err) {
      showError(err.message);
    } finally {
      updateSendEnabled();
      els.messageInput.focus();
    }
  });

  els.messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!els.sendBtn.disabled) els.messageForm.requestSubmit();
    }
  });

  els.messageInput.addEventListener('input', () => {
    autosize();
    const now = Date.now();
    if (state.token && els.messageInput.value.trim() && now - state.lastTypingSent > TYPING_SEND_INTERVAL_MS) {
      state.lastTypingSent = now;
      post('/typing', { token: state.token }).catch(() => {});
    }
  });

  function autosize() {
    const ta = els.messageInput;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight + 2, 160) + 'px';
  }

  function updateSendEnabled() {
    els.sendBtn.disabled = !state.token;
  }

  // ---------------------------------------------------------------- Rendering

  function renderMessage(m) {
    const li = document.createElement('li');

    if (m.type === 'system') {
      li.className = 'msg system';
      li.textContent = `${m.text} · ${formatTime(m.ts)}`;
    } else {
      li.className = 'msg' + (m.name === state.name ? ' mine' : '');

      const meta = document.createElement('div');
      meta.className = 'meta';
      const author = document.createElement('span');
      author.className = 'author';
      author.textContent = m.name;
      author.style.color = m.color;
      const time = document.createElement('time');
      time.className = 'time';
      time.dateTime = new Date(m.ts).toISOString();
      time.textContent = formatTime(m.ts);
      meta.append(author, time);

      const text = document.createElement('div');
      text.className = 'text';
      appendLinkified(text, m.text);

      li.append(meta, text);
    }

    els.messages.append(li);
    while (els.messages.children.length > MAX_RENDERED_MESSAGES) {
      els.messages.firstElementChild.remove();
    }
  }

  // Turn http(s) URLs into links without ever using innerHTML.
  const URL_RE = /\bhttps?:\/\/[^\s<]+[^\s<.,:;"')\]!?]/gi;
  function appendLinkified(el, text) {
    let last = 0;
    for (const match of text.matchAll(URL_RE)) {
      if (match.index > last) el.append(text.slice(last, match.index));
      const a = document.createElement('a');
      a.href = match[0];
      a.textContent = match[0];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      el.append(a);
      last = match.index + match[0].length;
    }
    if (last < text.length) el.append(text.slice(last));
  }

  function renderUsers(users) {
    els.users.replaceChildren(
      ...users.map((u) => {
        const li = document.createElement('li');
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = u.color;
        const name = document.createElement('span');
        name.textContent = u.name;
        li.append(dot, name);
        if (u.name === state.name) {
          const you = document.createElement('span');
          you.className = 'you';
          you.textContent = '(you)';
          li.append(you);
        }
        return li;
      })
    );
    els.userCount.textContent = users.length;
    els.userCountMobile.textContent = users.length;

    // Drop typing indicators for people who have left.
    const online = new Set(users.map((u) => u.name));
    for (const name of [...state.typing.keys()]) {
      if (!online.has(name)) clearTyping(name);
    }
  }

  function showTyping(name) {
    if (name === state.name) return;
    clearTimeout(state.typing.get(name));
    state.typing.set(name, setTimeout(() => clearTyping(name), TYPING_DISPLAY_MS));
    renderTyping();
  }

  function clearTyping(name) {
    if (!state.typing.has(name)) return;
    clearTimeout(state.typing.get(name));
    state.typing.delete(name);
    renderTyping();
  }

  function renderTyping() {
    const names = [...state.typing.keys()];
    let text = '';
    if (names.length === 1) text = `${names[0]} is typing…`;
    else if (names.length === 2) text = `${names[0]} and ${names[1]} are typing…`;
    else if (names.length > 2) text = 'Several people are typing…';
    els.typing.textContent = text;
  }

  // ---------------------------------------------------------------- Utilities

  function isNearBottom() {
    const el = els.messages;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  function scrollToBottom(force) {
    if (force) els.messages.scrollTop = els.messages.scrollHeight;
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function showError(message) {
    els.error.textContent = message;
    els.error.hidden = false;
    clearTimeout(showError.timer);
    showError.timer = setTimeout(hideError, 6000);
  }

  function hideError() {
    els.error.hidden = true;
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      state.unread = 0;
      document.title = BASE_TITLE;
    }
  });
})();
