// claude.ai の claude.use('db' | 'room' | 'user') と同じ形の仕組みを、自前サーバーにつないで用意する。
// ゲーム本体（seigokaku.html）は書き換えずにそのまま動く。
(function () {
  'use strict';
  if (window.claude && typeof window.claude.use === 'function') return;

  const rand = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); const s = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; return [...a].map(x => s[x % 62]).join(''); };
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };
  const ID_KEY = 'goka.server.id', ADMIN_KEY = 'goka.server.admin';
  let ident = null;
  try { ident = JSON.parse(ls.get(ID_KEY) || 'null'); } catch (e) {}
  const newIdent = () => { ident = { uid: 'u_' + rand(22), secret: rand(40) }; ls.set(ID_KEY, JSON.stringify(ident)); };
  if (!ident || !ident.uid || !ident.secret) newIdent();
  // 管理者キー: URL の末尾に #admin=キー を付けて一度開くと、この端末に記憶する
  const hm = /^#admin=(.+)$/.exec(location.hash);
  if (hm) { ls.set(ADMIN_KEY, decodeURIComponent(hm[1])); history.replaceState(null, '', location.pathname + location.search); }
  const adminKey = ls.get(ADMIN_KEY) || '';

  // ---------- ログイン（メールのコード、またはメールのリンク） ----------
  const AUTH_KEY = 'goka.auth';
  let tok = null;
  try { tok = JSON.parse(ls.get(AUTH_KEY) || 'null'); } catch (e) {}
  const saveTok = j => { tok = j ? { a: j.access_token, r: j.refresh_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 } : null; if (tok) ls.set(AUTH_KEY, JSON.stringify(tok)); else { try { localStorage.removeItem(AUTH_KEY); } catch (e) {} } };
  // メールのリンクから戻ったとき: #access_token=...&refresh_token=...
  if (/access_token=/.test(location.hash)) {
    const q = new URLSearchParams(location.hash.slice(1));
    if (q.get('access_token')) saveTok({ access_token: q.get('access_token'), refresh_token: q.get('refresh_token'), expires_in: q.get('expires_in') });
    history.replaceState(null, '', location.pathname + location.search);
  }
  const post = async (p, body, auth) => {
    const r = await fetch(p, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer ' + auth } : {}) }, body: JSON.stringify(body) });
    let j = {}; try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw { code: j.err || ('http_' + r.status), status: r.status };
    return j;
  };
  async function freshToken() {
    if (!tok) return null;
    if (tok.exp - Date.now() > 120000) return tok.a;
    try { saveTok(await post('/api/auth/refresh', { refresh_token: tok.r })); return tok.a; }
    catch (e) { if (e.status === 401 || e.status === 400) saveTok(null); return tok && tok.a; }
  }
  // 写真を768px以内のJPEGに縮める
  async function shrink(file) {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 768 / Math.max(bmp.width, bmp.height)), w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h; cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
    return cv.toDataURL('image/jpeg', 0.86);
  }
  const account = Object.freeze({
    info: () => helloInfo ? { on: !!helloInfo.auth, avatarOn: !!helloInfo.avatarOn, acct: helloInfo.acct || null } : { on: false, avatarOn: false, acct: null },
    start: email => post('/api/auth/start', { email }),
    verify: async (email, code) => { saveTok(await post('/api/auth/verify', { email, code })); location.reload(); },
    logout: () => { saveTok(null); location.reload(); },
    setName: async name => post('/api/profile', { name }, await freshToken()),
    avatar: async file => { const image = await shrink(file); return post('/api/avatar', { image }, await freshToken()); },
  });

  // ---------- 接続 ----------
  let ws = null, open = false, nextId = 1, retry = 0, helloInfo = null;
  const pending = new Map();   // id -> {resolve, reject, msg}
  const outbox = [];           // 接続前に送るもの
  const subs = new Map();      // subId -> {msg, fn, err}
  const rooms = new Map();     // name -> RoomImpl
  let readyResolve; const ready = new Promise(r => { readyResolve = r; });

  function rawSend(m) { if (open && ws && ws.readyState === 1) { ws.send(JSON.stringify(m)); return true; } return false; }
  function call(op, args) {
    return new Promise((resolve, reject) => {
      const id = nextId++; const msg = { ...args, op, id };
      pending.set(id, { resolve, reject, msg });
      if (!helloInfo || !rawSend(msg)) outbox.push(msg);
    });
  }
  function connect() {
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    ws = new WebSocket(url);
    ws.onopen = () => { open = true; retry = 0; freshToken().then(hello, hello); };
    ws.onclose = () => {
      open = false; helloInfo = null;
      // 返事の来ていない依頼は、つながり直したら送り直す
      for (const p of pending.values()) if (!outbox.includes(p.msg)) outbox.push(p.msg);
      setTimeout(connect, Math.min(10000, 500 * 2 ** retry++));
    };
    ws.onerror = () => {};
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'res') {
        if (m.id === 'hello') return onHello(m);
        const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
        m.ok ? p.resolve(m.data) : p.reject({ code: m.err, message: m.err });
      } else if (m.t === 'snap') {
        const s = subs.get(m.sub); if (s) try { s.fn(m); } catch (e) { console.error(e); }
      } else if (m.t === 'peers') {
        const r = rooms.get(m.room); if (r) r._peers(m.peers);
      } else if (m.t === 'ev') {
        const r = rooms.get(m.room); if (r) r._event(m);
      }
    };
  }
  function hello() { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ op: 'hello', id: 'hello', uid: ident.uid, secret: ident.secret, admin: adminKey, token: tok ? tok.a : undefined })); }
  function onHello(m) {
    if (!m.ok) { if (m.err === 'bad_secret' || m.err === 'bad_identity') { newIdent(); hello(); } return; }
    helloInfo = m.data;
    if (helloInfo.tokenBad) saveTok(null);
    // つながり直したときは、購読と部屋をやり直す
    for (const [id, s] of subs) rawSend({ ...s.msg, id: 'r' + id });
    for (const r of rooms.values()) r._rejoin();
    const q = outbox.splice(0); for (const msg of q) if (pending.has(msg.id)) rawSend(msg);
    readyResolve(helloInfo);
  }

  // ---------- db ----------
  const docSnap = (path, m) => ({ id: path.split('/').pop(), exists: !!m.exists, data: () => m.data == null ? undefined : JSON.parse(JSON.stringify(m.data)) });
  const colSnap = m => {
    const docs = (m.docs || []).map(d => ({ id: d.id, exists: true, data: () => JSON.parse(JSON.stringify(d.data)) }));
    return { docs, size: docs.length, empty: !docs.length, forEach: f => docs.forEach(f) };
  };
  function subscribe(msg, onSnap, onErr) {
    const sid = 's' + nextId++;
    const full = { ...msg, op: 'sub', sub: sid };
    subs.set(sid, { msg: full, fn: onSnap });
    call('sub', { ...msg, sub: sid }).catch(e => { subs.delete(sid); if (onErr) onErr(e); });
    return () => { if (subs.delete(sid)) call('unsub', { sub: sid }).catch(() => {}); };
  }
  function docRef(path) {
    return {
      id: path.split('/').pop(), path,
      get: () => call('get', { path }).then(m => docSnap(path, m)),
      set: data => call('set', { path, data }),
      update: data => call('update', { path, data }),
      delete: () => call('delete', { path }),
      onSnapshot: (fn, err) => subscribe({ path }, m => fn(docSnap(path, m)), err),
    };
  }
  function query(path, where, limit) {
    return {
      path,
      doc: id => docRef(path + '/' + id),
      where: (f, op, v) => query(path, [...where, [f, op, v]], limit),
      limit: n => query(path, where, n),
      orderBy: () => query(path, where, limit),
      get: () => call('qget', { path, where, limit }).then(docs => colSnap({ docs })),
      onSnapshot: (fn, err) => subscribe({ path, where, limit }, m => fn(colSnap(m)), err),
    };
  }
  const db = Object.freeze({ doc: docRef, collection: p => query(p, [], 0) });

  // ---------- room ----------
  function makeRoom(name, isLobby) {
    let peers = [], peerFns = [], evFns = new Map(), mine = {};
    const me = () => helloInfo && helloInfo.peer;
    const mark = ps => ps.map(p => ({ ...p, sameTab: p.peer === me() }));
    const impl = {
      _peers(ps) { peers = ps; const ch = { peers: mark(ps) }; peerFns.forEach(f => { try { f(ch); } catch (e) { console.error(e); } }); },
      _event(m) { (evFns.get(m.topic) || []).forEach(f => { try { f({ topic: m.topic, peer: m.peer, data: m.data }); } catch (e) { console.error(e); } }); },
      _rejoin() { rawSend({ op: 'join', id: 'j' + nextId++, room: name }); if (Object.keys(mine).length) rawSend({ op: 'presence', id: 'p' + nextId++, room: name, patch: mine }); },
    };
    rooms.set(name, impl);
    const joined = call('join', { room: name }).then(r => { impl._peers(r.peers); });
    const api = {
      presence: patch => { mine = { ...mine, ...patch }; return joined.then(() => call('presence', { room: name, patch })); },
      onPeers: (fn) => { peerFns.push(fn); if (peers.length) fn({ peers: mark(peers) }); return () => { peerFns = peerFns.filter(f => f !== fn); }; },
      peers: () => mark(peers),
      emit: (topic, data) => joined.then(() => call('emit', { room: name, topic, data })),
      on: (topic, fn) => { if (!evFns.has(topic)) evFns.set(topic, []); evFns.get(topic).push(fn); return () => evFns.set(topic, evFns.get(topic).filter(f => f !== fn)); },
    };
    if (isLobby) api.join = async n => { const r = makeRoom('g:' + String(n), false); return r; };
    else api.leave = () => { rooms.delete(name); return call('leave', { room: name }).catch(() => {}); };
    return Object.freeze(api);
  }
  let lobby = null;

  // ---------- user ----------
  const user = Object.freeze({
    id: async () => (helloInfo && helloInfo.uid) || ident.uid,
    me: async () => ({ id: (helloInfo && helloInfo.uid) || ident.uid, name: (helloInfo && helloInfo.acct && helloInfo.acct.name) || '', guest: false }),
    isOwner: () => !!(helloInfo && helloInfo.admin),
    canEdit: async () => !!(helloInfo && helloInfo.admin),
    can: () => null,
    profiles: async ids => Object.fromEntries((ids || []).map(i => [i, { id: i, name: '' }])),
  });

  connect();
  const timeout = new Promise(r => setTimeout(() => r(null), 10000));
  async function use(name) {
    const info = await Promise.race([ready, timeout]);
    if (!info) return null;
    if (name === 'db') return db;
    if (name === 'user') return user;
    if (name === 'room') { if (!lobby) lobby = makeRoom('lobby', true); return lobby; }
    return null;
  }
  window.claude = Object.freeze({ use, server: true, account });
})();
