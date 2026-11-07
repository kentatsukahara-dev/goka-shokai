// Tänk!（テンク） — 自前サーバー
// ルールは seigokaku.html の engine をそのまま読み込み、対局の判定はすべてここで行う。
// ブラウザは操作を送るだけで、サイコロ、ミニゲームの答え、相手の隠し情報は受け取らない。
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const HTML = fs.readFileSync(path.join(ROOT, 'seigokaku.html'), 'utf8');
const MAX_EMIT = 4 * 1024, MAX_TABLES = 300, AWAY_MS = 120000;

const engineSrc = /<script id="engine">([\s\S]*?)<\/script>/.exec(HTML)[1];
const E = new Function(engineSrc + '\nreturn{newGame,apply,cpuAct,viewFor,waitSeats,log,IDLE_MS};')();

// ---------- 保存 ----------
const docs = new Map();   // 'tables/abcde' | 'stats/n4'
const auth = new Map();   // uid -> sha256(secret)
function load() {
  try {
    const j = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    for (const [k, v] of Object.entries(j.docs || {})) docs.set(k, v);
    for (const [k, v] of Object.entries(j.auth || {})) auth.set(k, v);
    console.log(`loaded ${docs.size} docs`);
  } catch (e) { console.log('no saved data, starting fresh'); }
}
function writeNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ docs: Object.fromEntries(docs), auth: Object.fromEntries(auth) }));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) { console.error('save failed', e.message); }
}
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const cut = Date.now() - 24 * 3600 * 1000;
    for (const [k, v] of docs) if (k.startsWith('tables/') && (v.updated || 0) < cut) docs.delete(k);
    writeNow();
  }, 2000);
}

// ---------- 購読 ----------
const SEG = /^[A-Za-z0-9_.\-]{1,64}$/;
const splitPath = p => { if (typeof p !== 'string') return null; const s = p.split('/'); return s.every(x => SEG.test(x)) ? s : null; };
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const clients = new Set();
function seen(c, t) {   // 席ごとに見せてよい形へ
  if (!t.G) return t;
  const seat = t.G.pl.findIndex(p => p.uid === c.uid);
  return { ...t, G: E.viewFor(t.G, seat) };
}
const docSnap = (c, p) => {
  if (!docs.has(p)) return { exists: false, data: null };
  const v = docs.get(p);
  return { exists: true, data: p.startsWith('tables/') ? seen(c, v) : v };
};
function colSnap(c, q) {
  const out = [], pre = q.path + '/';
  for (const [k, v] of docs) {
    if (!k.startsWith(pre) || k.indexOf('/', pre.length) >= 0) continue;
    if (q.where && !q.where.every(([f, op, val]) => op === '==' ? v[f] === val : op === '!=' ? v[f] !== val : true)) continue;
    const { G, ...rest } = v;   // 一覧に対局の中身は出さない
    out.push({ id: k.slice(pre.length), data: rest });
    if (q.limit && out.length >= q.limit) break;
  }
  return out;
}
function sendSnap(c, id, q) {
  if (q.kind === 'doc') c.send({ t: 'snap', sub: id, ...docSnap(c, q.path) });
  else c.send({ t: 'snap', sub: id, docs: colSnap(c, q) });
}
function changed(p) {
  const col = p.slice(0, p.lastIndexOf('/'));
  for (const c of clients) for (const [id, q] of c.subs) {
    if ((q.kind === 'doc' && q.path === p) || (q.kind === 'col' && q.path === col)) sendSnap(c, id, q);
  }
  scheduleSave();
}

// ---------- 部屋（接続中の人の管理） ----------
const rooms = new Map();
const peersOf = name => { const r = rooms.get(name); return r ? [...r.values()].map(c => ({ peer: c.peer, presence: c.presence.get(name) || {}, kind: 'viewer', guest: false })) : []; };
function broadcastPeers(name) { const r = rooms.get(name); if (!r) return; const peers = peersOf(name); for (const c of r.values()) c.send({ t: 'peers', room: name, peers }); }
function joinRoom(c, name) { if (!rooms.has(name)) rooms.set(name, new Map()); rooms.get(name).set(c.peer, c); if (!c.presence.has(name)) c.presence.set(name, {}); broadcastPeers(name); }
function leaveRoom(c, name) { const r = rooms.get(name); if (!r) return; r.delete(c.peer); c.presence.delete(name); if (!r.size) rooms.delete(name); else broadcastPeers(name); }
const onlineUids = code => { const r = rooms.get('g:t' + code); return new Set(r ? [...r.values()].map(c => c.uid) : []); };

