import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Minimal .env loader (no extra dependency). Real env vars take precedence.
// ---------------------------------------------------------------------------
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    process.env[m[1]] = v;
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const MAX_TOKENS = Number(process.env.MAX_TOKENS) || 2048;
const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT) || 50; // messages sent to the model
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT || 'You are a helpful, concise assistant. Use Markdown for code.';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'chat.db');
const IS_PROD = process.env.NODE_ENV === 'production';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_MESSAGE_CHARS = 20000;

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT NOT NULL DEFAULT 'New chat',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content         TEXT NOT NULL,
    created_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);
`);

const q = {
  insertUser: db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)'),
  userByName: db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?'),
  insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
  sessionLookup: db.prepare(`
    SELECT s.user_id, s.expires_at, u.username
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  deleteExpiredSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),

  listConversations: db.prepare(`
    SELECT id, title, created_at, updated_at FROM conversations
    WHERE user_id = ? ORDER BY updated_at DESC, id DESC`),
  insertConversation: db.prepare(
    'INSERT INTO conversations (user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
  ),
  getConversation: db.prepare(
    'SELECT id, title, created_at, updated_at FROM conversations WHERE id = ? AND user_id = ?'
  ),
  renameConversation: db.prepare(
    'UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?'
  ),
  touchConversation: db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?'),
  deleteConversation: db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?'),

  listMessages: db.prepare(
    'SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id'
  ),
  recentMessages: db.prepare(`
    SELECT role, content FROM (
      SELECT id, role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?
    ) ORDER BY id`),
  countMessages: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?'),
  insertMessage: db.prepare(
    'INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)'
  ),
};

// Clean up expired sessions hourly.
setInterval(() => q.deleteExpiredSessions.run(Date.now()), 60 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
// Used to equalize timing when a username doesn't exist.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 12);

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  q.insertSession.run(hashToken(token), userId, Date.now() + SESSION_TTL_MS);
  res.cookie('sid', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

function requireAuth(req, res, next) {
  const token = req.cookies?.sid;
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  const th = hashToken(token);
  const row = q.sessionLookup.get(th);
  if (!row || row.expires_at < Date.now()) {
    if (row) q.deleteSession.run(th);
    res.clearCookie('sid', { path: '/' });
    return res.status(401).json({ error: 'Session expired' });
  }
  req.user = { id: row.user_id, username: row.username };
  req.sessionHash = th;
  next();
}

// Simple in-memory rate limiter for auth endpoints (per IP).
const authAttempts = new Map();
function authRateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip;
  const entry = authAttempts.get(key);
  if (!entry || entry.reset < now) {
    authAttempts.set(key, { count: 1, reset: now + 15 * 60 * 1000 });
    return next();
  }
  if (++entry.count > 20) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of authAttempts) if (v.reset < now) authAttempts.delete(k);
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());

// CSRF mitigation: state-changing API calls must be JSON (cannot be sent
// cross-site by a plain HTML form), on top of SameSite=Lax cookies.
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const ct = req.headers['content-type'] || '';
    if (!ct.startsWith('application/json')) {
      return res.status(415).json({ error: 'Content-Type must be application/json' });
    }
  }
  next();
});

const parseId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// ----- Auth routes ---------------------------------------------------------
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

app.post('/api/signup', authRateLimit, async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return res
      .status(400)
      .json({ error: 'Username must be 3–32 characters: letters, numbers, _ . -' });
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 72) {
    return res.status(400).json({ error: 'Password must be 8–72 characters' });
  }
  if (q.userByName.get(username)) {
    return res.status(409).json({ error: 'That username is taken' });
  }
  const hash = await bcrypt.hash(password, 12);
  let lastInsertRowid;
  try {
    ({ lastInsertRowid } = q.insertUser.run(username, hash, Date.now()));
  } catch (err) {
    // Race: someone registered the same name while we were hashing.
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'That username is taken' });
    }
    console.error('Signup error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
  startSession(res, Number(lastInsertRowid));
  res.status(201).json({ user: { id: Number(lastInsertRowid), username } });
});

app.post('/api/login', authRateLimit, async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  const user = q.userByName.get(username);
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) return res.status(401).json({ error: 'Invalid username or password' });
  startSession(res, user.id);
  res.json({ user: { id: user.id, username: user.username } });
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies?.sid;
  if (token) q.deleteSession.run(hashToken(token));
  res.clearCookie('sid', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.user, aiConfigured: Boolean(anthropic), model: MODEL });
});

// ----- Conversation routes -------------------------------------------------
app.get('/api/conversations', requireAuth, (req, res) => {
  res.json({ conversations: q.listConversations.all(req.user.id) });
});

