// Branchline server: accounts (username + password), a dashboard of projects per person,
// one join link per project, and AI chat through the provider the server owner chose.
// The AI key stays on this server and is never sent to any browser.
import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'state.json');
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const sj = (o) =>
  JSON.stringify(o, (k, v) => {
    if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((x) => [x, v[x]]));
    return v;
  });

/* ---------- optional MySQL: set DATABASE_URL=mysql://user:password@host:port/dbname ---------- */
let pool = null;
const DB_URL = process.env.DATABASE_URL || '';
if (DB_URL) {
  if (!/^mysql:\/\//i.test(DB_URL)) {
    console.error('DATABASE_URL must start with mysql://  (example: mysql://user:password@host:3306/defaultdb)');
    process.exit(1);
  }
  const u = new URL(DB_URL);
  const local = /^(localhost|127\.0\.0\.1)$/.test(u.hostname);
  const mysql = await import('mysql2/promise');
  pool = mysql.createPool({
    host: u.hostname,
    port: Number(u.port) || 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)),
    ssl: local ? undefined : { rejectUnauthorized: false },
    connectionLimit: 3,
    charset: 'utf8mb4',
  });
  await pool.query('CREATE TABLE IF NOT EXISTS kv (k VARCHAR(40) PRIMARY KEY, v LONGTEXT NOT NULL) CHARACTER SET utf8mb4');
  const T = [
    'CREATE TABLE IF NOT EXISTS app_users (id VARCHAR(40) PRIMARY KEY, username VARCHAR(80), display_name VARCHAR(80), created_by VARCHAR(40), created_at DATETIME)',
    'CREATE TABLE IF NOT EXISTS app_projects (id VARCHAR(40) PRIMARY KEY, name VARCHAR(160), brief TEXT, head_user_id VARCHAR(40), rules_version INT, created_at DATETIME)',
    'CREATE TABLE IF NOT EXISTS app_members (project_id VARCHAR(40), user_id VARCHAR(40), display_name VARCHAR(80), role VARCHAR(20), PRIMARY KEY (project_id, user_id))',
    'CREATE TABLE IF NOT EXISTS app_branches (project_id VARCHAR(40), id VARCHAR(60), parent_id VARCHAR(60), title VARCHAR(160), owner_user_id VARCHAR(40), locked TINYINT, best TINYINT, rules_version INT, messages INT, PRIMARY KEY (project_id, id))',
    'CREATE TABLE IF NOT EXISTS app_messages (project_id VARCHAR(40), branch_id VARCHAR(60), seq INT, author VARCHAR(80), kind VARCHAR(10), body TEXT, PRIMARY KEY (project_id, branch_id, seq)) CHARACTER SET utf8mb4',
  ];
  for (const q of T) await pool.query(q);
  console.log('Storage: MySQL');
}
async function dbGet(k) {
  const [rows] = await pool.query('SELECT v FROM kv WHERE k = ?', [k]);
  return rows[0] ? JSON.parse(rows[0].v) : null;
}
// Readable copy of the data, so you can open the tables in any MySQL tool. The app itself reads the "kv" table.
async function mirror(st) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const t of ['app_users', 'app_projects', 'app_members', 'app_branches', 'app_messages']) await conn.query(`DELETE FROM ${t}`);
    const nm = (id) => (st.users[id] ? st.users[id].username : String(id || ''));
    const when = (t) => new Date(t || Date.now());
    const users = Object.values(st.users).map((u) => [u.id, u.username, u.name, u.createdBy || null, when(u.created)]);
    if (users.length) await conn.query('INSERT INTO app_users VALUES ?', [users]);
    const projects = [], members = [], branches = [], messages = [];
    for (const [pid, p] of Object.entries(st.projects)) {
      const m = p.meta;
      projects.push([pid, m.name, m.brief, m.owner, (m.versions || []).length, when(m.created)]);
      for (const [uid, v] of Object.entries(m.members || {})) {
        const role = uid === m.owner ? 'head' : v.role === 'viewer' ? 'viewer' : (m.editKeys || []).includes(uid) ? 'editor' : 'member';
        members.push([pid, uid, v.n || '', role]);
      }
      for (const n of Object.values(p.nodes)) {
        const ms = Array.isArray(n.msgs) ? n.msgs : [];
        branches.push([pid, n.id, n.parent || null, String(n.title || '').slice(0, 160), n.owner, n.locked ? 1 : 0, n.best ? 1 : 0, n.ruleV || 1, ms.length]);
        ms.forEach((x, i) => messages.push([pid, n.id, i, x.r === 'ai' ? 'AI' : x.r === 'sys' ? 'system' : nm(x.u), x.r || 'user', String(x.t || '')]));
      }
    }
    if (projects.length) await conn.query('INSERT INTO app_projects VALUES ?', [projects]);
    if (members.length) await conn.query('INSERT INTO app_members VALUES ?', [members]);
    if (branches.length) await conn.query('INSERT INTO app_branches VALUES ?', [branches]);
    if (messages.length) await conn.query('INSERT INTO app_messages VALUES ?', [messages]);
    await conn.commit();
  } catch (e) {
    await conn.rollback().catch(() => {});
    console.error('Could not update the readable tables:', e.message);
  } finally {
    conn.release();
  }
}
let dbChain = Promise.resolve();
function dbSet(k, v) {
  const json = JSON.stringify(v);
  dbChain = dbChain
    .then(() => pool.query('INSERT INTO kv (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [k, json]))
    .then(() => (k === 'state' ? mirror(v) : undefined))
    .catch((e) => console.error('Database write failed:', e.message));
  return dbChain;
}

/* ---------- AI settings (the head changes these inside the app) ---------- */
const DEFAULT_MODELS = { openai: 'gpt-6-luna', gemini: 'gemini-3.8-flash', custom: 'llama3.1' };
async function loadSettings() {
  try {
    if (pool) {
      const v = await dbGet('settings');
      if (v) return v;
      throw new Error('none');
    }
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    const base = process.env.OPENAI_BASE_URL || '';
    return {
      provider: base ? 'custom' : 'openai',
      apiKey: process.env.OPENAI_API_KEY || '',
      model: process.env.OPENAI_MODEL || '',
      baseUrl: base,
    };
  }
}
let settings = await loadSettings();
function saveSettings() {
  if (pool) {
    dbSet('settings', settings);
    return;
  }
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings), { mode: 0o600 });
}
function cfg() {
  const provider = DEFAULT_MODELS[settings.provider] ? settings.provider : 'openai';
  const fallbackBase = provider === 'custom' ? 'http://localhost:11434/v1' : 'https://api.openai.com/v1';
  return {
    provider,
    apiKey: settings.apiKey || '',
    model: settings.model || DEFAULT_MODELS[provider],
    baseUrl: (settings.baseUrl || fallbackBase).replace(/\/+$/, ''),
  };
}
function aiInfo() {
  const c = cfg();
  return c.provider === 'custom' || c.apiKey ? { provider: c.provider, model: c.model } : null;
}