// ---------- 対局 ----------
const live = new Map();   // code -> {seen:{uid:time}, nextCpu, done:Set}
const liveOf = code => { if (!live.has(code)) live.set(code, { seen: {}, act: {}, mark: 0, nextCpu: 0, done: new Set(), since: Date.now() }); return live.get(code); };
const cleanName = v => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 10) || '名無し';
function touch(t) { t.rev = (t.rev || 0) + 1; t.updated = Date.now(); changed('tables/' + t.id); }
function afterMove(t) {
  liveOf(t.id).mark = Date.now();
  if (t.G.phase === 'over' && t.status !== 'done') {
    t.status = 'done';
    if (t.G.pl.filter(p => p.uid).length >= 2) {
      const n = t.G.n, k = 'stats/n' + n, x = docs.get(k) || { n, games: 0, wins: new Array(n).fill(0) };
      x.games++; x.wins[t.G.winner]++; docs.set(k, x); changed(k);
    }
  }
  touch(t);
}
function onAct(c, code, d) {
  const t = docs.get('tables/' + code);
  if (!t || !isObj(d)) return;
  if (d.sit !== undefined) {
    if (t.status !== 'wait' || t.seats.length >= t.size || t.seats.some(s => s.uid === c.uid)) return;
    t.seats.push({ uid: c.uid, name: cleanName(d.sit) }); touch(t); return;
  }
  if (d.start) {
    if (t.status !== 'wait' || !t.seats[0] || t.seats[0].uid !== c.uid) return;
    const seats = t.seats.map(s => ({ ...s }));
    while (seats.length < t.size) seats.push({ name: 'CPU' + (seats.length + 1), cpu: true });
    t.G = E.newGame({ seats, target: t.target, map: 1 }); t.status = 'play'; touch(t); return;
  }
  if (!t.G || !isObj(d.a)) return;
  const seat = t.G.pl.findIndex(p => p.uid === c.uid);   // 席は接続の本人から決める
  if (seat < 0 || (d.a.t === 'mg' && d.a.op === 'auto')) return;
  const L = liveOf(code), me = t.G.pl[seat];
  L.act[c.uid] = Date.now();   // 画面に触っている間は離席にしない
  if (me.afk) { me.afk = false; E.log(t.G, `${me.name}が戻った`); touch(t); }
  if (d.a.t === 'ping') return;
  if (typeof d.aid === 'string') { if (L.done.has(d.aid)) return; L.done.add(d.aid); if (L.done.size > 500) L.done.clear(); }
  if (!E.apply(t.G, seat, d.a)) afterMove(t);
}
function tickTable(t) {
  const G = t.G, L = liveOf(t.id), now = Date.now();
  if (now < L.nextCpu) return;
  const on = onlineUids(t.id);
  for (const u of on) L.seen[u] = now;
  for (const i of E.waitSeats(G)) {   // つながっていても操作が止まった人は離席にする
    const p = G.pl[i];
    if (p.uid && !p.cpu && !p.afk && on.has(p.uid) && now - Math.max(L.mark || L.since, L.act[p.uid] || 0) > E.IDLE_MS) {
      p.afk = true; E.log(G, `${p.name}は操作が止まり離席になった`); touch(t);
    }
  }
  const auto = i => { const p = G.pl[i]; return p.cpu || p.afk || (!on.has(p.uid) && now - (L.seen[p.uid] || L.since) > AWAY_MS); };
  let s = null;
  if (G.offer) {
    const w = G.pl.map((_, i) => i).filter(i => i !== G.offer.from && !G.offer.no.includes(i));
    s = w.find(auto); if (s === undefined) s = auto(G.offer.from) ? G.offer.from : null;
  } else if (auto(G.cur)) s = G.cur;
  if (s === null || s === undefined) return;
  const a = E.cpuAct(G, s), e = E.apply(G, s, a);
  if (e && s === G.cur && !G.offer) E.apply(G, s, G.phase === 'roll' ? { t: 'roll' } : { t: 'end' });
  L.nextCpu = now + (a.t === 'respond' ? 300 : a.t === 'roll' || a.k === 'forecast' ? 1500 : 750);
  afterMove(t);
}
setInterval(() => {
  for (const [k, t] of docs) {
    if (!k.startsWith('tables/') || !t.G || t.status !== 'play') continue;
    try { tickTable(t); } catch (e) { console.error('tick', t.id, e); }
  }
}, 300);

