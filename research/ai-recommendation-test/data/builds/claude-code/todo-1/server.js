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
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'todo.db');
const IS_PROD = process.env.NODE_ENV === 'production';
const COOKIE = 'token';
const TOKEN_TTL_SEC = 60 * 60 * 24 * 7; // 7 days

// ---------- Database ----------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(user_id);
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// JWT secret: use env var if provided, otherwise generate once and persist in DB
// so sessions survive restarts.
function getSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get();
  if (row) return row.value;
  const secret = crypto.randomBytes(48).toString('hex');
  db.prepare("INSERT INTO settings (key, value) VALUES ('jwt_secret', ?)").run(secret);
  return secret;
}
const JWT_SECRET = getSecret();

const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT id, email FROM users WHERE id = ?'),
  createUser: db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)'),
  listTodos: db.prepare(
    'SELECT id, title, completed, created_at FROM todos WHERE user_id = ? ORDER BY completed ASC, id DESC'
  ),
  getTodo: db.prepare('SELECT id, title, completed, created_at FROM todos WHERE id = ? AND user_id = ?'),
  createTodo: db.prepare('INSERT INTO todos (user_id, title) VALUES (?, ?)'),
  updateTodo: db.prepare('UPDATE todos SET title = ?, completed = ? WHERE id = ? AND user_id = ?'),
  deleteTodo: db.prepare('DELETE FROM todos WHERE id = ? AND user_id = ?'),
};

const toTodo = (r) => r && { ...r, completed: !!r.completed };

// ---------- App ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());

// Basic security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'"
  );
  next();
});

// CSRF mitigation: state-changing API calls must be JSON (forces CORS preflight
// cross-origin) in addition to the SameSite=Strict cookie.
app.use('/api', (req, res, next) => {
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && !req.is('application/json')) {
    return res.status(415).json({ error: 'Content-Type must be application/json' });
  }
  next();
});

// Simple in-memory rate limiter for auth endpoints
const attempts = new Map();
setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [k, v] of attempts) if (v.start < cutoff) attempts.delete(k);
}, 60 * 1000).unref();
function rateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const max = 20;
  const entry = attempts.get(key) || { count: 0, start: now };
  if (now - entry.start > windowMs) {
    entry.count = 0;
    entry.start = now;
  }
  entry.count++;
  attempts.set(key, entry);
  if (entry.count > max) {
    return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  }
  next();
}

function setAuthCookie(res, userId) {
  const token = jwt.sign({ sub: String(userId) }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: TOKEN_TTL_SEC,
  });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: IS_PROD,
    maxAge: TOKEN_TTL_SEC * 1000,
    path: '/',
  });
}

function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    const user = q.userById.get(Number(payload.sub));
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Not authenticated' });
  }
}

const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 12);
const EMAIL_RE =/^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateCredentials(body) {
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!EMAIL_RE.test(email) || email.length > 254) return { error: 'Please enter a valid email address.' };
  if (password.length < 8) return { error: 'Password must be at least 8 characters.' };
  if (password.length > 200) return { error: 'Password is too long.' };
  return { email, password };
}

// ---------- Auth routes ----------
app.post('/api/signup', rateLimit, async (req, res) => {
  const v = validateCredentials(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  if (q.userByEmail.get(v.email)) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }
  const hash = await bcrypt.hash(v.password, 12);
  try {
    const info = q.createUser.run(v.email, hash);
    setAuthCookie(res, info.lastInsertRowid);
    res.status(201).json({ user: { id: info.lastInsertRowid, email: v.email } });
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }
    console.error(e);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/api/login', rateLimit, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const user = email ? q.userByEmail.get(email) : null;
  // Always run a bcrypt compare to reduce user-enumeration timing differences.
  const ok = await bcrypt.compare(password, user?.password_hash || DUMMY_HASH);
  if (!user || !ok) return res.status(401).json({ error: 'Invalid email or password.' });
  setAuthCookie(res, user.id);
  res.json({ user: { id: user.id, email: user.email } });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE, { path: '/', sameSite: 'strict', secure: IS_PROD, httpOnly: true });
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ---------- Todo routes ----------
function parseTitle(t) {
  if (typeof t !== 'string') return null;
  const s = t.trim();
  if (!s || s.length > 500) return null;
  return s;
}

app.get('/api/todos', requireAuth, (req, res) => {
  res.json({ todos: q.listTodos.all(req.user.id).map(toTodo) });
});

app.post('/api/todos', requireAuth, (req, res) => {
  const title = parseTitle(req.body?.title);
  if (!title) return res.status(400).json({ error: 'Title is required (max 500 characters).' });
  const info = q.createTodo.run(req.user.id, title);
  res.status(201).json({ todo: toTodo(q.getTodo.get(info.lastInsertRowid, req.user.id)) });
});

app.patch('/api/todos/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const existing = Number.isInteger(id) ? q.getTodo.get(id, req.user.id) : null;
  if (!existing) return res.status(404).json({ error: 'Task not found.' });

  let title = existing.title;
  if (req.body?.title !== undefined) {
    title = parseTitle(req.body.title);
    if (!title) return res.status(400).json({ error: 'Title is required (max 500 characters).' });
  }
  let completed = existing.completed;
  if (req.body?.completed !== undefined) {
    if (typeof req.body.completed !== 'boolean') {
      return res.status(400).json({ error: 'completed must be a boolean.' });
    }
    completed = req.body.completed ? 1 : 0;
  }
  q.updateTodo.run(title, completed, id, req.user.id);
  res.json({ todo: toTodo(q.getTodo.get(id, req.user.id)) });
});

app.delete('/api/todos/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const info = Number.isInteger(id) ? q.deleteTodo.run(id, req.user.id) : { changes: 0 };
  if (!info.changes) return res.status(404).json({ error: 'Task not found.' });
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---------- Static frontend ----------
app.use(express.static(path.join(__dirname, 'public')));

// Error handler
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

app.listen(PORT, () => {
  console.log(`To-do app running at http://localhost:${PORT}`);
});