/* ---------- storage: one JSON file ---------- */
let state = { rev: 0, users: {}, sessions: {}, projects: {}, aiAdmin: '' };
try {
  state = { ...state, ...(pool ? (await dbGet('state')) || {} : JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))) };
} catch {
  /* first run */
}
state.users ||= {};
state.sessions ||= {};
state.projects ||= {};
// Projects from older versions had no owner account; they cannot be opened by anyone, so drop them.
for (const [id, p] of Object.entries(state.projects)) if (!p.meta || !p.meta.owner) delete state.projects[id];
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (pool) {
      dbSet('state', state);
      return;
    }
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, DATA_FILE);
  }, 200);
}
function bump() {
  state.rev++;
  persist();
}
function cleanMeta(b) {
  return {
    name: String(b.name || '').slice(0, 120),
    brief: String(b.brief || '').slice(0, 4000),
    editKeys: Array.isArray(b.editKeys) ? b.editKeys.map(String).slice(0, 50) : [],
    versions: Array.isArray(b.versions) ? b.versions.slice(0, 500) : [],
  };
}
const isMember = (p, uid) => p.meta.owner === uid || has(p.meta.members || {}, uid);
function listProjects(uid) {
  return Object.entries(state.projects)
    .filter(([, p]) => isMember(p, uid))
    .map(([id, p]) => ({ id, ...p.meta, joinToken: p.meta.owner === uid ? p.meta.joinToken || '' : undefined, nodes: Object.values(p.nodes) }))
    .sort((a, b) => (b.created || 0) - (a.created || 0));
}

