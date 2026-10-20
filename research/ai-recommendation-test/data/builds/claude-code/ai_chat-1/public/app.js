'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  user: null,
  conversations: [],
  currentId: null,
  streaming: false,
  authMode: 'login', // or 'register'
};

// ---------- API ----------
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login' && path !== '/api/me') {
    showAuth();
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- Auth ----------
function setAuthMode(mode) {
  state.authMode = mode;
  const reg = mode === 'register';
  $('auth-subtitle').textContent = reg ? 'Create an account to save your chats.' : 'Sign in to continue your conversations.';
  $('auth-submit').textContent = reg ? 'Create account' : 'Sign in';
  $('auth-switch-text').textContent = reg ? 'Already have an account?' : 'No account?';
  $('auth-switch').textContent = reg ? 'Sign in' : 'Create one';
  $('password').autocomplete = reg ? 'new-password' : 'current-password';
  $('auth-error').textContent = '';
}

function showAuth() {
  state.user = null;
  $('app').classList.add('hidden');
  $('auth').classList.remove('hidden');
  $('username').focus();
}

async function showApp(user) {
  state.user = user;
  $('auth').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('whoami').textContent = user.username;
  await loadConversations();
  const fromHash = Number(location.hash.match(/^#\/c\/(\d+)$/)?.[1]);
  if (fromHash && state.conversations.some((c) => c.id === fromHash)) {
    await openConversation(fromHash);
  } else {
    newChat();
  }
}

$('auth-switch').addEventListener('click', (e) => {
  e.preventDefault();
  setAuthMode(state.authMode === 'login' ? 'register' : 'login');
});

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('auth-submit');
  btn.disabled = true;
  $('auth-error').textContent = '';
  try {
    const { user } = await api(state.authMode === 'register' ? '/api/register' : '/api/login', {
      method: 'POST',
      body: { username: $('username').value, password: $('password').value },
    });
    $('password').value = '';
    await showApp(user);
  } catch (err) {
    $('auth-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST', body: {} }).catch(() => {});
  state.conversations = [];
  state.currentId = null;
  history.replaceState(null, '', location.pathname);
  setAuthMode('login');
  showAuth();
});

// ---------- Conversations ----------
async function loadConversations() {
  const { conversations } = await api('/api/conversations');
  state.conversations = conversations;
  renderConversationList();
}

function renderConversationList() {
  const list = $('convo-list');
  list.replaceChildren();
  if (!state.conversations.length) {
    const p = document.createElement('p');
    p.className = 'muted small empty-list';
    p.textContent = 'No conversations yet.';
    list.append(p);
    return;
  }
  for (const c of state.conversations) {
    const row = document.createElement('div');
    row.className = 'convo' + (c.id === state.currentId ? ' active' : '');

    const title = document.createElement('button');
    title.className = 'convo-title';
    title.textContent = c.title;
    title.title = c.title;
    title.addEventListener('click', () => { openConversation(c.id); closeSidebarOnMobile(); });

    const actions = document.createElement('div');
    actions.className = 'convo-actions';
    const rename = iconButton('✎', 'Rename', () => renameConversation(c));
    const del = iconButton('🗑', 'Delete', () => deleteConversation(c));
    actions.append(rename, del);

    row.append(title, actions);
    list.append(row);
  }
}

function iconButton(label, aria, onClick) {
  const b = document.createElement('button');
  b.className = 'icon-btn';
  b.textContent = label;
  b.setAttribute('aria-label', aria);
  b.title = aria;
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}

async function renameConversation(c) {
  const title = prompt('Rename conversation', c.title);
  if (!title || !title.trim()) return;
  try {
    await api(`/api/conversations/${c.id}`, { method: 'PATCH', body: { title } });
    c.title = title.trim().slice(0, 100);
    renderConversationList();
    if (c.id === state.currentId) $('chat-title').textContent = c.title;
  } catch (err) { alert(err.message); }
}

async function deleteConversation(c) {
  if (state.streaming && c.id === state.currentId) return;
  if (!confirm(`Delete "${c.title}"? This cannot be undone.`)) return;
  try {
    await api(`/api/conversations/${c.id}`, { method: 'DELETE' });
    state.conversations = state.conversations.filter((x) => x.id !== c.id);
    if (c.id === state.currentId) newChat();
    else renderConversationList();
  } catch (err) { alert(err.message); }
}

function newChat() {
  if (state.streaming) return;
  state.currentId = null;
  history.replaceState(null, '', location.pathname);
  $('chat-title').textContent = 'New chat';
  renderMessages([]);
  renderConversationList();
  $('input').focus();
}

