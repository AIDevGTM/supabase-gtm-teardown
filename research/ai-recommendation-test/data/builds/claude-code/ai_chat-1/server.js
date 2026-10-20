import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { db } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const MAX_TOKENS = Number(process.env.MAX_TOKENS) || 2048;
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || 'You are a helpful, concise assistant.';
const SESSION_DAYS = 30;
const COOKIE_NAME = 'sid';
const IS_PROD = process.env.NODE_ENV === 'production';

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('WARNING: ANTHROPIC_API_KEY is not set. Chat requests will fail until it is.');
}
const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(token), userId, expiresAt);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  });
}

function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  const row = db.prepare(`
    SELECT u.id, u.username, s.expires_at FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(hashToken(token));
  if (!row || row.expires_at < Date.now()) {
    if (row) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    res.clearCookie(COOKIE_NAME);
    return res.status(401).json({ error: 'Session expired' });
  }
  req.user = { id: row.id, username: row.username };
  next();
}

// Only allow JSON requests to mutate state (blocks simple cross-site form posts).
function requireJson(req, res, next) {
  // DELETE has no body; cross-origin DELETE already requires a CORS preflight, which we don't allow.
  if (['POST', 'PATCH', 'PUT'].includes(req.method) && !req.is('application/json')) {
    return res.status(415).json({ error: 'Content-Type must be application/json' });
  }
  next();
}
app.use('/api', requireJson);

// Simple in-memory rate limiter for auth endpoints.
const attempts = new Map();
function rateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const rec = attempts.get(key) || { count: 0, start: now };
  if (now - rec.start > windowMs) { rec.count = 0; rec.start = now; }
  rec.count++;
  attempts.set(key, rec);
  if (rec.count > 30) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  next();
}

function getOwnedConversation(id, userId) {
  return db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(id, userId);
}

// ---------- auth ----------
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

app.post('/api/register', rateLimit, (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!/^[a-z0-9_.-]{3,32}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-32 chars: letters, numbers, _ . -' });
  }
  if (password.length < 8 || password.length > 200) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'Username is taken' });
  }
  const hash = bcrypt.hashSync(password, 12);
  const { lastInsertRowid } = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
    .run(username, hash);
  createSession(res, lastInsertRowid);
  res.json({ user: { id: lastInsertRowid, username } });
});

app.post('/api/login', rateLimit, (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const ok = bcrypt.compareSync(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) return res.status(401).json({ error: 'Invalid username or password' });
  createSession(res, user.id);
  res.json({ user: { id: user.id, username: user.username } });
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies[COOKIE_NAME];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ user: req.user }));

// ---------- conversations ----------
app.get('/api/conversations', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT id, title, created_at, updated_at FROM conversations
    WHERE user_id = ? ORDER BY updated_at DESC`).all(req.user.id);
  res.json({ conversations: rows });
});

app.post('/api/conversations', requireAuth, (req, res) => {
  const now = Date.now();
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO conversations (user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
  ).run(req.user.id, 'New chat', now, now);
  res.json({ conversation: getOwnedConversation(lastInsertRowid, req.user.id) });
});

app.get('/api/conversations/:id', requireAuth, (req, res) => {
  const convo = getOwnedConversation(req.params.id, req.user.id);
  if (!convo) return res.status(404).json({ error: 'Conversation not found' });
  const messages = db.prepare(
    'SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id'
  ).all(convo.id);
  res.json({ conversation: convo, messages });
});

app.patch('/api/conversations/:id', requireAuth, (req, res) => {
  const convo = getOwnedConversation(req.params.id, req.user.id);
  if (!convo) return res.status(404).json({ error: 'Conversation not found' });
  const title = String(req.body?.title || '').trim().slice(0, 100);
  if (!title) return res.status(400).json({ error: 'Title is required' });
  db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, convo.id);
  res.json({ conversation: { ...convo, title } });
});

app.delete('/api/conversations/:id', requireAuth, (req, res) => {
  const convo = getOwnedConversation(req.params.id, req.user.id);
  if (!convo) return res.status(404).json({ error: 'Conversation not found' });
  db.prepare('DELETE FROM conversations WHERE id = ?').run(convo.id); // messages cascade
  res.json({ ok: true });
});

// ---------- chat (streaming) ----------
// Streams Server-Sent-Event style lines: data: {"type":"delta","text":"..."}
app.post('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  const convo = getOwnedConversation(req.params.id, req.user.id);
  if (!convo) return res.status(404).json({ error: 'Conversation not found' });
  const content = String(req.body?.content || '').trim();
  if (!content) return res.status(400).json({ error: 'Message is empty' });
  if (content.length > 32000) return res.status(400).json({ error: 'Message is too long' });

  const now = Date.now();
  const userMsg = db.prepare(
    'INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)'
  ).run(convo.id, 'user', content, now);

  // Auto-title from the first message.
  let title = convo.title;
  if (convo.title === 'New chat') {
    title = content.replace(/\s+/g, ' ').slice(0, 60) + (content.length > 60 ? '…' : '');
    db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, convo.id);
  }
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, convo.id);

  const history = db.prepare(
    'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id'
  ).all(convo.id);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({ type: 'meta', title, userMessageId: userMsg.lastInsertRowid });

  let fullText = '';
  let clientGone = false;
  let stream;
  res.on('close', () => {
    if (!res.writableFinished) {
      clientGone = true;
      stream?.abort();
    }
  });

  try {
    stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: history.map((m) => ({ role: m.role, content: m.content })),
    });
    stream.on('text', (text) => {
      fullText += text;
      if (!clientGone) send({ type: 'delta', text });
    });
    await stream.finalMessage();
  } catch (err) {
    if (!clientGone) {
      console.error('Anthropic error:', err?.message || err);
    }
    if (!fullText) {
      // Nothing generated: roll back the user message so history stays user/assistant alternating.
      db.prepare('DELETE FROM messages WHERE id = ?').run(userMsg.lastInsertRowid);
      if (!clientGone) {
        send({ type: 'error', error: friendlyError(err), rolledBack: true });
        return res.end();
      }
      return;
    }
  }

  // Save whatever was produced (full reply, or partial if interrupted).
  const saved = db.prepare(
    'INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)'
  ).run(convo.id, 'assistant', fullText, Date.now());
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), convo.id);

  if (!clientGone) {
    send({ type: 'done', assistantMessageId: saved.lastInsertRowid });
    res.end();
  }
});

function friendlyError(err) {
  const status = err?.status;
  if (status === 401) return 'The server’s AI API key is invalid or missing.';
  if (status === 429) return 'The AI service is rate limited. Please wait a moment and try again.';
  if (status === 529 || status === 503) return 'The AI service is overloaded. Please try again shortly.';
  return 'Something went wrong while generating a reply. Please try again.';
}

// Periodically clean up expired sessions.
setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}, 60 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`AI chat running at http://localhost:${PORT} (model: ${MODEL})`);
});
