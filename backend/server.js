import http from 'http';
import express from 'express';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const db = new Database(process.env.DB_PATH || '/app/data/database.db');
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

const now = () => Math.floor(Date.now() / 1000);
const rnd = (n) => crypto.randomBytes(n).toString('hex');

// ---------- Schema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL, parent_id INTEGER DEFAULT 0,
  username TEXT UNIQUE NOT NULL, pass TEXT NOT NULL,
  status TEXT DEFAULT 'pending', expires_at INTEGER DEFAULT 0,
  contact TEXT DEFAULT '', created_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY, user_id INTEGER, created_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS schedules(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER, title TEXT, starts_at INTEGER, minutes INTEGER
);
CREATE TABLE IF NOT EXISTS tickets(
  token TEXT PRIMARY KEY, room TEXT, kind TEXT, user_id INTEGER,
  expires_at INTEGER, used INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS room_state(
  room TEXT PRIMARY KEY,
  chat_enabled INTEGER DEFAULT 1,
  slow_mode INTEGER DEFAULT 0,
  pinned_msg TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS chat_messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL, user_id INTEGER NOT NULL,
  username TEXT NOT NULL, role TEXT NOT NULL,
  text TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_room_id ON chat_messages(room, id);

CREATE TABLE IF NOT EXISTS polls(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL, question TEXT NOT NULL,
  options_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_polls_room ON polls(room, id);

CREATE TABLE IF NOT EXISTS poll_votes(
  poll_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  option_idx INTEGER NOT NULL,
  PRIMARY KEY(poll_id, user_id)
);
`);

// ---------- Non-blocking Async Passwords (prevents 1,000-user login freeze) ----------
const scryptAsync = (p, s) => new Promise((resolve, reject) =>
  crypto.scrypt(p, s, 32, (err, derived) => err ? reject(err) : resolve(derived))
);
const hash = async (p) => {
  const s = rnd(8);
  return s + ':' + (await scryptAsync(p, s)).toString('hex');
};
const check = async (p, h) => {
  try {
    const [s, k] = h.split(':');
    const derived = await scryptAsync(p, s);
    return crypto.timingSafeEqual(Buffer.from(k, 'hex'), derived);
  } catch { return false; }
};

// ---------- Seed Admin ----------
if (!db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) {
  const passHash = await hash(process.env.ADMIN_PASS || 'admin123');
  db.prepare("INSERT INTO users(role,username,pass,status,created_at) VALUES('admin',?,?,'active',?)")
    .run((process.env.ADMIN_USER || 'admin').toLowerCase(), passHash, now());
  console.log('Seeded admin account.');
}

// ---------- Admin Settings (1,000-viewer & 4+ hour stream defaults) ----------
const settings = {
  maxConcurrentStreams: 1,
  extraStreamViewerThreshold: 300,
  maxViewersPerRoom: 1000,
  maxTotalViewers: 1000,
  requireSchedule: 0,
  maxBookingsPerSub: 5,
  maxSlotMinutes: 360
};
for (const r of db.prepare('SELECT * FROM settings').all())
  if (r.key in settings) settings[r.key] = parseInt(r.value);
const saveSetting = (k, v) =>
  db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=?').run(k, String(v), String(v));

// ---------- In-Memory High-Concurrency Caches ----------
// View tokens cached in RAM -> /api/mtx/auth answers in <0.1ms with zero SQLite reads
const viewTokens = new Map();     // token -> { userId, sid, room, expiresAt }
const userViewToken = new Map();  // userId -> token
const roomSockets = new Map();    // room -> Set<ws>
const userSocket = new Map();     // userId -> ws (1 active WS per account)
const mutedUsers = new Map();     // room -> Set<userId>
const lastChatAt = new Map();     // userId -> ms
const pollDirtyRooms = new Set(); // rooms needing throttled poll tally broadcast

function revokeUserLiveAccess(userId, reason = 'Session ended') {
  const oldTok = userViewToken.get(userId);
  if (oldTok) { viewTokens.delete(oldTok); userViewToken.delete(userId); }
  const oldWs = userSocket.get(userId);
  if (oldWs && oldWs.readyState === 1) {
    try { oldWs.send(JSON.stringify({ type: 'kicked', reason })); } catch {}
    try { oldWs.close(4001, reason); } catch {}
  }
  userSocket.delete(userId);
}

// ---------- Helpers ----------
const expired = (u) => u.expires_at > 0 && u.expires_at < now();
const subActive = (u) => u && u.status === 'active' && !expired(u);
const roomOf = (subId) => 'sub' + subId;

const parseSid = (cookieHeader) =>
  (cookieHeader || '').split(';').map(c => c.trim()).find(c => c.startsWith('sid='))?.slice(4) || null;

const getUserBySid = (sid) => {
  if (!sid) return null;
  return db.prepare('SELECT u.*, s.sid FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.sid=?').get(sid) || null;
};
const getUser = (req) => getUserBySid(parseSid(req.headers.cookie));

const auth = (role) => (req, res, next) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: 'Not logged in' });
  if (role && u.role !== role) return res.status(403).json({ error: 'Forbidden' });
  req.user = u;
  next();
};

function getRoomState(room) {
  let row = db.prepare('SELECT * FROM room_state WHERE room=?').get(room);
  if (!row) {
    db.prepare('INSERT OR IGNORE INTO room_state(room,chat_enabled,slow_mode,pinned_msg) VALUES(?,1,0,\'\')').run(room);
    row = { room, chat_enabled: 1, slow_mode: 0, pinned_msg: '' };
  }
  return { chatEnabled: !!row.chat_enabled, slowMode: row.slow_mode, pinnedMsg: row.pinned_msg || '' };
}

function getPollSummary(pollRow) {
  if (!pollRow) return null;
  const options = JSON.parse(pollRow.options_json);
  const counts = new Array(options.length).fill(0);
  const rows = db.prepare('SELECT option_idx, COUNT(*) c FROM poll_votes WHERE poll_id=? GROUP BY option_idx').all(pollRow.id);
  let total = 0;
  for (const r of rows) {
    if (r.option_idx >= 0 && r.option_idx < counts.length) {
      counts[r.option_idx] = r.c;
      total += r.c;
    }
  }
  return {
    id: pollRow.id, question: pollRow.question,
    options, counts, total, status: pollRow.status, createdAt: pollRow.created_at
  };
}

function getActivePoll(room) {
  const row = db.prepare("SELECT * FROM polls WHERE room=? AND status IN ('open','closed') ORDER BY id DESC LIMIT 1").get(room);
  return getPollSummary(row);
}

function broadcastRoom(room, payload) {
  const set = roomSockets.get(room);
  if (!set || set.size === 0) return;
  const raw = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === 1 && ws.bufferedAmount < 65536) ws.send(raw);
  }
}

// Accurate viewer counts from authenticated WebSocket presence
function roomViewerCount(room) {
  const set = roomSockets.get(room);
  if (!set) return 0;
  let c = 0;
  for (const ws of set) if (ws.userRole === 'user' && ws.readyState === 1) c++;
  return c;
}
function totalViewerCount() {
  let c = 0;
  for (const room of roomSockets.keys()) c += roomViewerCount(room);
  return c;
}

// ---------- MediaMTX Radar ----------
let mtxState = {};
const isLive = (p) => p.ready === true || p.sourceReady === true;
const liveRoomPaths = () => Object.keys(mtxState).filter(k => mtxState[k].ready);

async function kickRoom(room) {
  const mtxPath = 'live/' + room;
  for (const kind of ['webrtcsessions', 'rtmpconns', 'rtspsessions', 'srtconns']) {
    try {
      const r = await fetch(`http://127.0.0.1:9997/v3/${kind}/list`);
      if (!r.ok) continue;
      for (const item of (await r.json()).items || [])
        if (item.path === mtxPath)
          await fetch(`http://127.0.0.1:9997/v3/${kind}/kick/${item.id}`, { method: 'POST' });
    } catch {}
  }
  // Also invalidate HLS viewer tokens for this room
  for (const [tok, info] of viewTokens) {
    if (info.room === room) { viewTokens.delete(tok); userViewToken.delete(info.userId); }
  }
}

