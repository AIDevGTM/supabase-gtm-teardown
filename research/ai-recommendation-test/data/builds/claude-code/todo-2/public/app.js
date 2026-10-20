'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);

  const els = {
    loading: $('#loading'),
    authView: $('#auth-view'),
    appView: $('#app-view'),
    tabs: document.querySelectorAll('.tab'),
    authForm: $('#auth-form'),
    email: $('#email'),
    password: $('#password'),
    passwordHint: $('#password-hint'),
    authError: $('#auth-error'),
    authSubmit: $('#auth-submit'),
    userEmail: $('#user-email'),
    logoutBtn: $('#logout-btn'),
    newTaskForm: $('#new-task-form'),
    newTaskInput: $('#new-task-input'),
    taskError: $('#task-error'),
    filters: document.querySelectorAll('.filter'),
    taskList: $('#task-list'),
    emptyState: $('#empty-state'),
    taskCount: $('#task-count'),
    clearCompleted: $('#clear-completed'),
  };

  const state = {
    mode: 'login', // or 'signup'
    user: null,
    tasks: [],
    filter: 'all',
  };

  // -------------------------------------------------------------------------
  // API helper
  // -------------------------------------------------------------------------
  async function api(method, url, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (res.status === 401 && state.user && !url.startsWith('/api/login')) {
      // Session expired — return to login.
      state.user = null;
      render();
    }
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function showError(el, msg) {
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------
  function setMode(mode) {
    state.mode = mode;
    els.tabs.forEach((t) => {
      const active = t.dataset.mode === mode;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', String(active));
    });
    const signup = mode === 'signup';
    els.authSubmit.textContent = signup ? 'Create account' : 'Log in';
    els.password.autocomplete = signup ? 'new-password' : 'current-password';
    els.passwordHint.hidden = !signup;
    showError(els.authError, '');
  }

  els.tabs.forEach((t) => t.addEventListener('click', () => setMode(t.dataset.mode)));

  els.authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = els.email.value.trim();
    const password = els.password.value;

    if (!email || !password) return showError(els.authError, 'Please enter your email and password.');
    if (state.mode === 'signup' && password.length < 8) {
      return showError(els.authError, 'Password must be at least 8 characters.');
    }

    showError(els.authError, '');
    els.authSubmit.disabled = true;
    try {
      const url = state.mode === 'signup' ? '/api/signup' : '/api/login';
      const { user } = await api('POST', url, { email, password });
      state.user = user;
      els.password.value = '';
      await loadTasks();
      render();
    } catch (err) {
      showError(els.authError, err.message);
    } finally {
      els.authSubmit.disabled = false;
    }
  });

  els.logoutBtn.addEventListener('click', async () => {
    try { await api('POST', '/api/logout', {}); } catch { /* ignore */ }
    state.user = null;
    state.tasks = [];
    render();
  });

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------
  async function loadTasks() {
    const { tasks } = await api('GET', '/api/tasks');
    state.tasks = tasks;
  }

  els.newTaskForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = els.newTaskInput.value.trim();
    if (!title) return;
    showError(els.taskError, '');
    try {
      const { task } = await api('POST', '/api/tasks', { title });
      state.tasks.unshift(task);
      els.newTaskInput.value = '';
      renderTasks();
    } catch (err) {
      showError(els.taskError, err.message);
    }
  });

  async function updateTask(id, changes) {
    showError(els.taskError, '');
    try {
      const { task } = await api('PATCH', `/api/tasks/${id}`, changes);
      const i = state.tasks.findIndex((t) => t.id === id);
      if (i !== -1) state.tasks[i] = task;
    } catch (err) {
      showError(els.taskError, err.message);
    }
    renderTasks();
  }

  async function deleteTask(id) {
    showError(els.taskError, '');
    try {
      await api('DELETE', `/api/tasks/${id}`);
      state.tasks = state.tasks.filter((t) => t.id !== id);
    } catch (err) {
      showError(els.taskError, err.message);
    }
    renderTasks();
  }

  els.clearCompleted.addEventListener('click', async () => {
    showError(els.taskError, '');
    try {
      await api('POST', '/api/tasks/clear-completed', {});
      state.tasks = state.tasks.filter((t) => !t.completed);
    } catch (err) {
      showError(els.taskError, err.message);
    }
    renderTasks();
  });

  els.filters.forEach((btn) =>
    btn.addEventListener('click', () => {
      state.filter = btn.dataset.filter;
      els.filters.forEach((b) => b.classList.toggle('active', b === btn));
      renderTasks();
    })
  );

  function startEditing(li, task) {
    const titleEl = li.querySelector('.title');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'edit-input';
    input.value = task.title;
    input.maxLength = 500;
    input.setAttribute('aria-label', 'Edit task');
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      if (save && value && value !== task.title) {
        updateTask(task.id, { title: value });
      } else if (save && !value) {
        deleteTask(task.id);
      } else {
        renderTasks();
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  function renderTasks() {
    const visible = state.tasks
      .filter((t) =>
        state.filter === 'active' ? !t.completed :
        state.filter === 'completed' ? t.completed : true
      )
      // Keep incomplete tasks on top, newest first.
      .sort((a, b) => (a.completed - b.completed) || (b.id - a.id));

    els.taskList.replaceChildren();
    for (const task of visible) {
      const li = document.createElement('li');
      li.className = 'task' + (task.completed ? ' completed' : '');

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = task.completed;
      cb.setAttribute('aria-label', `Mark "${task.title}" as ${task.completed ? 'not done' : 'done'}`);
      cb.addEventListener('change', () => updateTask(task.id, { completed: cb.checked }));

      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = task.title; // textContent => no XSS
      title.title = 'Double-click to edit';
      title.addEventListener('dblclick', () => startEditing(li, task));

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'delete';
      del.textContent = '×';
      del.setAttribute('aria-label', `Delete "${task.title}"`);
      del.addEventListener('click', () => deleteTask(task.id));

      li.append(cb, title, del);
      els.taskList.append(li);
    }

    const remaining = state.tasks.filter((t) => !t.completed).length;
    const completed = state.tasks.length - remaining;
    els.taskCount.textContent = `${remaining} item${remaining === 1 ? '' : 's'} left`;
    els.clearCompleted.hidden = completed === 0;
    els.emptyState.hidden = visible.length > 0;
    els.emptyState.textContent =
      state.tasks.length === 0 ? 'No tasks yet — add one above!' : 'Nothing in this view.';
  }

  function render() {
    els.loading.hidden = true;
    const loggedIn = !!state.user;
    els.authView.hidden = loggedIn;
    els.appView.hidden = !loggedIn;
    if (loggedIn) {
      els.userEmail.textContent = state.user.email;
      renderTasks();
      els.newTaskInput.focus();
    } else {
      setMode(state.mode);
      els.email.focus();
    }
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  (async () => {
    try {
      const { user } = await api('GET', '/api/me');
      state.user = user;
      if (user) await loadTasks();
    } catch {
      state.user = null;
    }
    render();
  })();
})();
