const $ = (id) => document.getElementById(id);
let mode = 'login';
let tasks = [];

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong');
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- Views ----------
function showAuth() {
  $('tasks-view').hidden = true;
  $('auth-view').hidden = false;
  $('email').focus();
}

async function showTasks(user) {
  $('auth-view').hidden = true;
  $('tasks-view').hidden = false;
  $('user-email').textContent = user.email;
  $('task-error').textContent = '';
  const data = await api('/api/tasks');
  tasks = data.tasks;
  render();
  $('task-input').focus();
}

function setMode(m) {
  mode = m;
  $('tab-login').classList.toggle('active', m === 'login');
  $('tab-signup').classList.toggle('active', m === 'signup');
  $('auth-submit').textContent = m === 'login' ? 'Log in' : 'Create account';
  $('password').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  $('auth-error').textContent = '';
}

function render() {
  const list = $('task-list');
  list.innerHTML = '';
  for (const t of tasks) {
    const li = document.createElement('li');
    if (t.completed) li.classList.add('done');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = t.completed;
    cb.setAttribute('aria-label', 'Mark complete');
    cb.onchange = () => updateTask(t.id, { completed: cb.checked });

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = t.title; // textContent avoids XSS
    title.title = 'Double-click to edit';
    title.ondblclick = () => startEdit(li, title, t);

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.setAttribute('aria-label', 'Delete task');
    del.onclick = () => deleteTask(t.id);

    li.append(cb, title, del);
    list.appendChild(li);
  }
  const remaining = tasks.filter((t) => !t.completed).length;
  $('empty').hidden = tasks.length > 0;
  $('count').textContent = tasks.length ? `${remaining} of ${tasks.length} remaining` : '';
}

function startEdit(li, span, task) {
  const input = document.createElement('input');
  input.className = 'edit';
  input.value = task.title;
  input.maxLength = 500;
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const val = input.value.trim();
    if (save && val && val !== task.title) await updateTask(task.id, { title: val });
    else render();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
  li.replaceChild(input, span);
  input.focus();
  input.select();
}

// ---------- Actions ----------
function handleError(err) {
  if (err.status === 401) return showAuth();
  $('task-error').textContent = err.message;
}

async function updateTask(id, changes) {
  try {
    const { task } = await api(`/api/tasks/${id}`, { method: 'PATCH', body: changes });
    tasks = tasks.map((t) => (t.id === id ? task : t));
    $('task-error').textContent = '';
  } catch (err) {
    handleError(err);
  }
  render();
}

async function deleteTask(id) {
  try {
    await api(`/api/tasks/${id}`, { method: 'DELETE' });
    tasks = tasks.filter((t) => t.id !== id);
    render();
  } catch (err) {
    handleError(err);
  }
}

$('tab-login').onclick = () => setMode('login');
$('tab-signup').onclick = () => setMode('signup');

$('auth-form').onsubmit = async (e) => {
  e.preventDefault();
  const btn = $('auth-submit');
  btn.disabled = true;
  $('auth-error').textContent = '';
  try {
    const { user } = await api(mode === 'login' ? '/api/login' : '/api/signup', {
      method: 'POST',
      body: { email: $('email').value, password: $('password').value },
    });
    $('password').value = '';
    await showTasks(user);
  } catch (err) {
    $('auth-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
};

$('task-form').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('task-input');
  const title = input.value.trim();
  if (!title) return;
  try {
    const { task } = await api('/api/tasks', { method: 'POST', body: { title } });
    tasks.unshift(task);
    tasks.sort((a, b) => a.completed - b.completed || b.id - a.id);
    input.value = '';
    $('task-error').textContent = '';
    render();
  } catch (err) {
    handleError(err);
  }
};

$('logout').onclick = async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  tasks = [];
  $('email').value = '';
  setMode('login');
  showAuth();
};

// ---------- Boot ----------
api('/api/me')
  .then(({ user }) => showTasks(user))
  .catch(() => showAuth());
