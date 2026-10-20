const $ = (id) => document.getElementById(id);
const state = { conversations: [], currentId: null, streaming: false, abort: null, mode: 'login' };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && !path.startsWith('/api/login') && !path.startsWith('/api/register')) {
    showAuth();
    throw new Error('Not signed in');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- auth ----------
function showAuth() {
  $('app').classList.add('hidden');
  $('auth').classList.remove('hidden');
  $('username').focus();
}

async function showApp(username) {
  $('auth').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('whoami').textContent = username;
  await loadConversations();
  if (state.conversations.length) await openConversation(state.conversations[0].id);
  else renderMessages([]);
  $('input').focus();
}

$('auth-switch').addEventListener('click', (e) => {
  e.preventDefault();
  state.mode = state.mode === 'login' ? 'register' : 'login';
  const reg = state.mode === 'register';
  $('auth-submit').textContent = reg ? 'Create account' : 'Sign in';
  $('auth-subtitle').textContent = reg ? 'Create an account to save your chats' : 'Sign in to continue your conversations';
  $('auth-switch-text').textContent = reg ? 'Have an account?' : 'No account?';
  $('auth-switch').textContent = reg ? 'Sign in' : 'Create one';
  $('password').autocomplete = reg ? 'new-password' : 'current-password';
  $('auth-error').textContent = '';
});

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('auth-error').textContent = '';
  $('auth-submit').disabled = true;
  try {
    const { username } = await api(`/api/${state.mode}`, {
      method: 'POST',
      body: { username: $('username').value.trim(), password: $('password').value },
    });
    $('password').value = '';
    await showApp(username);
  } catch (err) {
    $('auth-error').textContent = err.message;
  } finally {
    $('auth-submit').disabled = false;
  }
});

$('logout').addEventListener('click', async () => {
  state.abort?.abort();
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  state.conversations = [];
  state.currentId = null;
  $('conv-list').innerHTML = '';
  showAuth();
});

// ---------- conversations ----------
async function loadConversations() {
  state.conversations = await api('/api/conversations');
  renderConversationList();
}

function renderConversationList() {
  const list = $('conv-list');
  list.innerHTML = '';
  for (const c of state.conversations) {
    const li = document.createElement('li');
    li.className = c.id === state.currentId ? 'active' : '';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = c.title;
    title.title = c.title;
    const actions = document.createElement('span');
    actions.className = 'actions';
    const rename = document.createElement('button');
    rename.textContent = '✎';
    rename.title = 'Rename';
    rename.onclick = (e) => { e.stopPropagation(); renameConversation(c); };
    const del = document.createElement('button');
    del.textContent = '🗑';
    del.title = 'Delete';
    del.onclick = (e) => { e.stopPropagation(); deleteConversation(c); };
    actions.append(rename, del);
    li.append(title, actions);
    li.onclick = () => { if (!state.streaming) openConversation(c.id); };
    list.append(li);
  }
}

async function openConversation(id) {
  const conv = await api(`/api/conversations/${id}`);
  state.currentId = conv.id;
  renderConversationList();
  renderMessages(conv.messages);
}

async function newConversation() {
  const conv = await api('/api/conversations', { method: 'POST' });
  state.conversations.unshift(conv);
  state.currentId = conv.id;
  renderConversationList();
  renderMessages([]);
  return conv;
}

async function renameConversation(c) {
  const title = prompt('Rename conversation', c.title);
  if (!title || !title.trim()) return;
  await api(`/api/conversations/${c.id}`, { method: 'PATCH', body: { title } });
  c.title = title.trim().slice(0, 100);
  renderConversationList();
}

async function deleteConversation(c) {
  if (!confirm(`Delete "${c.title}"? This cannot be undone.`)) return;
  if (state.streaming && c.id === state.currentId) state.abort?.abort();
  await api(`/api/conversations/${c.id}`, { method: 'DELETE' });
  state.conversations = state.conversations.filter((x) => x.id !== c.id);
  if (state.currentId === c.id) {
    state.currentId = null;
    if (state.conversations.length) await openConversation(state.conversations[0].id);
    else { renderConversationList(); renderMessages([]); }
  } else renderConversationList();
}

$('new-chat').addEventListener('click', () => { if (!state.streaming) { state.currentId = null; renderConversationList(); renderMessages([]); $('input').focus(); } });

// ---------- messages ----------
function renderMessages(messages) {
  const box = $('messages');
  box.innerHTML = '';
  if (!messages.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Start a conversation below.';
    box.append(empty);
    return;
  }
  for (const m of messages) appendMessage(m.role, m.content);
}

function appendMessage(role, text) {
  const box = $('messages');
  box.querySelector('.empty')?.remove();
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.textContent = text; // textContent: never interpret model/user output as HTML
  box.append(el);
  box.scrollTop = box.scrollHeight;
  return el;
}

function setStreaming(on) {
  state.streaming = on;
  $('send').classList.toggle('hidden', on);
  $('stop').classList.toggle('hidden', !on);
  $('input').disabled = on;
}

$('stop').addEventListener('click', () => state.abort?.abort());

async function sendMessage() {
  const text = $('input').value.trim();
  if (!text || state.streaming) return;

  // Lazily create a conversation on the first message ("New chat" doesn't hit the server).
  let conv = state.conversations.find((c) => c.id === state.currentId);
  if (!conv) conv = await newConversation();

  $('input').value = '';
  autoresize();
  appendMessage('user', text);
  const out = appendMessage('assistant', '');
  out.classList.add('pending');
  setStreaming(true);

  const controller = new AbortController();
  state.abort = controller;
  try {
    const res = await fetch(`/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
      signal: controller.signal,
    });
    if (res.status === 401) { showAuth(); return; }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${res.status})`);
    }

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
        const event = /^event: (.*)$/m.exec(raw)?.[1];
        const data = JSON.parse(/^data: (.*)$/m.exec(raw)?.[1] || '{}');
        if (event === 'delta') {
          out.textContent += data.text;
          const box = $('messages');
          box.scrollTop = box.scrollHeight;
        } else if (event === 'error') {
          appendMessage('error', data.error);
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') appendMessage('error', err.message);
  } finally {
    out.classList.remove('pending');
    if (!out.textContent) out.remove();
    setStreaming(false);
    state.abort = null;
    $('input').focus();
    // Refresh list so auto-generated title and ordering are up to date.
    loadConversations().catch(() => {});
  }
}

$('composer').addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
});
function autoresize() {
  const t = $('input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 200) + 'px';
}
$('input').addEventListener('input', autoresize);

// ---------- boot ----------
api('/api/me').then(({ username }) => showApp(username)).catch(() => showAuth());