/* ---------- permissions enforced on the server ---------- */
// The head of a project is the account that created it. Members can only change what the page lets them.
function mergeMeta(p, body, uid) {
  const existing = p.meta;
  const clean = cleanMeta(body);
  if (existing.owner === uid) {
    const editKeys = clean.editKeys.filter((k) => has(existing.members || {}, k) && existing.members[k].role !== 'viewer');
    return { ...existing, ...clean, editKeys };
  }
  if (!(existing.editKeys || []).includes(uid) || (existing.members[uid] && existing.members[uid].role === 'viewer')) return null;
  const have = existing.versions || [];
  if (clean.versions.length < have.length || sj(clean.versions.slice(0, have.length)) !== sj(have)) return null;
  return { ...existing, brief: clean.brief || existing.brief, versions: clean.versions };
}
function mergeNode(project, existing, body, uid) {
  const head = project.meta.owner === uid;
  if (head) {
    const out = { ...body };
    if (!existing) out.owner = uid;
    return out;
  }
  const members = project.meta.members || {};
  if (members[uid] && members[uid].role === 'viewer') return null; // viewers are read-only
  const msgs = Array.isArray(body.msgs) ? body.msgs.slice(0, 2000) : [];
  if (!existing) {
    if (body.owner !== uid || !body.parent || !project.nodes[body.parent]) return null;
    return { ...body, owner: uid, msgs, locked: false, access: [] };
  }
  const isOwner = existing.owner === uid;
  const hasAccess = (existing.access || []).includes(uid);
  if (!isOwner && !hasAccess) return null;
  if (existing.locked) {
    if (sj(msgs) !== sj(existing.msgs || [])) return null;
    if (!isOwner || body.locked === false) return null;
  }
  const next = { ...existing, msgs };
  if (isOwner) {
    for (const k of ['title', 'desc', 'best']) if (k in body) next[k] = body[k];
    if (Array.isArray(body.access)) next.access = body.access.map(String).filter((m) => has(members, m) && m !== uid);
    if (body.locked === true) next.locked = true;
  }
  return next;
}

/* ---------- accounts ---------- */
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const USERNAME = /^[a-z0-9_.@+-]{3,60}$/;
const attempts = new Map();
function tooMany(key) {
  const now = Date.now();
  const arr = (attempts.get(key) || []).filter((t) => now - t < 300000);
  attempts.set(key, arr);
  return arr.length >= 10;
}
function failed(key) {
  attempts.set(key, [...(attempts.get(key) || []), Date.now()]);
}
function cookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return '';
      }
    }
  }
  return '';
}
function startSession(req, res, uid) {
  const tok = crypto.randomBytes(32).toString('base64url');
  state.sessions[tok] = { uid, t: Date.now() };
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.set('Set-Cookie', `bl_sess=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`);
  persist();
}
function userOf(req) {
  const tok = cookie(req, 'bl_sess');
  const s = TOKEN.test(tok) && has(state.sessions, tok) ? state.sessions[tok] : null;
  if (!s || Date.now() - s.t > 30 * 86400000 || !state.users[s.uid]) return null;
  return { uid: s.uid, tok, user: state.users[s.uid] };
}
const publicUser = (u) => ({ id: u.id, name: u.name, username: u.username, aiAdmin: state.aiAdmin === u.id });

/* ---------- app ---------- */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.get('/healthz', (req, res) => res.send('ok'));
app.use(express.json({ limit: '1mb' }));
const PAGE = path.join(__dirname, 'index.html');
app.get(['/', '/index.html'], (req, res) => res.sendFile(PAGE));
// A join link opens the same page. The page signs the person in or up, then adds them to the project.
app.get('/join/:token', (req, res) => res.sendFile(PAGE));

