#!/usr/bin/env node
'use strict';
// ClassMates — school social network. One file, zero dependencies (Node 16+).
// Run:  node server.js     Then open http://localhost:3000
// Env:  PORT=3000  HOST=0.0.0.0  SCHOOL_CODE=school2026 (empty = no code)
//       ADMIN_CODE=...  (secret code that creates an admin/teacher account at registration)
//       MIN_VOTES=3 (min. number of ratings to appear in "best in subject")  DATA_DIR=./data

const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const SCHOOL_CODE = process.env.SCHOOL_CODE === undefined ? 'school2026' : process.env.SCHOOL_CODE;
const ADMIN_CODE = process.env.ADMIN_CODE || 'T-95RA-34EY-5WRP';
const MIN_VOTES = +process.env.MIN_VOTES || 3;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const UP = path.join(DATA, 'uploads'), DBF = path.join(DATA, 'db.json');
fs.mkdirSync(UP, { recursive: true });

let db = { users: {}, sessions: {}, posts: [], friends: {}, rooms: {}, ratings: {}, notifs: {}, clubs: {}, reports: [], seq: 1 };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DBF, 'utf8'))); } catch (e) {}
db.posts.forEach(p => { p.comments = p.comments || []; });
let saveT = null;
function saveNow() { const tmp = DBF + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, DBF); }
function save() { if (saveT) return; saveT = setTimeout(() => { saveT = null; saveNow(); }, 300); }
process.on('SIGINT', () => { try { saveNow(); } catch (e) {} process.exit(0); });
process.on('SIGTERM', () => { try { saveNow(); } catch (e) {} process.exit(0); });

const SUBJECTS = ['math', 'rus', 'lit', 'eng', 'phys', 'chem', 'bio', 'hist', 'geo', 'cs', 'arm', 'armh', 'soc', 'art', 'music', 'pe'];
const COLORS = ['#ffc8dd', '#bde0fe', '#b8ead6', '#ffd6a5', '#cdb4db', '#fdffb6', '#a2d2ff', '#caffbf'];
const rid = n => crypto.randomBytes(n).toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const safeEq = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());

class E extends Error { constructor(code, status) { super(code); this.code = code; this.status = status || 400; } }
const bad = (code, status) => { throw new E(code, status); };
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ---------- users, roles, bans ----------
const isAdmin = u => !!u && u.role === 'admin';
function banInfo(u) {
  const b = u && u.banned;
  if (!b) return null;
  if (b.until && b.until <= Date.now()) { delete u.banned; save(); return null; }
  return b;
}
const isBanned = u => !!banInfo(u);
const pub = u => ({ id: u.id, username: u.username, first: u.first, last: u.last, cls: u.cls, color: u.color, admin: isAdmin(u) });
const full = u => Object.assign(pub(u), { bio: u.bio || '', dream: u.dream || '', goal: u.goal || '', top: u.top || [] });
const pair = (a, b) => [a, b].sort().join('|');
function rel(me, other) {
  if (me === other) return 'self';
  const f = db.friends[pair(me, other)];
  if (!f) return 'none';
  if (f.st === 'a') return 'friend';
  return f.from === me ? 'outgoing' : 'incoming';
}
const canChat = (a, b) => a.id !== b.id && !isBanned(b) && (isAdmin(a) || isAdmin(b) || a.cls === b.cls || rel(a.id, b.id) === 'friend');
const dmRoom = (a, b) => 'dm:' + [a, b].sort().join(':');
const nameOf = u => (u ? u.first + ' ' + u.last : '?');

// ---------- notifications ----------
function notify(uid, n) {
  if (!db.users[uid]) return;
  const a = (db.notifs[uid] = db.notifs[uid] || []);
  a.unshift(Object.assign({ id: db.seq++, ts: Date.now(), read: false }, n));
  if (a.length > 80) a.length = 80;
  save();
}
function notifView(n) {
  const f = n.from && db.users[n.from];
  return { id: n.id, type: n.type, ts: n.ts, read: n.read, from: f ? { id: f.id, name: nameOf(f) } : null, post: n.post || null, club: n.club || null, clubName: n.clubName || '', task: n.task || '', pts: n.pts || 0, badge: n.badge || '', text: n.text || '' };
}

// ---------- achievements ----------
const BADGES = [['first_post', 'posts', 1], ['writer', 'posts', 10], ['photographer', 'photos', 5], ['popular', 'likes', 20], ['commentator', 'comments', 10], ['social', 'friends', 5], ['talker', 'msgs', 50], ['joiner', 'clubs', 1], ['clubstar', 'clubpts', 50], ['achiever', 'tasks', 5], ['recognized', 'votes', 10], ['streak7', 'streak', 7]];
function stats(u) {
  let posts = 0, photos = 0, likes = 0, comments = 0;
  for (const p of db.posts) {
    if (p.uid === u.id && !p.hidden) { posts++; if (p.img) photos++; likes += p.likes.filter(x => x !== u.id).length; }
    for (const c of p.comments) if (c.uid === u.id) comments++;
  }
  let friends = 0;
  for (const f of Object.values(db.friends)) if (f.st === 'a' && (f.from === u.id || f.to === u.id)) friends++;
  let clubs = 0, clubpts = 0;
  for (const c of Object.values(db.clubs)) if (c.members[u.id]) { clubs++; clubpts += c.points[u.id] || 0; }
  let votes = 0; const r = db.ratings[u.id] || {};
  for (const s in r) votes += Object.keys(r[s]).length;
  return { posts, photos, likes, comments, friends, msgs: u.msgCount || 0, clubs, clubpts, votes, streak: u.streak || 0, tasks: u.tasksDone || 0 };
}
function checkBadges(u) {
  if (!u) return;
  const st = stats(u); u.badges = u.badges || {};
  for (const [id, k, g] of BADGES) if (st[k] >= g && !u.badges[id]) { u.badges[id] = Date.now(); notify(u.id, { type: 'badge', badge: id }); save(); }
}
function badgeList(u) {
  const st = stats(u);
  return BADGES.map(([id, k, g]) => ({ id, have: !!(u.badges || {})[id], progress: Math.min(st[k], g), goal: g }));
}
function touchDay(u) {
  const d = new Date().toISOString().slice(0, 10);
  if (u.lastDay === d) return;
  const y = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  u.streak = u.lastDay === y ? (u.streak || 0) + 1 : 1; u.lastDay = d;
  checkBadges(u); save();
}
const actScore = u => { const s = stats(u); return s.posts * 3 + s.comments * 2 + s.likes + s.friends * 2 + Object.keys(u.badges || {}).length * 5; };

// ---------- ratings & boards ----------
function ratingRow(uid, s, meId) {
  const o = (db.ratings[uid] || {})[s] || {}, v = Object.values(o);
  return { avg: v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0, count: v.length, mine: o[meId] || 0 };
}
function board(s, cls) {
  return Object.values(db.users).filter(u => !isBanned(u) && !isAdmin(u) && (!cls || u.cls === cls))
    .map(u => { const r = ratingRow(u.id, s, ''); return { u, avg: r.avg, count: r.count }; })
    .filter(x => x.count >= MIN_VOTES)
    .sort((a, b) => b.avg - a.avg || b.count - a.count || a.u.first.localeCompare(b.u.first));
}
function awards(u) {
  const out = [];
  for (const s of SUBJECTS) {
    const bc = board(s, u.cls);
    if (bc[0] && bc[0].u.id === u.id) { const bs = board(s, null); out.push({ subject: s, school: !!(bs[0] && bs[0].u.id === u.id) }); }
  }
  return out;
}

// ---------- posts & comments ----------
function canSeePost(p, me) {
  if (isAdmin(me)) return true;
  if (p.hidden) return false;
  const a = db.users[p.uid];
  return !(a && isBanned(a));
}
function postView(p, me) {
  const u = db.users[p.uid] || { first: '?', last: '', username: '?', color: '#ddd', cls: '' };
  return { id: p.id, uid: p.uid, name: nameOf(u), first: u.first, last: u.last, color: u.color, cls: u.cls, admin: isAdmin(u), text: p.text, img: p.img || null, ts: p.ts, likes: p.likes.length, liked: p.likes.includes(me.id), mine: p.uid === me.id, comments: p.comments.filter(c => !c.hidden).length, hidden: !!p.hidden };
}
function cView(c, me) {
  const u = db.users[c.uid] || { first: '?', last: '', color: '#ddd', cls: '' };
  return { id: c.id, uid: c.uid, name: nameOf(u), first: u.first, last: u.last, color: u.color, cls: u.cls, admin: isAdmin(u), text: c.text, ts: c.ts, mine: c.uid === me.id, hidden: !!c.hidden };
}
const commentsOf = (p, me) => p.comments.filter(c => !c.hidden || isAdmin(me)).map(c => cView(c, me));
function saveImg(data) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+\/=]+)$/.exec(data || '');
  if (!m) bad('bad_image');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 3e6 || buf.length < 100 || buf[0] !== 0xFF || buf[1] !== 0xD8) bad('bad_image');
  const name = rid(12) + '.jpg';
  fs.writeFileSync(path.join(UP, name), buf);
  return name;
}

// ---------- chats ----------
function roomInfo(me, room) {
  const arr = db.rooms[room] || [], seen = (me.reads || {})[room] || 0;
  let unread = 0;
  for (let i = arr.length - 1; i >= 0 && arr[i].id > seen; i--) if (arr[i].uid !== me.id) unread++;
  const l = arr[arr.length - 1];
  return { lastMsg: l ? { text: l.text, ts: l.ts, mine: l.uid === me.id } : null, unread };
}
function chatSummary(me) {
  const contacts = Object.values(db.users).filter(u => canChat(me, u)).slice(0, 400).map(u => Object.assign(pub(u), { rel: rel(me.id, u.id) }, roomInfo(me, dmRoom(me.id, u.id))));
  contacts.sort((a, b) => ((b.lastMsg && b.lastMsg.ts) || 0) - ((a.lastMsg && a.lastMsg.ts) || 0) || a.first.localeCompare(b.first));
  const clubs = Object.values(db.clubs).filter(c => c.members[me.id]).map(c => Object.assign({ id: c.id, name: c.name, emoji: c.emoji }, roomInfo(me, 'club:' + c.id)));
  return { cls: me.cls, classRoom: roomInfo(me, 'class:' + me.cls), contacts, clubs };
}
function chatRoom(me, spec) {
  if (spec === 'class') return { room: 'class:' + me.cls, cls: me.cls };
  if (spec.startsWith('club/')) {
    const c = db.clubs[spec.slice(5)];
    if (!c) bad('not_found', 404);
    if (!c.members[me.id] && !isAdmin(me)) bad('forbidden', 403);
    return { room: 'club:' + c.id, club: { id: c.id, name: c.name, emoji: c.emoji } };
  }
  const peer = db.users[spec.slice(2)];
  if (!peer) bad('not_found', 404);
  if (!canChat(me, peer)) bad('forbidden', 403);
  return { room: dmRoom(me.id, peer.id), peer: pub(peer) };
}

// ---------- clubs ----------
const getClub = id => { const c = db.clubs[id]; if (!c) bad('not_found', 404); return c; };
const clubRole = (c, u) => c.members[u.id] || (isAdmin(u) ? 'admin' : null);
const isMod = (c, u) => { const r = clubRole(c, u); return r === 'owner' || r === 'mod' || r === 'admin'; };
const needMod = (c, u) => { if (!isMod(c, u)) bad('forbidden', 403); };
const clubBrief = (c, me) => ({ id: c.id, name: c.name, emoji: c.emoji, desc: c.desc, members: Object.keys(c.members).length, total: c.total, role: c.members[me.id] || null });

// ---------- moderation ----------
const adm = me => { if (!isAdmin(me)) bad('forbidden', 403); };
function findTarget(postId, commentId) {
  const p = db.posts.find(x => x.id === postId);
  if (!p) return null;
  if (!commentId) return { p, t: p };
  const c = p.comments.find(x => x.id === commentId);
  return c ? { p, t: c } : null;
}
function setHidden(postId, commentId, hide, notifyAuthor) {
  const f = findTarget(postId, commentId);
  if (!f) bad('not_found', 404);
  const was = !!f.t.hidden;
  f.t.hidden = !!hide;
  if (hide && !was && notifyAuthor) notify(f.t.uid, { type: 'hidden' });
  save();
}
function reportView(r) {
  const f = findTarget(r.post, r.comment);
  const au = f && db.users[f.t.uid], by = db.users[r.by];
  return { id: r.id, type: r.type, post: r.post, comment: r.comment, reason: r.reason, note: r.note, ts: r.ts, status: r.status, by: nameOf(by), gone: !f, hidden: !!(f && f.t.hidden), text: f ? f.t.text : '', img: f && r.type === 'post' ? f.p.img || null : null, author: au ? { id: au.id, name: nameOf(au), banned: isBanned(au), admin: isAdmin(au) } : null };
}

// ---------- brute-force guard ----------
const fails = {};
const blocked = ip => { const t = fails[ip]; return t && Date.now() - t.t < 6e5 && t.n >= 15; };
const fail = ip => { let t = fails[ip]; if (!t || Date.now() - t.t >= 6e5) t = fails[ip] = { n: 0, t: Date.now() }; t.n++; };

// ---------- sessions ----------
function newSession(res, uid) {
  const token = rid(24);
  db.sessions[sha(token)] = { uid, ts: Date.now() };
  res.setHeader('Set-Cookie', 'sid=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000');
  save();
}
function getMe(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{48})/.exec(req.headers.cookie || '');
  if (!m) return null;
  const s = db.sessions[sha(m[1])];
  return s ? db.users[s.uid] || null : null;
}

