// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

// Minimal, safe Markdown: fenced code, inline code, bold, paragraphs.
// Everything is HTML-escaped *before* any tags are inserted.
function renderInline(escaped) {
  return escaped
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
}
function renderMarkdown(text) {
  const parts = text.split('```');
  let html = '';
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      // Code block; drop a leading language tag line like "js".
      const nl = part.indexOf('\n');
      let code = part;
      if (nl !== -1 && /^[\w+#.-]*$/.test(part.slice(0, nl).trim())) code = part.slice(nl + 1);
      html += `<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`;
    } else {
      for (const para of part.split(/\n{2,}/)) {
        const p = para.replace(/^\n+|\n+$/g, '');
        if (p.trim()) html += `<p>${renderInline(escapeHtml(p))}</p>`;
      }
    }
  });
  return html;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  user: null,
  conversations: [],
  currentId: null,
  streaming: false,
  abort: null,
  authMode: 'login', // or 'signup'
};

// ---------------------------------------------------------------------------
// Auth UI
// ---------------------------------------------------------------------------
function showAuth() {
  $('chat-view').hidden = true;
  $('auth-view').hidden = false;
  setAuthMode(state.authMode);
  $('auth-username').focus();
}

function setAuthMode(mode) {
  state.authMode = mode;
  const signup = mode === 'signup';
  $('auth-submit').textContent = signup ? 'Create account' : 'Sign in';
  $('auth-subtitle').textContent = signup
    ? 'Create an account to save your conversations.'
    : 'Sign in to see your conversations.';
  $('auth-switch-text').textContent = signup ? 'Already have an account?' : 'No account?';
  $('auth-switch').textContent = signup ? 'Sign in' : 'Create one';
  $('auth-password').autocomplete = signup ? 'new-password' : 'current-password';
  $('auth-error').hidden = true;
}

$('auth-switch').addEventListener('click', () =>
  setAuthMode(state.authMode === 'login' ? 'signup' : 'login')
);

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('auth-username').value.trim();
  const password = $('auth-password').value;
  const btn = $('auth-submit');
  btn.disabled = true;
  $('auth-error').hidden = true;
  try {
    await api(state.authMode === 'signup' ? '/api/signup' : '/api/login', {
      method: 'POST',
      body: { username, password },
    });
    $('auth-password').value = '';
    await boot();
  } catch (err) {
    $('auth-error').textContent = err.message;
    $('auth-error').hidden = false;
  } finally {
    btn.disabled = false;
  }
});

$('logout').addEventListener('click', async () => {
  state.abort?.abort();
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  state.user = null;
  state.conversations = [];
  state.currentId = null;
  history.replaceState(null, '', location.pathname);
  showAuth();
});

// ---------------------------------------------------------------------------
// Sidebar / conversations
// ---------------------------------------------------------------------------
function renderConversationList() {
  const list = $('conversation-list');
  list.replaceChildren();
  if (state.conversations.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty muted';
    empty.textContent = 'No conversations yet.';
    list.append(empty);
    return;
  }
  for (const c of state.conversations) {
    const item = document.createElement('div');
    item.className = 'conv-item' + (c.id === state.currentId ? ' active' : '');

    const open = document.createElement('button');
    open.className = 'conv-open';
    open.textContent = c.title;
    open.title = c.title;
    open.addEventListener('click', () => openConversation(c.id));

    const rename = document.createElement('button');
    rename.className = 'conv-action';
    rename.textContent = '✎';
    rename.title = 'Rename';
    rename.setAttribute('aria-label', `Rename "${c.title}"`);
    rename.addEventListener('click', () => renameConversation(c));

    const del = document.createElement('button');
    del.className = 'conv-action';
    del.textContent = '🗑';
    del.title = 'Delete';
    del.setAttribute('aria-label', `Delete "${c.title}"`);
    del.addEventListener('click', () => deleteConversation(c));

    item.append(open, rename, del);
    list.append(item);
  }
}

async function loadConversations() {
  const { conversations } = await api('/api/conversations');
  state.conversations = conversations;
  renderConversationList();
}

function setTitle(title) {
  $('chat-title').textContent = title || 'New chat';
  document.title = title && title !== 'New chat' ? `${title} · AI Chat` : 'AI Chat';
}

function newChat() {
  if (state.streaming) return;
  state.currentId = null;
  history.replaceState(null, '', location.pathname);
  setTitle('New chat');
  clearMessages();
  renderConversationList();
  closeSidebar();
  $('input').focus();
}

async function openConversation(id) {
  if (state.streaming) return;
  try {
    const { conversation, messages } = await api(`/api/conversations/${id}`);
    state.currentId = conversation.id;
    history.replaceState(null, '', `#c${conversation.id}`);
    setTitle(conversation.title);
    clearMessages();
    for (const m of messages) addMessage(m.role, m.content);
    $('empty-state').hidden = messages.length > 0;
    renderConversationList();
    scrollToBottom(true);
    closeSidebar();
    $('input').focus();
  } catch (err) {
    if (err.status === 401) return showAuth();
    if (err.status === 404) {
      await loadConversations();
      return newChat();
    }
    alert(err.message);
  }
}