app.post('/api/register', (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim().toLowerCase();
  const name = String(b.name || '').trim().slice(0, 30);
  const pw = String(b.password || '');
  const linkOk = TOKEN.test(String(b.joinToken || '')) && Object.values(state.projects).some((p) => p.meta.joinToken === b.joinToken);
  if (Object.keys(state.users).length && !linkOk) return res.status(403).json({ error: 'signup_closed' });
  if (!USERNAME.test(username)) return res.status(400).json({ error: 'bad_username' });
  if (!name) return res.status(400).json({ error: 'bad_name' });
  if (pw.length < 6 || pw.length > 200) return res.status(400).json({ error: 'bad_password' });
  if (Object.values(state.users).some((u) => u.username === username)) return res.status(409).json({ error: 'username_taken' });
  const id = 'u' + crypto.randomBytes(6).toString('hex');
  const salt = crypto.randomBytes(16).toString('hex');
  state.users[id] = { id, username, name, salt, hash: hashPw(pw, salt), created: Date.now() };
  if (!state.aiAdmin) state.aiAdmin = id;
  startSession(req, res, id);
  bump();
  res.json({ user: publicUser(state.users[id]) });
});
app.post('/api/login', (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim().toLowerCase();
  const key = `${req.ip}|${username}`;
  if (tooMany(key)) return res.status(429).json({ error: 'too_many' });
  const u = Object.values(state.users).find((x) => x.username === username);
  const ok = u && crypto.timingSafeEqual(Buffer.from(hashPw(String(b.password || ''), u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
  if (!ok) {
    failed(key);
    return res.status(401).json({ error: 'wrong_login' });
  }
  startSession(req, res, u.id);
  res.json({ user: publicUser(u) });
});
app.post('/api/logout', (req, res) => {
  const a = userOf(req);
  if (a) {
    delete state.sessions[a.tok];
    persist();
  }
  res.set('Set-Cookie', 'bl_sess=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => {
  const a = userOf(req);
  res.json({ user: a ? publicUser(a.user) : null, firstRun: !Object.keys(state.users).length });
});
// Anyone with the link may see which project it opens, before logging in.
app.get('/api/join/:token', (req, res) => {
  const tok = req.params.token;
  const e = TOKEN.test(tok) ? Object.values(state.projects).find((p) => p.meta.joinToken === tok) : null;
  if (!e) return res.status(404).json({ error: 'bad_link' });
  const owner = state.users[e.meta.owner];
  res.json({ project: e.meta.name, head: owner ? owner.name : 'the head' });
});

// A read-only page for the server owner (the first account) that shows the tables.
app.get('/admin', (req, res) => {
  const a = userOf(req);
  if (!a || state.aiAdmin !== a.uid) return res.status(403).send('Only the server owner can open this page. Log in to Branchline first, then reload.');
  const h = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const table = (title, cols, rows) =>
    `<h2>${h(title)} (${rows.length})</h2><table><tr>${cols.map((c) => `<th>${h(c)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((v) => `<td>${h(v)}</td>`).join('')}</tr>`).join('')}</table>`;
  const nm = (id) => (state.users[id] ? state.users[id].username : id);
  const users = Object.values(state.users).map((u) => [u.id, u.username, u.name, u.createdBy ? nm(u.createdBy) : '', new Date(u.created).toISOString()]);
  const projects = [], members = [], branches = [];
  for (const [pid, p] of Object.entries(state.projects)) {
    projects.push([pid, p.meta.name, nm(p.meta.owner), Object.keys(p.meta.members || {}).length, Object.keys(p.nodes).length]);
    for (const [uid, v] of Object.entries(p.meta.members || {})) members.push([p.meta.name, nm(uid), uid === p.meta.owner ? 'head' : v.role === 'viewer' ? 'viewer' : (p.meta.editKeys || []).includes(uid) ? 'editor' : 'member']);
    for (const n of Object.values(p.nodes)) branches.push([p.meta.name, n.title, nm(n.owner), n.locked ? 'yes' : '', n.best ? 'yes' : '', (n.msgs || []).length]);
  }
  res.send(`<!doctype html><meta charset="utf-8"><title>Branchline database</title><style>body{font:14px system-ui;margin:24px;max-width:1100px}table{border-collapse:collapse;margin-bottom:24px}td,th{border:1px solid #bbb;padding:4px 8px;text-align:left}th{background:#eee}</style><h1>Branchline database view</h1><p>Storage: ${pool ? 'MySQL (tables app_users, app_projects, app_members, app_branches, app_messages)' : 'local file data/state.json'}. Read-only. Passwords are never shown.</p>${table('Users', ['id', 'username', 'name', 'created by', 'created'], users)}${table('Projects', ['id', 'name', 'head', 'members', 'branches'], projects)}${table('Members', ['project', 'user', 'role'], members)}${table('Branches', ['project', 'title', 'owner', 'locked', 'best', 'messages'], branches)}`);
});

app.use('/api', (req, res, next) => {
  const a = userOf(req);
  if (!a) return res.status(401).json({ error: 'unauthorized' });
  req.uid = a.uid;
  req.user = a.user;
  next();
});

app.post('/api/join/:token', (req, res) => {
  const tok = req.params.token;
  const entry = TOKEN.test(tok) ? Object.entries(state.projects).find(([, p]) => p.meta.joinToken === tok) : null;
  if (!entry) return res.status(404).json({ error: 'bad_link' });
  const [pid, p] = entry;
  p.meta.members ||= {};
  if (!isMember(p, req.uid)) {
    p.meta.members[req.uid] = { n: req.user.name };
    bump();
  }
  res.json({ pid });
});

app.get('/api/health', (req, res) => res.json({ ai: aiInfo(), aiAdmin: state.aiAdmin === req.uid }));
app.get('/api/state', (req, res) => {
  if (Number(req.query.since) === state.rev) return res.json({ rev: state.rev, unchanged: true });
  res.json({ rev: state.rev, projects: listProjects(req.uid) });
});

app.post('/api/projects', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 80);
  const rules = Array.isArray(b.rules) ? b.rules.map((r) => String(r).trim().slice(0, 300)).filter(Boolean).slice(0, 50) : [];
  if (!name || !rules.length) return res.status(400).json({ error: 'bad_request' });
  if (Object.values(state.projects).filter((p) => p.meta.owner === req.uid).length >= 50) return res.status(409).json({ error: 'too_many_projects' });
  const pid = 'p' + crypto.randomBytes(6).toString('hex');
  const rid = pid + 'r';
  state.projects[pid] = {
    meta: {
      name,
      brief: String(b.brief || '').trim().slice(0, 600) || 'No description yet.',
      owner: req.uid,
      created: Date.now(),
      editKeys: [],
      members: { [req.uid]: { n: req.user.name } },
      joinToken: crypto.randomBytes(18).toString('base64url'),
      versions: [{ v: 1, by: req.uid, date: new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }), note: 'Initial rules', rules }],
    },
    nodes: { [rid]: { id: rid, parent: null, title: name, owner: req.uid, ruleV: 1, locked: true, best: false, access: [], msgs: [], pos: [0, 0, 0], t: 1 } },
  };
  bump();
  res.json({ pid });
});

