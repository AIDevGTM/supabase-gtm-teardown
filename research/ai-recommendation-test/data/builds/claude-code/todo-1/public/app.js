(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  const authView = $('#auth-view');
  const todoView = $('#todo-view');
  const authForm = $('#auth-form');
  const emailEl = $('#email');
  const passwordEl = $('#password');
  const authError = $('#auth-error');
  const authSubmit = $('#auth-submit');
  const pwHint = $('#pw-hint');
  const todoForm = $('#todo-form');
  const todoInput = $('#todo-input');
  const todoError = $('#todo-error');
  const list = $('#todo-list');
  const emptyEl = $('#empty');
  const countEl = $('#count');

  let mode = 'login';
  let filter = 'all';
  let todos = [];

  // ---------- API helper ----------
  async function api(path, { method = 'GET', body } = {}) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    } else if (method !== 'GET') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = '{}';
    }
    const res = await fetch(path, opts);
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // Wraps a todo API call: on 401 return to login, otherwise show error.
  async function guarded(fn) {
    todoError.textContent = '';
    try {
      return await fn();
    } catch (e) {
      if (e.status === 401) return showAuth();
      todoError.textContent = e.message;
    }
  }

  // ---------- Views ----------
  function showAuth() {
    todos = [];
    list.replaceChildren();
    todoView.hidden = true;
    authView.hidden = false;
    passwordEl.value = '';
    emailEl.focus();
  }

  async function showTodos(user) {
    $('#user-email').textContent = user.email;
    authView.hidden = true;
    todoView.hidden = false;
    authError.textContent = '';
    await guarded(async () => {
      const data = await api('/api/todos');
      todos = data.todos;
      render();
    });
    todoInput.focus();
  }

  function setMode(m) {
    mode = m;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === m));
    authSubmit.textContent = m === 'login' ? 'Log in' : 'Create account';
    passwordEl.autocomplete = m === 'login' ? 'current-password' : 'new-password';
    pwHint.hidden = m === 'login';
    authError.textContent = '';
  }

  // ---------- Rendering ----------
  function render() {
    const visible = todos.filter((t) =>
      filter === 'all' ? true : filter === 'active' ? !t.completed : t.completed
    );
    list.replaceChildren(...visible.map(renderItem));
    emptyEl.hidden = visible.length > 0;
    emptyEl.textContent = todos.length === 0 ? 'No tasks yet — add one above.' : 'Nothing in this view.';
    const left = todos.filter((t) => !t.completed).length;
    countEl.textContent = `${left} item${left === 1 ? '' : 's'} left`;
  }

  function renderItem(todo) {
    const li = document.createElement('li');
    li.className = todo.completed ? 'done' : '';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = todo.completed;
    cb.setAttribute('aria-label', 'Mark complete');
    cb.addEventListener('change', () => updateTodo(todo.id, { completed: cb.checked }));

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = todo.title; // textContent => no XSS
    title.title = 'Double-click to edit';
    title.addEventListener('dblclick', () => startEdit(li, todo, title));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'delete';
    del.textContent = '×';
    del.setAttribute('aria-label', 'Delete task');
    del.addEventListener('click', () => deleteTodo(todo.id));

    li.append(cb, title, del);
    return li;
  }

  function startEdit(li, todo, titleEl) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'edit';
    input.value = todo.title;
    input.maxLength = 500;
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const val = input.value.trim();
      if (save && val && val !== todo.title) {
        await updateTodo(todo.id, { title: val });
      } else {
        render();
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    li.replaceChild(input, titleEl);
    input.focus();
    input.select();
  }

  // ---------- Actions ----------
  async function updateTodo(id, changes) {
    await guarded(async () => {
      const { todo } = await api(`/api/todos/${id}`, { method: 'PATCH', body: changes });
      todos = todos.map((t) => (t.id === id ? todo : t));
      // keep incomplete tasks above completed ones, newest first
      todos.sort((a, b) => a.completed - b.completed || b.id - a.id);
    });
    render();
  }

  async function deleteTodo(id) {
    await guarded(async () => {
      await api(`/api/todos/${id}`, { method: 'DELETE' });
      todos = todos.filter((t) => t.id !== id);
    });
    render();
  }

  // ---------- Event wiring ----------
  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => setMode(t.dataset.mode))
  );

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.textContent = '';
    const email = emailEl.value.trim();
    const password = passwordEl.value;
    if (!email || !password) {
      authError.textContent = 'Please enter your email and password.';
      return;
    }
    if (mode === 'signup' && password.length < 8) {
      authError.textContent = 'Password must be at least 8 characters.';
      return;
    }
    authSubmit.disabled = true;
    try {
      const { user } = await api(mode === 'login' ? '/api/login' : '/api/signup', {
        method: 'POST',
        body: { email, password },
      });
      passwordEl.value = '';
      await showTodos(user);
    } catch (err) {
      authError.textContent = err.message;
    } finally {
      authSubmit.disabled = false;
    }
  });

  todoForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = todoInput.value.trim();
    if (!title) return;
    const btn = todoForm.querySelector('button');
    btn.disabled = true;
    await guarded(async () => {
      const { todo } = await api('/api/todos', { method: 'POST', body: { title } });
      todos.unshift(todo);
      todoInput.value = '';
      render();
    });
    btn.disabled = false;
    todoInput.focus();
  });

  document.querySelectorAll('.filter').forEach((b) =>
    b.addEventListener('click', () => {
      filter = b.dataset.filter;
      document.querySelectorAll('.filter').forEach((x) => x.classList.toggle('active', x === b));
      render();
    })
  );

  $('#logout').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
    showAuth();
  });

  // ---------- Boot ----------
  (async () => {
    try {
      const { user } = await api('/api/me');
      await showTodos(user);
    } catch {
      setMode('login');
      showAuth();
    }
  })();
})();