app.post('/api/conversations', requireAuth, (req, res) => {
  const now = Date.now();
  const { lastInsertRowid } = q.insertConversation.run(req.user.id, 'New chat', now, now);
  res.status(201).json({ conversation: q.getConversation.get(lastInsertRowid, req.user.id) });
});

app.get('/api/conversations/:id', requireAuth, (req, res) => {
  const id = parseId(req.params.id);
  const conv = id && q.getConversation.get(id, req.user.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  res.json({ conversation: conv, messages: q.listMessages.all(id) });
});

app.patch('/api/conversations/:id', requireAuth, (req, res) => {
  const id = parseId(req.params.id);
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  if (!title || title.length > 100) {
    return res.status(400).json({ error: 'Title must be 1–100 characters' });
  }
  const info = id && q.renameConversation.run(title, Date.now(), id, req.user.id);
  if (!info || info.changes === 0) return res.status(404).json({ error: 'Conversation not found' });
  res.json({ conversation: q.getConversation.get(id, req.user.id) });
});

app.delete('/api/conversations/:id', requireAuth, (req, res) => {
  const id = parseId(req.params.id);
  const info = id && q.deleteConversation.run(id, req.user.id);
  if (!info || info.changes === 0) return res.status(404).json({ error: 'Conversation not found' });
  res.json({ ok: true });
});

// ----- Chat (streaming) ----------------------------------------------------
const activeConversations = new Set();

function makeTitle(text) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? oneLine.slice(0, 57).trimEnd() + '…' : oneLine || 'New chat';
}

// Anthropic requires the history to start with a user turn and alternate
// roles. A failed reply can leave two user turns in a row, so merge them.
function buildModelMessages(rows) {
  const out = [];
  for (const r of rows) {
    if (out.length === 0 && r.role !== 'user') continue;
    const last = out[out.length - 1];
    if (last && last.role === r.role) last.content += '\n\n' + r.content;
    else out.push({ role: r.role, content: r.content });
  }
  return out;
}

app.post('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  const conv = id && q.getConversation.get(id, req.user.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });

  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  if (!content) return res.status(400).json({ error: 'Message cannot be empty' });
  if (content.length > MAX_MESSAGE_CHARS) {
    return res.status(400).json({ error: `Message exceeds ${MAX_MESSAGE_CHARS} characters` });
  }
  if (!anthropic) {
    return res
      .status(503)
      .json({ error: 'AI is not configured. Set ANTHROPIC_API_KEY on the server.' });
  }
  if (activeConversations.has(id)) {
    return res.status(409).json({ error: 'A reply is already in progress for this chat' });
  }
  activeConversations.add(id);

  try {
    // Persist the user message first so it's never lost.
    const now = Date.now();
    const isFirst = q.countMessages.get(id).n === 0;
    const userMsg = q.insertMessage.run(id, 'user', content, now);
    let title = conv.title;
    if (isFirst && conv.title === 'New chat') {
      title = makeTitle(content);
      q.renameConversation.run(title, now, id, req.user.id);
    } else {
      q.touchConversation.run(now, id);
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send('meta', { userMessageId: Number(userMsg.lastInsertRowid), title });

    const history = buildModelMessages(q.recentMessages.all(id, HISTORY_LIMIT));
    let full = '';
    let errorMessage = null;
    let clientGone = false;

    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: history,
    });

    res.on('close', () => {
      if (!res.writableEnded) {
        clientGone = true;
        stream.abort();
      }
    });

    stream.on('text', (t) => {
      full += t;
      send('delta', { text: t });
    });

    try {
      await stream.finalMessage();
    } catch (err) {
      if (!clientGone) {
        console.error('Anthropic error:', err?.message || err);
        errorMessage =
          err?.status === 401
            ? 'The server’s AI API key is invalid.'
            : err?.status === 429
              ? 'The AI service is rate-limited. Please try again shortly.'
              : 'The AI request failed. Please try again.';
      }
    }

    // Save whatever we got (including partial replies if stopped/failed).
    let assistantMessageId = null;
    if (full.trim()) {
      const info = q.insertMessage.run(id, 'assistant', full, Date.now());
      assistantMessageId = Number(info.lastInsertRowid);
      q.touchConversation.run(Date.now(), id);
    }

    if (errorMessage) send('error', { error: errorMessage, assistantMessageId });
    else send('done', { assistantMessageId });
    if (!res.writableEnded) res.end();
  } catch (err) {
    console.error('Chat handler error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    else if (!res.writableEnded) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'Internal server error' })}\n\n`);
      res.end();
    }
  } finally {
    activeConversations.delete(id);
  }
});

// ----- Static frontend + error handling -----------------------------------
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`AI chat running at http://localhost:${PORT}`);
  if (!anthropic) {
    console.warn('⚠  ANTHROPIC_API_KEY is not set — sign-up/history work, but AI replies will fail.');
  }
});