app.put('/api/meta/:pid', (req, res) => {
  const p = state.projects[req.params.pid];
  if (!p || !isMember(p, req.uid) || !isObj(req.body)) return res.status(403).json({ error: 'forbidden' });
  const next = mergeMeta(p, req.body, req.uid);
  if (!next) return res.status(403).json({ error: 'forbidden' });
  p.meta = next;
  bump();
  res.json({ ok: true, rev: state.rev });
});

app.put('/api/node/:pid/:nid', (req, res) => {
  const { pid, nid } = req.params;
  const p = state.projects[pid];
  if (!ID.test(nid) || !isObj(req.body) || !p || !isMember(p, req.uid)) return res.status(403).json({ error: 'forbidden' });
  if (!p.nodes[nid] && Object.keys(p.nodes).length >= 500) return res.status(409).json({ error: 'too_many_nodes' });
  const next = mergeNode(p, p.nodes[nid], req.body, req.uid);
  if (!next) return res.status(403).json({ error: 'forbidden' });
  p.nodes[nid] = { ...next, id: nid };
  bump();
  res.json({ ok: true, rev: state.rev });
});

app.delete('/api/project/:pid', (req, res) => {
  const p = state.projects[req.params.pid];
  if (!p || p.meta.owner !== req.uid) return res.status(403).json({ error: 'forbidden' });
  delete state.projects[req.params.pid];
  bump();
  res.json({ ok: true });
});

