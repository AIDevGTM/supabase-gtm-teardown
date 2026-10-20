import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) {
  console.warn('JWT_SECRET not set: using a random secret (sessions reset on restart).');
}
const COOKIE = 'token';
const isProd = process.env.NODE_ENV === 'production';

// ---------- Database ----------
const db = new Database(process.env.DB_PATH || path.join(__dirname, 'todo.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
`);

const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT id, email FROM users WHERE id = ?'),
  createUser: db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)'),
  listTasks: db.prepare('SELECT id, title, completed, created_at FROM tasks WHERE user_id = ? ORDER BY completed, id DESC'),
  getTask: db.prepare('SELECT id, title, completed, created_at FROM tasks WHERE id = ? AND user_id = ?'),
  createTask: db.prepare('INSERT INTO tasks (user_id, title) VALUES (?, ?)'),
  updateTask: db.prepare('UPDATE tasks SET title = ?, completed = ? WHERE id = ? AND user_id = ?'),
  deleteTask: db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?'),
};

const toTask = (t) => t && { ...t, completed: !!t.completed };

// ---------- App ----------
const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

function setSession(res, userId) {
  const token = jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: isProd,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function requireAuth(req, res, next) {
  try {
    const { sub } = jwt.verify(req.cookies[COOKIE] || '', JWT_SECRET);
    const user = q.userById.get(sub);
    if (!user) throw new Error('no user');
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Not authenticated' });
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validateCreds(body) {
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!EMAIL_RE.test(email) || email.length > 254) return { error: 'Please enter a valid email.' };
  if (password.length < 8 || password.length > 128) return { error: 'Password must be 8–128 characters.' };
  return { email, password };
}

// ---------- Auth routes ----------
app.post('/api/signup', (req, res) => {
  const v = validateCreds(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  if (q.userByEmail.get(v.email)) return res.status(409).json({ error: 'An account with that email already exists.' });
  const hash = bcrypt.hashSync(v.password, 10);
  const { lastInsertRowid } = q.createUser.run(v.email, hash);
  setSession(res, Number(lastInsertRowid));
  res.status(201).json({ user: { id: Number(lastInsertRowid), email: v.email } });
});

app.post('/api/login', (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const user = q.userByEmail.get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  setSession(res, user.id);
  res.json({ user: { id: user.id, email: user.email } });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'strict', secure: isProd });
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ user: req.user }));

// ---------- Task routes ----------
function parseTitle(title) {
  if (typeof title !== 'string') return null;
  const t = title.trim();
  return t.length >= 1 && t.length <= 500 ? t : null;
}

app.get('/api/tasks', requireAuth, (req, res) => {
  res.json({ tasks: q.listTasks.all(req.user.id).map(toTask) });
});

app.post('/api/tasks', requireAuth, (req, res) => {
  const title = parseTitle(req.body?.title);
  if (!title) return res.status(400).json({ error: 'Task title must be 1–500 characters.' });
  const { lastInsertRowid } = q.createTask.run(req.user.id, title);
  res.status(201).json({ task: toTask(q.getTask.get(lastInsertRowid, req.user.id)) });
});

app.patch('/api/tasks/:id', requireAuth, (req, res) => {
  const existing = q.getTask.get(Number(req.params.id), req.user.id);
  if (!existing) return res.status(404).json({ error: 'Task not found' });
  let title = existing.title;
  if (req.body?.title !== undefined) {
    title = parseTitle(req.body.title);
    if (!title) return res.status(400).json({ error: 'Task title must be 1–500 characters.' });
  }
  const completed = req.body?.completed !== undefined ? (req.body.completed ? 1 : 0) : existing.completed;
  q.updateTask.run(title, completed, existing.id, req.user.id);
  res.json({ task: toTask(q.getTask.get(existing.id, req.user.id)) });
});

app.delete('/api/tasks/:id', requireAuth, (req, res) => {
  const { changes } = q.deleteTask.run(Number(req.params.id), req.user.id);
  if (!changes) return res.status(404).json({ error: 'Task not found' });
  res.status(204).end();
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.status === 400 ? 'Bad request' : 'Server error' });
});

app.listen(PORT, () => console.log(`To-do app running at http://localhost:${PORT}`));
