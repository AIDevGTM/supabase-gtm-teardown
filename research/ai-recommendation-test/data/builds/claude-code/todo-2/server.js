'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.sqlite');
const IS_PROD = process.env.NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

if (!process.env.SESSION_SECRET) {
  console.warn('[warn] SESSION_SECRET not set; using a random secret (sessions reset on restart).');
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    completed  INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);

  CREATE TABLE IF NOT EXISTS sessions (
    sid     TEXT PRIMARY KEY,
    sess    TEXT NOT NULL,
    expires INTEGER NOT NULL
  );
`);

// ---------------------------------------------------------------------------
// Minimal SQLite-backed session store (avoids the leaky default MemoryStore)
// ---------------------------------------------------------------------------
class SqliteStore extends session.Store {
  constructor(database) {
    super();
    this.db = database;
    this.getStmt = database.prepare('SELECT sess, expires FROM sessions WHERE sid = ?');
    this.setStmt = database.prepare(
      'INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ' +
        'ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires'
    );
    this.delStmt = database.prepare('DELETE FROM sessions WHERE sid = ?');
    this.touchStmt = database.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
    this.pruneStmt = database.prepare('DELETE FROM sessions WHERE expires < ?');
    setInterval(() => this.pruneStmt.run(Date.now()), 15 * 60 * 1000).unref();
  }
  static expiry(sess) {
    return sess && sess.cookie && sess.cookie.expires
      ? new Date(sess.cookie.expires).getTime()
      : Date.now() + 24 * 60 * 60 * 1000;
  }
  get(sid, cb) {
    try {
      const row = this.getStmt.get(sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.sess));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb = () => {}) {
    try { this.setStmt.run(sid, JSON.stringify(sess), SqliteStore.expiry(sess)); cb(null); }
    catch (e) { cb(e); }
  }
  destroy(sid, cb = () => {}) {
    try { this.delStmt.run(sid); cb(null); } catch (e) { cb(e); }
  }
  touch(sid, sess, cb = () => {}) {
    try { this.touchStmt.run(SqliteStore.expiry(sess), sid); cb(null); } catch (e) { cb(e); }
  }
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------
const app = express();
if (IS_PROD) app.set('trust proxy', 1);

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
  });
  next();
});

app.use(express.json({ limit: '10kb' }));
app.use(
  session({
    store: new SqliteStore(db),
    name: 'todo.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PROD,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);

// CSRF mitigation: state-changing API calls must be JSON (not sendable by a
// plain cross-site HTML form) and, when present, Origin must match Host.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // DELETE can't be sent cross-site without a CORS preflight, so no body is required.
  if (req.method !== 'DELETE' && !req.is('application/json')) {
    return res.status(415).json({ error: 'Content-Type must be application/json' });
  }
  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) {
        return res.status(403).json({ error: 'Cross-origin request rejected' });
      }
    } catch {
      return res.status(403).json({ error: 'Invalid origin' });
    }
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_TITLE = 500;

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

function toTask(row) {
  return {
    id: row.id,
    title: row.title,
    completed: !!row.completed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Simple in-memory rate limiter for auth endpoints (per IP).
const attempts = new Map();
function authRateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const entry = attempts.get(key) || { count: 0, start: now };
  if (now - entry.start > windowMs) { entry.count = 0; entry.start = now; }
  entry.count += 1;
  attempts.set(key, entry);
  if (entry.count > 20) {
    return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  }
  next();
}
setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [k, v] of attempts) if (v.start < cutoff) attempts.delete(k);
}, 5 * 60 * 1000).unref();

function startSession(req, user, cb) {
  // Regenerate to prevent session fixation.
  req.session.regenerate((err) => {
    if (err) return cb(err);
    req.session.userId = user.id;
    req.session.email = user.email;
    req.session.save(cb);
  });
}

// Pre-computed hash so login timing doesn't reveal whether an email exists.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------
const stmts = {
  findUserByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  insertUser: db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)'),
  listTasks: db.prepare('SELECT * FROM tasks WHERE user_id = ? ORDER BY completed ASC, created_at DESC, id DESC'),
  getTask: db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?'),
  insertTask: db.prepare('INSERT INTO tasks (user_id, title) VALUES (?, ?)'),
  updateTask: db.prepare(
    "UPDATE tasks SET title = ?, completed = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
  ),
  deleteTask: db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?'),
  clearCompleted: db.prepare('DELETE FROM tasks WHERE user_id = ? AND completed = 1'),
};

app.post('/api/signup', authRateLimit, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!EMAIL_RE.test(email) || email.length > 254) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (password.length < 8 || password.length > 72) {
      return res.status(400).json({ error: 'Password must be 8–72 characters.' });
    }
    if (stmts.findUserByEmail.get(email)) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const hash = await bcrypt.hash(password, 12);
    let info;
    try {
      info = stmts.insertUser.run(email, hash);
    } catch (e) {
      if (String(e.code).startsWith('SQLITE_CONSTRAINT')) {
        return res.status(409).json({ error: 'An account with that email already exists.' });
      }
      throw e;
    }
    const user = { id: info.lastInsertRowid, email };
    startSession(req, user, (err) => {
      if (err) return next(err);
      res.status(201).json({ user: { id: user.id, email } });
    });
  } catch (e) { next(e); }
});

app.post('/api/login', authRateLimit, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = stmts.findUserByEmail.get(email);
    const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }
    startSession(req, user, (err) => {
      if (err) return next(err);
      res.json({ user: { id: user.id, email: user.email } });
    });
  } catch (e) { next(e); }
});

app.post('/api/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('todo.sid');
    res.json({ ok: true });
  });
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  res.json({ user: { id: req.session.userId, email: req.session.email } });
});

// ---------------------------------------------------------------------------
// Task routes (all scoped to the logged-in user)
// ---------------------------------------------------------------------------
app.get('/api/tasks', requireAuth, (req, res) => {
  res.json({ tasks: stmts.listTasks.all(req.session.userId).map(toTask) });
});

app.post('/api/tasks', requireAuth, (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Task title is required.' });
  if (title.length > MAX_TITLE) {
    return res.status(400).json({ error: `Task title must be at most ${MAX_TITLE} characters.` });
  }
  const info = stmts.insertTask.run(req.session.userId, title);
  res.status(201).json({ task: toTask(stmts.getTask.get(info.lastInsertRowid, req.session.userId)) });
});

app.patch('/api/tasks/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid task id.' });
  const existing = stmts.getTask.get(id, req.session.userId);
  if (!existing) return res.status(404).json({ error: 'Task not found.' });

  let title = existing.title;
  if (req.body.title !== undefined) {
    title = String(req.body.title).trim();
    if (!title) return res.status(400).json({ error: 'Task title is required.' });
    if (title.length > MAX_TITLE) {
      return res.status(400).json({ error: `Task title must be at most ${MAX_TITLE} characters.` });
    }
  }
  let completed = existing.completed;
  if (req.body.completed !== undefined) completed = req.body.completed ? 1 : 0;

  stmts.updateTask.run(title, completed, id, req.session.userId);
  res.json({ task: toTask(stmts.getTask.get(id, req.session.userId)) });
});

app.delete('/api/tasks/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid task id.' });
  const info = stmts.deleteTask.run(id, req.session.userId);
  if (info.changes === 0) return res.status(404).json({ error: 'Task not found.' });
  res.json({ ok: true });
});

app.post('/api/tasks/clear-completed', requireAuth, (req, res) => {
  const info = stmts.clearCompleted.run(req.session.userId);
  res.json({ deleted: info.changes });
});

// ---------------------------------------------------------------------------
// Fallbacks
// ---------------------------------------------------------------------------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON body.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

app.listen(PORT, () => {
  console.log(`To-do app running at http://localhost:${PORT}`);
});