// ---------- 接続 ----------
class Client {
  constructor(ws) { this.ws = ws; this.uid = null; this.peer = 'p' + crypto.randomBytes(9).toString('hex'); this.subs = new Map(); this.presence = new Map(); this.lastTable = 0; }
  send(o) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
}
function createTable(c, p, d) {
  const id = p.split('/')[1];
  if (!/^[a-z0-9]{5}$/.test(id) || docs.has(p)) return 'permission_denied';
  if (Date.now() - c.lastTable < 3000) return 'too_fast';
  let n = 0; for (const k of docs.keys()) if (k.startsWith('tables/')) n++;
  if (n >= MAX_TABLES) return 'full';
  const size = [2, 3, 4].includes(d.size) ? d.size : 4, target = [16, 20, 24].includes(d.target) ? d.target : 20;
  const name = cleanName(d.seats && d.seats[0] && d.seats[0].name);
  c.lastTable = Date.now();
  docs.set(p, { id, status: 'wait', seats: [{ uid: c.uid, name }], size, map: 1, target, created: Date.now(), updated: Date.now(), rev: 1 });
  changed(p); return null;
}
function handle(c, m) {
  const ok = data => c.send({ t: 'res', id: m.id, ok: true, data });
  const ng = err => c.send({ t: 'res', id: m.id, ok: false, err });
  if (m.op === 'hello') {
    const { uid, secret } = m;
    if (typeof uid !== 'string' || !/^u_[A-Za-z0-9]{10,40}$/.test(uid) || typeof secret !== 'string' || secret.length < 20) return ng('bad_identity');
    const h = crypto.createHash('sha256').update(secret).digest('hex');
    if (auth.has(uid) && auth.get(uid) !== h) return ng('bad_secret');
    if (!auth.has(uid)) { auth.set(uid, h); scheduleSave(); }
    c.uid = uid;
    return ok({ uid, admin: false, peer: c.peer });
  }
  if (!c.uid) return ng('not_ready');
  const segs = m.path !== undefined ? splitPath(m.path) : null;
  switch (m.op) {
    case 'get':
      if (!segs || segs.length !== 2) return ng('bad_path');
      return ok(docSnap(c, m.path));
    case 'set': {
      if (!segs || segs.length !== 2 || segs[0] !== 'tables' || !isObj(m.data)) return ng('permission_denied');
      const e = createTable(c, m.path, m.data); return e ? ng(e) : ok(true);
    }
    case 'update': case 'delete': return ng('permission_denied');
    case 'sub': {
      if (!segs || typeof m.sub !== 'string') return ng('bad_path');
      const q = segs.length === 2 ? { kind: 'doc', path: m.path }
        : { kind: 'col', path: m.path, limit: Math.min(1000, Number(m.limit) || 0) || 0, where: Array.isArray(m.where) ? m.where.filter(w => Array.isArray(w) && w.length === 3).slice(0, 5) : null };
      c.subs.set(m.sub, q); ok(true); sendSnap(c, m.sub, q); return;
    }
    case 'unsub': c.subs.delete(m.sub); return ok(true);
    case 'qget':
      if (!segs || segs.length !== 1) return ng('bad_path');
      return ok(colSnap(c, { path: m.path, limit: m.limit, where: m.where }));
    case 'join':
      if (typeof m.room !== 'string' || m.room.length > 80) return ng('bad_room');
      joinRoom(c, m.room); return ok({ peers: peersOf(m.room) });
    case 'leave': leaveRoom(c, m.room); return ok(true);
    case 'presence': {
      const r = rooms.get(m.room);
      if (!r || !r.has(c.peer) || !isObj(m.patch)) return ng('not_joined');
      const next = { ...(c.presence.get(m.room) || {}), uid: c.uid };
      c.presence.set(m.room, next); broadcastPeers(m.room); return ok(true);
    }
    case 'emit': {
      const r = rooms.get(m.room);
      if (!r || !r.has(c.peer)) return ng('not_joined');
      if (m.topic !== 'act' || JSON.stringify(m.data ?? null).length > MAX_EMIT) return ng('too_large');
      const code = /^g:t([a-z0-9]{5})$/.exec(m.room);
      if (code) onAct(c, code[1], m.data);
      return ok(true);
    }
    default: return ng('unknown_op');
  }
}

// ---------- HTTP ----------
function page() {
  return '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<style>*,*::before,*::after{box-sizing:border-box}body{margin:0}</style>' +
    '<script src="/shim.js"></script></head><body>' + HTML + '</body></html>';
}
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (url === '/' || url === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(page()); }
    if (url === '/shim.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(fs.readFileSync(path.join(ROOT, 'shim.js'))); }
    if (url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  } catch (e) { console.error(e); res.writeHead(500); return res.end('error'); }
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
});
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
wss.on('connection', ws => {
  const c = new Client(ws); clients.add(c);
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!isObj(m)) return;
    try { handle(c, m); } catch (e) { console.error(e); c.send({ t: 'res', id: m.id, ok: false, err: 'server_error' }); }
  });
  ws.on('close', () => { clients.delete(c); for (const name of [...c.presence.keys()]) leaveRoom(c, name); });
});
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 20000);

load();
server.listen(PORT, () => console.log(`goka-shokai server on :${PORT}`));
process.on('SIGTERM', () => { writeNow(); process.exit(0); });