async function renameConversation(c) {
  const title = prompt('Rename conversation', c.title);
  if (title == null || !title.trim() || title.trim() === c.title) return;
  try {
    const { conversation } = await api(`/api/conversations/${c.id}`, {
      method: 'PATCH',
      body: { title: title.trim() },
    });
    Object.assign(c, conversation);
    if (c.id === state.currentId) setTitle(c.title);
    renderConversationList();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteConversation(c) {
  if (state.streaming && c.id === state.currentId) return;
  if (!confirm(`Delete "${c.title}"? This cannot be undone.`)) return;
  try {
    await api(`/api/conversations/${c.id}`, { method: 'DELETE' });
    state.conversations = state.conversations.filter((x) => x.id !== c.id);
    if (c.id === state.currentId) newChat();
    else renderConversationList();
  } catch (err) {
    alert(err.message);
  }
}

$('new-chat').addEventListener('click', newChat);

// Mobile sidebar
const closeSidebar = () => $('sidebar').classList.remove('open');
$('toggle-sidebar').addEventListener('click', (e) => {
  e.stopPropagation();
  $('sidebar').classList.toggle('open');
});
document.addEventListener('click', (e) => {
  if ($('sidebar').classList.contains('open') && !$('sidebar').contains(e.target)) closeSidebar();
});

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
function clearMessages() {
  const box = $('messages');
  for (const el of [...box.querySelectorAll('.msg')]) el.remove();
  $('empty-state').hidden = false;
}

function addMessage(role, content) {
  $('empty-state').hidden = true;
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (role === 'user') bubble.textContent = content;
  else bubble.innerHTML = renderMarkdown(content);
  wrap.append(bubble);
  $('messages').append(wrap);
  return bubble;
}

function isNearBottom() {
  const box = $('messages');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
}
function scrollToBottom(force = false) {
  const box = $('messages');
  if (force || isNearBottom()) box.scrollTop = box.scrollHeight;
}

function setStreaming(on) {
  state.streaming = on;
  $('send').hidden = on;
  $('stop').hidden = !on;
  $('new-chat').disabled = on;
}

// Parse a fetch() body as a Server-Sent Events stream.
async function readSSE(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      let data = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      try { onEvent(event, data ? JSON.parse(data) : {}); } catch (e) { console.error(e); }
    }
  }
}

async function sendMessage(text) {
  if (state.streaming) return;
  setStreaming(true);

  try {
    // Create the conversation lazily on first message.
    if (!state.currentId) {
      const { conversation } = await api('/api/conversations', { method: 'POST' });
      state.currentId = conversation.id;
      state.conversations.unshift(conversation);
      history.replaceState(null, '', `#c${conversation.id}`);
      renderConversationList();
    }
    const convId = state.currentId;

    addMessage('user', text);
    const bubble = addMessage('assistant', '');
    bubble.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
    scrollToBottom(true);

    const controller = new AbortController();
    state.abort = controller;
    let full = '';
    let stopped = false;

    let res;
    try {
      res = await fetch(`/api/conversations/${convId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ content: text }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') stopped = true;
      else throw err;
    }

    if (res && !res.ok) {
      let msg = `Request failed (${res.status})`;
      try { msg = (await res.json()).error || msg; } catch {}
      if (res.status === 401) return showAuth();
      bubble.innerHTML = '';
      showBubbleError(bubble, msg);
      return;
    }

    if (res) {
      try {
        await readSSE(res, (event, data) => {
          if (event === 'meta') {
            const c = state.conversations.find((x) => x.id === convId);
            if (c && data.title) {
              c.title = data.title;
              if (state.currentId === convId) setTitle(c.title);
            }
          } else if (event === 'delta') {
            full += data.text;
            const stick = isNearBottom();
            bubble.innerHTML = renderMarkdown(full);
            if (stick) scrollToBottom(true);
          } else if (event === 'error') {
            if (!full) bubble.innerHTML = '';
            showBubbleError(bubble, data.error || 'Something went wrong.');
          }
        });
      } catch (err) {
        if (err.name === 'AbortError') stopped = true;
        else throw err;
      }
    }

    if (stopped) {
      if (!full) bubble.innerHTML = '';
      const note = document.createElement('div');
      note.className = 'stopped';
      note.textContent = full ? 'Stopped — partial reply saved.' : 'Stopped.';
      bubble.append(note);
    }

    // Move this conversation to the top of the list.
    const c = state.conversations.find((x) => x.id === convId);
    if (c) {
      c.updated_at = Date.now();
      state.conversations = [c, ...state.conversations.filter((x) => x !== c)];
    }
    renderConversationList();
  } catch (err) {
    console.error(err);
    const last = $('messages').querySelector('.msg.assistant:last-child .bubble');
    if (last) {
      if (!last.textContent.trim()) last.innerHTML = '';
      showBubbleError(last, err.message || 'Network error.');
    } else {
      alert(err.message);
    }
  } finally {
    state.abort = null;
    setStreaming(false);
    scrollToBottom();
    $('input').focus();
  }
}

function showBubbleError(bubble, msg) {
  const el = document.createElement('div');
  el.className = 'msg-error';
  el.textContent = `⚠ ${msg}`;
  bubble.append(el);
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------
const input = $('input');

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 220) + 'px';
}
input.addEventListener('input', autosize);

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || state.streaming) return;
  input.value = '';
  autosize();
  sendMessage(text);
});

$('stop').addEventListener('click', () => state.abort?.abort());

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  let me;
  try {
    me = await api('/api/me');
  } catch (err) {
    if (err.status === 401) return showAuth();
    document.body.textContent = `Could not reach the server: ${err.message}`;
    return;
  }
  state.user = me.user;
  $('account-name').textContent = me.user.username;
  $('config-warning').hidden = me.aiConfigured;
  $('auth-view').hidden = true;
  $('chat-view').hidden = false;

  await loadConversations();
  const match = location.hash.match(/^#c(\d+)$/);
  if (match) await openConversation(Number(match[1]));
  else newChat();
}

boot();