/* ---------- join link and members (head only, except leaving) ---------- */
app.post('/api/project/:pid/link', (req, res) => {
  const p = state.projects[req.params.pid];
  if (!p || p.meta.owner !== req.uid) return res.status(403).json({ error: 'forbidden' });
  p.meta.joinToken = req.body && req.body.off ? '' : crypto.randomBytes(18).toString('base64url');
  bump();
  res.json({ joinToken: p.meta.joinToken });
});

// The head can create a login for a specific person, or add someone who already has an account.
const ROLES = ['viewer', 'member', 'editor'];
function setRole(p, uid, role) {
  const m = p.meta.members[uid];
  m.role = role === 'viewer' ? 'viewer' : 'member';
  p.meta.editKeys = (p.meta.editKeys || []).filter((k) => k !== uid);
  if (role === 'editor') p.meta.editKeys.push(uid);
}
app.put('/api/project/:pid/members/:uid/role', (req, res) => {
  const p = state.projects[req.params.pid];
  const target = req.params.uid;
  const role = req.body && req.body.role;
  if (!p || p.meta.owner !== req.uid || target === p.meta.owner || !has(p.meta.members || {}, target) || !ROLES.includes(role)) return res.status(403).json({ error: 'forbidden' });
  setRole(p, target, role);
  bump();
  res.json({ ok: true });
});
const randomPw = () => crypto.randomBytes(6).toString('base64url');
app.post('/api/project/:pid/people', (req, res) => {
  const p = state.projects[req.params.pid];
  if (!p || p.meta.owner !== req.uid) return res.status(403).json({ error: 'forbidden' });
  const b = req.body || {};
  const username = String(b.username || '').trim().toLowerCase();
  if (!USERNAME.test(username)) return res.status(400).json({ error: 'bad_username' });
  let u = Object.values(state.users).find((x) => x.username === username);
  let created = false;
  let password = '';
  if (!u) {
    const name = String(b.name || '').trim().slice(0, 30);
    password = String(b.password || '') || randomPw();
    if (!name) return res.status(400).json({ error: 'bad_name' });
    if (password.length < 6 || password.length > 200) return res.status(400).json({ error: 'bad_password' });
    const id = 'u' + crypto.randomBytes(6).toString('hex');
    const salt = crypto.randomBytes(16).toString('hex');
    u = state.users[id] = { id, username, name, salt, hash: hashPw(password, salt), created: Date.now(), createdBy: req.uid };
    created = true;
  }
  p.meta.members ||= {};
  p.meta.members[u.id] = u.createdBy === req.uid ? { n: u.name, managed: true } : { n: u.name };
  setRole(p, u.id, ROLES.includes(b.role) ? b.role : 'member');
  bump();
  res.json({ ok: true, created, username: u.username, name: u.name, password });
});
app.post('/api/project/:pid/members/:uid/password', (req, res) => {
  const p = state.projects[req.params.pid];
  const u = state.users[req.params.uid];
  if (!p || !u || p.meta.owner !== req.uid || !has(p.meta.members || {}, u.id) || u.createdBy !== req.uid) return res.status(403).json({ error: 'forbidden' });
  const password = String((req.body && req.body.password) || '') || randomPw();
  if (password.length < 6 || password.length > 200) return res.status(400).json({ error: 'bad_password' });
  u.salt = crypto.randomBytes(16).toString('hex');
  u.hash = hashPw(password, u.salt);
  for (const [tok, sess] of Object.entries(state.sessions)) if (sess.uid === u.id) delete state.sessions[tok];
  bump();
  res.json({ ok: true, username: u.username, password });
});
app.delete('/api/project/:pid/members/:uid', (req, res) => {
  const p = state.projects[req.params.pid];
  const target = req.params.uid;
  if (!p || !has(p.meta.members || {}, target) || target === p.meta.owner) return res.status(404).json({ error: 'not_found' });
  if (p.meta.owner !== req.uid && target !== req.uid) return res.status(403).json({ error: 'forbidden' });
  delete p.meta.members[target];
  p.meta.editKeys = (p.meta.editKeys || []).filter((k) => k !== target);
  for (const n of Object.values(p.nodes)) n.access = (n.access || []).filter((k) => k !== target);
  bump();
  res.json({ ok: true });
});

