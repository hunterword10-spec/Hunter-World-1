'use strict';
/* =========================================================================
   HUNTER WORLD — SERVIDOR ONLINE
   - Contas (cadastro/login com scrypt + sessões por token)
   - Personagem único por conta, nome único (sem duplicação)
   - Tempo real por WebSocket: presença, posições, chat, grupos, guildas
   - Instâncias de dungeon por grupo, com recompensa deduplicada
   - Ranking global calculado no servidor (sem bots)
   - Administração restrita ao criador (role=owner)
   - Persistência em SQLite (node:sqlite), sem dependências além de "ws"
   ========================================================================= */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'hunter.db');
const OWNER_KEY = process.env.OWNER_KEY || '';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_LEVEL = 150;
const SESSION_DAYS = 30;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS accounts(
  id TEXT PRIMARY KEY, user TEXT UNIQUE NOT NULL, pass TEXT NOT NULL, salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'player', banned INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL, last_login INTEGER
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, account_id TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS characters(
  account_id TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  cls TEXT NOT NULL, lv INTEGER NOT NULL, xp_total INTEGER NOT NULL, coins INTEGER NOT NULL,
  crystals INTEGER NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS guilds(
  id TEXT PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE, tag TEXT UNIQUE COLLATE NOCASE,
  leader TEXT NOT NULL, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS guild_members(guild_id TEXT NOT NULL, account_id TEXT PRIMARY KEY, joined INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS chat(id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, from_id TEXT, from_name TEXT, text TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS gifts(id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, payload TEXT NOT NULL, claimed INTEGER DEFAULT 0, created INTEGER);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT, action TEXT, target TEXT, detail TEXT, ts INTEGER);
CREATE INDEX IF NOT EXISTS idx_char_lv ON characters(lv DESC);
`);

/* ------------------------------ utilidades ------------------------------ */
const now = () => Date.now();
const rid = (n = 12) => crypto.randomBytes(n).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hashPass = (pass, salt) => crypto.scryptSync(String(pass), salt, 64).toString('hex');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const int = (v, d = 0) => (Number.isFinite(+v) ? Math.trunc(+v) : d);
const need = (l) => Math.floor(12 * Math.pow(l, 1.5) + 10);
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function totalXpFor(lv, xp) {
  let t = 0;
  for (let i = 1; i < lv; i++) t += need(i);
  return t + Math.max(0, xp);
}
function levelFromTotal(total) {
  let lv = 1, left = Math.max(0, total);
  while (lv < MAX_LEVEL && left >= need(lv)) { left -= need(lv); lv++; }
  return { lv, xp: Math.floor(left) };
}

/* ------------------------------ contas ---------------------------------- */
const q = {
  accByUser: db.prepare('SELECT * FROM accounts WHERE user = ? COLLATE NOCASE'),
  accById: db.prepare('SELECT * FROM accounts WHERE id = ?'),
  insAcc: db.prepare('INSERT INTO accounts(id,user,pass,salt,role,created) VALUES(?,?,?,?,?,?)'),
  touchLogin: db.prepare('UPDATE accounts SET last_login = ? WHERE id = ?'),
  insSession: db.prepare('INSERT INTO sessions(token,account_id,created,expires) VALUES(?,?,?,?)'),
  getSession: db.prepare('SELECT * FROM sessions WHERE token = ?'),
  delSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  delSessionsOf: db.prepare('DELETE FROM sessions WHERE account_id = ?'),
  charByAcc: db.prepare('SELECT * FROM characters WHERE account_id = ?'),
  charByName: db.prepare('SELECT * FROM characters WHERE name = ? COLLATE NOCASE'),
  charById: db.prepare('SELECT * FROM characters WHERE id = ?'),
  insChar: db.prepare('INSERT INTO characters(account_id,id,name,cls,lv,xp_total,coins,crystals,data,updated) VALUES(?,?,?,?,?,?,?,?,?,?)'),
  updChar: db.prepare('UPDATE characters SET name=?,cls=?,lv=?,xp_total=?,coins=?,crystals=?,data=?,updated=? WHERE account_id=?'),
  topByLevel: db.prepare('SELECT * FROM characters ORDER BY lv DESC, coins DESC LIMIT 50'),
  allChars: db.prepare('SELECT * FROM characters'),
  guildByAcc: db.prepare('SELECT g.* FROM guilds g JOIN guild_members m ON m.guild_id=g.id WHERE m.account_id=?'),
  guildById: db.prepare('SELECT * FROM guilds WHERE id=?'),
  guildByName: db.prepare('SELECT * FROM guilds WHERE name=? COLLATE NOCASE OR tag=? COLLATE NOCASE'),
  insGuild: db.prepare('INSERT INTO guilds(id,name,tag,leader,created) VALUES(?,?,?,?,?)'),
  delGuild: db.prepare('DELETE FROM guilds WHERE id=?'),
  guildMembers: db.prepare('SELECT account_id FROM guild_members WHERE guild_id=?'),
  insMember: db.prepare('INSERT OR REPLACE INTO guild_members(guild_id,account_id,joined) VALUES(?,?,?)'),
  delMember: db.prepare('DELETE FROM guild_members WHERE account_id=?'),
  updLeader: db.prepare('UPDATE guilds SET leader=? WHERE id=?'),
  insChat: db.prepare('INSERT INTO chat(channel,from_id,from_name,text,ts) VALUES(?,?,?,?,?)'),
  recentChat: db.prepare('SELECT * FROM chat WHERE channel=? ORDER BY id DESC LIMIT 60'),
  insGift: db.prepare('INSERT INTO gifts(account_id,payload,claimed,created) VALUES(?,?,0,?)'),
  pendGifts: db.prepare('SELECT * FROM gifts WHERE account_id=? AND claimed=0'),
  claimGift: db.prepare('UPDATE gifts SET claimed=1 WHERE id=?'),
  audit: db.prepare('INSERT INTO audit(actor,action,target,detail,ts) VALUES(?,?,?,?,?)'),
};

function accountPublic(a) {
  return { id: a.id, user: a.user, role: a.role, banned: !!a.banned, created: a.created };
}
function makeSession(accId) {
  const token = rid(24);
  q.insSession.run(sha(token), accId, now(), now() + SESSION_DAYS * 864e5);
  return token;
}
function sessionAccount(token) {
  if (!token) return null;
  const s = q.getSession.get(sha(token));
  if (!s || s.expires < now()) return null;
  const a = q.accById.get(s.account_id);
  if (!a || a.banned) return null;
  return a;
}
function readBody(req, limit = 2e6) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > limit) { reject(new Error('payload grande')); req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(new Error('JSON inválido')); } });
    req.on('error', reject);
  });
}
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(body);
}

/* ------------------------------ personagem ------------------------------ */
const CLS_KEYS = ['war', 'mag', 'arc', 'cac', 'reap', 'ninja', 'inv'];
function charPublic(row) {
  if (!row) return null;
  let data = {};
  try { data = JSON.parse(row.data); } catch (e) { data = {}; }
  return Object.assign({}, data, {
    id: row.id, name: row.name, cls: row.cls, lv: row.lv, coins: row.coins, crystals: row.crystals,
  });
}
function powerOf(c) {
  const lv = clamp(int(c.lv, 1), 1, MAX_LEVEL);
  const atk = clamp(int(c.atk, 0), 0, 40 + lv * 12);
  const def = clamp(int(c.def, 0), 0, 20 + lv * 8);
  const hp = clamp(int(c.maxHp, 0), 0, 200 + lv * 80);
  const mp = clamp(int(c.maxMp, 0), 0, 100 + lv * 40);
  return Math.round(atk + def * 1.5 + hp / 8 + mp / 10 + lv * 4);
}

/* Validação do que o cliente envia: o servidor é a fonte da verdade para
   nível/XP, moedas e cristais. Equipamentos e inventário são aceitos, mas
   com limites plausíveis por nível. */
function mergeProfile(acc, row, incoming) {
  const prev = row ? charPublic(row) : null;
  const role = acc.role;
  const lvIn = clamp(int(incoming.lv, prev ? prev.lv : 1), 1, MAX_LEVEL);
  const xpIn = Math.max(0, int(incoming.xp, 0));
  const incomingTotal = totalXpFor(lvIn, xpIn);
  const prevTotal = row ? row.xp_total : 0;
  // progresso só sobe (evita reescrever nível para baixo e recuperar XP)
  let total = Math.max(prevTotal, incomingTotal);
  if (role !== 'owner') {
    // teto por salvamento: no máximo 5 níveis de progresso aceitos de uma vez
    const prevLv = row ? row.lv : 1;
    const maxLv = Math.min(MAX_LEVEL, prevLv + 5);
    total = Math.min(total, totalXpFor(maxLv, need(maxLv) - 1));
  }
  const derived = levelFromTotal(total);
  const lv = derived.lv;

  let coins = Math.max(0, int(incoming.coins, prev ? prev.coins : 120));
  let crystals = Math.max(0, int(incoming.crystals, prev ? prev.crystals : 0));
  if (role !== 'owner') {
    const maxCoins = (prev ? prev.coins : 500) + 300_000;
    const maxCrystals = (prev ? prev.crystals : 0) + 60;
    coins = Math.min(coins, maxCoins);
    crystals = Math.min(crystals, maxCrystals);
  }

  const data = Object.assign({}, prev || {}, incoming, {
    id: row ? row.id : incoming.id,
    lv, xp: derived.xp, coins, crystals,
  });
  data.atk = clamp(int(data.atk, 0), 0, 40 + lv * 12);
  data.def = clamp(int(data.def, 0), 0, 20 + lv * 8);
  data.maxHp = clamp(int(data.maxHp, 0), 0, 200 + lv * 80);
  data.maxMp = clamp(int(data.maxMp, 0), 0, 100 + lv * 40);
  data.power = powerOf(data);
  if (!Array.isArray(data.inv)) data.inv = [];
  data.inv = data.inv.slice(0, 80);
  data.role = role;
  data.adm = role === 'owner';
  return { data, lv, total, coins, crystals };
}

/* ------------------------------ estado em memória ------------------------ */
const clients = new Map();      // accountId -> ws
const sockets = new Set();
const parties = new Map();      // partyId -> {id, leader, members:[], created}
const invites = new Map();      // targetAccountId -> [{kind,id,from,ts}]
const instances = new Map();    // instanceId -> {id, key, party, host, members:Set, kills:Set, created}
const rooms = new Map();        // roomId -> Set(ws)

function roomOf(ws) { return ws.room || null; }
function joinRoom(ws, room) {
  if (ws.room === room) return;
  leaveRoom(ws);
  ws.room = room;
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(ws);
}
function leaveRoom(ws) {
  if (!ws.room) return;
  const s = rooms.get(ws.room);
  if (s) { s.delete(ws); if (!s.size) rooms.delete(ws.room); }
  ws.room = null;
}
function wsSend(ws, obj) {
  if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ } }
}
function sendToAccount(accId, obj) {
  const ws = clients.get(accId);
  if (ws) wsSend(ws, obj);
}
function broadcastRoom(room, obj, except) {
  const s = rooms.get(room);
  if (!s) return;
  for (const ws of s) if (ws !== except) wsSend(ws, obj);
}
function playersInRoom(room, exceptId) {
  const out = [];
  const s = rooms.get(room);
  if (!s) return out;
  for (const ws of s) {
    if (!ws.char || ws.account.id === exceptId) continue;
    out.push({ id: ws.account.id, name: ws.char.name, cls: ws.char.cls, lv: ws.char.lv, x: ws.x || 0, y: ws.y || 0, dir: ws.dir || 'down', moving: !!ws.moving, party: ws.partyId || null });
  }
  return out;
}
function partyOf(accId) {
  for (const p of parties.values()) if (p.members.includes(accId)) return p;
  return null;
}
function partyPublic(p) {
  if (!p) return null;
  return {
    id: p.id, leader: p.leader, members: p.members.map((id) => {
      const ws = clients.get(id);
      return { id, name: ws ? ws.char.name : (q.accById.get(id) ? q.accById.get(id).user : '?'), lv: ws ? ws.char.lv : 0, cls: ws ? ws.char.cls : 'war', online: !!ws };
    }),
  };
}
function pushParty(p) {
  const pub = partyPublic(p);
  for (const id of p.members) sendToAccount(id, { t: 'party', party: pub });
}
function guildPublic(gid) {
  const g = q.guildById.get(gid);
  if (!g) return null;
  const members = q.guildMembers.all(gid).map((m) => {
    const ws = clients.get(m.account_id);
    const row = q.charByAcc.get(m.account_id);
    return { id: m.account_id, name: row ? row.name : '?', lv: row ? row.lv : 0, online: !!ws, leader: g.leader === m.account_id };
  });
  return { id: g.id, name: g.name, tag: g.tag, leader: g.leader, members };
}
function pushGuild(gid) {
  const pub = guildPublic(gid);
  if (!pub) return;
  for (const m of pub.members) sendToAccount(m.id, { t: 'guild', guild: pub });
}

/* ------------------------------ ranking --------------------------------- */
let rankingCache = [];
function rebuildRanking() {
  const rows = q.allChars.all();
  rankingCache = rows.map((r) => {
    const c = charPublic(r);
    return { id: r.id, acc: r.account_id, name: r.name, cls: r.cls, lv: r.lv, power: powerOf(c), guild: null };
  }).sort((a, b) => b.power - a.power || b.lv - a.lv);
  rankingCache.forEach((r, i) => { r.rank = i + 1; });
}
function rankingPayload() {
  return rankingCache.slice(0, 50).map((r) => ({ rank: r.rank, id: r.id, name: r.name, cls: r.cls, lv: r.lv, power: r.power }));
}

/* ------------------------------ HTTP ------------------------------------ */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,authorization', 'access-control-allow-methods': 'GET,POST,OPTIONS' }); return res.end(); }

    if (p === '/api/health') return send(res, 200, { ok: true, online: clients.size, accounts: q.accById ? 0 : 0, uptime: process.uptime() });

    if (p === '/api/register' && req.method === 'POST') {
      const b = await readBody(req);
      const user = clean(b.user, 18), pass = String(b.pass || '');
      if (!/^[A-Za-z0-9_.-]{3,18}$/.test(user)) return send(res, 400, { error: 'Usuário inválido (3-18 letras/números).' });
      if (pass.length < 6) return send(res, 400, { error: 'Senha muito curta (mínimo 6).' });
      if (q.accByUser.get(user)) return send(res, 409, { error: 'Usuário já existe.' });
      const salt = rid(16);
      const role = OWNER_KEY && String(b.ownerKey || '') === OWNER_KEY ? 'owner' : 'player';
      const id = 'a' + rid(10);
      q.insAcc.run(id, user, hashPass(pass, salt), salt, role, now());
      q.touchLogin.run(now(), id);
      const token = makeSession(id);
      const acc = q.accById.get(id);
      return send(res, 200, { token, account: accountPublic(acc), character: charPublic(q.charByAcc.get(id)) });
    }

    if (p === '/api/login' && req.method === 'POST') {
      const b = await readBody(req);
      const user = clean(b.user, 18), pass = String(b.pass || '');
      const acc = q.accByUser.get(user);
      if (!acc || acc.pass !== hashPass(pass, acc.salt)) return send(res, 401, { error: 'Usuário ou senha incorretos.' });
      if (acc.banned) return send(res, 403, { error: 'Conta banida.' });
      q.touchLogin.run(now(), acc.id);
      const token = makeSession(acc.id);
      return send(res, 200, { token, account: accountPublic(acc), character: charPublic(q.charByAcc.get(acc.id)) });
    }

    if (p === '/api/me') {
      const acc = sessionAccount((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
      if (!acc) return send(res, 401, { error: 'Sessão expirada.' });
      return send(res, 200, { account: accountPublic(acc), character: charPublic(q.charByAcc.get(acc.id)), ranking: rankingPayload() });
    }

    if (p === '/api/logout' && req.method === 'POST') {
      const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (tok) q.delSession.run(sha(tok));
      return send(res, 200, { ok: true });
    }

    if (p === '/api/ranking') return send(res, 200, { ranking: rankingPayload(), online: clients.size });

    if (p === '/api/character' && req.method === 'POST') {
      const acc = sessionAccount((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
      if (!acc) return send(res, 401, { error: 'Sessão expirada.' });
      if (q.charByAcc.get(acc.id)) return send(res, 409, { error: 'Esta conta já possui um personagem.' });
      const b = await readBody(req);
      const name = clean(b.name, 12);
      const cls = CLS_KEYS.includes(b.cls) ? b.cls : 'war';
      if (!/^[\p{L}\p{N} _.-]{2,12}$/u.test(name)) return send(res, 400, { error: 'Nome inválido (2-12 caracteres).' });
      if (q.charByName.get(name)) return send(res, 409, { error: 'Este nome já está em uso.' });
      const base = {
        id: 'u' + rid(8), name, cls, lv: 1, xp: 0, pts: 0, skillPts: 0, skp: [0, 0, 0],
        st: { war: { str: 8, def: 6, spd: 5, man: 3 }, mag: { str: 3, def: 3, spd: 5, man: 10 }, arc: { str: 6, def: 4, spd: 7, man: 5 }, cac: { str: 7, def: 4, spd: 7, man: 4 }, reap: { str: 8, def: 5, spd: 5, man: 6 }, ninja: { str: 7, def: 4, spd: 10, man: 5 }, inv: { str: 4, def: 4, spd: 5, man: 10 } }[cls],
        coins: 120, crystals: 0, inv: [], eq: { weapon: null, armor: null, helm: null, boots: null, accessory: null },
        bosses: [0, 0, 0, 0, 0], defeatedCreatures: [], duns: {}, wildMaterials: {}, hunterRank: 'H',
        rankHistory: ['H'], kills: 0, sp: 0, play: 0, guild: null, zone: 'c5', hp: 1, mp: 1,
        created: now(), seen: {}, atk: 4 + 8 * 2 + 1, def: 12, maxHp: 60 + 16 + 30, maxMp: 20 + 15 + 2,
      };
      base.power = powerOf(base);
      q.insChar.run(acc.id, base.id, name, cls, 1, 0, 120, 0, JSON.stringify(base), now());
      rebuildRanking();
      q.audit.run(acc.user, 'create_character', name, cls, now());
      return send(res, 200, { character: charPublic(q.charByAcc.get(acc.id)) });
    }

    if (p === '/api/stats') return send(res, 200, { online: clients.size, rooms: rooms.size, parties: parties.size, instances: instances.size, accounts: db.prepare('SELECT COUNT(*) c FROM accounts').get().c, characters: db.prepare('SELECT COUNT(*) c FROM characters').get().c });

    // arquivos estáticos
    let file = p === '/' ? '/game.html' : p;
    const full = path.join(PUBLIC_DIR, path.normalize(file).replace(/^([/\\])+/, ''));
    if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'proibido' });
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, { 'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
      return fs.createReadStream(full).pipe(res);
    }
    return send(res, 404, { error: 'não encontrado' });
  } catch (e) {
    return send(res, 400, { error: e.message || 'erro' });
  }
});

/* ------------------------------ WebSocket ------------------------------- */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.account = null;
  sockets.add(ws);
  ws.on('pong', () => { ws.isAlive = true; });
  const authTimer = setTimeout(() => { if (!ws.account) ws.close(4001, 'auth'); }, 15000);

  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    try { await handle(ws, m); } catch (e) { wsSend(ws, { t: 'error', msg: e.message || 'erro' }); }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    sockets.delete(ws);
    leaveRoom(ws);
    if (ws.account) {
      if (clients.get(ws.account.id) === ws) clients.delete(ws.account.id);
      const p = partyOf(ws.account.id);
      if (p) { p.members = p.members.filter((x) => x !== ws.account.id); if (!p.members.length) parties.delete(p.id); else { if (p.leader === ws.account.id) p.leader = p.members[0]; pushParty(p); } }
      const g = q.guildByAcc.get(ws.account.id);
      if (g) pushGuild(g.id);
      broadcastPresence(ws, true);
    }
  });
  ws.on('error', () => { });
});

function broadcastPresence(ws, leaving) {
  const room = ws.room;
  if (!room) return;
  broadcastRoom(room, { t: 'leave', id: ws.account ? ws.account.id : null });
}

const presenceTimer = setInterval(() => {
  for (const [room, set] of rooms) {
    const list = [];
    for (const ws of set) if (ws.char) list.push({ id: ws.account.id, name: ws.char.name, cls: ws.char.cls, lv: ws.char.lv, x: ws.x || 0, y: ws.y || 0, dir: ws.dir || 'down', moving: !!ws.moving, party: ws.partyId || null });
    for (const ws of set) wsSend(ws, { t: 'players', room, online: clients.size, list: list.filter((x) => x.id !== ws.account.id) });
  }
}, 120);
setInterval(() => {
  for (const ws of sockets) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { }
  }
}, 30000);

/* ranking: recalcula e distribui */
setInterval(() => {
  rebuildRanking();
  const payload = rankingPayload();
  for (const ws of sockets) if (ws.account) wsSend(ws, { t: 'ranking', ranking: payload });
}, 5000);

/* ------------------------------ handlers -------------------------------- */
async function handle(ws, m) {
  if (m.t === 'auth') {
    const acc = sessionAccount(m.token);
    if (!acc) { wsSend(ws, { t: 'authError', msg: 'Sessão inválida. Entre novamente.' }); ws.close(4002, 'auth'); return; }
    if (acc.banned) { wsSend(ws, { t: 'authError', msg: 'Conta banida.' }); ws.close(4003, 'ban'); return; }
    // sessão única: derruba conexão anterior (evita personagem duplicado online)
    const old = clients.get(acc.id);
    if (old && old !== ws) { wsSend(old, { t: 'kicked', msg: 'Sua conta entrou em outro dispositivo.' }); old.close(4004, 'duplicate'); }
    clients.set(acc.id, ws);
    ws.account = acc;
    const row = q.charByAcc.get(acc.id);
    ws.char = row ? { id: row.id, name: row.name, cls: row.cls, lv: row.lv } : null;
    const party = partyOf(acc.id);
    ws.partyId = party ? party.id : null;
    const guild = q.guildByAcc.get(acc.id);
    wsSend(ws, {
      t: 'ready', account: accountPublic(acc), character: charPublic(row), party: partyPublic(party),
      guild: guild ? guildPublic(guild.id) : null, ranking: rankingPayload(), online: clients.size,
      serverTime: now(),
    });
    const gifts = q.pendGifts.all(acc.id);
    for (const g of gifts) { wsSend(ws, { t: 'gift', gift: JSON.parse(g.payload) }); q.claimGift.run(g.id); }
    return;
  }

  if (!ws.account) return wsSend(ws, { t: 'authError', msg: 'Não autenticado.' });
  const acc = ws.account;

  switch (m.t) {
    case 'hello': {
      const row = q.charByAcc.get(acc.id);
      if (!row) return;
      ws.char = { id: row.id, name: row.name, cls: row.cls, lv: row.lv };
      ws.room = null;
      joinRoom(ws, clean(m.room || 'city:0', 40));
      wsSend(ws, { t: 'players', room: ws.room, list: playersInRoom(ws.room, acc.id) });
      const g = q.guildByAcc.get(acc.id);
      if (g) pushGuild(g.id);
      return;
    }
    case 'pos': {
      if (!ws.char) return;
      const room = clean(m.room || ws.room || 'city:0', 40);
      joinRoom(ws, room);
      ws.x = int(m.x); ws.y = int(m.y); ws.dir = clean(m.dir || 'down', 8); ws.moving = !!m.moving;
      return;
    }
    case 'chat': {
      const ch = m.ch === 'guild' ? 'guild' : m.ch === 'party' ? 'party' : 'global';
      const text = clean(m.text, 140);
      if (!text) return;
      const msg = { t: 'chat', ch, from: ws.char ? ws.char.name : acc.user, fid: acc.id, text, ts: now() };
      if (ch === 'global') {
        q.insChat.run('global', acc.id, msg.from, text, msg.ts);
        for (const w of sockets) if (w.account) wsSend(w, msg);
      } else if (ch === 'guild') {
        const g = q.guildByAcc.get(acc.id);
        if (!g) return;
        q.insChat.run('guild:' + g.id, acc.id, msg.from, text, msg.ts);
        msg.g = g.id;
        for (const mm of q.guildMembers.all(g.id)) sendToAccount(mm.account_id, msg);
      } else {
        const p = partyOf(acc.id);
        if (!p) return;
        msg.g = p.id;
        for (const id of p.members) sendToAccount(id, msg);
      }
      return;
    }
    case 'history': {
      const ch = m.ch === 'guild' ? 'guild' : 'global';
      let rows = [];
      if (ch === 'global') rows = q.recentChat.all('global');
      else { const g = q.guildByAcc.get(acc.id); if (g) rows = q.recentChat.all('guild:' + g.id); }
      const list = rows.reverse().map((r) => ({ t: 'chat', ch, from: r.from_name, fid: r.from_id, text: r.text, ts: r.ts }));
      wsSend(ws, { t: 'history', ch, list });
      return;
    }
    case 'party': return partyOp(ws, m);
    case 'guild': return guildOp(ws, m);
    case 'dungeon': return dungeonOp(ws, m);
    case 'monsters': {
      const inst = ws.instanceId ? instances.get(ws.instanceId) : null;
      if (!inst || inst.host !== acc.id) return;
      for (const id of inst.members) if (id !== acc.id) sendToAccount(id, { t: 'monsters', list: m.list, room: inst.id });
      return;
    }
    case 'kill': {
      const inst = ws.instanceId ? instances.get(ws.instanceId) : null;
      if (!inst) return;
      const uid = clean(m.uid, 60);
      if (!uid || inst.kills.has(uid)) return; // dedupe: nenhuma recompensa duplicada
      inst.kills.add(uid);
      const lv = clamp(int(m.lv, 1), 1, MAX_LEVEL), boss = !!m.boss;
      const xp = Math.round((8 + Math.pow(lv, 1.35) * 3.2) * (boss ? 12 : 1));
      const gold = Math.round((4 + lv * 3) * (boss ? 15 : 1));
      for (const id of inst.members) grantReward(id, xp, gold, boss);
      return;
    }
    case 'save': {
      const row = q.charByAcc.get(acc.id);
      if (!row) return;
      const merged = mergeProfile(acc, row, m.profile || {});
      q.updChar.run(merged.data.name || row.name, merged.data.cls || row.cls, merged.lv, merged.total, merged.coins, merged.crystals, JSON.stringify(merged.data), now(), acc.id);
      ws.char.lv = merged.lv;
      wsSend(ws, { t: 'saved', lv: merged.lv, xp: merged.data.xp, coins: merged.coins, crystals: merged.crystals, power: merged.data.power });
      return;
    }
    case 'profile': {
      const row = q.charByAcc.get(acc.id);
      wsSend(ws, { t: 'profile', character: charPublic(row) });
      return;
    }
    case 'admin': return adminOp(ws, m);
    case 'ping': return wsSend(ws, { t: 'pong', ts: m.ts || 0, serverTime: now() });
    default: return;
  }
}

function grantReward(accId, xp, gold, boss) {
  const row = q.charByAcc.get(accId);
  if (!row) return;
  const total = row.xp_total + xp;
  const d = levelFromTotal(total);
  const data = charPublic(row);
  data.lv = d.lv; data.xp = d.xp; data.coins = row.coins + gold;
  data.power = powerOf(data);
  q.updChar.run(row.name, row.cls, d.lv, total, data.coins, row.crystals, JSON.stringify(data), now(), row.account_id);
  sendToAccount(accId, { t: 'reward', xp, gold, boss, lv: d.lv });
}

function partyOp(ws, m) {
  const acc = ws.account;
  const op = m.op;
  if (op === 'create') {
    let p = partyOf(acc.id);
    if (p) return wsSend(ws, { t: 'party', party: partyPublic(p) });
    p = { id: 'p' + rid(6), leader: acc.id, members: [acc.id], created: now() };
    parties.set(p.id, p);
    ws.partyId = p.id;
    pushParty(p);
    return;
  }
  if (op === 'invite') {
    const p = partyOf(acc.id);
    if (!p) return wsSend(ws, { t: 'error', msg: 'Crie um grupo primeiro.' });
    if (p.leader !== acc.id) return wsSend(ws, { t: 'error', msg: 'Só o líder convida.' });
    if (p.members.length >= 5) return wsSend(ws, { t: 'error', msg: 'Grupo cheio (5).' });
    const target = clean(m.target, 40);
    const targetAcc = /^a[0-9a-f]{10,}$/.test(target) ? q.accById.get(target) : (q.charByName.get(target) ? q.accById.get(q.charByName.get(target).account_id) : null);
    if (!targetAcc) return wsSend(ws, { t: 'error', msg: 'Jogador não encontrado.' });
    if (p.members.includes(targetAcc.id)) return wsSend(ws, { t: 'error', msg: 'Já está no grupo.' });
    const list = invites.get(targetAcc.id) || [];
    if (!list.some((i) => i.kind === 'party' && i.id === p.id)) list.push({ kind: 'party', id: p.id, from: ws.char.name, ts: now() });
    invites.set(targetAcc.id, list);
    sendToAccount(targetAcc.id, { t: 'invite', kind: 'party', id: p.id, from: ws.char.name, fromId: acc.id });
    return wsSend(ws, { t: 'ok', msg: 'Convite enviado para ' + (q.charByAcc.get(targetAcc.id) ? q.charByAcc.get(targetAcc.id).name : targetAcc.user) });
  }
  if (op === 'accept') {
    const list = invites.get(acc.id) || [];
    const inv = list.find((i) => i.kind === 'party' && i.id === clean(m.id, 40));
    if (!inv) return wsSend(ws, { t: 'error', msg: 'Convite expirado.' });
    const p = parties.get(inv.id);
    invites.set(acc.id, list.filter((i) => i !== inv));
    if (!p) return wsSend(ws, { t: 'error', msg: 'Grupo não existe mais.' });
    if (p.members.length >= 5) return wsSend(ws, { t: 'error', msg: 'Grupo cheio.' });
    if (!p.members.includes(acc.id)) p.members.push(acc.id);
    ws.partyId = p.id;
    pushParty(p);
    for (const id of p.members) sendToAccount(id, { t: 'toast', msg: (ws.char ? ws.char.name : acc.user) + ' entrou no grupo.', color: '#7fe36b' });
    return;
  }
  if (op === 'leave') {
    const p = partyOf(acc.id);
    if (!p) return;
    p.members = p.members.filter((x) => x !== acc.id);
    ws.partyId = null;
    if (!p.members.length) parties.delete(p.id);
    else { if (p.leader === acc.id) p.leader = p.members[0]; pushParty(p); }
    wsSend(ws, { t: 'party', party: null });
    return;
  }
  if (op === 'kick') {
    const p = partyOf(acc.id);
    if (!p || p.leader !== acc.id) return;
    const target = clean(m.target, 40);
    p.members = p.members.filter((x) => x !== target);
    const tw = clients.get(target); if (tw) tw.partyId = null;
    sendToAccount(target, { t: 'party', party: null });
    pushParty(p);
    return;
  }
}

function guildOp(ws, m) {
  const acc = ws.account;
  const op = m.op;
  if (op === 'create') {
    if (q.guildByAcc.get(acc.id)) return wsSend(ws, { t: 'error', msg: 'Você já tem guilda.' });
    const name = clean(m.name, 18), tag = clean(m.tag, 4).toUpperCase();
    if (name.length < 3) return wsSend(ws, { t: 'error', msg: 'Nome muito curto.' });
    if (!/^[A-Z0-9]{2,4}$/.test(tag)) return wsSend(ws, { t: 'error', msg: 'Tag inválida (2-4 letras).' });
    if (q.guildByName.get(name, tag)) return wsSend(ws, { t: 'error', msg: 'Nome ou tag já existem.' });
    const row = q.charByAcc.get(acc.id);
    if (!row || row.coins < 500) return wsSend(ws, { t: 'error', msg: 'São necessárias 500 moedas.' });
    const data = charPublic(row);
    data.coins = row.coins - 500;
    q.updChar.run(row.name, row.cls, row.lv, row.xp_total, data.coins, row.crystals, JSON.stringify(data), now(), row.account_id);
    const gid = 'g' + rid(6);
    q.insGuild.run(gid, name, tag, acc.id, now());
    q.insMember.run(gid, acc.id, now());
    wsSend(ws, { t: 'coins', coins: data.coins });
    pushGuild(gid);
    return;
  }
  if (op === 'invite') {
    const g = q.guildByAcc.get(acc.id);
    if (!g) return wsSend(ws, { t: 'error', msg: 'Sem guilda.' });
    if (g.leader !== acc.id) return wsSend(ws, { t: 'error', msg: 'Só o líder convida.' });
    const target = clean(m.target, 40);
    const targetAcc = /^a[0-9a-f]{10,}$/.test(target) ? q.accById.get(target) : (q.charByName.get(target) ? q.accById.get(q.charByName.get(target).account_id) : null);
    if (!targetAcc) return wsSend(ws, { t: 'error', msg: 'Jogador não encontrado.' });
    const list = invites.get(targetAcc.id) || [];
    if (!list.some((i) => i.kind === 'guild' && i.id === g.id)) list.push({ kind: 'guild', id: g.id, from: ws.char.name, ts: now() });
    invites.set(targetAcc.id, list);
    sendToAccount(targetAcc.id, { t: 'invite', kind: 'guild', id: g.id, from: ws.char.name, fromId: acc.id });
    return;
  }
  if (op === 'accept') {
    const list = invites.get(acc.id) || [];
    const inv = list.find((i) => i.kind === 'guild' && i.id === clean(m.id, 40));
    if (!inv) return wsSend(ws, { t: 'error', msg: 'Convite expirado.' });
    invites.set(acc.id, list.filter((i) => i !== inv));
    const g = q.guildById.get(inv.id);
    if (!g) return wsSend(ws, { t: 'error', msg: 'Guilda não existe.' });
    if (q.guildByAcc.get(acc.id)) return wsSend(ws, { t: 'error', msg: 'Saia da guilda atual primeiro.' });
    q.insMember.run(g.id, acc.id, now());
    pushGuild(g.id);
    return;
  }
  if (op === 'leave') {
    const g = q.guildByAcc.get(acc.id);
    if (!g) return;
    q.delMember.run(acc.id);
    const rest = q.guildMembers.all(g.id);
    if (!rest.length) q.delGuild.run(g.id);
    else { if (g.leader === acc.id) q.updLeader.run(rest[0].account_id, g.id); pushGuild(g.id); }
    wsSend(ws, { t: 'guild', guild: null });
    return;
  }
  if (op === 'kick') {
    const g = q.guildByAcc.get(acc.id);
    if (!g || g.leader !== acc.id) return;
    const target = clean(m.target, 40);
    if (target === acc.id) return;
    q.delMember.run(target);
    sendToAccount(target, { t: 'guild', guild: null });
    pushGuild(g.id);
    return;
  }
}

function dungeonOp(ws, m) {
  const acc = ws.account;
  if (m.op === 'enter') {
    const key = clean(m.key, 40);
    if (!key) return;
    const p = partyOf(acc.id);
    const id = p ? 'i:' + p.id + ':' + key : 'solo:' + acc.id + ':' + key;
    let inst = instances.get(id);
    if (!inst) { inst = { id, key, party: p ? p.id : null, host: acc.id, members: new Set(), kills: new Set(), created: now() }; instances.set(id, inst); }
    inst.members.add(acc.id);
    ws.instanceId = id;
    joinRoom(ws, 'dun:' + id);
    wsSend(ws, { t: 'dungeon', instance: id, host: inst.host === acc.id, members: [...inst.members] });
    for (const mem of inst.members) if (mem !== acc.id) sendToAccount(mem, { t: 'dungeonPeer', instance: id, account: acc.id, name: ws.char.name });
    return;
  }
  if (m.op === 'leave') {
    const inst = ws.instanceId ? instances.get(ws.instanceId) : null;
    ws.instanceId = null;
    if (inst) {
      inst.members.delete(acc.id);
      if (!inst.members.size) instances.delete(inst.id);
      else if (inst.host === acc.id) { inst.host = [...inst.members][0]; sendToAccount(inst.host, { t: 'dungeon', instance: inst.id, host: true }); }
    }
    return;
  }
}

function adminOp(ws, m) {
  const acc = ws.account;
  if (acc.role !== 'owner') return wsSend(ws, { t: 'error', msg: 'Sem permissão administrativa.' });
  const op = m.op;
  if (op === 'stats') return wsSend(ws, { t: 'adminStats', stats: { online: clients.size, rooms: rooms.size, parties: parties.size, instances: instances.size } });
  if (op === 'broadcast') {
    const text = clean(m.text, 140);
    for (const w of sockets) if (w.account) wsSend(w, { t: 'toast', msg: '[ADM] ' + text, color: '#ffd24a' });
    q.audit.run(acc.user, 'broadcast', null, text, now());
    return;
  }
  if (op === 'gift') {
    const target = clean(m.target, 40);
    const row = q.charByName.get(target) || q.charById.get(target);
    if (!row) return wsSend(ws, { t: 'error', msg: 'Jogador não encontrado.' });
    const payload = { from: acc.user, coins: clamp(int(m.coins, 0), 0, 10_000_000), crystals: clamp(int(m.crystals, 0), 0, 100000), item: clean(m.item, 40) || null, msg: clean(m.msg, 120), ts: now() };
    q.insGift.run(row.account_id, JSON.stringify(payload), now());
    q.audit.run(acc.user, 'gift', target, JSON.stringify(payload), now());
    sendToAccount(row.account_id, { t: 'gift', gift: payload });
    const g = q.pendGifts.all(row.account_id);
    for (const gg of g) q.claimGift.run(gg.id);
    return wsSend(ws, { t: 'ok', msg: 'Presente enviado para ' + row.name });
  }
  if (op === 'setlevel') {
    const row = q.charByName.get(clean(m.target, 40));
    if (!row) return wsSend(ws, { t: 'error', msg: 'Jogador não encontrado.' });
    const lv = clamp(int(m.lv, 1), 1, MAX_LEVEL);
    let total = 0; for (let i = 1; i < lv; i++) total += need(i);
    const data = charPublic(row); data.lv = lv; data.xp = 0;
    q.updChar.run(row.name, row.cls, lv, total, row.coins, row.crystals, JSON.stringify(data), now(), row.account_id);
    q.audit.run(acc.user, 'setlevel', row.name, String(lv), now());
    sendToAccount(row.account_id, { t: 'toast', msg: '[ADM] Seu nível foi ajustado para ' + lv, color: '#ffd24a' });
    return wsSend(ws, { t: 'ok', msg: row.name + ' agora é nível ' + lv });
  }
  if (op === 'ban' || op === 'unban') {
    const target = clean(m.target, 40);
    const a = q.accByUser.get(target) || q.accById.get(target);
    if (!a) return wsSend(ws, { t: 'error', msg: 'Conta não encontrada.' });
    db.prepare('UPDATE accounts SET banned=? WHERE id=?').run(op === 'ban' ? 1 : 0, a.id);
    q.audit.run(acc.user, op, a.user, null, now());
    if (op === 'ban') { const w = clients.get(a.id); if (w) { wsSend(w, { t: 'kicked', msg: 'Conta banida pela administração.' }); w.close(4003, 'ban'); } }
    return wsSend(ws, { t: 'ok', msg: 'Conta ' + a.user + (op === 'ban' ? ' banida.' : ' desbanida.') });
  }
  if (op === 'kick') {
    const target = clean(m.target, 40);
    const w = clients.get(target);
    if (!w) return wsSend(ws, { t: 'error', msg: 'Jogador offline.' });
    wsSend(w, { t: 'kicked', msg: 'Você foi removido pelo administrador.' });
    w.close(4005, 'admin');
    return wsSend(ws, { t: 'ok', msg: 'Jogador desconectado.' });
  }
  if (op === 'players') {
    const list = [...clients.values()].filter((w) => w.char).map((w) => ({ id: w.account.id, name: w.char.name, lv: w.char.lv, room: w.room }));
    return wsSend(ws, { t: 'adminPlayers', list });
  }
}

/* ------------------------------ start ----------------------------------- */
rebuildRanking();
server.listen(PORT, HOST, () => {
  const nets = os.networkInterfaces();
  const ips = Object.values(nets).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
  console.log('Hunter World online em http://localhost:' + PORT);
  for (const ip of ips) console.log('  rede local / celular: http://' + ip + ':' + PORT);
  console.log('Contas:', db.prepare('SELECT COUNT(*) c FROM accounts').get().c, '| Personagens:', db.prepare('SELECT COUNT(*) c FROM characters').get().c);
});