const currentSlot = (subId) =>
  db.prepare('SELECT * FROM schedules WHERE subscriber_id=? AND starts_at-600<=? AND starts_at+minutes*60>?')
    .get(subId, now(), now());

function canStartStream(subId) {
  const room = 'live/' + roomOf(subId);
  const live = liveRoomPaths();
  if (live.includes(room))
    return { error: 'You are already live from another device. Stop that stream first.' };
  if (live.length >= settings.maxConcurrentStreams)
    return { error: 'All stream slots are busy right now.' };
  if (live.length > 0 && totalViewerCount() >= settings.extraStreamViewerThreshold)
    return { error: 'Server is under viewer load — simultaneous stream blocked.' };
  if (settings.requireSchedule && !currentSlot(subId))
    return { error: 'You have no booked slot right now. Book a slot in your dashboard first.' };
  return { ok: true };
}

// Poll MediaMTX & push live status + viewer count to connected rooms every 3s
setInterval(async () => {
  try {
    const r = await fetch('http://127.0.0.1:9997/v3/paths/list');
    if (r.ok) {
      const data = await r.json();
      const s = {};
      (data.items || []).forEach(p => { s[p.name] = { ready: isLive(p) }; });
      mtxState = s;
    }
  } catch {}

  for (const room of roomSockets.keys()) {
    broadcastRoom(room, {
      type: 'presence',
      live: !!mtxState['live/' + room]?.ready,
      viewers: roomViewerCount(room)
    });
  }

  if (settings.requireSchedule) {
    for (const path of liveRoomPaths()) {
      const subId = parseInt(path.replace('live/sub', ''));
      if (!subId) continue;
      const slot = db.prepare('SELECT 1 FROM schedules WHERE subscriber_id=? AND starts_at-600<=? AND starts_at+minutes*60+300>?')
        .get(subId, now(), now());
      if (!slot) { console.log(`SLOT ENDED: kicking room sub${subId}`); await kickRoom('sub' + subId); }
    }
  }

  const t = now();
  for (const [tok, info] of viewTokens) if (info.expiresAt < t) viewTokens.delete(tok);
  db.prepare('DELETE FROM tickets WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM sessions WHERE created_at < ?').run(t - 7 * 86400);
  db.prepare('DELETE FROM schedules WHERE starts_at < ?').run(t - 86400);
}, 3000);