/* ---------- who is here ---------- */
const peers = new Map();
app.post('/api/presence', (req, res) => {
  const b = req.body || {};
  const now = Date.now();
  const pid = String(b.pid || '').slice(0, 40);
  const p = state.projects[pid];
  if (p && isMember(p, req.uid)) peers.set(req.uid, { who: req.uid, pid, sel: String(b.sel || '').slice(0, 40), t: now });
  const out = [];
  for (const [id, v] of peers) {
    if (now - v.t > 12000) peers.delete(id);
    else if (id !== req.uid && v.pid === pid && p && isMember(p, req.uid)) out.push({ who: v.who, pid: v.pid, sel: v.sel });
  }
  res.json({ peers: out });
});

/* ---------- AI ---------- */
const hits = new Map();
function limited(key) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < 60000);
  if (arr.length >= 20) return true;
  arr.push(now);
  hits.set(key, arr);
  return false;
}
const httpErr = (status, code) => Object.assign(new Error(code), { status, code });

const HUMAN = {
  ai_not_configured: 'No AI key is saved yet. Paste a key and press Test again.',
  bad_key: 'The provider rejected the key. Check that you pasted the whole key and that it is for this provider.',
  no_quota: 'This key has no credit or free usage available. Add billing on that account, or switch the provider to Google Gemini (free tier) or to a local Ollama server.',
  rate_limited: 'The provider says you hit its rate limit. Wait a minute, then test again.',
  model_not_found: 'The provider does not know that model name. Clear the model box to use the default, or type another model name.',
  provider_unreachable: 'The server could not reach the provider. Check the server\'s internet connection, or that Ollama is running.',
  provider_error: 'The provider returned an error. The server window shows the details.',
  empty_reply: 'The provider answered with nothing. Try again or choose another model.',
};

async function readError(r, who) {
  const raw = await r.text();
  let code = '';
  try {
    const j = JSON.parse(raw);
    code = j.error?.code || j.error?.status || '';
  } catch {
    /* not JSON */
  }
  console.error(`${who} error`, r.status, raw.slice(0, 300));
  if (r.status === 401 || r.status === 403 || (r.status === 400 && /API_KEY_INVALID|API key not valid/i.test(raw))) return httpErr(502, 'bad_key');
  if (r.status === 429) return httpErr(429, code === 'insufficient_quota' ? 'no_quota' : 'rate_limited');
  if (r.status === 404) return httpErr(502, 'model_not_found');
  return httpErr(502, 'provider_error');
}