async function openConversation(id) {
  if (state.streaming) return;
  try {
    const { conversation, messages } = await api(`/api/conversations/${id}`);
    state.currentId = conversation.id;
    history.replaceState(null, '', `#/c/${conversation.id}`);
    $('chat-title').textContent = conversation.title;
    renderMessages(messages);
    renderConversationList();
    $('input').focus();
  } catch (err) {
    alert(err.message);
    newChat();
  }
}

$('new-chat').addEventListener('click', () => { newChat(); closeSidebarOnMobile(); });

// ---------- Messages ----------
function renderMessages(messages) {
  const box = $('messages');
  box.replaceChildren();
  if (!messages.length) {
    const w = document.createElement('div');
    w.className = 'welcome';
    const h = document.createElement('h3');
    h.textContent = `Hi${state.user ? ', ' + state.user.username : ''}!`;
    const p = document.createElement('p');
    p.textContent = 'Ask anything. Your conversations are saved automatically.';
    w.append(h, p);
    box.append(w);
    return;
  }
  for (const m of messages) appendMessage(m.role, m.content);
  scrollToBottom(true);
}

function appendMessage(role, text, extraClass = '') {
  const box = $('messages');
  box.querySelector('.welcome')?.remove();
  const el = document.createElement('div');
  el.className = `msg ${role} ${extraClass}`.trim();
  el.textContent = text; // textContent = no HTML injection
  box.append(el);
  return el;
}

function scrollToBottom(force = false) {
  const box = $('messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  if (force || nearBottom) box.scrollTop = box.scrollHeight;
}

function setStreaming(on) {
  state.streaming = on;
  $('send').disabled = on;
  $('new-chat').disabled = on;
}

async function sendMessage(content) {
  setStreaming(true);
  const userEl = appendMessage('user', content);
  scrollToBottom(true);
  let assistantEl = null;
  let saved = false; // becomes true once the server confirms it stored the user message

  try {
    // Create the conversation lazily on first message.
    if (!state.currentId) {
      const { conversation } = await api('/api/conversations', { method: 'POST', body: {} });
      state.currentId = conversation.id;
      state.conversations.unshift(conversation);
      history.replaceState(null, '', `#/c/${conversation.id}`);
      renderConversationList();
    }
    const convoId = state.currentId;

    const res = await fetch(`/api/conversations/${convoId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) showAuth();
      throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { rolledBack: true });
    }

    assistantEl = appendMessage('assistant', '', 'streaming');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;

    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 2);
        if (!line.startsWith('data:')) continue;
        const evt = JSON.parse(line.slice(5));
        if (evt.type === 'meta') {
          saved = true;
          const c = state.conversations.find((x) => x.id === convoId);
          if (c) {
            c.title = evt.title;
            // Move to top of the list (most recently updated).
            state.conversations = [c, ...state.conversations.filter((x) => x !== c)];
          }
          $('chat-title').textContent = evt.title;
          renderConversationList();
        } else if (evt.type === 'delta') {
          assistantEl.textContent += evt.text;
          scrollToBottom();
        } else if (evt.type === 'error') {
          throw Object.assign(new Error(evt.error), { rolledBack: evt.rolledBack });
        } else if (evt.type === 'done') {
          finished = true;
        }
      }
    }
    if (!finished) throw new Error('Connection lost before the reply finished.');
  } catch (err) {
    if (assistantEl && !assistantEl.textContent) assistantEl.remove();
    if (!saved || err.rolledBack) {
      // Server did not save the message; restore it to the input so it isn't lost.
      userEl.remove();
      if (!$('input').value) { $('input').value = content; autoResize(); }
    }
    appendMessage('assistant', err.message, 'error-msg');
    scrollToBottom(true);
  } finally {
    assistantEl?.classList.remove('streaming');
    setStreaming(false);
    $('input').focus();
  }
}

// ---------- Composer ----------
const input = $('input');
function autoResize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
}
input.addEventListener('input', autoResize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});
$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const content = input.value.trim();
  if (!content || state.streaming) return;
  input.value = '';
  autoResize();
  sendMessage(content);
});

// ---------- Mobile sidebar ----------
$('toggle-sidebar').addEventListener('click', () => $('sidebar').classList.toggle('open'));
function closeSidebarOnMobile() { $('sidebar').classList.remove('open'); }

// ---------- Boot ----------
(async function init() {
  setAuthMode('login');
  try {
    const { user } = await api('/api/me');
    await showApp(user);
  } catch {
    showAuth();
  }
})();