// ---------- routes ----------
const routes = [];
const R = (method, re, fn, open) => routes.push([method, new RegExp('^' + re + '$'), fn, !!open]);
const nameOk = v => { const s = str(v, 30); if (!/^\p{L}[\p{L}\-' ]*$/u.test(s)) bad('bad_name'); return s; };
const clsOk = v => { const s = str(v, 6).replace(/\s+/g, '').toUpperCase(); if (!/^[\p{L}\p{N}\-]{1,6}$/u.test(s)) bad('bad_class'); return s; };

R('GET', '/api/config', () => ({ codeRequired: !!SCHOOL_CODE }), true);

R('POST', '/api/register', ({ req, res, body }) => {
  const ip = req.socket.remoteAddress;
  if (blocked(ip)) bad('too_many', 429);
  const ac = str(body.admin, 80);
  let role = null;
  if (ac) { if (!safeEq(ac, ADMIN_CODE)) { fail(ip); bad('bad_admin_code', 403); } role = 'admin'; }
  else if (SCHOOL_CODE && str(body.code, 50).toLowerCase() !== SCHOOL_CODE.toLowerCase()) { fail(ip); bad('bad_code', 403); }
  const username = str(body.username, 20).toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(username)) bad('bad_username');
  const first = nameOk(body.first), last = nameOk(body.last);
  const cls = role === 'admin' && !str(body.cls, 6) ? 'STAFF' : clsOk(body.cls);
  const pw = body.password;
  if (typeof pw !== 'string' || pw.length < 6 || pw.length > 100) bad('weak_password');
  if (Object.values(db.users).some(u => u.username === username)) bad('username_taken', 409);
  const id = rid(4), salt = rid(16);
  db.users[id] = { id, username, first, last, cls, role, salt, hash: hashPw(pw, salt), bio: '', dream: '', goal: '', top: [], color: COLORS[Math.floor(Math.random() * COLORS.length)], reads: {}, badges: {}, created: Date.now() };
  newSession(res, id);
  return { ok: true };
}, true);

R('POST', '/api/login', ({ req, res, body }) => {
  const ip = req.socket.remoteAddress;
  if (blocked(ip)) bad('too_many', 429);
  const username = str(body.username, 20).toLowerCase();
  const u = Object.values(db.users).find(x => x.username === username);
  const salt = u ? u.salt : 'x'.repeat(32);
  const h = Buffer.from(hashPw(String(body.password || '').slice(0, 100), salt));
  const ok = u && crypto.timingSafeEqual(h, Buffer.from(u.hash));
  if (!ok) { fail(ip); bad('bad_credentials', 401); }
  delete fails[ip];
  newSession(res, u.id);
  return { ok: true };
}, true);

R('POST', '/api/logout', ({ req, res }) => {
  const m = /(?:^|;\s*)sid=([a-f0-9]{48})/.exec(req.headers.cookie || '');
  if (m) { delete db.sessions[sha(m[1])]; save(); }
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  return { ok: true };
}, true);

R('GET', '/api/me', ({ me }) => ({ me: full(me), ban: banInfo(me) }));

R('PUT', '/api/me', ({ me, body }) => {
  me.first = nameOk(body.first); me.last = nameOk(body.last);
  me.cls = clsOk(body.cls);
  me.bio = str(body.bio, 500); me.dream = str(body.dream, 80); me.goal = str(body.goal, 100);
  const top = Array.isArray(body.top) ? body.top : [];
  me.top = [...new Set(top.filter(s => SUBJECTS.includes(s)))].slice(0, 3);
  if (COLORS.includes(body.color)) me.color = body.color;
  save();
  return { me: full(me) };
});

R('GET', '/api/users', ({ me, q }) => {
  const s = (q.get('q') || '').trim().toLowerCase().slice(0, 40);
  const mine = q.get('mine') === '1';
  const list = Object.values(db.users).filter(u => u.id !== me.id && (isAdmin(me) || !isBanned(u)) && (!mine || u.cls === me.cls) &&
    (!s || (u.first + ' ' + u.last + ' ' + u.username + ' ' + u.cls).toLowerCase().includes(s)));
  list.sort((a, b) => a.cls.localeCompare(b.cls) || a.first.localeCompare(b.first));
  return { users: list.slice(0, 100).map(u => Object.assign(pub(u), { rel: rel(me.id, u.id) })) };
});

R('GET', '/api/user/([a-f0-9]{8})', ({ me, m }) => {
  const u = db.users[m[1]];
  if (!u || (isBanned(u) && !isAdmin(me) && u.id !== me.id)) bad('not_found', 404);
  const ratings = {};
  SUBJECTS.forEach(s => { ratings[s] = ratingRow(u.id, s, me.id); });
  const friendsCount = Object.values(db.friends).filter(f => f.st === 'a' && (f.from === u.id || f.to === u.id)).length;
  const clubs = Object.values(db.clubs).filter(c => c.members[u.id]).map(c => ({ id: c.id, name: c.name, emoji: c.emoji }));
  return {
    user: full(u), rel: rel(me.id, u.id), canChat: canChat(me, u), ratings, friendsCount, clubs,
    badges: badgeList(u), awards: isAdmin(u) ? [] : awards(u), banned: isAdmin(me) ? banInfo(u) : null,
    posts: db.posts.filter(p => p.uid === u.id && canSeePost(p, me)).slice(0, 50).map(p => postView(p, me))
  };
});

R('POST', '/api/rate', ({ me, body }) => {
  const t = db.users[body.target], v = Math.round(+body.value);
  if (!t) bad('not_found', 404);
  if (t.id === me.id) bad('own_profile');
  if (!SUBJECTS.includes(body.subject) || !(v >= 0 && v <= 5)) bad('bad_request');
  const r = (db.ratings[t.id] = db.ratings[t.id] || {});
  const o = (r[body.subject] = r[body.subject] || {});
  if (v === 0) delete o[me.id]; else o[me.id] = v;
  checkBadges(t);
  save();
  return { row: ratingRow(t.id, body.subject, me.id) };
});

// ----- posts, likes, comments -----
R('GET', '/api/feed', ({ me }) => ({ posts: db.posts.filter(p => canSeePost(p, me)).slice(0, 60).map(p => postView(p, me)) }));

R('POST', '/api/posts', ({ me, body }) => {
  const text = str(body.text, 1000);
  if (!text && !body.img) bad('bad_request');
  const img = body.img ? saveImg(body.img) : null;
  db.posts.unshift({ id: rid(6), uid: me.id, text, img, ts: Date.now(), likes: [], comments: [] });
  checkBadges(me);
  save();
  return { ok: true };
});

R('GET', '/api/posts/([a-f0-9]{12})', ({ me, m }) => {
  const p = db.posts.find(x => x.id === m[1]);
  if (!p || !canSeePost(p, me)) bad('not_found', 404);
  return { post: postView(p, me), comments: commentsOf(p, me) };
});

R('DELETE', '/api/posts/([a-f0-9]{12})', ({ me, m }) => {
  const i = db.posts.findIndex(p => p.id === m[1]);
  if (i < 0) bad('not_found', 404);
  if (db.posts[i].uid !== me.id && !isAdmin(me)) bad('forbidden', 403);
  const p = db.posts.splice(i, 1)[0];
  if (p.img) fs.unlink(path.join(UP, p.img), () => {});
  save();
  return { ok: true };
});

R('POST', '/api/posts/([a-f0-9]{12})/like', ({ me, m }) => {
  const p = db.posts.find(x => x.id === m[1]);
  if (!p || !canSeePost(p, me)) bad('not_found', 404);
  const i = p.likes.indexOf(me.id);
  if (i >= 0) p.likes.splice(i, 1);
  else {
    p.likes.push(me.id);
    p.nl = p.nl || [];
    if (p.uid !== me.id && !p.nl.includes(me.id)) { p.nl.push(me.id); notify(p.uid, { type: 'like', from: me.id, post: p.id }); }
    checkBadges(db.users[p.uid]);
  }
  save();
  return { post: postView(p, me) };
});

R('POST', '/api/posts/([a-f0-9]{12})/comments', ({ me, m, body }) => {
  const p = db.posts.find(x => x.id === m[1]);
  if (!p || !canSeePost(p, me)) bad('not_found', 404);
  const text = str(body.text, 300);
  if (!text) bad('bad_request');
  if (p.comments.length >= 500) bad('bad_request');
  p.comments.push({ id: rid(5), uid: me.id, text, ts: Date.now() });
  if (p.uid !== me.id) notify(p.uid, { type: 'comment', from: me.id, post: p.id, text: text.slice(0, 60) });
  checkBadges(me);
  save();
  return { post: postView(p, me), comments: commentsOf(p, me) };
});

R('DELETE', '/api/posts/([a-f0-9]{12})/comments/([a-f0-9]{10})', ({ me, m }) => {
  const p = db.posts.find(x => x.id === m[1]);
  if (!p) bad('not_found', 404);
  const i = p.comments.findIndex(c => c.id === m[2]);
  if (i < 0) bad('not_found', 404);
  if (p.comments[i].uid !== me.id && !isAdmin(me)) bad('forbidden', 403);
  p.comments.splice(i, 1);
  save();
  return { ok: true };
});

// ----- friends -----
R('GET', '/api/friends', ({ me }) => {
  const out = { friends: [], incoming: [], outgoing: [] };
  Object.values(db.friends).forEach(f => {
    if (f.from !== me.id && f.to !== me.id) return;
    const u = db.users[f.from === me.id ? f.to : f.from];
    if (!u) return;
    (f.st === 'a' ? out.friends : f.from === me.id ? out.outgoing : out.incoming).push(pub(u));
  });
  return out;
});

R('POST', '/api/friends/([a-f0-9]{8})', ({ me, m }) => {
  const o = db.users[m[1]];
  if (!o) bad('not_found', 404);
  if (o.id === me.id) bad('bad_request');
  const k = pair(me.id, o.id), f = db.friends[k];
  if (!f) { db.friends[k] = { from: me.id, to: o.id, st: 'p' }; notify(o.id, { type: 'friend_req', from: me.id }); }
  else if (f.st === 'p' && f.to === me.id) { f.st = 'a'; notify(o.id, { type: 'friend_acc', from: me.id }); checkBadges(me); checkBadges(o); }
  save();
  return { rel: rel(me.id, o.id) };
});

R('DELETE', '/api/friends/([a-f0-9]{8})', ({ me, m }) => {
  delete db.friends[pair(me.id, m[1])];
  save();
  return { ok: true };
});

// ----- chats -----
R('GET', '/api/chats', ({ me }) => chatSummary(me));

R('GET', '/api/badges', ({ me }) => {
  const s = chatSummary(me);
  const unread = s.classRoom.unread + s.contacts.reduce((n, c) => n + c.unread, 0) + s.clubs.reduce((n, c) => n + c.unread, 0);
  const requests = Object.values(db.friends).filter(f => f.st === 'p' && f.to === me.id).length;
  const notifs = (db.notifs[me.id] || []).filter(n => !n.read).length;
  const reports = isAdmin(me) ? db.reports.filter(r => r.status === 'open').length : 0;
  return { unread, requests, notifs, reports };
});

R('GET', '/api/chat/(class|u/[a-f0-9]{8}|club/[a-f0-9]{8})', ({ me, m, q }) => {
  const r = chatRoom(me, m[1]);
  const arr = db.rooms[r.room] || [], after = +q.get('after') || 0;
  const list = after ? arr.filter(x => x.id > after) : arr.slice(-80);
  if (arr.length) {
    me.reads = me.reads || {};
    const lastId = arr[arr.length - 1].id;
    if (me.reads[r.room] !== lastId) { me.reads[r.room] = lastId; save(); }
  }
  const msgs = list.map(x => { const u = db.users[x.uid]; return { id: x.id, uid: x.uid, name: nameOf(u), color: u ? u.color : '#ddd', text: x.text, ts: x.ts }; });
  return { msgs, peer: r.peer, cls: r.cls, club: r.club };
});

R('POST', '/api/chat/(class|u/[a-f0-9]{8}|club/[a-f0-9]{8})', ({ me, m, body }) => {
  const r = chatRoom(me, m[1]);
  const text = str(body.text, 1000);
  if (!text) bad('bad_request');
  const arr = (db.rooms[r.room] = db.rooms[r.room] || []);
  const msg = { id: db.seq++, uid: me.id, text, ts: Date.now() };
  arr.push(msg);
  if (arr.length > 3000) arr.splice(0, arr.length - 3000);
  me.reads = me.reads || {};
  me.reads[r.room] = msg.id;
  me.msgCount = (me.msgCount || 0) + 1;
  checkBadges(me);
  save();
  return { msg: { id: msg.id, uid: me.id, name: nameOf(me), color: me.color, text, ts: msg.ts } };
});

// ----- notifications -----
R('GET', '/api/notifs', ({ me }) => ({ notifs: (db.notifs[me.id] || []).map(notifView) }));
R('POST', '/api/notifs/read', ({ me }) => { (db.notifs[me.id] || []).forEach(n => { n.read = true; }); save(); return { ok: true }; });

// ----- rankings -----
R('GET', '/api/rank', ({ me, q }) => {
  const type = q.get('type');
  if (type === 'clubs') {
    return { rows: Object.values(db.clubs).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)).slice(0, 30).map((c, i) => ({ rank: i + 1, id: c.id, name: c.name, emoji: c.emoji, total: c.total, members: Object.keys(c.members).length })) };
  }
  const cls = q.get('scope') === 'school' ? null : me.cls;
  if (type === 'activity') {
    const rows = Object.values(db.users).filter(u => !isAdmin(u) && !isBanned(u) && (!cls || u.cls === cls)).map(u => ({ user: pub(u), score: actScore(u), badges: Object.keys(u.badges || {}).length }))
      .sort((a, b) => b.score - a.score || a.user.first.localeCompare(b.user.first)).slice(0, 20).map((r, i) => Object.assign({ rank: i + 1 }, r));
    return { rows };
  }
  const s = q.get('subject');
  if (!SUBJECTS.includes(s)) bad('bad_request');
  return { min: MIN_VOTES, rows: board(s, cls).slice(0, 20).map((x, i) => ({ rank: i + 1, user: pub(x.u), avg: x.avg, count: x.count })) };
});

// ----- clubs -----
R('GET', '/api/clubs', ({ me, q }) => {
  const s = (q.get('q') || '').toLowerCase().slice(0, 40);
  const list = Object.values(db.clubs).filter(c => !s || c.name.toLowerCase().includes(s))
    .sort((a, b) => (!!b.members[me.id] - !!a.members[me.id]) || b.total - a.total || a.name.localeCompare(b.name)).slice(0, 100).map(c => clubBrief(c, me));
  return { clubs: list };
});

R('POST', '/api/clubs', ({ me, body }) => {
  const name = str(body.name, 30);
  if (name.length < 3) bad('bad_club');
  if (Object.values(db.clubs).some(c => c.name.toLowerCase() === name.toLowerCase())) bad('name_taken', 409);
  if (Object.values(db.clubs).filter(c => c.owner === me.id).length >= 3) bad('club_limit');
  const id = rid(4);
  db.clubs[id] = { id, name, emoji: str(body.emoji, 8) || '🎯', desc: str(body.desc, 200), owner: me.id, created: Date.now(), members: { [me.id]: 'owner' }, points: {}, total: 0, tasks: [] };
  checkBadges(me);
  save();
  return { id };
});

R('GET', '/api/club/([a-f0-9]{8})', ({ me, m }) => {
  const c = getClub(m[1]), mod = isMod(c, me);
  const members = Object.keys(c.members).map(id => db.users[id]).filter(Boolean).map(u => Object.assign(pub(u), { role: c.members[u.id], pts: c.points[u.id] || 0 })).sort((a, b) => b.pts - a.pts || a.first.localeCompare(b.first));
  const tasks = c.tasks.map(t => {
    const mine = t.subs[me.id];
    return {
      id: t.id, title: t.title, desc: t.desc, pts: t.pts, ts: t.ts, done: Object.values(t.subs).filter(s => s.st === 'ok').length,
      mine: mine ? { st: mine.st, text: mine.text } : null,
      pending: mod ? Object.entries(t.subs).filter(([, s]) => s.st === 'p').map(([uid, s]) => ({ uid, name: nameOf(db.users[uid]), text: s.text, ts: s.ts })) : []
    };
  });
  return { club: clubBrief(c, me), owner: c.owner, role: clubRole(c, me), mod, members, tasks };
});

R('POST', '/api/club/([a-f0-9]{8})/join', ({ me, m }) => {
  const c = getClub(m[1]);
  if (!c.members[me.id]) c.members[me.id] = 'member';
  checkBadges(me);
  save();
  return { ok: true };
});

