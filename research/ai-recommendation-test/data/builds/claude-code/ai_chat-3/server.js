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
const SESSION_DAYS = 30;
const IS_PROD = process.env.NODE_ENV === 'production';

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('WARNING: ANTHROPIC_API_KEY is not set — chat requests will fail.');
}
// Created lazily so the server can still start (and serve login/history) without a key.
let anthropicClient;
const getAnthropic = () => (anthropicClient ??= new Anthropic()); // reads ANTHROPIC_API_KEY

const app = express();
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 864e5;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(token), userId, expires);
  res.cookie('sid', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: SESSION_DAYS * 864e5,
  });
}

function requireAuth(req, res, next) {
  const token = req.cookies.sid;
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  const row = db.prepare(
    `SELECT u.id, u.username, s.expires_at FROM sessions s
     JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`
  ).get(hashToken(token));
  if (!row || row.expires_at < Date.now()) {
    if (row) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    res.clearCookie('sid');
    return res.status(401).json({ error: 'Session expired' });
  }
  req.user = { id: row.id, username: row.username };
  next();
}

// Returns the conversation only if it belongs to the current user.
function getOwnedConversation(userId, convId) {
  return db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
    .get(Number(convId), userId);
}

// Simple in-memory login rate limiter (per IP).
const attempts = new Map();
function loginRateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const rec = attempts.get(key) || { count: 0, reset: now + 15 * 60e3 };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + 15 * 60e3; }
  rec.count++;
  attempts.set(key, rec);
  if (rec.count > 20) return res.status(429).json({ error: 'Too many attempts, try again later' });
  next();
}

// ---------- auth routes ----------
app.post('/api/register', loginRateLimit, (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3–32 chars: letters, numbers, _ . -' });
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (exists) return res.status(409).json({ error: 'Username already taken' });
  const hash = bcrypt.hashSync(password, 12);
  const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
  createSession(res, info.lastInsertRowid);
  res.json({ username });
});

app.post('/api/login', loginRateLimit, (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password required' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  createSession(res, user.id);
  res.json({ username: user.username });
});

app.post('/api/logout', (req, res) => {
  if (req.cookies.sid) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(req.cookies.sid));
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ username: req.user.username }));

// ---------- conversation routes ----------
app.get('/api/conversations', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC'
  ).all(req.user.id);
  res.json(rows);
});

app.post('/api/conversations', requireAuth, (req, res) => {
  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO conversations (user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
  ).run(req.user.id, 'New chat', now, now);
  res.json({ id: info.lastInsertRowid, title: 'New chat', created_at: now, updated_at: now });
});

app.get('/api/conversations/:id', requireAuth, (req, res) => {
  const conv = getOwnedConversation(req.user.id, req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  const messages = db.prepare(
    'SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id'
  ).all(conv.id);
  res.json({ id: conv.id, title: conv.title, messages });
});

app.patch('/api/conversations/:id', requireAuth, (req, res) => {
  const conv = getOwnedConversation(req.user.id, req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  const title = String(req.body?.title || '').trim().slice(0, 100);
  if (!title) return res.status(400).json({ error: 'Title required' });
  db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, conv.id);
  res.json({ ok: true });
});

app.delete('/api/conversations/:id', requireAuth, (req, res) => {
  const conv = getOwnedConversation(req.user.id, req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id); // messages cascade
  res.json({ ok: true });
});

// Send a message and stream the assistant's reply via Server-Sent Events.
app.post('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  const conv = getOwnedConversation(req.user.id, req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  if (!content) return res.status(400).json({ error: 'Message cannot be empty' });
  if (content.length > 32000) return res.status(400).json({ error: 'Message too long' });

  const now = Date.now();
  db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)')
    .run(conv.id, 'user', content, now);
  if (conv.title === 'New chat') {
    const title = content.replace(/\s+/g, ' ').slice(0, 60) + (content.length > 60 ? '…' : '');
    db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, conv.id);
  }
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conv.id);

  const history = db.prepare(
    'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id'
  ).all(conv.id);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  let full = '';
  let aborted = false;
  let stream;
  res.on('close', () => {
    if (!res.writableEnded) { aborted = true; stream?.abort(); }
  });

  try {
    stream = getAnthropic().messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: 'You are a helpful, concise assistant.',
      messages: normalizeHistory(history),
    });
    stream.on('text', (delta) => { full += delta; send('delta', { text: delta }); });
    await stream.finalMessage();
  } catch (err) {
    if (!aborted) {
      console.error('Anthropic error:', err?.message || err);
      send('error', { error: 'The AI request failed. Please try again.' });
    }
  }

  // Persist whatever was generated (including partial output if the user stopped it).
  if (full) {
    db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)')
      .run(conv.id, 'assistant', full, Date.now());
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), conv.id);
  }
  if (!aborted) { send('done', {}); res.end(); }
});

// The API requires alternating user/assistant turns. If a previous request failed
// and left two user messages in a row, merge them so the conversation stays valid.
function normalizeHistory(rows) {
  const out = [];
  for (const { role, content } of rows) {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += '\n\n' + content;
    else out.push({ role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

// Purge expired sessions hourly.
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3600e3).unref();

app.listen(PORT, () => console.log(`AI chat running at http://localhost:${PORT}`));
