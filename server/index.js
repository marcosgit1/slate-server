'use strict';
/**
 * Slate server — accounts, messaging, presence, groups, moderation.
 * Zero npm dependencies: plain Node http + JSON file storage.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const MAX_BODY = 12 * 1024 * 1024; // 12 MB (base64 media)
const ONLINE_MS = 50000;           // a client is "online" for 50s after its last sync
const MOD_RE = /^(1|mod([1-9]|1[0-9]|20))$/i;

fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ---------------------------------------------------------------- state

function emptyState() {
  return {
    users: {}, messages: [], reports: [], groups: {}, seq: 0, gid: 0, rid: 0, mid: 0, typing: {},
    epoch: crypto.randomBytes(6).toString('hex')
  };
}

let S = emptyState();
try {
  if (fs.existsSync(STATE_FILE)) {
    S = Object.assign(emptyState(), JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
  }
} catch (e) {
  console.error('could not load state, starting fresh:', e.message);
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(S));
      fs.renameSync(tmp, STATE_FILE);
    } catch (e) {
      console.error('save failed:', e.message);
    }
  }, 250);
}

const now = () => Date.now();
const key = (u) => String(u || '').trim().toLowerCase();
const isModName = (u) => MOD_RE.test(String(u || '').trim());
const tokenOf = () => crypto.randomBytes(24).toString('hex');

function hashPassword(pass, salt) {
  return crypto.scryptSync(String(pass || ''), salt, 32).toString('hex');
}

function publicUser(u) {
  if (!u) return null;
  return {
    username: u.u,
    display: u.display || u.u,
    bio: u.bio || '',
    avatar: u.avatar || '',
    mod: !!u.mod,
    online: !!u.online && now() - (u.lastSeen || 0) < ONLINE_MS,
    lastSeen: u.lastSeen || 0,
    banned: !!u.banned && (!u.bannedUntil || u.bannedUntil > now()),
    bannedUntil: u.bannedUntil || 0,
    banReason: u.banReason || ''
  };
}

function refreshOnline(u) {
  if (u.banned) u.online = false;
  else u.online = now() - (u.lastSeen || 0) < ONLINE_MS;
  return u;
}

function bannedNow(u) {
  if (!u || !u.banned) return false;
  if (u.bannedUntil && u.bannedUntil <= now()) {
    u.banned = false;
    u.bannedUntil = 0;
    u.banReason = '';
    save();
    return false;
  }
  return true;
}

// ---------------------------------------------------------------- helpers

class ApiError extends Error {
  constructor(code, message, extra) {
    super(message || code);
    this.code = code;
    this.extra = extra || {};
  }
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization,content-type',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ApiError('TOO_LARGE', 'Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new ApiError('BAD_JSON', 'Malformed JSON'));
      }
    });
    req.on('error', reject);
  });
}

function bearer(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : (req.headers['x-slate-token'] || '').trim();
}

function userByToken(token) {
  if (!token) return null;
  for (const k of Object.keys(S.users)) {
    if (S.users[k].token && S.users[k].token === token) return S.users[k];
  }
  return null;
}

function auth(req) {
  const u = userByToken(bearer(req));
  if (!u) throw new ApiError('UNAUTHORIZED', 'Not signed in');
  u.lastSeen = now();
  return u;
}

function authActive(req) {
  const u = auth(req);
  if (bannedNow(u)) {
    throw new ApiError('BANNED', u.banReason || 'Account suspended', {
      reason: u.banReason || 'Account suspended',
      until: u.bannedUntil || 0
    });
  }
  return u;
}

function validateUsername(u) {
  if (!u || u.length < 2) throw new ApiError('USERNAME_INVALID', 'Username is too short');
  if (u.length > 20) throw new ApiError('USERNAME_INVALID', 'Username is too long');
  if (!/^[A-Za-z0-9._]+$/.test(u)) throw new ApiError('USERNAME_INVALID', 'Only letters, numbers, dot and underscore');
  if (u.toLowerCase() === 'slatebot') throw new ApiError('USERNAME_RESERVED', 'That username is reserved');
}

function mediaUrl(req, name) {
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers['host'];
  const base = process.env.PUBLIC_URL || `${proto}://${host}`;
  return `${base.replace(/\/$/, '')}/media/${name}`;
}

function groupKeyOf(gid) {
  return 'g:' + gid;
}

function groupMembers(g) {
  return (g.members || []).map((m) => m.u);
}

function isGroupMember(g, username) {
  return groupMembers(g).some((m) => m.toLowerCase() === key(username));
}

function memberOf(g, username) {
  return (g.members || []).find((m) => m.u.toLowerCase() === key(username)) || null;
}

function roleOf(g, member) {
  if (!member || !member.role) return null;
  return (g.roles || []).find((r) => r.id === member.role) || null;
}

function canGroup(g, username, perm) {
  const m = memberOf(g, username);
  if (!m) return false;
  if (g.owner.toLowerCase() === key(username)) return true;
  const role = roleOf(g, m);
  if (!role) return false;
  if (role.full) return true;
  return (role.perms & perm) !== 0;
}

function publicGroup(g) {
  return {
    gid: g.gid,
    name: g.name || 'Group',
    bio: g.bio || '',
    photo: g.photo || '',
    owner: g.owner,
    created: g.created || 0,
    members: (g.members || []).map((m) => {
      const u = S.users[key(m.u)];
      return {
        username: m.u,
        display: u ? (u.display || u.u) : m.u,
        avatar: u ? (u.avatar || '') : '',
        role: m.role || 0,
        joined: m.joined || 0,
        online: u ? refreshOnline(u).online : false,
        lastSeen: u ? (u.lastSeen || 0) : 0
      };
    }),
    roles: (g.roles || []).slice()
  };
}

function publicMessage(m) {
  return {
    id: m.id,
    seq: m.seq,
    from: m.from,
    to: m.to,
    body: m.body || '',
    type: m.type || 0,
    media: m.media || '',
    dur: m.dur || 0,
    ts: m.ts
  };
}

function conversationsOf(username) {
  const me = key(username);
  const peers = new Set();
  for (const m of S.messages) {
    const from = key(m.from);
    const to = key(m.to);
    if (from === me) peers.add(to);
    else if (to === me) peers.add(from);
    else if (m.to.startsWith('g:')) {
      const g = S.groups[m.to.slice(2)];
      if (g && isGroupMember(g, username)) peers.add(to);
    }
  }
  const groups = Object.values(S.groups).filter((g) => isGroupMember(g, username));
  return { peers, groups };
}

// ---------------------------------------------------------------- actions

function register(req, body) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  validateUsername(username);
  if (password.length > 128) throw new ApiError('PASSWORD_INVALID', 'Password is too long');
  const k = key(username);
  if (S.users[k]) throw new ApiError('USERNAME_TAKEN', 'That username is taken');
  const salt = crypto.randomBytes(16).toString('hex');
  const u = {
    u: username,
    display: String(body.display || '').trim().slice(0, 40) || username,
    bio: '',
    avatar: '',
    salt,
    hash: hashPassword(password, salt),
    token: tokenOf(),
    created: now(),
    lastSeen: now(),
    online: true,
    mod: isModName(username),
    banned: false,
    bannedUntil: 0,
    banReason: '',
    bannedBy: '',
    readMarks: {}
  };
  S.users[k] = u;
  save();
  return { token: u.token, user: publicUser(u) };
}

function login(body) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const u = S.users[key(username)];
  if (!u) throw new ApiError('NO_ACCOUNT', 'No account with that username');
  const hash = hashPassword(password, u.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(u.hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ApiError('BAD_PASSWORD', 'Wrong password');
  }
  if (bannedNow(u)) {
    throw new ApiError('BANNED', u.banReason || 'Account suspended', {
      reason: u.banReason || 'Account suspended',
      until: u.bannedUntil || 0
    });
  }
  u.token = u.token || tokenOf();
  u.lastSeen = now();
  u.online = true;
  save();
  return { token: u.token, user: publicUser(u) };
}

function sendMessage(req, u, body) {
  const to = String(body.to || '').trim();
  if (!to) throw new ApiError('NO_RECIPIENT', 'Missing recipient');
  const clientId = String(body.clientId || '');
  // Idempotent retries: same clientId from the same sender returns the same message.
  if (clientId) {
    const dup = S.messages.find((m) => m.from === u.u && m.clientId === clientId && m.clientId);
    if (dup) return { id: dup.id, seq: dup.seq, ts: dup.ts };
  }
  let target = null;
  if (to.startsWith('g:')) {
    const g = S.groups[to.slice(2)];
    if (!g) throw new ApiError('NO_GROUP', 'Group not found');
    if (!isGroupMember(g, u.u)) throw new ApiError('NOT_MEMBER', 'You are not in this group');
    target = g;
  } else {
    const peer = S.users[key(to)];
    if (!peer) throw new ApiError('NO_USER', 'No such user');
    if (bannedNow(peer)) throw new ApiError('PEER_BANNED', 'That account is suspended');
  }
  const type = Math.max(0, Math.min(2, parseInt(body.type || 0, 10) || 0));
  const msg = {
    id: ++S.mid,
    seq: ++S.seq,
    from: u.u,
    to: target ? groupKeyOf(target.gid) : to,
    body: String(body.body || '').slice(0, 8000),
    type,
    media: String(body.media || '').slice(0, 500),
    dur: Math.max(0, parseInt(body.dur || 0, 10) || 0),
    ts: now(),
    clientId: clientId || undefined
  };
  S.messages.push(msg);
  save();
  return { id: msg.id, seq: msg.seq, ts: msg.ts };
}

function markRead(u, peer) {
  const p = String(peer || '').trim();
  if (!p) throw new ApiError('NO_PEER', 'Missing peer');
  if (p.startsWith('g:')) {
    const g = S.groups[p.slice(2)];
    if (!g || !isGroupMember(g, u.u)) throw new ApiError('NOT_MEMBER', 'You are not in this group');
  }
  // Remember the wall-clock time up to which this user has read the peer's messages.
  // The peer's own messages carry their send timestamp, so the sender can mark
  // everything older than readTs as read.
  const pk = key(p);
  u.readMarks[pk] = Math.max(u.readMarks[pk] || 0, now());
  save();
  return { peer: p, readTs: u.readMarks[pk] };
}

function sync(req, u, query) {
  const since = parseInt(query.get('since') || '0', 10) || 0;
  refreshOnline(u);
  const { peers, groups } = conversationsOf(u.u);
  const me = key(u.u);

  const messages = [];
  for (const m of S.messages) {
    if (m.seq <= since) continue;
    const toMe = key(m.to) === me;
    const fromMe = key(m.from) === me;
    let groupMine = false;
    if (m.to.startsWith('g:')) {
      const g = S.groups[m.to.slice(2)];
      groupMine = !!g && isGroupMember(g, u.u);
    }
    if (!toMe && !groupMine && !fromMe) continue;
    if (fromMe) continue; // my own messages are already local
    messages.push(publicMessage(m));
  }

  // Which of my own messages has the other side read? Clock-independent: compare
  // message timestamps with the reader's read timestamp on the server.
  const reads = [];
  for (const m of S.messages) {
    if (key(m.from) !== me || !m.clientId) continue;
    let read = false;
    if (m.to.startsWith('g:')) {
      const g = S.groups[m.to.slice(2)];
      if (g) {
        const others = g.members.filter((x) => key(x.u) !== me);
        read = others.length > 0 && others.every((x) => {
          const ou = S.users[key(x.u)];
          return ou && ((ou.readMarks || {})[key(m.to)] || 0) >= m.ts;
        });
      }
    } else {
      const other = S.users[key(m.to)];
      read = !!other && ((other.readMarks || {})[me] || 0) >= m.ts;
    }
    if (read) reads.push({ clientId: m.clientId, peer: m.to, read: true });
  }

  const receipts = [];
  for (const p of peers) {
    if (p.startsWith('g:')) continue;
    const other = S.users[p];
    if (!other) continue;
    const readTs = (other.readMarks || {})[me] || 0;
    if (readTs) receipts.push({ peer: other.u, readTs });
  }

  const typing = [];
  for (const [from, t] of Object.entries(S.typing)) {
    if (t.until < now()) continue;
    if (key(from) === me) continue;
    if (key(t.to) === me || (t.to.startsWith('g:') && groups.some((g) => groupKeyOf(g.gid) === t.to))) {
      typing.push({ from, typing: t.on !== false, to: t.to });
    }
  }

  const users = [];
  for (const other of Object.values(S.users)) {
    if (other === u) continue;
    users.push(publicUser(refreshOnline(other)));
  }

  return {
    seq: S.seq,
    epoch: S.epoch,
    me: publicUser(u),
    messages,
    reads,
    receipts,
    typing,
    users,
    groups: groups.map(publicGroup),
    serverTime: now()
  };
}

function createGroup(u, body) {
  const name = String(body.name || '').trim().slice(0, 60) || 'Group';
  const members = Array.isArray(body.members) ? body.members.map((m) => String(m).trim()).filter(Boolean) : [];
  const gid = String(++S.gid);
  const g = {
    gid,
    name,
    bio: '',
    photo: '',
    owner: u.u,
    created: now(),
    members: [{ u: u.u, role: 0, joined: now() }],
    roles: []
  };
  for (const m of members) {
    if (key(m) === key(u.u)) continue;
    const other = S.users[key(m)];
    if (!other) continue;
    g.members.push({ u: other.u, role: 0, joined: now() });
  }
  S.groups[gid] = g;
  save();
  return { group: publicGroup(g) };
}

function groupAction(req, u, gid, action, body) {
  const g = S.groups[String(gid)];
  if (!g) throw new ApiError('NO_GROUP', 'Group not found');
  if (!isGroupMember(g, u.u)) throw new ApiError('NOT_MEMBER', 'You are not in this group');
  if (action === 'members') {
    if (!canGroup(g, u.u, 1 | 2)) throw new ApiError('FORBIDDEN', 'You cannot manage members');
    const username = String(body.username || '').trim();
    const other = S.users[key(username)];
    if (body.remove) {
      if (key(username) === key(g.owner)) throw new ApiError('FORBIDDEN', 'The owner cannot be removed');
      g.members = g.members.filter((m) => key(m.u) !== key(username));
    } else {
      if (!other) throw new ApiError('NO_USER', 'No such user');
      if (!memberOf(g, username)) g.members.push({ u: other.u, role: 0, joined: now() });
    }
    save();
    return { group: publicGroup(g) };
  }
  if (action === 'info') {
    if (!canGroup(g, u.u, 4)) throw new ApiError('FORBIDDEN', 'You cannot edit this group');
    if (typeof body.name === 'string' && body.name.trim()) g.name = body.name.trim().slice(0, 60);
    if (typeof body.bio === 'string') g.bio = body.bio.slice(0, 300);
    if (typeof body.photo === 'string') g.photo = body.photo.slice(0, 500);
    save();
    return { group: publicGroup(g) };
  }
  if (action === 'role') {
    if (!canGroup(g, u.u, 8)) throw new ApiError('FORBIDDEN', 'You cannot manage roles');
    const op = String(body.op || 'add');
    if (op === 'add') {
      const id = (g.roles.reduce((mx, r) => Math.max(mx, r.id), 0) || 0) + 1;
      g.roles.push({
        id,
        name: String(body.name || 'Role').slice(0, 40),
        color: parseInt(body.color || 0, 10) || 0,
        perms: parseInt(body.perms || 0, 10) || 0,
        full: !!body.full
      });
    } else if (op === 'update') {
      const r = g.roles.find((x) => x.id === parseInt(body.id, 10));
      if (r) {
        if (typeof body.name === 'string') r.name = body.name.slice(0, 40);
        if (body.color != null) r.color = parseInt(body.color, 10) || 0;
        if (body.perms != null) r.perms = parseInt(body.perms, 10) || 0;
        if (body.full != null) r.full = !!body.full;
      }
    } else if (op === 'delete') {
      const id = parseInt(body.id, 10);
      g.roles = g.roles.filter((x) => x.id !== id);
      g.members.forEach((m) => { if (m.role === id) m.role = 0; });
    } else if (op === 'assign') {
      const m = memberOf(g, body.username);
      if (m) m.role = parseInt(body.id, 10) || 0;
    }
    save();
    return { group: publicGroup(g) };
  }
  if (action === 'leave') {
    if (key(g.owner) === key(u.u)) {
      throw new ApiError('OWNER_LEAVE', 'Transfer or delete the group first');
    }
    g.members = g.members.filter((m) => key(m.u) !== key(u.u));
    save();
    return { ok: true };
  }
  if (action === 'delete') {
    if (key(g.owner) !== key(u.u)) throw new ApiError('FORBIDDEN', 'Only the owner can delete');
    delete S.groups[String(gid)];
    save();
    return { ok: true };
  }
  throw new ApiError('BAD_ACTION', 'Unknown group action');
}

function addReport(u, body) {
  const target = String(body.target || '').trim();
  if (!target) throw new ApiError('NO_TARGET', 'Missing target');
  const r = {
    id: ++S.rid,
    reporter: u.u,
    target,
    reason: String(body.reason || 'other').slice(0, 60),
    descr: String(body.descr || '').slice(0, 2000),
    snapshot: String(body.snapshot || '').slice(0, 4000),
    ts: now(),
    status: 'open'
  };
  S.reports.push(r);
  save();
  return { id: r.id };
}

function modOnly(u) {
  if (!u.mod) throw new ApiError('FORBIDDEN', 'Moderators only');
}

function modBan(u, body) {
  modOnly(u);
  const target = S.users[key(body.user)];
  if (!target) throw new ApiError('NO_USER', 'No such user');
  if (target.mod && !u.mod) throw new ApiError('FORBIDDEN', 'Cannot ban a moderator');
  if (key(target.u) === key(u.u)) throw new ApiError('FORBIDDEN', 'Cannot ban yourself');
  const until = parseInt(body.until || 0, 10) || 0;
  target.banned = true;
  target.bannedUntil = until;
  target.banReason = String(body.reason || 'Community guidelines').slice(0, 200);
  target.bannedBy = u.u;
  target.online = false;
  save();
  return { user: publicUser(target) };
}

function modUnban(u, body) {
  modOnly(u);
  const target = S.users[key(body.user)];
  if (!target) throw new ApiError('NO_USER', 'No such user');
  target.banned = false;
  target.bannedUntil = 0;
  target.banReason = '';
  target.bannedBy = '';
  save();
  return { user: publicUser(target) };
}

function upload(req, u, body) {
  const data = String(body.data || '');
  if (!data) throw new ApiError('NO_DATA', 'Missing image data');
  const m = /^data:([^;]+);base64,(.*)$/.exec(data);
  const raw = m ? m[2] : data;
  const mime = (m ? m[1] : (body.mime || 'image/jpeg')).toLowerCase();
  let buf;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch (e) {
    throw new ApiError('BAD_DATA', 'Invalid image data');
  }
  if (!buf.length) throw new ApiError('BAD_DATA', 'Empty upload');
  if (buf.length > 8 * 1024 * 1024) throw new ApiError('TOO_LARGE', 'Image is too large (8 MB max)');
  const ext = mime.includes('png') ? '.png' : mime.includes('webm') ? '.webm' : mime.includes('aac') ? '.aac'
    : mime.includes('mpeg') ? '.m4a'
    : mime.includes('audio') ? '.m4a' : '.jpg';
  const name = crypto.randomBytes(10).toString('hex') + ext;
  fs.writeFileSync(path.join(MEDIA_DIR, name), buf);
  return { url: mediaUrl(req, name) };
}

// ---------------------------------------------------------------- router

const routes = {
  'POST /api/register': async (req, res, _q, body) => send(res, 200, register(req, body)),
  'POST /api/login': async (req, res, _q, body) => send(res, 200, login(body)),
  'POST /api/logout': async (req, res) => {
    const u = userByToken(bearer(req));
    if (u) { u.token = null; save(); }
    send(res, 200, { ok: true });
  },
  'GET /health': async (req, res) => send(res, 200, { ok: true, service: 'slate', time: now() }),
  'GET /api/me': async (req, res) => {
    const u = auth(req);
    send(res, 200, { user: publicUser(bannedNow(u) ? u : refreshOnline(u)) });
  },
  'POST /api/profile': async (req, res, _q, body) => {
    const u = authActive(req);
    if (typeof body.display === 'string') u.display = body.display.trim().slice(0, 40) || u.u;
    if (typeof body.bio === 'string') u.bio = body.bio.slice(0, 300);
    if (typeof body.avatar === 'string') u.avatar = body.avatar.slice(0, 500);
    save();
    send(res, 200, { user: publicUser(u) });
  },
  'GET /api/users': async (req, res, query) => {
    auth(req);
    const q = key(query.get('q') || '');
    const exact = query.get('u');
    let list = Object.values(S.users).map((x) => publicUser(refreshOnline(x)));
    if (exact != null) return send(res, 200, { found: !!S.users[key(exact)], user: S.users[key(exact)] ? list.find((x) => key(x.username) === key(exact)) : null });
    if (q) list = list.filter((x) => key(x.username).includes(q) || key(x.display).includes(q));
    list.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
    send(res, 200, { users: list.slice(0, 30) });
  },
  'GET /api/sync': async (req, res, query) => {
    const u = auth(req);
    send(res, 200, sync(req, u, query));
  },
  'POST /api/send': async (req, res, _q, body) => {
    const u = authActive(req);
    send(res, 200, sendMessage(req, u, body));
  },
  'POST /api/typing': async (req, res, _q, body) => {
    const u = auth(req);
    const to = String(body.to || '').trim();
    if (!to) return send(res, 200, { ok: true });
    const on = body.typing !== false;
    // Keep the "stopped" state briefly so clients that poll every few seconds
    // actually see the indicator turn off.
    S.typing[key(u.u)] = { to, until: now() + (on ? 6000 : 12000), on };
    send(res, 200, { ok: true });
  },
  'POST /api/read': async (req, res, _q, body) => {
    const u = auth(req);
    send(res, 200, markRead(u, body.peer));
  },
  'POST /api/upload': async (req, res, _q, body) => {
    const u = authActive(req);
    send(res, 200, upload(req, u, body));
  },
  'POST /api/groups': async (req, res, _q, body) => {
    const u = authActive(req);
    send(res, 200, createGroup(u, body));
  },
  'POST /api/report': async (req, res, _q, body) => {
    const u = authActive(req);
    send(res, 200, addReport(u, body));
  },
  'GET /api/mod/reports': async (req, res) => {
    const u = authActive(req);
    modOnly(u);
    send(res, 200, { reports: S.reports.filter((r) => r.status === 'open').sort((a, b) => b.ts - a.ts).slice(0, 100) });
  },
  'POST /api/mod/report': async (req, res, _q, body) => {
    const u = authActive(req);
    modOnly(u);
    const r = S.reports.find((x) => x.id === parseInt(body.id, 10));
    if (r) r.status = String(body.status || 'dismissed');
    save();
    send(res, 200, { ok: true });
  },
  'POST /api/mod/ban': async (req, res, _q, body) => {
    const u = authActive(req);
    send(res, 200, modBan(u, body));
  },
  'POST /api/admin/grant': async (req, res, _q, body) => {
    const key = process.env.ADMIN_KEY || '';
    if (!key || req.headers['x-admin-key'] !== key) throw new ApiError('FORBIDDEN', 'Admin key required');
    const target = S.users[String(body.user || '').trim().toLowerCase()];
    if (!target) throw new ApiError('NO_USER', 'No such user');
    target.mod = body.mod !== false;
    save();
    send(res, 200, { user: publicUser(target) });
  },
  'POST /api/mod/unban': async (req, res, _q, body) => {
    const u = authActive(req);
    send(res, 200, modUnban(u, body));
  }
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization,content-type',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS'
    });
    return res.end();
  }

  // static media
  if (req.method === 'GET' && p.startsWith('/media/')) {
    const name = path.basename(p.slice('/media/'.length));
    const file = path.join(MEDIA_DIR, name);
    if (!fs.existsSync(file)) return send(res, 404, { error: 'NOT_FOUND' });
    const ext = path.extname(name).toLowerCase();
    const type = ext === '.png' ? 'image/png' : ext === '.webm' ? 'audio/webm'
      : ext === '.m4a' ? 'audio/mp4' : ext === '.aac' ? 'audio/aac' : 'image/jpeg';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=604800' });
    return fs.createReadStream(file).pipe(res);
  }

  // group actions: /api/groups/<gid>/<action>
  const gm = /^\/api\/groups\/([^/]+)\/([a-z]+)$/.exec(p);
  if (gm && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const u = authActive(req);
      return send(res, 200, groupAction(req, u, decodeURIComponent(gm[1]), gm[2], body));
    } catch (e) {
      return fail(res, e);
    }
  }

  const handler = routes[`${req.method} ${p}`];
  if (!handler) return send(res, 404, { error: 'NOT_FOUND', path: p });

  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    await handler(req, res, url.searchParams, body);
  } catch (e) {
    fail(res, e);
  }
});

function fail(res, e) {
  if (e instanceof ApiError) {
    return send(res, e.code === 'UNAUTHORIZED' ? 401 : e.code === 'FORBIDDEN' ? 403
      : e.code === 'BANNED' ? 403 : e.code === 'TOO_LARGE' ? 413 : 400,
      Object.assign({ error: e.code, message: e.message }, e.extra));
  }
  console.error('unhandled:', e);
  send(res, 500, { error: 'SERVER_ERROR', message: 'Something went wrong' });
}

// keep presence fresh and expire bans
setInterval(() => {
  let dirty = false;
  for (const u of Object.values(S.users)) {
    const was = !!u.online;
    refreshOnline(u);
    if (was !== !!u.online) dirty = true;
    if (u.banned && u.bannedUntil && u.bannedUntil <= now()) {
      bannedNow(u);
      dirty = true;
    }
  }
  for (const [who, t] of Object.entries(S.typing)) {
    if (t.until >= now()) continue;
    if (t.on) {
      t.on = false;
      t.until = now() + 12000;
      dirty = true;
    } else {
      delete S.typing[who];
      dirty = true;
    }
  }
  if (dirty) save();
}, 15000);

server.listen(PORT, () => {
  console.log(`Slate server listening on :${PORT} (data: ${DATA_DIR})`);
});

module.exports = server;