R('POST', '/api/club/([a-f0-9]{8})/leave', ({ me, m }) => {
  const c = getClub(m[1]);
  if (c.members[me.id] === 'owner') bad('owner_cannot_leave');
  delete c.members[me.id]; delete c.points[me.id];
  save();
  return { ok: true };
});

R('DELETE', '/api/club/([a-f0-9]{8})', ({ me, m }) => {
  const c = getClub(m[1]);
  if (c.owner !== me.id && !isAdmin(me)) bad('forbidden', 403);
  delete db.clubs[c.id]; delete db.rooms['club:' + c.id];
  save();
  return { ok: true };
});

R('POST', '/api/club/([a-f0-9]{8})/tasks', ({ me, m, body }) => {
  const c = getClub(m[1]); needMod(c, me);
  const title = str(body.title, 60);
  if (title.length < 3) bad('bad_request');
  if (c.tasks.length >= 30) bad('bad_request');
  const pts = Math.max(1, Math.min(100, Math.round(+body.pts || 10)));
  c.tasks.unshift({ id: rid(4), title, desc: str(body.desc, 300), pts, ts: Date.now(), subs: {} });
  Object.keys(c.members).forEach(uid => { if (uid !== me.id) notify(uid, { type: 'club_task', from: me.id, club: c.id, clubName: c.name, task: title, pts }); });
  save();
  return { ok: true };
});

R('DELETE', '/api/club/([a-f0-9]{8})/tasks/([a-f0-9]{8})', ({ me, m }) => {
  const c = getClub(m[1]); needMod(c, me);
  c.tasks = c.tasks.filter(t => t.id !== m[2]);
  save();
  return { ok: true };
});

R('POST', '/api/club/([a-f0-9]{8})/tasks/([a-f0-9]{8})/submit', ({ me, m, body }) => {
  const c = getClub(m[1]);
  if (!c.members[me.id]) bad('forbidden', 403);
  const t = c.tasks.find(x => x.id === m[2]);
  if (!t) bad('not_found', 404);
  const ex = t.subs[me.id];
  if (ex && (ex.st === 'p' || ex.st === 'ok')) bad('already_submitted', 409);
  const text = str(body.text, 300);
  if (!text) bad('bad_request');
  t.subs[me.id] = { text, ts: Date.now(), st: 'p' };
  for (const [uid, r] of Object.entries(c.members)) if ((r === 'owner' || r === 'mod') && uid !== me.id) notify(uid, { type: 'club_sub', from: me.id, club: c.id, clubName: c.name, task: t.title });
  save();
  return { ok: true };
});

R('POST', '/api/club/([a-f0-9]{8})/tasks/([a-f0-9]{8})/review', ({ me, m, body }) => {
  const c = getClub(m[1]); needMod(c, me);
  const t = c.tasks.find(x => x.id === m[2]);
  if (!t) bad('not_found', 404);
  const uid = body.uid, s = t.subs[uid], u = db.users[uid];
  if (!s || !u || s.st !== 'p') bad('not_found', 404);
  if (uid === me.id) bad('forbidden', 403);
  if (body.ok) {
    s.st = 'ok';
    c.points[uid] = (c.points[uid] || 0) + t.pts; c.total += t.pts;
    u.tasksDone = (u.tasksDone || 0) + 1;
    notify(uid, { type: 'club_ok', club: c.id, clubName: c.name, task: t.title, pts: t.pts });
    checkBadges(u);
  } else {
    s.st = 'no';
    notify(uid, { type: 'club_no', club: c.id, clubName: c.name, task: t.title });
  }
  save();
  return { ok: true };
});

R('POST', '/api/club/([a-f0-9]{8})/members/([a-f0-9]{8})/role', ({ me, m, body }) => {
  const c = getClub(m[1]);
  if (c.owner !== me.id && !isAdmin(me)) bad('forbidden', 403);
  if (!c.members[m[2]] || c.members[m[2]] === 'owner') bad('bad_request');
  c.members[m[2]] = body.role === 'mod' ? 'mod' : 'member';
  save();
  return { ok: true };
});

R('DELETE', '/api/club/([a-f0-9]{8})/members/([a-f0-9]{8})', ({ me, m }) => {
  const c = getClub(m[1]); needMod(c, me);
  const tr = c.members[m[2]];
  if (!tr || tr === 'owner' || m[2] === me.id) bad('bad_request');
  if (tr === 'mod' && c.owner !== me.id && !isAdmin(me)) bad('forbidden', 403);
  delete c.members[m[2]]; delete c.points[m[2]];
  save();
  return { ok: true };
});

// ----- moderation -----
R('POST', '/api/report', ({ me, body }) => {
  const f = findTarget(String(body.post || ''), body.comment ? String(body.comment) : null);
  if (!f || !canSeePost(f.p, me)) bad('not_found', 404);
  const type = body.comment ? 'comment' : 'post';
  if (f.t.uid === me.id) bad('own_content');
  const reason = ['spam', 'bullying', 'inappropriate', 'other'].includes(body.reason) ? body.reason : 'other';
  const cid = body.comment ? f.t.id : null;
  if (db.reports.some(r => r.status === 'open' && r.by === me.id && r.type === type && r.post === f.p.id && r.comment === cid)) bad('already_reported', 409);
  db.reports.unshift({ id: rid(5), type, post: f.p.id, comment: cid, by: me.id, reason, note: str(body.note, 200), ts: Date.now(), status: 'open' });
  if (db.reports.length > 1000) db.reports.length = 1000;
  save();
  return { ok: true };
});

R('GET', '/api/admin/reports', ({ me, q }) => {
  adm(me);
  const open = q.get('status') !== 'done';
  return { reports: db.reports.filter(r => (r.status === 'open') === open).slice(0, 60).map(reportView) };
});

R('POST', '/api/admin/reports/([a-f0-9]{10})/resolve', ({ me, m, body }) => {
  adm(me);
  const r = db.reports.find(x => x.id === m[1]);
  if (!r) bad('not_found', 404);
  const hide = body.action === 'hide';
  if (hide && findTarget(r.post, r.comment)) setHidden(r.post, r.comment, true, true);
  db.reports.forEach(x => { if (x.status === 'open' && x.type === r.type && x.post === r.post && x.comment === r.comment) x.status = hide ? 'hidden' : 'dismissed'; });
  save();
  return { ok: true };
});

R('POST', '/api/admin/hide', ({ me, body }) => {
  adm(me);
  setHidden(String(body.post || ''), body.comment ? String(body.comment) : null, !!body.hide, true);
  return { ok: true };
});

R('GET', '/api/admin/users', ({ me, q }) => {
  adm(me);
  const s = (q.get('q') || '').trim().toLowerCase().slice(0, 40);
  const list = Object.values(db.users).filter(u => !s || (u.first + ' ' + u.last + ' ' + u.username + ' ' + u.cls).toLowerCase().includes(s))
    .sort((a, b) => (!!banInfo(b) - !!banInfo(a)) || a.cls.localeCompare(b.cls) || a.first.localeCompare(b.first)).slice(0, 100);
  return { users: list.map(u => Object.assign(pub(u), { banned: banInfo(u) })) };
});

R('POST', '/api/admin/ban', ({ me, body }) => {
  adm(me);
  const u = db.users[body.uid];
  if (!u) bad('not_found', 404);
  if (isAdmin(u)) bad('forbidden', 403);
  const days = Math.max(0, Math.min(365, Math.round(+body.days || 0)));
  u.banned = { until: days ? Date.now() + days * 864e5 : 0, reason: str(body.reason, 200), ts: Date.now() };
  save();
  return { ok: true };
});

R('POST', '/api/admin/unban', ({ me, body }) => {
  adm(me);
  const u = db.users[body.uid];
  if (!u) bad('not_found', 404);
  delete u.banned;
  save();
  return { ok: true };
});

// ---------- http ----------
const SRC = fs.readFileSync(__filename, 'utf8');
const MK = '__HT' + 'ML__';
const HTML = SRC.slice(SRC.indexOf('/*' + MK) + 2 + MK.length, SRC.lastIndexOf(MK + '*/'));

function send(res, status, type, data, extra) {
  res.writeHead(status, Object.assign({ 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' }, extra || {}));
  res.end(data);
}
const json = (res, status, obj) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj), { 'Cache-Control': 'no-store' });
function readBody(req) {
  return new Promise((ok, no) => {
    let n = 0; const c = [];
    req.on('data', d => { n += d.length; if (n > 6e6) { no(new E('too_big', 413)); req.destroy(); return; } c.push(d); });
    req.on('end', () => { if (!c.length) return ok({}); try { ok(JSON.parse(Buffer.concat(c).toString())); } catch (e) { no(new E('bad_request')); } });
    req.on('error', no);
  });
}

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x'), p = u.pathname, me = getMe(req);
    if (req.method === 'GET' && p === '/') {
      return send(res, 200, 'text/html; charset=utf-8', HTML, { 'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'" });
    }
    if (req.method === 'GET' && p.startsWith('/uploads/')) {
      const name = p.slice(9);
      if (!me) return json(res, 401, { error: 'unauth' });
      if (!/^[a-f0-9]{24}\.jpg$/.test(name)) return json(res, 404, { error: 'not_found' });
      return fs.readFile(path.join(UP, name), (err, buf) => err ? json(res, 404, { error: 'not_found' }) : send(res, 200, 'image/jpeg', buf, { 'Cache-Control': 'private, max-age=604800' }));
    }
    if (!p.startsWith('/api/')) return json(res, 404, { error: 'not_found' });
    if (req.method !== 'GET' && req.headers.origin) {
      let oh = ''; try { oh = new URL(req.headers.origin).host; } catch (e) {}
      if (oh !== req.headers.host) return json(res, 403, { error: 'forbidden' });
    }
    for (const [m, re, fn, open] of routes) {
      if (m !== req.method) continue;
      const mt = re.exec(p);
      if (!mt) continue;
      if (!open && !me) return json(res, 401, { error: 'unauth' });
      if (me && !open && isBanned(me) && p !== '/api/me') return json(res, 403, { error: 'banned' });
      if (me && !open) touchDay(me);
      const body = (m === 'GET' || m === 'DELETE') ? {} : await readBody(req);
      const out = await fn({ req, res, me, m: mt, q: u.searchParams, body });
      return json(res, 200, out || { ok: true });
    }
    json(res, 404, { error: 'not_found' });
  } catch (e) {
    if (e instanceof E) json(res, e.status, { error: e.code });
    else { console.error(e); json(res, 500, { error: 'server' }); }
  }
}).listen(PORT, HOST, () => {
  console.log('ClassMates is running:  http://localhost:' + PORT);
  console.log(SCHOOL_CODE ? 'School code for students: ' + SCHOOL_CODE + '  (change: SCHOOL_CODE=... node server.js)' : 'School code: disabled — anyone who can open the site can register');
  console.log('Admin code (teachers only, keep it secret): ' + ADMIN_CODE + '  (change: ADMIN_CODE=... node server.js)');
  console.log('Data folder: ' + DATA);
});