// Throttled poll tally fan-out (max 2x/sec even if 1,000 viewers vote at once)
setInterval(() => {
  if (pollDirtyRooms.size === 0) return;
  for (const room of pollDirtyRooms) {
    const poll = getActivePoll(room);
    if (poll) broadcastRoom(room, { type: 'poll', poll });
  }
  pollDirtyRooms.clear();
}, 500);

// =====================================================
// HEALTH & AUTH
// =====================================================
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/login', async (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE username=?')
    .get(String(req.body.username || '').trim().toLowerCase());
  if (!u || !(await check(req.body.password || '', u.pass)))
    return res.status(401).json({ error: 'Invalid username or password' });
  if (u.status === 'pending') return res.status(403).json({ error: 'Awaiting approval. Contact admin to activate.' });
  if (u.status === 'suspended') return res.status(403).json({ error: 'Account suspended. Contact admin to renew.' });
  if (u.role === 'subscriber' && expired(u)) return res.status(403).json({ error: 'Subscription expired. Contact admin to renew.' });
  if (u.role === 'user') {
    const p = db.prepare('SELECT * FROM users WHERE id=?').get(u.parent_id);
    if (!subActive(p)) return res.status(403).json({ error: 'Your broadcaster\'s subscription is inactive.' });
  }

  // Enforce single active login per account (anti-sharing)
  revokeUserLiveAccess(u.id, 'Signed in on another device');
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  const sid = rnd(24);
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sid, u.id, now());
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`);
  res.json({ role: u.role });
});

app.post('/api/logout', auth(), (req, res) => {
  revokeUserLiveAccess(req.user.id, 'Logged out');
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.user.id);
  res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', auth(), (req, res) => {
  const { id, role, username, status, expires_at } = req.user;
  res.json({ id, role, username, status, expires_at });
});

app.post('/api/signup', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{3,30}$/.test(username)) return res.status(400).json({ error: 'Username: 3-30 chars (a-z 0-9 - _)' });
  if ((req.body.password || '').length < 6) return res.status(400).json({ error: 'Password: min 6 chars' });
  try {
    const ph = await hash(req.body.password);
    db.prepare("INSERT INTO users(role,username,pass,status,contact,created_at) VALUES('subscriber',?,?,'pending',?,?)")
      .run(username, ph, String(req.body.contact || '').slice(0, 100), now());
    res.json({ ok: true, message: 'Registered! Contact admin on WhatsApp/phone for activation.' });
  } catch { res.status(400).json({ error: 'Username already taken' }); }
});

// =====================================================
// ADMIN
// =====================================================
app.get('/api/admin/subscribers', auth('admin'), (req, res) => {
  const subs = db.prepare("SELECT id,username,status,expires_at,contact,created_at FROM users WHERE role='subscriber' ORDER BY id DESC").all();
  res.json({
    settings,
    totals: { liveStreams: liveRoomPaths().length, totalViewers: totalViewerCount() },
    subscribers: subs.map(s => {
      const room = roomOf(s.id);
      return {
        ...s, expired: expired(s),
        users: db.prepare('SELECT COUNT(*) c FROM users WHERE parent_id=?').get(s.id).c,
        live: !!mtxState['live/' + room]?.ready,
        viewers: roomViewerCount(room)
      };
    })
  });
});

const getSub = (id) => db.prepare("SELECT * FROM users WHERE id=? AND role='subscriber'").get(id);

app.post('/api/admin/subscribers/:id/approve', auth('admin'), (req, res) => {
  const days = parseInt(req.body.days) || 30;
  db.prepare("UPDATE users SET status='active', expires_at=? WHERE id=? AND role='subscriber'")
    .run(now() + days * 86400, req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/subscribers/:id/renew', auth('admin'), (req, res) => {
  const s = getSub(req.params.id); if (!s) return res.status(404).json({ error: 'Not found' });
  const days = parseInt(req.body.days) || 30;
  const base = Math.max(now(), s.expires_at || 0);
  db.prepare("UPDATE users SET status='active', expires_at=? WHERE id=?").run(base + days * 86400, s.id);
  res.json({ ok: true });
});

app.post('/api/admin/subscribers/:id/suspend', auth('admin'), async (req, res) => {
  const s = getSub(req.params.id); if (!s) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE users SET status='suspended' WHERE id=?").run(s.id);
  const childIds = db.prepare('SELECT id FROM users WHERE parent_id=?').all(s.id).map(x => x.id);
  [s.id, ...childIds].forEach(id => revokeUserLiveAccess(id, 'Broadcast suspended'));
  db.prepare("DELETE FROM sessions WHERE user_id=? OR user_id IN (SELECT id FROM users WHERE parent_id=?)").run(s.id, s.id);
  db.prepare('DELETE FROM schedules WHERE subscriber_id=?').run(s.id);
  await kickRoom(roomOf(s.id));
  res.json({ ok: true });
});

app.post('/api/admin/subscribers/:id/delete', auth('admin'), async (req, res) => {
  const s = getSub(req.params.id); if (!s) return res.status(404).json({ error: 'Not found' });
  const childIds = db.prepare('SELECT id FROM users WHERE parent_id=?').all(s.id).map(x => x.id);
  [s.id, ...childIds].forEach(id => revokeUserLiveAccess(id, 'Account deleted'));
  db.prepare("DELETE FROM sessions WHERE user_id=? OR user_id IN (SELECT id FROM users WHERE parent_id=?)").run(s.id, s.id);
  db.prepare('DELETE FROM users WHERE parent_id=?').run(s.id);
  db.prepare('DELETE FROM users WHERE id=?').run(s.id);
  db.prepare('DELETE FROM schedules WHERE subscriber_id=?').run(s.id);
  await kickRoom(roomOf(s.id));
  res.json({ ok: true });
});

app.post('/api/admin/kick/:id', auth('admin'), async (req, res) => {
  await kickRoom(roomOf(req.params.id));
  res.json({ ok: true });
});

app.post('/api/admin/settings', auth('admin'), (req, res) => {
  for (const k of Object.keys(settings)) {
    if (req.body[k] !== undefined) {
      settings[k] = parseInt(req.body[k]) || 0;
      saveSetting(k, settings[k]);
    }
  }
  res.json({ ok: true, settings });
});

// =====================================================
// SUBSCRIBER (BROADCASTER)
// =====================================================
app.get('/api/sub/me', auth('subscriber'), (req, res) => {
  const room = roomOf(req.user.id);
  res.json({
    id: req.user.id, room, username: req.user.username,
    status: req.user.status, expires_at: req.user.expires_at,
    active: subActive(req.user),
    live: !!mtxState['live/' + room]?.ready,
    viewers: roomViewerCount(room),
    requireSchedule: !!settings.requireSchedule,
    bookingsUsed: db.prepare('SELECT COUNT(*) c FROM schedules WHERE subscriber_id=? AND starts_at>?').get(req.user.id, now()).c,
    bookingsMax: settings.maxBookingsPerSub, maxSlotMinutes: settings.maxSlotMinutes
  });
});

app.get('/api/sub/users', auth('subscriber'), (req, res) => {
  res.json(db.prepare('SELECT id,username,status,created_at FROM users WHERE parent_id=? ORDER BY username').all(req.user.id));
});

async function addUser(subId, username, password) {
  username = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9_.@-]{3,50}$/.test(username)) return { error: 'bad username: ' + username };
  if (String(password || '').length < 4) return { error: 'password too short for: ' + username };
  try {
    const ph = await hash(String(password));
    db.prepare("INSERT INTO users(role,parent_id,username,pass,status,created_at) VALUES('user',?,?,?,'active',?)")
      .run(subId, username, ph, now());
    return { ok: true };
  } catch { return { error: 'username taken: ' + username }; }
}

app.post('/api/sub/users', auth('subscriber'), async (req, res) => {
  const r = await addUser(req.user.id, req.body.username, req.body.password);
  r.ok ? res.json(r) : res.status(400).json(r);
});

app.post('/api/sub/users/:id/delete', auth('subscriber'), (req, res) => {
  const uid = parseInt(req.params.id);
  const owned = db.prepare("SELECT id FROM users WHERE id=? AND parent_id=? AND role='user'").get(uid, req.user.id);
  if (!owned) return res.status(404).json({ error: 'Not found' });
  revokeUserLiveAccess(uid, 'Account deleted');
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(uid);
  db.prepare('DELETE FROM users WHERE id=?').run(uid);
  res.json({ ok: true });
});

app.post('/api/sub/users/:id/toggle', auth('subscriber'), (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=? AND parent_id=? AND role='user'").get(req.params.id, req.user.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const st = u.status === 'active' ? 'suspended' : 'active';
  db.prepare('UPDATE users SET status=? WHERE id=?').run(st, u.id);
  if (st === 'suspended') {
    revokeUserLiveAccess(u.id, 'Account suspended');
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  }
  res.json({ ok: true, status: st });
});

app.get('/api/sub/users.csv', auth('subscriber'), (req, res) => {
  const rows = db.prepare('SELECT username,status,created_at FROM users WHERE parent_id=?').all(req.user.id);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=users.csv');
  res.send('username,status,created\n' + rows.map(r =>
    `${r.username},${r.status},${new Date(r.created_at * 1000).toISOString().slice(0, 10)}`).join('\n'));
});

app.post('/api/sub/users/import', auth('subscriber'), async (req, res) => {
  const lines = String(req.body.csv || '').split(/\r?\n/).filter(l => l.trim()).slice(0, 2000);
  let added = 0; const errors = [];
  for (const line of lines) {
    if (/^username\s*,/i.test(line)) continue;
    const [u, p] = line.split(',').map(x => (x || '').trim());
    const r = await addUser(req.user.id, u, p);
    r.ok ? added++ : errors.push(r.error);
  }
  res.json({ added, errors });
});

// =====================================================
// SCHEDULER
// =====================================================
app.get('/api/sub/slots', auth('subscriber'), (req, res) => {
  const rows = db.prepare('SELECT id,subscriber_id,title,starts_at,minutes FROM schedules WHERE starts_at+minutes*60 > ? ORDER BY starts_at LIMIT 200').all(now());
  res.json(rows.map(r => ({
    id: r.subscriber_id === req.user.id ? r.id : null,
    starts_at: r.starts_at, minutes: r.minutes,
    mine: r.subscriber_id === req.user.id,
    title: r.subscriber_id === req.user.id ? r.title : 'Booked'
  })));
});

app.post('/api/sub/schedules', auth('subscriber'), (req, res) => {
  if (!subActive(req.user)) return res.status(403).json({ error: 'Subscription inactive' });
  const starts = parseInt(req.body.starts_at);
  const minutes = Math.min(Math.max(parseInt(req.body.minutes) || 60, 15), settings.maxSlotMinutes);
  if (!starts || !req.body.title) return res.status(400).json({ error: 'Title and start time required' });
  if (starts < now()) return res.status(400).json({ error: 'Slot is in the past' });

  const mine = db.prepare('SELECT COUNT(*) c FROM schedules WHERE subscriber_id=? AND starts_at>?').get(req.user.id, now()).c;
  if (mine >= settings.maxBookingsPerSub)
    return res.status(400).json({ error: `Booking limit reached (${settings.maxBookingsPerSub} upcoming).` });

  const ends = starts + minutes * 60;
  if (db.prepare('SELECT 1 FROM schedules WHERE subscriber_id=? AND starts_at<? AND starts_at+minutes*60>?').get(req.user.id, ends, starts))
    return res.status(400).json({ error: 'You already have an overlapping booking' });

  const clashes = db.prepare('SELECT COUNT(*) c FROM schedules WHERE starts_at<? AND starts_at+minutes*60>?').get(ends, starts).c;
  if (clashes >= settings.maxConcurrentStreams)
    return res.status(400).json({ error: 'Slot already booked.' });

  db.prepare('INSERT INTO schedules(subscriber_id,title,starts_at,minutes) VALUES(?,?,?,?)')
    .run(req.user.id, String(req.body.title).slice(0, 100), starts, minutes);
  res.json({ ok: true });
});

app.post('/api/sub/schedules/:id/delete', auth('subscriber'), (req, res) => {
  db.prepare('DELETE FROM schedules WHERE id=? AND subscriber_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// =====================================================
// CHAT MODERATION & LIVE POLLS (BROADCASTER)
// =====================================================
app.post('/api/room/settings', auth('subscriber'), (req, res) => {
  const room = roomOf(req.user.id);
  const cur = getRoomState(room);
  const chatEnabled = req.body.chatEnabled !== undefined ? (req.body.chatEnabled ? 1 : 0) : (cur.chatEnabled ? 1 : 0);
  const slowMode = req.body.slowMode !== undefined ? Math.max(0, Math.min(300, parseInt(req.body.slowMode) || 0)) : cur.slowMode;
  const pinnedMsg = req.body.pinnedMsg !== undefined ? String(req.body.pinnedMsg).trim().slice(0, 240) : cur.pinnedMsg;
  db.prepare('INSERT INTO room_state(room,chat_enabled,slow_mode,pinned_msg) VALUES(?,?,?,?) ON CONFLICT(room) DO UPDATE SET chat_enabled=?,slow_mode=?,pinned_msg=?')
    .run(room, chatEnabled, slowMode, pinnedMsg, chatEnabled, slowMode, pinnedMsg);
  const state = { chatEnabled: !!chatEnabled, slowMode, pinnedMsg };
  broadcastRoom(room, { type: 'room_state', state });
  res.json({ ok: true, state });
});

app.post('/api/room/chat/delete/:msgId', auth('subscriber'), (req, res) => {
  const room = roomOf(req.user.id);
  const id = parseInt(req.params.msgId);
  db.prepare('DELETE FROM chat_messages WHERE id=? AND room=?').run(id, room);
  broadcastRoom(room, { type: 'chat_delete', id });
  res.json({ ok: true });
});

app.post('/api/room/chat/clear', auth('subscriber'), (req, res) => {
  const room = roomOf(req.user.id);
  db.prepare('DELETE FROM chat_messages WHERE room=?').run(room);
  broadcastRoom(room, { type: 'chat_clear' });
  res.json({ ok: true });
});

app.post('/api/room/mute/:userId', auth('subscriber'), (req, res) => {
  const room = roomOf(req.user.id);
  const uid = parseInt(req.params.userId);
  if (!mutedUsers.has(room)) mutedUsers.set(room, new Set());
  const set = mutedUsers.get(room);
  const muted = req.body.muted !== undefined ? !!req.body.muted : !set.has(uid);
  muted ? set.add(uid) : set.delete(uid);
  const ws = userSocket.get(uid);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'muted', muted }));
  res.json({ ok: true, muted });
});

app.post('/api/room/kick-viewer/:userId', auth('subscriber'), (req, res) => {
  const uid = parseInt(req.params.userId);
  const u = db.prepare("SELECT id FROM users WHERE id=? AND parent_id=? AND role='user'").get(uid, req.user.id);
  if (!u) return res.status(404).json({ error: 'Viewer not found' });
  revokeUserLiveAccess(uid, 'Removed by broadcaster');
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(uid);
  res.json({ ok: true });
});

app.get('/api/room/polls', auth('subscriber'), (req, res) => {
  const room = roomOf(req.user.id);
  const rows = db.prepare('SELECT * FROM polls WHERE room=? ORDER BY id DESC LIMIT 20').all(room);
  res.json(rows.map(getPollSummary));
});

app.post('/api/room/polls', auth('subscriber'), (req, res) => {
  const room = roomOf(req.user.id);
  const question = String(req.body.question || '').trim().slice(0, 200);
  const options = (Array.isArray(req.body.options) ? req.body.options : [])
    .map(o => String(o || '').trim().slice(0, 80)).filter(Boolean).slice(0, 6);
  if (!question || options.length < 2)
    return res.status(400).json({ error: 'Provide a question and 2–6 options.' });

  // Archive any currently visible poll
  db.prepare("UPDATE polls SET status='archived' WHERE room=? AND status IN ('open','closed')").run(room);
  const info = db.prepare("INSERT INTO polls(room,question,options_json,status,created_at) VALUES(?,?,?,'open',?)")
    .run(room, question, JSON.stringify(options), now());
  const poll = getPollSummary(db.prepare('SELECT * FROM polls WHERE id=?').get(info.lastInsertRowid));
  broadcastRoom(room, { type: 'poll', poll });
  res.json({ ok: true, poll });
});

app.post('/api/room/polls/:id/close', auth('subscriber'), (req, res) => {
  const room = roomOf(req.user.id);
  db.prepare("UPDATE polls SET status='closed' WHERE id=? AND room=?").run(req.params.id, room);
  const poll = getPollSummary(db.prepare('SELECT * FROM polls WHERE id=? AND room=?').get(req.params.id, room));
  broadcastRoom(room, { type: 'poll', poll });
  res.json({ ok: true, poll });
});

app.post('/api/room/polls/:id/clear', auth('subscriber'), (req, res) => {
  const room = roomOf(req.user.id);
  db.prepare("UPDATE polls SET status='archived' WHERE id=? AND room=?").run(req.params.id, room);
  broadcastRoom(room, { type: 'poll', poll: null });
  res.json({ ok: true });
});

// =====================================================
// STREAM TICKETS (Publish: single-use | View: session-bound in RAM)
// =====================================================
app.post('/api/stream/pub-ticket', auth('subscriber'), (req, res) => {
  if (!subActive(req.user)) return res.status(403).json({ error: 'Subscription inactive' });
  const gate = canStartStream(req.user.id);
  if (gate.error) return res.status(403).json(gate);
  const room = roomOf(req.user.id);
  const ttl = Math.min(parseInt(req.body.ttl) || 30, 1800); // up to 30 min window for OBS setup
  const token = 'p_' + rnd(16);
  db.prepare('INSERT INTO tickets VALUES(?,?,?,?,?,0)').run(token, room, 'pub', req.user.id, now() + ttl);
  res.json({ room, token });
});

app.post('/api/stream/view-ticket', auth(), (req, res) => {
  const u = req.user;
  const subId = u.role === 'user' ? u.parent_id : u.role === 'subscriber' ? u.id : 0;
  if (!subId) return res.status(403).json({ error: 'No stream for this account' });
  const sub = db.prepare('SELECT * FROM users WHERE id=?').get(subId);
  if (!subActive(sub) || u.status !== 'active') return res.status(403).json({ error: 'Broadcast unavailable' });

  const room = roomOf(subId);
  const live = !!mtxState['live/' + room]?.ready;
  const next = db.prepare('SELECT title,starts_at,minutes FROM schedules WHERE subscriber_id=? AND starts_at+minutes*60 > ? ORDER BY starts_at LIMIT 1')
    .get(subId, now());
  if (!live) return res.json({ live: false, room, next, provider: sub.username });

  // Enforce capacity only for new viewers not already counted in room
  const alreadyConnected = userSocket.has(u.id);
  if (u.role === 'user' && !alreadyConnected) {
    if (roomViewerCount(room) >= settings.maxViewersPerRoom)
      return res.status(403).json({ error: 'This broadcast is at capacity' });
    if (totalViewerCount() >= settings.maxTotalViewers)
      return res.status(403).json({ error: 'Server is at full capacity, please try again shortly' });
  }

  // Reuse or create session-scoped HLS token (valid 6 hours; instantly revoked on logout/kick/2nd login)
  let token = userViewToken.get(u.id);
  const existing = token ? viewTokens.get(token) : null;
  if (!existing || existing.sid !== u.sid || existing.room !== room || existing.expiresAt < now() + 300) {
    if (token) viewTokens.delete(token);
    token = 'v_' + rnd(16);
    viewTokens.set(token, { userId: u.id, sid: u.sid, room, expiresAt: now() + 21600 });
    userViewToken.set(u.id, token);
  }
  res.json({ live: true, room, token, next, provider: sub.username });
});

// =====================================================
// MediaMTX AUTH WEBHOOK (Sub-millisecond RAM validation for HLS)
// =====================================================
app.post('/api/mtx/auth', (req, res) => {
  const { action, path: streamPath, query, password, token: bodyToken } = req.body || {};
  const q = new URLSearchParams(query || '');
  let t = bodyToken || password || q.get('token') || q.get('jwt') || '';
  t = String(t).replace(/^Bearer\s+/i, '').trim();

  const room = String(streamPath || '').replace(/^live\//, '');
  const kind = action === 'publish' ? 'pub' : action === 'read' ? 'view' : null;
  if (!kind || !t) return res.sendStatus(401);

  if (kind === 'view') {
    const entry = viewTokens.get(t);
    if (!entry || entry.room !== room || entry.expiresAt < now()) return res.sendStatus(401);
    return res.sendStatus(200);
  }

  // Publish auth (WHIP or RTMP) — single-use ticket checked in SQLite
  const row = db.prepare('SELECT * FROM tickets WHERE token=? AND room=? AND kind=? AND used=0 AND expires_at>?')
    .get(t, room, 'pub', now());
  if (!row) return res.sendStatus(401);
  db.prepare('UPDATE tickets SET used=1 WHERE token=?').run(t);

  const owner = db.prepare('SELECT * FROM users WHERE id=?').get(row.user_id);
  if (!owner || !subActive(owner)) return res.sendStatus(401);

  const others = liveRoomPaths().filter(p => p !== 'live/' + room);
  if (others.length >= settings.maxConcurrentStreams) return res.sendStatus(401);
  if (others.length > 0 && totalViewerCount() >= settings.extraStreamViewerThreshold) return res.sendStatus(401);
  return res.sendStatus(200);
});

// =====================================================
// WEBSOCKET SERVER (Chat, Polls, Real-Time Presence)
// =====================================================
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) { socket.destroy(); return; }
  const u = getUserBySid(parseSid(req.headers.cookie));
  if (!u || u.status !== 'active') { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }

  const subId = u.role === 'user' ? u.parent_id : u.role === 'subscriber' ? u.id : 0;
  if (!subId) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  const sub = db.prepare('SELECT * FROM users WHERE id=?').get(subId);
  if (!subActive(sub)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }

  const room = roomOf(subId);
  if (u.role === 'user' && !userSocket.has(u.id)) {
    if (roomViewerCount(room) >= settings.maxViewersPerRoom || totalViewerCount() >= settings.maxTotalViewers) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); return;
    }
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.userId = u.id;
    ws.username = u.username;
    ws.userRole = u.role;
    ws.room = room;
    ws.isAlive = true;
    wss.emit('connection', ws);
  });
});

wss.on('connection', (ws) => {
  const { userId, username, userRole, room } = ws;

  // Enforce 1 active WebSocket per user (only replace older socket for viewers)
  if (userRole === 'user') {
    const prev = userSocket.get(userId);
    if (prev && prev !== ws && prev.readyState === 1) {
      try { prev.send(JSON.stringify({ type: 'kicked', reason: 'Opened in another tab/device' })); } catch {}
      try { prev.close(4002, 'Replaced'); } catch {}
    }
    userSocket.set(userId, ws);
  }

  if (!roomSockets.has(room)) roomSockets.set(room, new Set());
  roomSockets.get(room).add(ws);

  // Send initial room snapshot
  const messages = db.prepare('SELECT id,user_id,username,role,text,created_at FROM chat_messages WHERE room=? ORDER BY id DESC LIMIT 100')
    .all(room).reverse();
  const activePoll = getActivePoll(room);
  let myVote = null;
  if (activePoll) {
    const v = db.prepare('SELECT option_idx FROM poll_votes WHERE poll_id=? AND user_id=?').get(activePoll.id, userId);
    if (v) myVote = v.option_idx;
  }
  const isMuted = mutedUsers.get(room)?.has(userId) || false;

  ws.send(JSON.stringify({
    type: 'init',
    room,
    live: !!mtxState['live/' + room]?.ready,
    viewers: roomViewerCount(room),
    state: getRoomState(room),
    muted: isMuted,
    messages,
    activePoll,
    myVote
  }));

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // --- Chat Message ---
    if (msg.type === 'chat') {
      const text = String(msg.text || '').trim().slice(0, 400);
      if (!text) return;
      const isHost = userRole === 'subscriber' || userRole === 'admin';
      const st = getRoomState(room);

      if (!isHost) {
        if (!st.chatEnabled) { ws.send(JSON.stringify({ type: 'err', message: 'Chat is currently disabled by host.' })); return; }
        if (mutedUsers.get(room)?.has(userId)) { ws.send(JSON.stringify({ type: 'err', message: 'You are muted in this chat.' })); return; }
        const cooldownMs = Math.max(1500, st.slowMode * 1000);
        const last = lastChatAt.get(userId) || 0;
        const wait = cooldownMs - (Date.now() - last);
        if (wait > 0) {
          ws.send(JSON.stringify({ type: 'err', message: `Slow mode: wait ${Math.ceil(wait / 1000)}s.` }));
          return;
        }
        lastChatAt.set(userId, Date.now());
      }

      const ts = now();
      const info = db.prepare('INSERT INTO chat_messages(room,user_id,username,role,text,created_at) VALUES(?,?,?,?,?,?)')
        .run(room, userId, username, userRole, text, ts);
      broadcastRoom(room, {
        type: 'chat',
        msg: { id: info.lastInsertRowid, user_id: userId, username, role: userRole, text, created_at: ts }
      });
      return;
    }

    // --- Poll Vote ---
    if (msg.type === 'vote') {
      const pollId = parseInt(msg.pollId);
      const optionIdx = parseInt(msg.optionIdx);
      const poll = db.prepare("SELECT * FROM polls WHERE id=? AND room=? AND status='open'").get(pollId, room);
      if (!poll) return;
      const opts = JSON.parse(poll.options_json);
      if (isNaN(optionIdx) || optionIdx < 0 || optionIdx >= opts.length) return;
      try {
        db.prepare('INSERT INTO poll_votes(poll_id,user_id,option_idx) VALUES(?,?,?)').run(pollId, userId, optionIdx);
        ws.send(JSON.stringify({ type: 'vote_ok', pollId, optionIdx }));
        pollDirtyRooms.add(room);
      } catch {
        // Already voted (PRIMARY KEY conflict)
        ws.send(JSON.stringify({ type: 'err', message: 'You already voted on this poll.' }));
      }
    }
  });

  ws.on('close', () => {
    roomSockets.get(room)?.delete(ws);
    if (userSocket.get(userId) === ws) userSocket.delete(userId);
  });
});

// Dead WebSocket reaper (every 30s)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`saasLiveStream-1K backend running on :${PORT}`));