async function callOpenAICompat(c, turns) {
  const messages = turns.map((t, i) => ({ role: i === 0 ? 'system' : t.role, content: t.content }));
  const headers = { 'Content-Type': 'application/json' };
  if (c.apiKey) headers.Authorization = `Bearer ${c.apiKey}`;
  let r;
  try {
    r = await fetch(`${c.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: c.model, messages, max_completion_tokens: 2000 }),
    });
  } catch (e) {
    console.error('Cannot reach the AI service:', e.message);
    throw httpErr(502, 'provider_unreachable');
  }
  if (!r.ok) throw await readError(r, 'AI');
  const j = await r.json();
  const text = (j.choices?.[0]?.message?.content || '').trim();
  if (!text) throw httpErr(502, 'empty_reply');
  return text;
}

async function callGemini(c, turns) {
  const contents = [];
  for (const t of turns.slice(1)) {
    const role = t.role === 'assistant' ? 'model' : 'user';
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts[0].text += '\n\n' + t.content;
    else contents.push({ role, parts: [{ text: t.content }] });
  }
  if (!contents.length || contents[0].role !== 'user') contents.unshift({ role: 'user', parts: [{ text: 'Continue.' }] });
  let r;
  try {
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(c.model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': c.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: turns[0].content }] },
        contents,
        generationConfig: { maxOutputTokens: 1500 },
      }),
    });
  } catch (e) {
    console.error('Cannot reach Gemini:', e.message);
    throw httpErr(502, 'provider_unreachable');
  }
  if (!r.ok) throw await readError(r, 'Gemini');
  const j = await r.json();
  const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) throw httpErr(502, 'empty_reply');
  return text;
}

async function callAI(turns) {
  if (!aiInfo()) throw httpErr(503, 'ai_not_configured');
  const c = cfg();
  return c.provider === 'gemini' ? callGemini(c, turns) : callOpenAICompat(c, turns);
}

app.post('/api/chat', async (req, res) => {
  try {
    if (limited(req.uid)) throw httpErr(429, 'rate_limited');
    const turns = req.body && req.body.turns;
    const ok =
      Array.isArray(turns) &&
      turns.length >= 2 &&
      turns.length <= 40 &&
      turns[0].role === 'user' &&
      turns[turns.length - 1].role === 'user' &&
      turns.every((t) => isObj(t) && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.length > 0);
    if (!ok || turns.reduce((n, t) => n + t.content.length, 0) > 60000) throw httpErr(400, 'bad_request');
    res.json({ text: await callAI(turns) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.code || 'server_error' });
  }
});

const aiAdminOnly = (req, res, next) => (state.aiAdmin === req.uid ? next() : res.status(403).json({ error: 'forbidden' }));
/* ---------- AI settings and connection test (head only) ---------- */
app.get('/api/settings', aiAdminOnly, (req, res) => {
  const c = cfg();
  res.json({
    provider: c.provider,
    model: settings.model || '',
    baseUrl: settings.baseUrl || '',
    hasKey: Boolean(c.apiKey),
    keyHint: c.apiKey ? '…' + c.apiKey.slice(-4) : '',
    defaults: DEFAULT_MODELS,
  });
});
app.put('/api/settings', aiAdminOnly, (req, res) => {
  const b = req.body || {};
  if (!DEFAULT_MODELS[b.provider]) return res.status(400).json({ error: 'bad_request' });
  const baseUrl = String(b.baseUrl || '').trim();
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) return res.status(400).json({ error: 'bad_url' });
  settings.provider = b.provider;
  settings.model = String(b.model || '').trim().slice(0, 80);
  settings.baseUrl = baseUrl.slice(0, 300);
  if (typeof b.apiKey === 'string' && b.apiKey.trim()) settings.apiKey = b.apiKey.trim().slice(0, 300);
  if (b.clearKey === true) settings.apiKey = '';
  saveSettings();
  res.json({ ok: true, ai: aiInfo() });
});
app.post('/api/settings/test', aiAdminOnly, async (req, res) => {
  const t0 = Date.now();
  try {
    const text = await callAI([
      { role: 'user', content: 'This is a connection test. Reply with the single word OK.' },
      { role: 'user', content: 'Test' },
    ]);
    res.json({ ok: true, reply: text.slice(0, 60), ms: Date.now() - t0 });
  } catch (e) {
    res.json({ ok: false, code: e.code || 'server_error', message: HUMAN[e.code] || 'The test failed. The server window shows the details.' });
  }
});

app.listen(PORT, () => {
  const ai = aiInfo();
  console.log(`Branchline running on http://localhost:${PORT}`);
  console.log(ai ? `AI: ${ai.provider} (${ai.model})` : 'AI: not connected yet. The first account created can open "AI settings".');
});