/*__HTML__
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ClassMates</title>
<style>
:root{--bg:#fbf8ff;--ink:#3d3a50;--mute:#8a87a0;--line:#ece7f7;--lav:#cdb4db;--lav2:#efe7fb;--pink:#ffc8dd;--sky:#bde0fe;--mint:#b8ead6;--peach:#ffd6a5;--acc:#9b87d4;--acc2:#8470c4;--r:18px}
*{box-sizing:border-box}
body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:linear-gradient(160deg,#fbf8ff 0%,#eef6ff 55%,#fff3f8 100%) fixed;min-height:100vh}
a{color:inherit;text-decoration:none}
h2{margin:6px 0 14px;font-size:22px}
h3{margin:0 0 10px;font-size:16px}
header{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:14px;padding:10px 18px;background:rgba(255,255,255,.82);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.logo{font-weight:800;font-size:19px;color:var(--acc2);white-space:nowrap}
nav{display:flex;gap:4px;flex:1;justify-content:center}
nav a{position:relative;display:flex;align-items:center;gap:6px;padding:8px 14px;border-radius:999px;color:var(--mute);font-weight:600}
nav a em{font-style:normal}
nav a:hover{background:var(--lav2)}
nav a.on{background:var(--lav2);color:var(--acc2)}
.bd{display:none;position:absolute;top:0;right:2px;min-width:18px;height:18px;border-radius:9px;background:#ff8fab;color:#fff;font-style:normal;font-size:11px;line-height:18px;text-align:center;padding:0 5px;font-weight:700}
.bd.show{display:block}
.tools{display:flex;gap:6px}
.tools a,.tools button{position:relative}
main{max-width:720px;margin:0 auto;padding:18px 14px 90px}
.card{background:#fff;border:1px solid var(--line);border-radius:var(--r);padding:16px;margin-bottom:14px;box-shadow:0 4px 18px rgba(155,135,212,.08)}
.btn,.ghost{display:inline-flex;align-items:center;gap:6px;border:0;border-radius:999px;padding:9px 18px;font:inherit;font-weight:600;cursor:pointer;background:var(--acc);color:#fff;transition:.15s}
.btn:hover{background:var(--acc2)}
.btn.soft{background:var(--lav2);color:var(--acc2)}
.btn.soft:hover{background:#e3d6f8}
.btn.pink{background:var(--pink);color:#a23b63}
.btn.sm{padding:6px 12px;font-size:13px}
.ghost{background:transparent;color:var(--mute);padding:8px 12px;border:1px solid var(--line)}
.ghost:hover{background:var(--lav2)}
input,textarea,select{width:100%;font:inherit;color:var(--ink);background:#fcfaff;border:1.5px solid var(--line);border-radius:12px;padding:10px 12px;outline:none}
input:focus,textarea:focus,select:focus{border-color:var(--lav);background:#fff}
textarea{resize:vertical;min-height:70px}
label.f{display:block;font-size:13px;font-weight:600;color:var(--mute);margin:10px 0 4px}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.sp{flex:1}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.av{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:50%;font-weight:700;color:#5b5675;flex:none;font-size:16px}
.av.sm{width:32px;height:32px;font-size:12px}
.av.lg{width:92px;height:92px;font-size:34px}
.av.em{font-size:22px;background:var(--lav2)}
.av.lg.em{font-size:44px}
.chip{display:inline-block;padding:2px 10px;border-radius:999px;background:var(--sky);color:#3b6a94;font-size:12px;font-weight:700}
.chip.m{background:var(--mint);color:#2e7a5e}
.chip.p{background:var(--pink);color:#a23b63}
.chip.y{background:var(--peach);color:#9a6320}
.mute{color:var(--mute);font-size:13px}
.tabs{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}
.tab{position:relative;padding:7px 14px;border-radius:999px;background:#fff;border:1px solid var(--line);font-weight:600;color:var(--mute)}
.tab.on{background:var(--lav2);color:var(--acc2)}
.post .hd{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.post .nm{font-weight:700}
.post p{margin:6px 0;white-space:pre-wrap;word-wrap:break-word}
.post img{width:100%;max-height:520px;object-fit:cover;border-radius:14px;margin-top:6px;background:var(--lav2)}
.post.hid{opacity:.65;border-style:dashed}
.acts{display:flex;align-items:center;gap:2px;margin-top:6px}
.lk{background:transparent;border:0;cursor:pointer;font:inherit;color:var(--mute);padding:4px 8px;border-radius:999px}
.lk:hover{background:var(--lav2)}
.lk.on{color:#e0457b;font-weight:700}
.cms{display:none;margin-top:8px;border-top:1px dashed var(--line);padding-top:8px}
.cm{display:flex;gap:8px;align-items:flex-start;padding:5px 0}
.cm.hid{opacity:.6}
.cm .cb{flex:1;min-width:0}
.cm .ct{white-space:pre-wrap;word-wrap:break-word}
.cm .ca{display:flex;flex:none}
.cm .ca .lk{padding:2px 5px;font-size:13px}
.prev{position:relative;margin:8px 0}
.prev img{max-height:200px;border-radius:12px}
.prev button{position:absolute;top:6px;left:6px;border:0;border-radius:50%;width:26px;height:26px;cursor:pointer;background:#fff}
.empty{text-align:center;color:var(--mute);padding:26px 10px}
.person{display:flex;align-items:center;gap:12px}
.person .info{flex:1;min-width:0}
.person .info b{display:block}
.hero{text-align:center}
.hero h2{margin:10px 0 2px}
.facts{display:grid;gap:10px;text-align:left;margin-top:14px}
.fact{background:var(--bg);border-radius:14px;padding:10px 14px}
.fact small{display:block;color:var(--mute);font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.tops{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
.award{display:inline-block;margin:3px;padding:4px 12px;border-radius:999px;background:linear-gradient(90deg,#fff1c9,#ffe0ec);color:#8a5a14;font-weight:700;font-size:13px}
.bgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px}
.bc{background:var(--bg);border-radius:14px;padding:10px;text-align:center}
.bc .be{font-size:28px}
.bc b{display:block;font-size:13px}
.bc small{display:block;color:var(--mute);font-size:11px;line-height:1.3}
.bc.lock{opacity:.5;filter:grayscale(.8)}
.rr{display:grid;grid-template-columns:140px 1fr auto;gap:10px;align-items:center;padding:7px 0;border-bottom:1px dashed var(--line)}
.rr:last-child{border:0}
.bar{height:9px;border-radius:5px;background:var(--lav2);overflow:hidden}
.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--sky),var(--lav));border-radius:5px}
.st{cursor:pointer;color:#e3dcf0;font-size:20px;user-select:none;line-height:1}
.st.on{color:#ffc15e}
.avg{font-size:12px;color:var(--mute);margin-top:2px}
.sw{display:inline-block;width:30px;height:30px;border-radius:50%;margin:3px;cursor:pointer;border:3px solid transparent}
.sw.on{border-color:var(--acc2)}
.ems span{display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;font-size:20px;border-radius:12px;cursor:pointer;margin:2px;background:var(--bg);border:2px solid transparent}
.ems span.on{border-color:var(--acc2);background:var(--lav2)}
.chat{display:flex;flex-direction:column;height:calc(100vh - 150px);min-height:360px}
.chead{display:flex;align-items:center;gap:10px;padding-bottom:10px}
.msgs{flex:1;overflow-y:auto;background:#fff;border:1px solid var(--line);border-radius:var(--r);padding:12px;display:flex;flex-direction:column;gap:6px}
.m{max-width:78%;align-self:flex-start;background:var(--sky);border-radius:16px 16px 16px 4px;padding:7px 12px}
.m.me{align-self:flex-end;background:var(--lav2);border-radius:16px 16px 4px 16px}
.m p{margin:0;white-space:pre-wrap;word-wrap:break-word}
.m small{display:block;font-weight:700;color:var(--acc2);font-size:12px}
.m time{display:block;text-align:right;font-size:10px;color:var(--mute)}
.cform{display:flex;gap:8px;margin-top:10px}
.cform input{flex:1}
.auth{max-width:400px;margin:6vh auto;padding:0 14px}
.auth .logo{display:block;text-align:center;font-size:30px;margin-bottom:4px}
.auth .tag{text-align:center;color:var(--mute);margin-bottom:18px}
.err{color:#c2415f;background:#fff0f4;border-radius:10px;padding:8px 12px;margin-top:10px;display:none}
.dot{background:#ff8fab;color:#fff;border-radius:999px;font-size:12px;font-weight:700;padding:1px 8px}
.nt{display:flex;gap:12px;align-items:center}
.nt.un{background:#fbf6ff;border-color:var(--lav)}
.nt .ic{font-size:22px;flex:none;width:36px;text-align:center}
.task{border-top:1px dashed var(--line);padding:10px 0}
.task:first-of-type{border:0}
.sub{background:var(--bg);border-radius:12px;padding:8px 12px;margin-top:8px}
.rk{display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px dashed var(--line)}
.rk:last-child{border:0}
.rk .n{width:30px;text-align:center;font-weight:800;font-size:18px;color:var(--acc2)}
.rk .v{font-weight:700;color:var(--acc2);text-align:right}
.ov{position:fixed;inset:0;background:rgba(61,58,80,.35);z-index:60;display:flex;align-items:center;justify-content:center;padding:14px}
.ov .box{background:#fff;border-radius:var(--r);padding:20px;width:100%;max-width:420px;max-height:90vh;overflow:auto}
#toast{position:fixed;left:50%;bottom:86px;transform:translateX(-50%);background:#4a4560;color:#fff;padding:10px 18px;border-radius:999px;opacity:0;pointer-events:none;transition:.25s;z-index:80;max-width:90vw}
#toast.show{opacity:1}
@media(max-width:700px){
 header{padding:8px 12px;gap:8px;backdrop-filter:none;-webkit-backdrop-filter:none;background:#fff}
 .logo{font-size:16px}
 nav{position:fixed;bottom:0;left:0;right:0;background:rgba(255,255,255,.95);backdrop-filter:blur(10px);border-top:1px solid var(--line);padding:6px 4px;justify-content:space-around;z-index:30}
 nav a{flex-direction:column;gap:0;padding:4px 10px;font-size:11px;border-radius:14px}
 nav a span{font-size:20px}
 .bd{top:0;right:4px}
 .tools{margin-left:auto}
 .tools .ghost{padding:6px 9px}
 .grid2{grid-template-columns:1fr}
 .rr{grid-template-columns:1fr auto}
 .rr .bw{grid-column:1/3;order:3}
 .chat{height:calc(100vh - 190px)}
}
</style></head>
<body><div id="app"></div>
<script>
var $=function(s){return document.querySelector(s)};
var esc=function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
var S=['math','rus','lit','eng','phys','chem','bio','hist','geo','cs','arm','armh','soc','art','music','pe'];
var SI={math:'📐',rus:'📝',lit:'📚',eng:'🔤',phys:'⚛️',chem:'🧪',bio:'🧬',hist:'🏛️',geo:'🌍',cs:'💻',arm:'🇦🇲',armh:'📜',soc:'⚖️',art:'🎨',music:'🎵',pe:'⚽'};
var BE={first_post:'📝',writer:'✍️',photographer:'📸',popular:'❤️',commentator:'💬',social:'🤝',talker:'🗣️',joiner:'🎯',clubstar:'🏅',achiever:'✅',recognized:'⭐',streak7:'🔥'};
var EMS=['♟️','🏆','⚽','🔬','🎨','🎵','💻','📚','🧪','🎭','🏀','🌍'];
var COLORS=['#ffc8dd','#bde0fe','#b8ead6','#ffd6a5','#cdb4db','#fdffb6','#a2d2ff','#caffbf'];
var L={en:{
tagline:'The private network for our school',login:'Log in',register:'Sign up',logout:'Log out',username:'Username',first:'First name',last:'Last name',cls:'Class',cls_ph:'e.g. 9A',password:'Password',code:'School code',code_hint:'Ask your teacher or a classmate for the school code.',no_acc:'No account yet? Sign up',has_acc:'Already registered? Log in',
i_admin:'I am a teacher / admin',i_student:'I am a student',admin_code:'Admin code',cls_opt:'Class (optional for staff)',
n_feed:'Feed',n_people:'People',n_friends:'Friends',n_chats:'Chats',n_me:'Profile',n_clubs:'Clubs',n_notifs:'Notifications',n_rank:'Rankings',n_admin:'Moderation',
ok:'OK',send:'Send',back:'Back',admin:'Admin',
feed_title:'What\'s new at school',post_ph:'Share something with your school…',photo:'Photo',publish:'Post',empty_feed:'No posts yet — be the first! ✨',del:'Delete',confirm_del:'Delete this post?',
about:'About me',dream:'Who I want to become',goal:'Where I want to study',top3:'Top 3 favorite subjects',edit:'Edit profile',save:'Save',cancel:'Cancel',bio_ph:'Tell us about yourself…',color:'Avatar color',none:'— none —',
ratings:'Subject knowledge',rate_hint:'Rate how well this student knows each subject — your honest opinion, 1 to 5 stars. Tap the same star again to remove your rating.',rate_self:'Other students rate your knowledge here. Averages of their ratings:',votes:'votes',no_rate:'no ratings yet',
posts:'Posts',friends_n:'friends',no_posts:'No posts yet.',
add_friend:'Add friend',sent:'Request sent',cancel_req:'Cancel',accept:'Accept',decline:'Decline',remove:'Remove friend',write:'Message',
p_search:'Search by name or username…',p_mine:'My class only',p_none:'Nobody found.',
f_in:'Friend requests',f_my:'My friends',f_out:'Sent requests',f_none:'No friends yet — find classmates in People.',tab_all:'Everyone',
class_chat:'Class chat',c_class:'Class chat',c_people:'Classmates & friends',c_clubs:'Club chats',c_none:'No one to chat with yet. Add friends or ask classmates to join!',msg_ph:'Message…',no_msgs:'No messages yet. Say hi! 👋',you:'You',
report:'Report',reason:'Reason',note:'Details (optional)',reported:'Thanks! A moderator will take a look.',reason_spam:'Spam',reason_bullying:'Bullying or insults',reason_inap:'Inappropriate content',reason_other:'Something else',
hide:'Hide',unhide:'Show again',hidden_chip:'🙈 hidden',banned_chip:'banned',
no_comments:'No comments yet.',comment_ph:'Write a comment…',
no_notifs:'No notifications yet.',nt_like:'{n} liked your post',nt_comment:'{n} commented: “{t}”',nt_friend_req:'{n} sent you a friend request',nt_friend_acc:'{n} accepted your friend request',nt_badge:'You earned a new badge: {b}',nt_hidden:'A moderator hid one of your posts or comments',nt_club_sub:'{n} submitted “{k}” in {c}',nt_club_ok:'Your task “{k}” in {c} was approved: +{p} points',nt_club_no:'Your task “{k}” in {c} was declined — you can try again',nt_club_task:'New task in {c}: “{k}” (+{p})',
badges:'Badges',earned:'Earned!',best_class:'Best in {s} — class {c}',best_school:'Best in {s} — whole school',
b_first_post:'First post',b_writer:'Writer',b_photographer:'Photographer',b_popular:'Popular',b_commentator:'Commentator',b_social:'Sociable',b_talker:'Chatterbox',b_joiner:'Team player',b_clubstar:'Club star',b_achiever:'Achiever',b_recognized:'Recognized',b_streak7:'On fire',
bd_first_post:'Publish your first post',bd_writer:'Publish 10 posts',bd_photographer:'Publish 5 photo posts',bd_popular:'Get 20 likes',bd_commentator:'Write 10 comments',bd_social:'Make 5 friends',bd_talker:'Send 50 messages',bd_joiner:'Join or create a club',bd_clubstar:'Earn 50 club points',bd_achiever:'Complete 5 club tasks',bd_recognized:'Get 10 subject ratings',bd_streak7:'Visit 7 days in a row',
clubs_title:'Clubs & groups',new_club:'New club',club_name:'Club name',club_desc:'What is it about?',create:'Create',join:'Join',leave:'Leave',open:'Open',members:'Members',pts:'pts',points:'points',search_clubs:'Search clubs…',no_clubs:'No clubs yet — create the first one!',
tasks:'Tasks',new_task:'New task',task_title:'Task title',task_desc:'Description',task_pts:'Points (1–100)',no_tasks:'No tasks yet.',submit:'Submit',submit_title:'Submit your answer',submit_ph:'Describe what you did or paste your answer…',st_p:'⏳ Waiting for review',st_ok:'✅ Approved',st_no:'❌ Declined — try again',pending:'To review',approve:'Approve',kick:'Remove',make_mod:'Make moderator',remove_mod:'Remove moderator',delete_club:'Delete club',confirm_delete_club:'Delete this club for everyone?',confirm_kick:'Remove this member?',leaderboard:'Club leaderboard',role_owner:'owner',role_mod:'moderator',club_chat:'Club chat',done_by:'done by',
rankings:'Rankings',r_subject:'By subject',r_clubs:'Clubs',r_activity:'Activity',sc_class:'My class',sc_school:'Whole school',r_min:'Only students with at least {n} ratings are shown.',no_rank:'Nobody here yet.',
adm_reports:'Reports',adm_handled:'Handled',adm_users:'Users',no_reports:'No reports 🎉',dismiss:'Dismiss',hide_content:'Hide content',ban:'Ban',unban:'Unban',ban_title:'Ban user',ban_days:'Duration',days_1:'1 day',days_3:'3 days',days_7:'7 days',days_30:'30 days',perm:'Permanent',ban_reason:'Reason (the user will see it)',restore:'Restore',gone:'content deleted',from_by:'Reported by',st_hidden:'hidden',st_dismissed:'dismissed',
banned_title:'Your account is suspended',banned_text:'A moderator has restricted your access.',banned_until:'Until',banned_perm:'Permanently',banned_reason:'Reason',
e_bad_code:'Wrong school code.',e_bad_admin_code:'Wrong admin code.',e_bad_username:'Username: 3–20 chars, latin letters, digits or _',e_bad_name:'Please enter a valid first and last name.',e_bad_class:'Class: 1–6 letters/digits, e.g. 9A',e_weak_password:'Password must be at least 6 characters.',e_username_taken:'This username is taken.',e_bad_credentials:'Wrong username or password.',e_too_many:'Too many attempts. Try again in a few minutes.',e_forbidden:'Not allowed.',e_not_found:'Not found.',e_bad_request:'Something is missing.',e_bad_image:'This image can\'t be used.',e_own_profile:'You can\'t rate yourself.',e_too_big:'File is too large.',e_server:'Server error.',e_already_reported:'You already reported this.',e_own_content:'This is your own content.',e_already_submitted:'Already submitted.',e_owner_cannot_leave:'The owner can\'t leave — delete the club instead.',e_club_limit:'You can own up to 3 clubs.',e_name_taken:'A club with this name exists.',e_bad_club:'Club name must be at least 3 characters.',e_banned:'Your account is suspended.'},
ru:{
tagline:'Закрытая соцсеть нашей школы',login:'Войти',register:'Регистрация',logout:'Выйти',username:'Юзернейм',first:'Имя',last:'Фамилия',cls:'Класс',cls_ph:'напр. 9А',password:'Пароль',code:'Школьный код',code_hint:'Спроси код у учителя или одноклассника.',no_acc:'Нет аккаунта? Зарегистрироваться',has_acc:'Уже есть аккаунт? Войти',
i_admin:'Я учитель / администратор',i_student:'Я ученик',admin_code:'Админ-код',cls_opt:'Класс (для сотрудников необязательно)',
n_feed:'Лента',n_people:'Люди',n_friends:'Друзья',n_chats:'Чаты',n_me:'Профиль',n_clubs:'Клубы',n_notifs:'Уведомления',n_rank:'Рейтинги',n_admin:'Модерация',
ok:'ОК',send:'Отправить',back:'Назад',admin:'Админ',
feed_title:'Что нового в школе',post_ph:'Поделись чем-нибудь со школой…',photo:'Фото',publish:'Опубликовать',empty_feed:'Пока нет записей — будь первым! ✨',del:'Удалить',confirm_del:'Удалить эту запись?',
about:'Обо мне',dream:'Кем хочу стать',goal:'Куда хочу поступить',top3:'Топ-3 любимых предмета',edit:'Редактировать',save:'Сохранить',cancel:'Отмена',bio_ph:'Расскажи о себе…',color:'Цвет аватара',none:'— не выбрано —',
ratings:'Знание предметов',rate_hint:'Оцени, насколько хорошо этот ученик знает каждый предмет — по твоему мнению, от 1 до 5 звёзд. Нажми на ту же звезду ещё раз, чтобы убрать оценку.',rate_self:'Другие ученики оценивают твои знания. Средние оценки:',votes:'голосов',no_rate:'пока нет оценок',
posts:'Записи',friends_n:'друзей',no_posts:'Пока нет записей.',
add_friend:'Добавить в друзья',sent:'Заявка отправлена',cancel_req:'Отменить',accept:'Принять',decline:'Отклонить',remove:'Убрать из друзей',write:'Написать',
p_search:'Поиск по имени или юзернейму…',p_mine:'Только мой класс',p_none:'Никого не найдено.',
f_in:'Заявки в друзья',f_my:'Мои друзья',f_out:'Отправленные заявки',f_none:'Друзей пока нет — найди одноклассников во вкладке «Люди».',tab_all:'Все',
class_chat:'Чат класса',c_class:'Чат класса',c_people:'Одноклассники и друзья',c_clubs:'Чаты клубов',c_none:'Пока не с кем общаться. Добавь друзей!',msg_ph:'Сообщение…',no_msgs:'Сообщений пока нет. Поздоровайся! 👋',you:'Вы',
report:'Пожаловаться',reason:'Причина',note:'Подробности (необязательно)',reported:'Спасибо! Модератор посмотрит.',reason_spam:'Спам',reason_bullying:'Травля или оскорбления',reason_inap:'Неприемлемый контент',reason_other:'Другое',
hide:'Скрыть',unhide:'Показать снова',hidden_chip:'🙈 скрыто',banned_chip:'в бане',
no_comments:'Комментариев пока нет.',comment_ph:'Написать комментарий…',
no_notifs:'Уведомлений пока нет.',nt_like:'{n} оценил(а) твою запись',nt_comment:'{n} прокомментировал(а): «{t}»',nt_friend_req:'{n} отправил(а) тебе заявку в друзья',nt_friend_acc:'{n} принял(а) твою заявку в друзья',nt_badge:'Новый бейдж: {b}',nt_hidden:'Модератор скрыл твою запись или комментарий',nt_club_sub:'{n} сдал(а) «{k}» в клубе {c}',nt_club_ok:'Задание «{k}» в клубе {c} принято: +{p} очков',nt_club_no:'Задание «{k}» в клубе {c} отклонено — можно попробовать ещё раз',nt_club_task:'Новое задание в клубе {c}: «{k}» (+{p})',
badges:'Бейджи',earned:'Получен!',best_class:'Лучший по предмету «{s}» — класс {c}',best_school:'Лучший по предмету «{s}» — во всей школе',
b_first_post:'Первая запись',b_writer:'Писатель',b_photographer:'Фотограф',b_popular:'Популярный',b_commentator:'Комментатор',b_social:'Душа компании',b_talker:'Болтун',b_joiner:'Командный игрок',b_clubstar:'Звезда клуба',b_achiever:'Выполнитель',b_recognized:'Признание',b_streak7:'В ударе',
bd_first_post:'Опубликуй первую запись',bd_writer:'Опубликуй 10 записей',bd_photographer:'Опубликуй 5 записей с фото',bd_popular:'Набери 20 лайков',bd_commentator:'Напиши 10 комментариев',bd_social:'Заведи 5 друзей',bd_talker:'Отправь 50 сообщений',bd_joiner:'Вступи в клуб или создай свой',bd_clubstar:'Заработай 50 очков клуба',bd_achiever:'Выполни 5 заданий клубов',bd_recognized:'Получи 10 оценок знаний',bd_streak7:'Заходи 7 дней подряд',
clubs_title:'Клубы и группы',new_club:'Новый клуб',club_name:'Название клуба',club_desc:'О чём этот клуб?',create:'Создать',join:'Вступить',leave:'Выйти',open:'Открыть',members:'Участники',pts:'очк.',points:'очков',search_clubs:'Поиск клубов…',no_clubs:'Клубов пока нет — создай первый!',
tasks:'Задания',new_task:'Новое задание',task_title:'Название задания',task_desc:'Описание',task_pts:'Очки (1–100)',no_tasks:'Заданий пока нет.',submit:'Сдать',submit_title:'Сдать задание',submit_ph:'Опиши, что ты сделал, или вставь ответ…',st_p:'⏳ Ждёт проверки',st_ok:'✅ Принято',st_no:'❌ Отклонено — попробуй ещё раз',pending:'На проверке',approve:'Принять',kick:'Исключить',make_mod:'Сделать модератором',remove_mod:'Снять модератора',delete_club:'Удалить клуб',confirm_delete_club:'Удалить этот клуб для всех?',confirm_kick:'Исключить участника?',leaderboard:'Рейтинг клуба',role_owner:'владелец',role_mod:'модератор',club_chat:'Чат клуба',done_by:'выполнили',
rankings:'Рейтинги',r_subject:'По предметам',r_clubs:'Клубы',r_activity:'Активность',sc_class:'Мой класс',sc_school:'Вся школа',r_min:'Показаны только ученики минимум с {n} оценками.',no_rank:'Пока никого нет.',
adm_reports:'Жалобы',adm_handled:'Обработаны',adm_users:'Пользователи',no_reports:'Жалоб нет 🎉',dismiss:'Отклонить',hide_content:'Скрыть',ban:'Забанить',unban:'Разбанить',ban_title:'Бан пользователя',ban_days:'Срок',days_1:'1 день',days_3:'3 дня',days_7:'7 дней',days_30:'30 дней',perm:'Навсегда',ban_reason:'Причина (пользователь её увидит)',restore:'Вернуть',gone:'контент удалён',from_by:'Пожаловался',st_hidden:'скрыто',st_dismissed:'отклонено',
banned_title:'Твой аккаунт заблокирован',banned_text:'Модератор ограничил твой доступ.',banned_until:'До',banned_perm:'Навсегда',banned_reason:'Причина',
e_bad_code:'Неверный школьный код.',e_bad_admin_code:'Неверный админ-код.',e_bad_username:'Юзернейм: 3–20 символов, латиница, цифры или _',e_bad_name:'Введи корректные имя и фамилию.',e_bad_class:'Класс: 1–6 букв/цифр, например 9А',e_weak_password:'Пароль — минимум 6 символов.',e_username_taken:'Этот юзернейм занят.',e_bad_credentials:'Неверный юзернейм или пароль.',e_too_many:'Слишком много попыток. Попробуй через несколько минут.',e_forbidden:'Нет доступа.',e_not_found:'Не найдено.',e_bad_request:'Что-то не заполнено.',e_bad_image:'Это изображение не подходит.',e_own_profile:'Нельзя оценивать себя.',e_too_big:'Файл слишком большой.',e_server:'Ошибка сервера.',e_already_reported:'Ты уже пожаловался на это.',e_own_content:'Это твой собственный контент.',e_already_submitted:'Уже сдано.',e_owner_cannot_leave:'Владелец не может выйти — удали клуб.',e_club_limit:'Можно владеть не более чем 3 клубами.',e_name_taken:'Клуб с таким названием уже есть.',e_bad_club:'Название клуба — минимум 3 символа.',e_banned:'Твой аккаунт заблокирован.'}};
L.ru.remove_mod='Снять модератора';
L.en.s_math='Math';L.en.s_rus='Russian';L.en.s_lit='Literature';L.en.s_eng='English';L.en.s_phys='Physics';L.en.s_chem='Chemistry';L.en.s_bio='Biology';L.en.s_hist='History';L.en.s_geo='Geography';L.en.s_cs='Computer Science';L.en.s_arm='Armenian';L.en.s_armh='Armenian History';L.en.s_soc='Social Studies';L.en.s_art='Art';L.en.s_music='Music';L.en.s_pe='PE';
L.ru.s_math='Математика';L.ru.s_rus='Русский язык';L.ru.s_lit='Литература';L.ru.s_eng='Английский';L.ru.s_phys='Физика';L.ru.s_chem='Химия';L.ru.s_bio='Биология';L.ru.s_hist='История';L.ru.s_geo='География';L.ru.s_cs='Информатика';L.ru.s_arm='Армянский язык';L.ru.s_armh='История Армении';L.ru.s_soc='Обществознание';L.ru.s_art='ИЗО';L.ru.s_music='Музыка';L.ru.s_pe='Физкультура';
L.en.remove_mod='Remove moderator';

var ME=null,poll=null,bt=null,pend=null,editing=false,chatLast=0,pt=null,cEmoji=EMS[0];
var rk={type:'subject',subject:'math',scope:null},adm={tab:'open'};
var lang='en';try{lang=localStorage.getItem('lang')||((navigator.language||'').indexOf('ru')===0?'ru':'en')}catch(e){}
var t=function(k){var v=L[lang][k];return v!=null?v:(L.en[k]!=null?L.en[k]:k)};
var fmt=function(k,o){var s=t(k);for(var x in o)s=s.split('{'+x+'}').join(o[x]);return s};
var sn=function(s){return SI[s]+' '+t('s_'+s)};
var nm=function(u){return u.first+' '+u.last};
var tr=function(e){var k='e_'+(e.code||e.message);return L[lang][k]||L.en[k]||e.message||'Error'};
function C(fn){var a=[].slice.call(arguments,1).map(function(x){return typeof x==='string'?"'"+x+"'":x});return 'run(function(){return '+fn+'('+a.join(',')+')})'}

async function api(m,u,b){
 var r=await fetch(u,{method:m,headers:b?{'Content-Type':'application/json'}:{},body:b?JSON.stringify(b):undefined,credentials:'same-origin'});
 var j={};try{j=await r.json()}catch(e){}
 if(!r.ok){var e=new Error(j.error||'error');e.code=j.error||'error';e.status=r.status;throw e}
 return j;
}
async function run(fn){try{await fn()}catch(e){if(e.status===401&&ME){ME=null;return boot()}if(e.code==='banned'){return boot()}toast(tr(e))}}
var tt=null;
function toast(s){var el=$('#toast');if(!el){el=document.createElement('div');el.id='toast';document.body.appendChild(el)}el.textContent=s;el.className='show';clearTimeout(tt);tt=setTimeout(function(){el.className=''},3200)}
function av(u,sz){var i=((u.first||'?')[0]+(u.last||'')[0]).toUpperCase();return '<span class="av '+(sz||'')+'" style="background:'+esc(u.color)+'">'+esc(i)+'</span>'}
function ft(ts){return new Date(ts).toLocaleString(lang==='ru'?'ru-RU':'en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}
function hm(ts){return new Date(ts).toLocaleTimeString(lang==='ru'?'ru-RU':'en-GB',{hour:'2-digit',minute:'2-digit'})}
function main(h){$('#main').innerHTML=h;window.scrollTo(0,0)}
function adminChip(u){return u.admin?' <span class="chip y">🛡 '+t('admin')+'</span>':''}
function closeModal(){var m=$('#modal');if(m)m.remove()}
function modal(title,body,ok,okTxt){
 closeModal();
 var d=document.createElement('div');d.id='modal';d.className='ov';
 d.innerHTML='<div class="box"><h3>'+title+'</h3>'+body+'<div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn soft" data-x="1">'+t('cancel')+'</button><button class="btn" data-ok="1">'+(okTxt||t('ok'))+'</button></div></div>';
 document.body.appendChild(d);
 d.onclick=function(e){if(e.target===d||e.target.getAttribute('data-x'))closeModal()};
 d.querySelector('[data-ok]').onclick=function(){run(async function(){await ok();closeModal()})};
 var f=d.querySelector('input,textarea,select');if(f)f.focus();
}

// ---------- auth ----------
var adminMode=false;
async function vAuth(mode){
 var cfg={codeRequired:true};try{cfg=await api('GET','/api/config')}catch(e){}
 var reg=mode==='register';adminMode=false;
 $('#app').innerHTML='<div class="auth"><span class="logo">🎒 ClassMates</span><div class="tag">'+t('tagline')+'</div><form class="card" onsubmit="return authGo(event,\''+mode+'\')">'
 +(reg?'<div id="w_code" style="'+(cfg.codeRequired?'':'display:none')+'"><label class="f">'+t('code')+'</label><input id="a_code" autocomplete="off"><div class="mute" style="margin-top:4px">'+t('code_hint')+'</div></div><div id="w_admin" style="display:none"><label class="f">🛡 '+t('admin_code')+'</label><input id="a_admin" type="password" autocomplete="off"></div>':'')
 +'<label class="f">'+t('username')+'</label><input id="a_user" autocomplete="username" autocapitalize="none" maxlength="20">'
 +(reg?'<div class="grid2"><div><label class="f">'+t('first')+'</label><input id="a_first" maxlength="30"></div><div><label class="f">'+t('last')+'</label><input id="a_last" maxlength="30"></div></div><label class="f" id="l_cls">'+t('cls')+'</label><input id="a_cls" maxlength="6" placeholder="'+t('cls_ph')+'">':'')
 +'<label class="f">'+t('password')+'</label><input id="a_pw" type="password" autocomplete="'+(reg?'new-password':'current-password')+'" maxlength="100">'
 +'<div class="err" id="a_err"></div><div style="margin-top:16px"><button class="btn" style="width:100%;justify-content:center">'+(reg?t('register'):t('login'))+'</button></div>'
 +'<div style="text-align:center;margin-top:14px"><a href="#" class="mute" onclick="vAuth(\''+(reg?'login':'register')+'\');return false">'+(reg?t('has_acc'):t('no_acc'))+'</a> · <a href="#" class="mute" onclick="setLang(1);return false">'+(lang==='ru'?'EN':'RU')+'</a>'
 +(reg?'<div style="margin-top:8px"><a href="#" class="mute" id="a_tog" onclick="toggleAdmin(\''+(cfg.codeRequired?'1':'')+'\');return false">🛡 '+t('i_admin')+'</a></div>':'')+'</div></form></div><div id="toast"></div>';
}
function toggleAdmin(codeReq){
 adminMode=!adminMode;
 $('#w_admin').style.display=adminMode?'block':'none';
 $('#w_code').style.display=(!adminMode&&codeReq)?'block':'none';
 $('#l_cls').textContent=adminMode?t('cls_opt'):t('cls');
 $('#a_tog').innerHTML='🛡 '+(adminMode?t('i_student'):t('i_admin'));
}
async function authGo(e,mode){
 e.preventDefault();
 var g=function(i){var el=$('#'+i);return el?el.value:''};
 var b=mode==='register'?{code:adminMode?'':g('a_code'),admin:adminMode?g('a_admin'):'',username:g('a_user'),first:g('a_first'),last:g('a_last'),cls:g('a_cls'),password:g('a_pw')}:{username:g('a_user'),password:g('a_pw')};
 try{await api('POST','/api/'+mode,b);await boot()}catch(er){var el=$('#a_err');el.textContent=tr(er);el.style.display='block'}
 return false;
}
async function logout(){await api('POST','/api/logout',{});ME=null;clearInterval(bt);clearInterval(poll);location.hash='';vAuth('login')}
function setLang(auth){lang=lang==='ru'?'en':'ru';try{localStorage.setItem('lang',lang)}catch(e){}if(auth||!ME){vAuth('login')}else{shell();route();run(badges)}}
function vBanned(ban){
 clearInterval(bt);clearInterval(poll);
 $('#app').innerHTML='<div class="auth"><span class="logo">🎒 ClassMates</span><div class="card" style="text-align:center"><div style="font-size:44px">🚫</div><h2>'+t('banned_title')+'</h2><p>'+t('banned_text')+'</p>'
 +'<p class="mute">'+t('banned_until')+': <b>'+(ban.until?ft(ban.until):t('banned_perm'))+'</b></p>'+(ban.reason?'<div class="fact" style="text-align:left"><small>'+t('banned_reason')+'</small>'+esc(ban.reason)+'</div>':'')
 +'<div style="margin-top:16px"><button class="btn soft" onclick="run(logout)">'+t('logout')+'</button> <button class="ghost" onclick="setLang(1)">'+(lang==='ru'?'EN':'RU')+'</button></div></div></div><div id="toast"></div>';
}

// ---------- shell ----------
function shell(){
 var nav=[['feed','🏠'],['people','🔎'],['clubs','🎯'],['chats','💬'],['me','🙂']].map(function(x){return '<a href="#/'+x[0]+'" data-k="'+x[0]+'"><span>'+x[1]+'</span><em>'+t('n_'+x[0])+'</em><i class="bd" id="bd-'+x[0]+'"></i></a>'}).join('');
 $('#app').innerHTML='<header><a class="logo" href="#/feed">🎒 ClassMates</a><nav>'+nav+'</nav><div class="tools">'
 +(ME.admin?'<a class="ghost" href="#/admin" title="'+t('n_admin')+'">🛡<i class="bd" id="bd-admin"></i></a>':'')
 +'<a class="ghost" href="#/rank" title="'+t('n_rank')+'">🏆</a><a class="ghost" href="#/notifs" title="'+t('n_notifs')+'">🔔<i class="bd" id="bd-notifs"></i></a>'
 +'<button class="ghost" onclick="setLang()">'+(lang==='ru'?'EN':'RU')+'</button><button class="ghost" title="'+t('logout')+'" onclick="run(logout)">⎋</button></div></header><main id="main"></main><div id="toast"></div>';
}
async function badges(){
 var b=await api('GET','/api/badges');
 var set=function(k,n){var el=$('#bd-'+k);if(!el)return;el.textContent=n>99?'99+':n;el.className='bd'+(n>0?' show':'')};
 set('chats',b.unread);set('people',b.requests);set('notifs',b.notifs);set('admin',b.reports);
}

// ---------- router ----------
function route(){
 clearInterval(poll);closeModal();
 var p=(location.hash.slice(1)||'/feed').split('/');
 var k=p[1];
 var map={friends:'people',club:'clubs',chat:'chats',post:'feed'};
 var act=map[k]||k;
 if(k==='u')act=(ME&&p[2]===ME.id)?'me':'people';
 document.querySelectorAll('nav a').forEach(function(a){a.className=a.getAttribute('data-k')===act?'on':''});
 if(k!=='me'&&!(k==='u'&&p[2]===ME.id))editing=false;
 run(function(){
  if(k==='people')return vPeople();
  if(k==='friends')return vFriends();
  if(k==='clubs')return vClubs();
  if(k==='club')return vClub(p[2]);
  if(k==='chats')return vChats();
  if(k==='chat')return vChat(p[2]==='class'?'class':p[2]+'/'+p[3]);
  if(k==='me')return vProfile(ME.id);
  if(k==='u')return vProfile(p[2]);
  if(k==='post')return vPost(p[2]);
  if(k==='notifs')return vNotifs();
  if(k==='rank')return vRank();
  if(k==='admin'&&ME.admin)return vAdmin();
  return vFeed();
 });
}
window.addEventListener('hashchange',function(){if(ME)route()});

// ---------- feed, posts, comments ----------
function composer(){pend=null;return '<div class="card"><textarea id="ptext" maxlength="1000" placeholder="'+t('post_ph')+'"></textarea><div id="pprev"></div><div class="row" style="margin-top:8px"><label class="btn soft">📷 '+t('photo')+'<input type="file" accept="image/*" hidden onchange="run(function(){return pickImg(this)}.bind(this))"></label><span class="sp"></span><button class="btn" onclick="run(doPost)">'+t('publish')+'</button></div></div>'}
function pickImg(inp){
 return new Promise(function(ok,no){
  var f=inp.files[0];if(!f)return ok();
  var img=new Image(),url=URL.createObjectURL(f);
  img.onload=function(){
   var k=Math.min(1,1100/Math.max(img.width,img.height));
   var c=document.createElement('canvas');c.width=Math.max(1,Math.round(img.width*k));c.height=Math.max(1,Math.round(img.height*k));
   var x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);x.drawImage(img,0,0,c.width,c.height);
   pend=c.toDataURL('image/jpeg',0.82);URL.revokeObjectURL(url);inp.value='';
   $('#pprev').innerHTML='<div class="prev"><img src="'+pend+'"><button onclick="pend=null;$(\'#pprev\').innerHTML=\'\'">✕</button></div>';ok();
  };
  img.onerror=function(){var e=new Error('bad_image');e.code='bad_image';no(e)};
  img.src=url;
 });
}
async function doPost(){
 var text=$('#ptext').value.trim();if(!text&&!pend)return;
 await api('POST','/api/posts',{text:text,img:pend});route();
}
function postHtml(p){
 var a='<button class="lk'+(p.liked?' on':'')+'" id="lk-'+p.id+'" onclick="'+C('like',p.id)+'">'+(p.liked?'❤️':'🤍')+' '+p.likes+'</button>'
 +'<button class="lk" onclick="'+C('toggleCm',p.id)+'">💬 <span id="cc-'+p.id+'">'+p.comments+'</span></button><span class="sp"></span>';
 if(p.mine)a+='<button class="lk" title="'+t('del')+'" onclick="'+C('delPost',p.id)+'">🗑</button>';
 else a+='<button class="lk" title="'+t('report')+'" onclick="reportDlg(\''+p.id+'\',\'\')">🚩</button>';
 if(ME.admin)a+='<button class="lk" title="'+(p.hidden?t('unhide'):t('hide'))+'" onclick="'+C('adminHide',p.id,'',!p.hidden)+'">'+(p.hidden?'👁':'🙈')+'</button>';
 return '<div class="card post'+(p.hidden?' hid':'')+'" id="post-'+p.id+'"><div class="hd"><a href="#/u/'+p.uid+'">'+av(p,'')+'</a><div style="flex:1"><a class="nm" href="#/u/'+p.uid+'">'+esc(p.name)+'</a> <span class="chip">'+esc(p.cls)+'</span>'+adminChip(p)+(p.hidden?' <span class="chip p">'+t('hidden_chip')+'</span>':'')+'<div class="mute">'+ft(p.ts)+'</div></div></div>'
 +(p.text?'<p>'+esc(p.text)+'</p>':'')+(p.img?'<img loading="lazy" src="/uploads/'+esc(p.img)+'">':'')
 +'<div class="acts">'+a+'</div><div class="cms" id="cm-'+p.id+'"></div></div>';
}
async function like(id){
 var r=await api('POST','/api/posts/'+id+'/like',{});var b=$('#lk-'+id);
 if(b){b.className='lk'+(r.post.liked?' on':'');b.innerHTML=(r.post.liked?'❤️':'🤍')+' '+r.post.likes}
}
async function delPost(id){if(!confirm(t('confirm_del')))return;await api('DELETE','/api/posts/'+id);route()}
function cmHtml(pid,c){
 var a='';
 if(c.mine||ME.admin)a+='<button class="lk" title="'+t('del')+'" onclick="'+C('delCm',pid,c.id)+'">🗑</button>';
 if(!c.mine)a+='<button class="lk" title="'+t('report')+'" onclick="reportDlg(\''+pid+'\',\''+c.id+'\')">🚩</button>';
 if(ME.admin)a+='<button class="lk" onclick="'+C('adminHide',pid,c.id,!c.hidden)+'">'+(c.hidden?'👁':'🙈')+'</button>';
 return '<div class="cm'+(c.hidden?' hid':'')+'"><a href="#/u/'+c.uid+'">'+av(c,'sm')+'</a><div class="cb"><a href="#/u/'+c.uid+'"><b>'+esc(nm(c))+'</b></a>'+adminChip(c)+' <span class="mute">'+ft(c.ts)+'</span>'+(c.hidden?' <span class="chip p">'+t('hidden_chip')+'</span>':'')+'<div class="ct">'+esc(c.text)+'</div></div><div class="ca">'+a+'</div></div>';
}
function renderCm(id,r){
 var box=$('#cm-'+id);if(!box)return;
 box.innerHTML=(r.comments.length?r.comments.map(function(c){return cmHtml(id,c)}).join(''):'<div class="mute" style="padding:4px 0">'+t('no_comments')+'</div>')
 +'<form class="cform" onsubmit="return addCm(event,\''+id+'\')"><input maxlength="300" id="ci-'+id+'" autocomplete="off" placeholder="'+t('comment_ph')+'"><button class="btn sm">➤</button></form>';
 var n=$('#cc-'+id);if(n)n.textContent=r.post.comments;
}
async function toggleCm(id,force){
 var box=$('#cm-'+id);if(!box)return;
 if(!force&&box.style.display==='block'){box.style.display='none';return}
 var r=await api('GET','/api/posts/'+id);renderCm(id,r);box.style.display='block';
}
function addCm(e,pid){
 e.preventDefault();var i=$('#ci-'+pid),tx=i.value.trim();if(!tx)return false;i.value='';
 run(async function(){var r=await api('POST','/api/posts/'+pid+'/comments',{text:tx});renderCm(pid,r);var n=$('#ci-'+pid);if(n)n.focus()});
 return false;
}
async function delCm(pid,cid){await api('DELETE','/api/posts/'+pid+'/comments/'+cid);return toggleCm(pid,true)}
async function adminHide(post,comment,hide){
 await api('POST','/api/admin/hide',{post:post,comment:comment||null,hide:hide});
 if(comment)return toggleCm(post,true);
 route();
}
function reportDlg(post,comment){
 var opts=[['spam','spam'],['bullying','bullying'],['inap','inappropriate'],['other','other']].map(function(r){return '<option value="'+r[1]+'">'+t('reason_'+r[0])+'</option>'}).join('');
 modal('🚩 '+t('report'),'<label class="f">'+t('reason')+'</label><select id="m_reason">'+opts+'</select><label class="f">'+t('note')+'</label><textarea id="m_note" maxlength="200"></textarea>',async function(){
  await api('POST','/api/report',{post:post,comment:comment||null,reason:$('#m_reason').value,note:$('#m_note').value});toast(t('reported'));
 },t('send'));
}
async function vFeed(){
 main('<h2>'+t('feed_title')+'</h2>'+composer()+'<div id="plist"></div>');
 var r=await api('GET','/api/feed');
 $('#plist').innerHTML=r.posts.length?r.posts.map(postHtml).join(''):'<div class="empty">'+t('empty_feed')+'</div>';
}
async function vPost(id){
 var r=await api('GET','/api/posts/'+id);
 main('<a href="#/feed" class="btn soft sm">←</a><div style="height:10px"></div>'+postHtml(r.post));
 await toggleCm(id,true);
}

// ---------- profile ----------
function starsRow(uid,s,r,self){
 var h='<div class="rr" id="rr-'+s+'"><div><b>'+sn(s)+'</b></div><div class="bw"><div class="bar"><i style="width:'+(r.avg/5*100)+'%"></i></div><div class="avg">'+(r.count?'★ '+r.avg.toFixed(1)+' · '+r.count+' '+t('votes'):t('no_rate'))+'</div></div>';
 if(self)return h+'<div></div></div>';
 h+='<div>';for(var i=1;i<=5;i++)h+='<span class="st'+(i<=r.mine?' on':'')+'" onclick="run(function(){return rate(\''+uid+'\',\''+s+'\','+i+','+r.mine+')})">★</span>';
 return h+'</div></div>';
}
async function rate(uid,s,v,cur){
 var r=await api('POST','/api/rate',{target:uid,subject:s,value:v===cur?0:v});
 var el=$('#rr-'+s);if(el)el.outerHTML=starsRow(uid,s,r.row,false);
}
function relBtns(d){
 var u=d.user,h='';
 if(d.rel==='self')return '<button class="btn soft" onclick="editing=true;route()">✏️ '+t('edit')+'</button>';
 if(d.canChat)h+='<a class="btn" href="#/chat/u/'+u.id+'">💬 '+t('write')+'</a> ';
 var f=function(m,txt,cls){return '<button class="btn '+cls+'" onclick="'+C('fr',m,u.id)+'">'+txt+'</button> '};
 if(d.rel==='none')h+=f('POST','➕ '+t('add_friend'),'soft');
 if(d.rel==='outgoing')h+='<span class="chip y">'+t('sent')+'</span> '+f('DELETE',t('cancel_req'),'soft sm');
 if(d.rel==='incoming')h+=f('POST','✔ '+t('accept'),'')+f('DELETE',t('decline'),'soft');
 if(d.rel==='friend')h+=f('DELETE',t('remove'),'soft sm');
 if(ME.admin&&!u.admin)h+=d.banned?'<button class="btn pink sm" onclick="'+C('unban',u.id)+'">'+t('unban')+'</button>':'<button class="btn pink sm" onclick="banDlg(\''+u.id+'\')">🚫 '+t('ban')+'</button>';
 return h;
}
async function fr(m,id){await api(m,'/api/friends/'+id);route();run(badges)}
function banDlg(uid){
 modal('🚫 '+t('ban_title'),'<label class="f">'+t('ban_days')+'</label><select id="m_days"><option value="1">'+t('days_1')+'</option><option value="3">'+t('days_3')+'</option><option value="7" selected>'+t('days_7')+'</option><option value="30">'+t('days_30')+'</option><option value="0">'+t('perm')+'</option></select><label class="f">'+t('ban_reason')+'</label><textarea id="m_reason" maxlength="200"></textarea>',async function(){
  await api('POST','/api/admin/ban',{uid:uid,days:+$('#m_days').value,reason:$('#m_reason').value});route();
 },t('ban'));
}
async function unban(uid){await api('POST','/api/admin/unban',{uid:uid});route()}
function editForm(){
 var u=ME,sel=function(i){return '<select id="e_top'+i+'"><option value="">'+t('none')+'</option>'+S.map(function(s){return '<option value="'+s+'"'+(u.top[i]===s?' selected':'')+'>'+sn(s)+'</option>'}).join('')+'</select>'};
 return '<div class="card"><h3>✏️ '+t('edit')+'</h3><div class="grid2"><div><label class="f">'+t('first')+'</label><input id="e_first" maxlength="30" value="'+esc(u.first)+'"></div><div><label class="f">'+t('last')+'</label><input id="e_last" maxlength="30" value="'+esc(u.last)+'"></div></div>'
 +'<label class="f">'+t('cls')+'</label><input id="e_cls" maxlength="6" value="'+esc(u.cls)+'">'
 +'<label class="f">'+t('about')+'</label><textarea id="e_bio" maxlength="500" placeholder="'+t('bio_ph')+'">'+esc(u.bio)+'</textarea>'
 +'<label class="f">'+t('dream')+'</label><input id="e_dream" maxlength="80" value="'+esc(u.dream)+'">'
 +'<label class="f">'+t('goal')+'</label><input id="e_goal" maxlength="100" value="'+esc(u.goal)+'">'
 +'<label class="f">'+t('top3')+'</label><div class="grid2">'+sel(0)+sel(1)+'</div><div style="margin-top:10px">'+sel(2)+'</div>'
 +'<label class="f">'+t('color')+'</label><div id="e_cols">'+COLORS.map(function(c){return '<span class="sw'+(c===u.color?' on':'')+'" data-c="'+c+'" style="background:'+c+'" onclick="pickColor(this)"></span>'}).join('')+'</div>'
 +'<div class="row" style="margin-top:16px"><button class="btn" onclick="run(saveProfile)">'+t('save')+'</button><button class="btn soft" onclick="editing=false;route()">'+t('cancel')+'</button></div></div>';
}
function pickColor(el){document.querySelectorAll('#e_cols .sw').forEach(function(x){x.className='sw'});el.className='sw on'}
async function saveProfile(){
 var top=[0,1,2].map(function(i){return $('#e_top'+i).value}).filter(Boolean);
 var c=document.querySelector('#e_cols .on');
 var r=await api('PUT','/api/me',{first:$('#e_first').value,last:$('#e_last').value,cls:$('#e_cls').value,bio:$('#e_bio').value,dream:$('#e_dream').value,goal:$('#e_goal').value,top:top,color:c?c.getAttribute('data-c'):ME.color});
 ME=r.me;editing=false;route();
}
async function vProfile(id){
 var d=await api('GET','/api/user/'+id),u=d.user,self=d.rel==='self';
 if(self)ME=u;
 var medals=['🥇','🥈','🥉'];
 var facts='';
 if(u.bio)facts+='<div class="fact"><small>'+t('about')+'</small>'+esc(u.bio).replace(/\n/g,'<br>')+'</div>';
 if(u.dream)facts+='<div class="fact"><small>'+t('dream')+'</small>'+esc(u.dream)+'</div>';
 if(u.goal)facts+='<div class="fact"><small>'+t('goal')+'</small>'+esc(u.goal)+'</div>';
 if(u.top.length)facts+='<div class="fact"><small>'+t('top3')+'</small><div class="tops">'+u.top.map(function(s,i){return '<span class="chip '+['p','m','y'][i]+'">'+medals[i]+' '+sn(s)+'</span>'}).join('')+'</div></div>';
 if(d.clubs.length)facts+='<div class="fact"><small>'+t('n_clubs')+'</small><div class="tops">'+d.clubs.map(function(c){return '<a class="chip" href="#/club/'+c.id+'">'+esc(c.emoji)+' '+esc(c.name)+'</a>'}).join('')+'</div></div>';
 var aw=d.awards.map(function(a){return '<span class="award">🏆 '+(a.school?fmt('best_school',{s:t('s_'+a.subject)}):fmt('best_class',{s:t('s_'+a.subject),c:esc(u.cls)}))+'</span>'}).join('');
 var rows=S.map(function(s){return starsRow(u.id,s,d.ratings[s],self)}).join('');
 var earned=d.badges.filter(function(b){return b.have}).length;
 var bg=d.badges.map(function(b){return '<div class="bc'+(b.have?'':' lock')+'"><div class="be">'+BE[b.id]+'</div><b>'+t('b_'+b.id)+'</b><small>'+(b.have?t('earned'):t('bd_'+b.id)+' · '+b.progress+'/'+b.goal)+'</small></div>'}).join('');
 main((self&&editing?editForm():'<div class="card hero">'+av(u,'lg')+'<h2>'+esc(nm(u))+'</h2><div class="mute">@'+esc(u.username)+'</div><div style="margin:8px 0"><span class="chip">'+t('cls')+' '+esc(u.cls)+'</span> <span class="chip m">'+d.friendsCount+' '+t('friends_n')+'</span>'+adminChip(u)+(d.banned?' <span class="chip p">🚫 '+t('banned_chip')+'</span>':'')+'</div>'+(aw?'<div style="margin:6px 0">'+aw+'</div>':'')+'<div class="row" style="justify-content:center">'+relBtns(d)+'</div><div class="facts">'+facts+'</div></div>')
 +(u.admin?'':'<div class="card"><h3>⭐ '+t('ratings')+'</h3><div class="mute" style="margin-bottom:6px">'+(self?t('rate_self'):t('rate_hint'))+'</div>'+rows+'</div>')
 +'<div class="card"><h3>🏅 '+t('badges')+' ('+earned+'/'+d.badges.length+')</h3><div class="bgrid">'+bg+'</div></div>'
 +'<h2>'+t('posts')+'</h2>'+(self?composer():'')+(d.posts.length?d.posts.map(postHtml).join(''):'<div class="empty">'+t('no_posts')+'</div>'));
}

// ---------- people & friends ----------
function pTabs(a){return '<div class="tabs"><a class="tab'+(a==='people'?' on':'')+'" href="#/people">🔎 '+t('tab_all')+'</a><a class="tab'+(a==='friends'?' on':'')+'" href="#/friends">🤝 '+t('n_friends')+'</a></div>'}
function pRow(u,extra){return '<div class="card person"><a href="#/u/'+u.id+'">'+av(u,'')+'</a><a class="info" href="#/u/'+u.id+'"><b>'+esc(nm(u))+adminChip(u)+'</b><span class="mute">@'+esc(u.username)+'</span></a><span class="chip">'+esc(u.cls)+'</span>'+(extra||'')+'</div>'}
function psearch(){clearTimeout(pt);pt=setTimeout(function(){run(loadPeople)},250)}
async function loadPeople(){
 var r=await api('GET','/api/users?q='+encodeURIComponent($('#pq').value.trim())+($('#pm').checked?'&mine=1':''));
 $('#pl').innerHTML=r.users.length?r.users.map(function(u){return pRow(u,u.rel==='friend'?'<span class="chip m">🤝</span>':'')}).join(''):'<div class="empty">'+t('p_none')+'</div>';
}
async function vPeople(){
 main('<h2>🔎 '+t('n_people')+'</h2>'+pTabs('people')+'<div class="card"><input id="pq" placeholder="'+t('p_search')+'" oninput="psearch()"><label class="row" style="margin-top:10px;cursor:pointer"><input type="checkbox" id="pm" style="width:auto" onchange="psearch()"> '+t('p_mine')+' ('+esc(ME.cls)+')</label></div><div id="pl"></div>');
 await loadPeople();
}
async function vFriends(){
 var r=await api('GET','/api/friends');
 var btn=function(m,id,txt,cls){return '<button class="btn sm '+cls+'" onclick="'+C('fr',m,id)+'">'+txt+'</button>'};
 var h='<h2>🤝 '+t('n_friends')+'</h2>'+pTabs('friends');
 if(r.incoming.length)h+='<h3>'+t('f_in')+'</h3>'+r.incoming.map(function(u){return pRow(u,btn('POST',u.id,'✔ '+t('accept'),'')+' '+btn('DELETE',u.id,t('decline'),'soft'))}).join('');
 h+='<h3>'+t('f_my')+' ('+r.friends.length+')</h3>'+(r.friends.length?r.friends.map(function(u){return pRow(u,'<a class="btn sm" href="#/chat/u/'+u.id+'">💬</a>')}).join(''):'<div class="empty">'+t('f_none')+'</div>');
 if(r.outgoing.length)h+='<h3>'+t('f_out')+'</h3>'+r.outgoing.map(function(u){return pRow(u,btn('DELETE',u.id,t('cancel_req'),'soft'))}).join('');
 main(h);
}

// ---------- chats ----------
async function vChats(){
 var r=await api('GET','/api/chats');
 var row=function(href,avh,title,sub,unread){return '<a class="card person" href="'+href+'">'+avh+'<div class="info"><b>'+title+'</b><span class="mute" style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+sub+'</span></div>'+(unread?'<span class="dot">'+unread+'</span>':'')+'</a>'};
 var sub=function(c){return c.lastMsg?(c.lastMsg.mine?t('you')+': ':'')+esc(c.lastMsg.text):'…'};
 var h='<h2>💬 '+t('n_chats')+'</h2>'+row('#/chat/class','<span class="av" style="background:var(--mint)">👥</span>',t('c_class')+' '+esc(r.cls),sub(r.classRoom),r.classRoom.unread);
 if(r.clubs.length)h+='<h3 style="margin-top:18px">'+t('c_clubs')+'</h3>'+r.clubs.map(function(c){return row('#/chat/club/'+c.id,'<span class="av em">'+esc(c.emoji)+'</span>',esc(c.name),sub(c),c.unread)}).join('');
 h+='<h3 style="margin-top:18px">'+t('c_people')+'</h3>';
 h+=r.contacts.length?r.contacts.map(function(c){return row('#/chat/u/'+c.id,av(c,''),esc(nm(c))+' <span class="chip">'+esc(c.cls)+'</span>'+adminChip(c),sub(c),c.unread)}).join(''):'<div class="empty">'+t('c_none')+'</div>';
 main(h);
}
function addMsgs(list,spec,first){
 var box=$('#msgs');if(!box)return;
 var near=first||box.scrollHeight-box.scrollTop-box.clientHeight<90,add='';
 list.forEach(function(m){
  if(m.id<=chatLast)return;chatLast=m.id;var mine=m.uid===ME.id;
  add+='<div class="m'+(mine?' me':'')+'">'+(spec!=='class'&&spec.indexOf('club/')!==0||mine?'':'<small>'+esc(m.name)+'</small>')+'<p>'+esc(m.text)+'</p><time>'+hm(m.ts)+'</time></div>';
 });
 if(!add)return;
 var em=$('#mempty');if(em)em.remove();
 box.insertAdjacentHTML('beforeend',add);
 if(near)box.scrollTop=box.scrollHeight;
}
async function vChat(spec){
 var r=await api('GET','/api/chat/'+spec);chatLast=0;
 var title=spec==='class'?'👥 '+t('class_chat')+' '+esc(r.cls):r.club?'<a href="#/club/'+r.club.id+'">'+esc(r.club.emoji)+' '+esc(r.club.name)+'</a>':'<a href="#/u/'+r.peer.id+'" style="display:flex;align-items:center;gap:8px">'+av(r.peer,'sm')+esc(nm(r.peer))+'</a>';
 main('<div class="chat"><div class="chead"><a href="#/chats" class="btn soft sm">←</a><b>'+title+'</b></div><div id="msgs" class="msgs"><div class="empty" id="mempty">'+t('no_msgs')+'</div></div><form class="cform" onsubmit="return sendMsg(event,\''+spec+'\')"><input id="mtext" maxlength="1000" autocomplete="off" placeholder="'+t('msg_ph')+'"><button class="btn">➤</button></form></div>');
 addMsgs(r.msgs,spec,true);
 run(badges);
 poll=setInterval(function(){run(async function(){var x=await api('GET','/api/chat/'+spec+'?after='+chatLast);addMsgs(x.msgs,spec,false);if(x.msgs.length)badges()})},2500);
}
function sendMsg(e,spec){
 e.preventDefault();
 var inp=$('#mtext'),text=inp.value.trim();if(!text)return false;
 inp.value='';
 run(async function(){var r=await api('POST','/api/chat/'+spec,{text:text});addMsgs([r.msg],spec,true)});
 return false;
}

// ---------- notifications ----------
function ntInfo(n){
 var nn=n.from?'<b>'+esc(n.from.name)+'</b>':'';
 var o={n:nn,t:esc(n.text),b:'<b>'+esc(t('b_'+n.badge))+'</b>',k:'<b>'+esc(n.task)+'</b>',c:'<b>'+esc(n.clubName)+'</b>',p:n.pts};
 var m={like:['❤️','#/post/'+n.post],comment:['💬','#/post/'+n.post],friend_req:['🤝','#/friends'],friend_acc:['✅','#/u/'+(n.from?n.from.id:'')],badge:['🏅','#/me'],hidden:['🙈','#/me'],club_sub:['📨','#/club/'+n.club],club_ok:['✅','#/club/'+n.club],club_no:['❌','#/club/'+n.club],club_task:['🎯','#/club/'+n.club]}[n.type]||['🔔','#/feed'];
 return {ic:m[0],href:m[1],txt:fmt('nt_'+n.type,o)};
}
async function vNotifs(){
 var r=await api('GET','/api/notifs');
 main('<h2>🔔 '+t('n_notifs')+'</h2>'+(r.notifs.length?r.notifs.map(function(n){var i=ntInfo(n);return '<a class="card nt'+(n.read?'':' un')+'" href="'+i.href+'"><span class="ic">'+i.ic+'</span><div style="flex:1"><div>'+i.txt+'</div><div class="mute">'+ft(n.ts)+'</div></div></a>'}).join(''):'<div class="empty">'+t('no_notifs')+'</div>'));
 if(r.notifs.some(function(n){return !n.read})){await api('POST','/api/notifs/read',{});badges()}
}

// ---------- rankings ----------
async function vRank(){
 if(!rk.scope)rk.scope=ME.admin?'school':'class';
 var tabs=['subject','clubs','activity'].map(function(k){return '<a href="#" class="tab'+(rk.type===k?' on':'')+'" onclick="rk.type=\''+k+'\';route();return false">'+t('r_'+k)+'</a>'}).join('');
 var ctl='';
 if(rk.type==='subject')ctl+='<select style="margin-bottom:10px" onchange="rk.subject=this.value;route()">'+S.map(function(s){return '<option value="'+s+'"'+(rk.subject===s?' selected':'')+'>'+sn(s)+'</option>'}).join('')+'</select>';
 if(rk.type!=='clubs')ctl+='<div class="tabs">'+['class','school'].map(function(k){return '<a href="#" class="tab'+(rk.scope===k?' on':'')+'" onclick="rk.scope=\''+k+'\';route();return false">'+t('sc_'+k)+'</a>'}).join('')+'</div>';
 var r=await api('GET','/api/rank?type='+rk.type+'&subject='+rk.subject+'&scope='+rk.scope);
 var med=function(n){return n<4?['🥇','🥈','🥉'][n-1]:n};
 var rows=r.rows.map(function(x){
  if(rk.type==='clubs')return '<a class="rk" href="#/club/'+x.id+'"><span class="n">'+med(x.rank)+'</span><span class="av sm em">'+esc(x.emoji)+'</span><div style="flex:1"><b>'+esc(x.name)+'</b><div class="mute">'+x.members+' '+t('members').toLowerCase()+'</div></div><span class="v">'+x.total+' '+t('pts')+'</span></a>';
  return '<a class="rk" href="#/u/'+x.user.id+'"><span class="n">'+med(x.rank)+'</span>'+av(x.user,'sm')+'<div style="flex:1"><b>'+esc(nm(x.user))+'</b> <span class="chip">'+esc(x.user.cls)+'</span></div><span class="v">'+(rk.type==='subject'?'★ '+x.avg.toFixed(2)+'<div class="mute">'+x.count+' '+t('votes')+'</div>':x.score+' '+t('pts')+'<div class="mute">🏅 '+x.badges+'</div>')+'</span></a>';
 }).join('');
 main('<h2>🏆 '+t('rankings')+'</h2><div class="tabs">'+tabs+'</div>'+ctl+'<div class="card">'+(rows||'<div class="empty">'+t('no_rank')+'</div>')+'</div>'+(rk.type==='subject'?'<div class="mute" style="text-align:center">'+fmt('r_min',{n:r.min})+'</div>':''));
}

// ---------- clubs ----------
var clq='';
function clubRow(c){
 return '<div class="card person"><a href="#/club/'+c.id+'"><span class="av em">'+esc(c.emoji)+'</span></a><a class="info" href="#/club/'+c.id+'"><b>'+esc(c.name)+'</b><span class="mute" style="display:block">'+esc(c.desc||'')+'</span><span class="chip m">'+c.members+' 👥</span> <span class="chip y">'+c.total+' '+t('pts')+'</span></a>'
 +(c.role?'<a class="btn soft sm" href="#/club/'+c.id+'">'+t('open')+'</a>':'<button class="btn sm" onclick="'+C('joinClub',c.id,true)+'">'+t('join')+'</button>')+'</div>';
}
async function loadClubs(){
 var r=await api('GET','/api/clubs?q='+encodeURIComponent(clq));
 $('#cl').innerHTML=r.clubs.length?r.clubs.map(clubRow).join(''):'<div class="empty">'+t('no_clubs')+'</div>';
}
function csearch(el){clq=el.value.trim();clearTimeout(pt);pt=setTimeout(function(){run(loadClubs)},250)}
async function vClubs(){
 cEmoji=EMS[0];
 main('<h2>🎯 '+t('clubs_title')+'</h2><div class="row" style="margin-bottom:12px"><input style="flex:1" placeholder="'+t('search_clubs')+'" value="'+esc(clq)+'" oninput="csearch(this)"><button class="btn" onclick="var f=$(\'#cnew\');f.style.display=f.style.display===\'block\'?\'none\':\'block\'">➕ '+t('new_club')+'</button></div>'
 +'<div class="card" id="cnew" style="display:none"><div class="ems" id="cems">'+EMS.map(function(e,i){return '<span class="'+(i===0?'on':'')+'" onclick="pickEm(this)">'+e+'</span>'}).join('')+'</div><label class="f">'+t('club_name')+'</label><input id="c_name" maxlength="30"><label class="f">'+t('club_desc')+'</label><textarea id="c_desc" maxlength="200"></textarea><div style="margin-top:12px"><button class="btn" onclick="run(createClub)">'+t('create')+'</button></div></div><div id="cl"></div>');
 await loadClubs();
}
function pickEm(el){document.querySelectorAll('#cems span').forEach(function(x){x.className=''});el.className='on';cEmoji=el.textContent}
async function createClub(){
 var r=await api('POST','/api/clubs',{name:$('#c_name').value,desc:$('#c_desc').value,emoji:cEmoji});
 location.hash='#/club/'+r.id;
}
async function joinClub(id){await api('POST','/api/club/'+id+'/join',{});var h='#/club/'+id;if(location.hash===h)route();else location.hash=h;run(badges)}
async function leaveClub(id){await api('POST','/api/club/'+id+'/leave',{});route()}
async function delClub(id){if(!confirm(t('confirm_delete_club')))return;await api('DELETE','/api/club/'+id);location.hash='#/clubs'}
async function vClub(id){
 var d=await api('GET','/api/club/'+id),c=d.club,medals=['🥇','🥈','🥉'];
 var btns='';
 if(d.role&&d.role!=='admin')btns+='<a class="btn" href="#/chat/club/'+c.id+'">💬 '+t('club_chat')+'</a> ';
 if(!c.role)btns+='<button class="btn" onclick="'+C('joinClub',c.id,true)+'">'+t('join')+'</button> ';
 else if(c.role!=='owner')btns+='<button class="btn soft sm" onclick="'+C('leaveClub',c.id)+'">'+t('leave')+'</button> ';
 if(d.role==='admin'&&!c.role)btns+='<a class="btn soft sm" href="#/chat/club/'+c.id+'">💬</a> ';
 if(c.role==='owner'||ME.admin)btns+='<button class="btn pink sm" onclick="'+C('delClub',c.id)+'">🗑 '+t('delete_club')+'</button>';
 var tasks=d.tasks.map(function(k){
  var st='';
  if(c.role){
   if(!k.mine||k.mine.st==='no')st='<button class="btn sm" onclick="subDlg(\''+c.id+'\',\''+k.id+'\')">📨 '+t('submit')+'</button>'+(k.mine?' <span class="chip p">'+t('st_no')+'</span>':'');
   else st='<span class="chip '+(k.mine.st==='ok'?'m':'y')+'">'+t('st_'+k.mine.st)+'</span>';
  }
  var pend='';
  if(d.mod&&k.pending.length)pend='<div class="sub"><small class="mute"><b>'+t('pending')+'</b></small>'+k.pending.map(function(s){return '<div style="margin-top:6px"><a href="#/u/'+s.uid+'"><b>'+esc(s.name)+'</b></a> <span class="mute">'+ft(s.ts)+'</span><div style="white-space:pre-wrap">'+esc(s.text)+'</div><div class="row" style="margin-top:4px"><button class="btn sm" onclick="'+C('review',c.id,k.id,s.uid,true)+'">✔ '+t('approve')+'</button><button class="btn soft sm" onclick="'+C('review',c.id,k.id,s.uid,false)+'">'+t('decline')+'</button></div></div>'}).join('')+'</div>';
  return '<div class="task"><div class="row"><b style="flex:1">'+esc(k.title)+'</b><span class="chip y">+'+k.pts+' '+t('pts')+'</span>'+(d.mod?'<button class="lk" onclick="'+C('delTask',c.id,k.id)+'">🗑</button>':'')+'</div>'+(k.desc?'<div class="mute" style="white-space:pre-wrap">'+esc(k.desc)+'</div>':'')+'<div class="row" style="margin-top:6px">'+st+'<span class="mute">'+k.done+' '+t('done_by')+'</span></div>'+pend+'</div>';
 }).join('');
 var mem=d.members.map(function(u,i){
  var ctl='';
  if(u.role!=='owner'&&u.id!==ME.id){
   if(d.role==='owner'||ME.admin)ctl+='<button class="lk" title="'+(u.role==='mod'?t('remove_mod'):t('make_mod'))+'" onclick="'+C('setRole',c.id,u.id,u.role==='mod'?'member':'mod')+'">'+(u.role==='mod'?'⬇️':'⭐')+'</button>';
   if(d.mod&&(u.role==='member'||d.role==='owner'||ME.admin))ctl+='<button class="lk" title="'+t('kick')+'" onclick="'+C('kickMember',c.id,u.id)+'">✕</button>';
  }
  return '<div class="rk"><span class="n">'+(i<3&&u.pts>0?medals[i]:i+1)+'</span><a href="#/u/'+u.id+'">'+av(u,'sm')+'</a><a href="#/u/'+u.id+'" style="flex:1"><b>'+esc(nm(u))+'</b> <span class="chip">'+esc(u.cls)+'</span>'+(u.role!=='member'?' <span class="chip p">'+t('role_'+u.role)+'</span>':'')+'</a><span class="v">'+u.pts+' '+t('pts')+'</span>'+ctl+'</div>';
 }).join('');
 var newTask=d.mod?'<details style="margin-bottom:8px"><summary class="btn soft sm" style="display:inline-flex">➕ '+t('new_task')+'</summary><div style="margin-top:8px"><label class="f">'+t('task_title')+'</label><input id="t_title" maxlength="60"><label class="f">'+t('task_desc')+'</label><textarea id="t_desc" maxlength="300"></textarea><label class="f">'+t('task_pts')+'</label><input id="t_pts" type="number" min="1" max="100" value="10"><div style="margin-top:10px"><button class="btn sm" onclick="'+C('addTask',c.id)+'">'+t('create')+'</button></div></div></details>':'';
 main('<a href="#/clubs" class="btn soft sm">←</a><div style="height:10px"></div><div class="card hero"><span class="av lg em">'+esc(c.emoji)+'</span><h2>'+esc(c.name)+'</h2><div class="mute">'+esc(c.desc||'')+'</div><div style="margin:8px 0"><span class="chip m">'+c.members+' 👥</span> <span class="chip y">'+c.total+' '+t('pts')+'</span></div><div class="row" style="justify-content:center">'+btns+'</div></div>'
 +'<div class="card"><h3>📋 '+t('tasks')+'</h3>'+newTask+(tasks||'<div class="empty">'+t('no_tasks')+'</div>')+'</div>'
 +'<div class="card"><h3>🏆 '+t('leaderboard')+'</h3>'+mem+'</div>');
}
function subDlg(cid,tid){
 modal('📨 '+t('submit_title'),'<textarea id="m_text" maxlength="300" placeholder="'+t('submit_ph')+'"></textarea>',async function(){
  await api('POST','/api/club/'+cid+'/tasks/'+tid+'/submit',{text:$('#m_text').value});route();
 },t('submit'));
}
async function addTask(cid){await api('POST','/api/club/'+cid+'/tasks',{title:$('#t_title').value,desc:$('#t_desc').value,pts:+$('#t_pts').value});route()}
async function delTask(cid,tid){await api('DELETE','/api/club/'+cid+'/tasks/'+tid);route()}
async function review(cid,tid,uid,ok){await api('POST','/api/club/'+cid+'/tasks/'+tid+'/review',{uid:uid,ok:ok});route()}
async function setRole(cid,uid,role){await api('POST','/api/club/'+cid+'/members/'+uid+'/role',{role:role});route()}
async function kickMember(cid,uid){if(!confirm(t('confirm_kick')))return;await api('DELETE','/api/club/'+cid+'/members/'+uid);route()}

// ---------- admin ----------
var aq='';
async function vAdmin(){
 var tabs=[['open','adm_reports'],['done','adm_handled'],['users','adm_users']].map(function(k){return '<a href="#" class="tab'+(adm.tab===k[0]?' on':'')+'" onclick="adm.tab=\''+k[0]+'\';route();return false">'+t(k[1])+'</a>'}).join('');
 if(adm.tab==='users'){
  main('<h2>🛡 '+t('n_admin')+'</h2><div class="tabs">'+tabs+'</div><div class="card"><input placeholder="'+t('p_search')+'" value="'+esc(aq)+'" oninput="aq=this.value;clearTimeout(pt);pt=setTimeout(function(){run(loadAdminUsers)},250)"></div><div id="au"></div>');
  return loadAdminUsers();
 }
 var r=await api('GET','/api/admin/reports?status='+adm.tab);
 var rs={spam:t('reason_spam'),bullying:t('reason_bullying'),inappropriate:t('reason_inap'),other:t('reason_other')};
 var h=r.reports.map(function(x){
  var acts='';
  if(!x.gone){
   if(x.status==='open'){acts+='<button class="btn sm" onclick="'+C('resolveR',x.id,'hide')+'">🙈 '+t('hide_content')+'</button> <button class="btn soft sm" onclick="'+C('resolveR',x.id,'dismiss')+'">'+t('dismiss')+'</button> ';}
   else if(x.hidden)acts+='<button class="btn soft sm" onclick="'+C('adminHide',x.post,x.comment||'',false)+'">👁 '+t('restore')+'</button> ';
   if(x.author&&!x.author.admin&&!x.author.banned)acts+='<button class="btn pink sm" onclick="banDlg(\''+x.author.id+'\')">🚫 '+t('ban')+'</button> ';
   acts+='<a class="btn soft sm" href="#/post/'+x.post+'">'+t('open')+'</a>';
  }
  return '<div class="card"><div class="row"><span class="chip p">'+(x.type==='comment'?'💬':'📝')+' '+esc(rs[x.reason]||x.reason)+'</span>'+(x.status!=='open'?'<span class="chip">'+t('st_'+x.status)+'</span>':'')+'<span class="sp"></span><span class="mute">'+ft(x.ts)+'</span></div>'
  +(x.author?'<div style="margin-top:8px"><a href="#/u/'+x.author.id+'"><b>'+esc(x.author.name)+'</b></a>'+(x.author.banned?' <span class="chip p">🚫</span>':'')+'</div>':'')
  +(x.gone?'<div class="mute">'+t('gone')+'</div>':'<div class="fact" style="margin-top:6px;white-space:pre-wrap">'+esc(x.text)+(x.img?'<img style="display:block;max-width:100%;max-height:240px;border-radius:10px;margin-top:6px" src="/uploads/'+esc(x.img)+'">':'')+'</div>')
  +'<div class="mute" style="margin-top:6px">'+t('from_by')+': '+esc(x.by)+(x.note?' — “'+esc(x.note)+'”':'')+'</div><div class="row" style="margin-top:8px">'+acts+'</div></div>';
 }).join('');
 main('<h2>🛡 '+t('n_admin')+'</h2><div class="tabs">'+tabs+'</div>'+(h||'<div class="empty">'+t('no_reports')+'</div>'));
}
async function resolveR(id,action){await api('POST','/api/admin/reports/'+id+'/resolve',{action:action});route();run(badges)}
async function loadAdminUsers(){
 var r=await api('GET','/api/admin/users?q='+encodeURIComponent(aq.trim()));
 $('#au').innerHTML=r.users.map(function(u){
  var b=u.banned?'<span class="chip p">🚫 '+(u.banned.until?ft(u.banned.until):t('banned_perm'))+'</span>':'';
  var a=u.admin?'':(u.banned?'<button class="btn soft sm" onclick="'+C('unban',u.id)+'">'+t('unban')+'</button>':'<button class="btn pink sm" onclick="banDlg(\''+u.id+'\')">'+t('ban')+'</button>');
  return pRow(u,b+a);
 }).join('');
}

// ---------- boot ----------
async function boot(){
 clearInterval(bt);clearInterval(poll);
 var r=null;
 try{r=await api('GET','/api/me');ME=r.me}catch(e){ME=null}
 if(!ME){return vAuth('login')}
 if(r.ban){return vBanned(r.ban)}
 shell();route();
 run(badges);bt=setInterval(function(){run(badges)},8000);
}
boot();
</script></body></html>
__HTML__*/