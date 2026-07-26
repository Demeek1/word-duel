/* ============================================================
 *  WordSwap — real-time game server (Online Friend Match)
 *  Node + Express + Socket.IO. Authoritative timers + server-side
 *  word validation (anti-cheat). In-memory rooms (MVP).
 * ============================================================ */
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const WORDS = require('./words.js').map((w) => String(w).toLowerCase());
const DICT = new Set(WORDS);
const BY_LEN = {};
DICT.forEach((w) => { (BY_LEN[w.length] = BY_LEN[w.length] || []).push(w); });

const DIFF = { chill:{start:12,step:.3}, normal:{start:10,step:.5}, blitz:{start:8,step:.75}, insane:{start:7,step:1} };
const MIN_LIMIT = 5;
const MAX_PLAYERS = 2;          // friend match = 1v1 for the MVP
const GRACE_MS = 20000;         // reconnect grace before forfeit
const ROOM_TTL_MS = 60 * 60 * 1000;

const app = express();
app.use(cors());
app.get('/', (_req, res) => res.json({ ok: true, service: 'wordswap-server', rooms: Object.keys(rooms).length, words: DICT.size }));
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

/** rooms[code] = { code, hostUserId, players:[{userId,name,avatar,socketId,connected}],
 *   state, len, diffKey, word, used:[], turnIndex, limit, deadline, timer, graceTimers:{}, createdAt } */
const rooms = {};

// ---------- helpers ----------
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
function genCode() {
  let c;
  do { c = ''; for (let i = 0; i < 6; i++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]; }
  while (rooms[c]);
  return c;
}
function pickWord(len) {
  const pool = BY_LEN[len] || BY_LEN[4];
  for (let tries = 0; tries < 60; tries++) {
    const w = pool[Math.floor(Math.random() * pool.length)];
    if (movesCount(w, []) >= 3) return w;
  }
  return pool[Math.floor(Math.random() * pool.length)];
}
function oneOff(a, b) {
  if (a.length !== b.length) return -1;
  let d = 0, idx = -1;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { d++; idx = i; if (d > 1) return -1; }
  return d === 1 ? idx : -1;
}
function movesCount(w, used) {
  let n = 0;
  for (let i = 0; i < w.length; i++) for (let c = 97; c < 123; c++) {
    const ch = String.fromCharCode(c);
    if (ch === w[i]) continue;
    const cand = w.slice(0, i) + ch + w.slice(i + 1);
    if (DICT.has(cand) && used.indexOf(cand) === -1) n++;
  }
  return n;
}
function publicRoom(room) {
  return {
    code: room.code,
    state: room.state,
    hostUserId: room.hostUserId,
    len: room.len,
    diff: room.diffKey,
    word: room.word,
    used: room.used,
    chain: Math.max(0, room.used.length - 1),
    turnUserId: room.state === 'playing' && room.players[room.turnIndex] ? room.players[room.turnIndex].userId : null,
    deadline: room.deadline || null,
    limit: room.limit || null,
    players: room.players.map((p) => ({ userId: p.userId, name: p.name, avatar: p.avatar, connected: p.connected })),
  };
}
function emitLobby(room) { io.to(room.code).emit('lobby', publicRoom(room)); }
function emitState(room) { io.to(room.code).emit('state', publicRoom(room)); }

function clearTurnTimer(room) { if (room.timer) { clearTimeout(room.timer); room.timer = null; } }
function startTurn(room) {
  clearTurnTimer(room);
  room.deadline = Date.now() + room.limit * 1000;
  room.timer = setTimeout(() => onTimeout(room), room.limit * 1000 + 120);
  emitState(room);
}
function onTimeout(room) {
  if (room.state !== 'playing') return;
  const loser = room.players[room.turnIndex];
  const winner = room.players[(room.turnIndex + 1) % room.players.length];
  endGame(room, winner ? winner.userId : null, loser ? loser.userId : null, 'timeout');
}
function endGame(room, winnerUserId, loserUserId, reason) {
  clearTurnTimer(room);
  room.state = 'over';
  io.to(room.code).emit('gameover', { winnerUserId, loserUserId, reason, chain: Math.max(0, room.used.length - 1), word: room.word });
}

function findRoomBySocket(socket) {
  const d = socket.data || {};
  return d.code ? rooms[d.code] : null;
}

// ---------- socket handlers ----------
io.on('connection', (socket) => {

  socket.on('create', (payload = {}, cb) => {
    try {
      const len = [3, 4, 5].includes(+payload.len) ? +payload.len : 4;
      const diffKey = DIFF[payload.diff] ? payload.diff : 'normal';
      const userId = String(payload.userId || socket.id).slice(0, 64);
      const code = genCode();
      const room = {
        code, hostUserId: userId, state: 'lobby', len, diffKey,
        word: '', used: [], turnIndex: 0, limit: DIFF[diffKey].start, deadline: null, timer: null,
        graceTimers: {}, createdAt: Date.now(),
        players: [{ userId, name: cleanName(payload.name), avatar: cleanAvatar(payload.avatar), socketId: socket.id, connected: true }],
      };
      rooms[code] = room;
      socket.data = { code, userId };
      socket.join(code);
      if (cb) cb({ ok: true, code, you: userId });
      emitLobby(room);
    } catch (e) { if (cb) cb({ ok: false, error: 'create_failed' }); }
  });

  socket.on('join', (payload = {}, cb) => {
    try {
      const code = String(payload.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      const room = rooms[code];
      const userId = String(payload.userId || socket.id).slice(0, 64);
      if (!room) return cb && cb({ ok: false, error: 'not_found' });

      const existing = room.players.find((p) => p.userId === userId);
      if (existing) {
        // reconnect / resume
        existing.socketId = socket.id; existing.connected = true;
        if (room.graceTimers[userId]) { clearTimeout(room.graceTimers[userId]); delete room.graceTimers[userId]; }
        socket.data = { code, userId }; socket.join(code);
        if (cb) cb({ ok: true, code, you: userId, resumed: true });
        emitLobby(room);
        if (room.state === 'playing') emitState(room);
        return;
      }
      if (room.players.length >= MAX_PLAYERS) return cb && cb({ ok: false, error: 'full' });
      if (room.state !== 'lobby') return cb && cb({ ok: false, error: 'in_progress' });

      room.players.push({ userId, name: cleanName(payload.name), avatar: cleanAvatar(payload.avatar), socketId: socket.id, connected: true });
      socket.data = { code, userId }; socket.join(code);
      if (cb) cb({ ok: true, code, you: userId });
      emitLobby(room);
    } catch (e) { if (cb) cb({ ok: false, error: 'join_failed' }); }
  });

  socket.on('start', (cb) => {
    const room = findRoomBySocket(socket);
    if (!room) return cb && cb({ ok: false, error: 'no_room' });
    if (socket.data.userId !== room.hostUserId) return cb && cb({ ok: false, error: 'not_host' });
    if (room.players.length < 2) return cb && cb({ ok: false, error: 'need_players' });
    room.state = 'playing';
    room.word = pickWord(room.len);
    room.used = [room.word];
    room.turnIndex = 0;
    room.limit = DIFF[room.diffKey].start;
    if (cb) cb({ ok: true });
    startTurn(room);
  });

  socket.on('move', (payload = {}, cb) => {
    const room = findRoomBySocket(socket);
    if (!room || room.state !== 'playing') return cb && cb({ ok: false, error: 'not_playing' });
    const me = room.players[room.turnIndex];
    if (!me || me.userId !== socket.data.userId) return cb && cb({ ok: false, error: 'not_your_turn' });

    const guess = String(payload.word || '').trim().toLowerCase();
    let reason = null;
    if (!/^[a-z]+$/.test(guess)) reason = 'Letters only';
    else if (guess.length !== room.word.length) reason = 'Wrong length';
    else if (guess === room.word) reason = 'Change one letter';
    else if (oneOff(room.word, guess) < 0) reason = 'Change exactly one letter';
    else if (room.used.indexOf(guess) !== -1) reason = 'Already used';
    else if (!DICT.has(guess)) reason = 'Not a word';
    if (reason) return cb && cb({ ok: false, error: 'invalid', reason });

    const changedIndex = oneOff(room.word, guess);
    room.word = guess;
    room.used.push(guess);
    room.turnIndex = (room.turnIndex + 1) % room.players.length;
    room.limit = Math.max(MIN_LIMIT, room.limit - DIFF[room.diffKey].step);
    if (cb) cb({ ok: true });
    io.to(room.code).emit('moved', { word: guess, byUserId: me.userId, changedIndex });
    startTurn(room);
  });

  socket.on('typing', (payload = {}) => {
    const room = findRoomBySocket(socket); if (!room) return;
    socket.to(room.code).emit('opp_status', { userId: socket.data.userId, typing: !!payload.typing });
  });

  socket.on('react', (payload = {}) => {
    const room = findRoomBySocket(socket); if (!room) return;
    const emoji = String(payload.emoji || '').slice(0, 8);
    if (!emoji) return;
    io.to(room.code).emit('reaction', { userId: socket.data.userId, emoji });
  });

  socket.on('rematch', (cb) => {
    const room = findRoomBySocket(socket); if (!room) return cb && cb({ ok: false });
    clearTurnTimer(room);
    room.state = 'lobby'; room.word = ''; room.used = []; room.turnIndex = 0; room.limit = DIFF[room.diffKey].start; room.deadline = null;
    if (cb) cb({ ok: true });
    io.to(room.code).emit('rematch');
    emitLobby(room);
  });

  socket.on('leaveRoom', () => handleLeave(socket, false));
  socket.on('disconnect', () => handleLeave(socket, true));
});

function handleLeave(socket, isDisconnect) {
  const room = findRoomBySocket(socket);
  if (!room) return;
  const userId = socket.data.userId;
  const p = room.players.find((x) => x.userId === userId);
  if (!p) return;

  if (isDisconnect && room.state === 'playing') {
    // allow a grace period to reconnect
    p.connected = false;
    socket.to(room.code).emit('opp_status', { userId, disconnected: true });
    room.graceTimers[userId] = setTimeout(() => {
      if (room.state === 'playing') {
        const winner = room.players.find((x) => x.userId !== userId);
        endGame(room, winner ? winner.userId : null, userId, 'left');
      }
    }, GRACE_MS);
    return;
  }
  // lobby leave (or explicit leave): remove player
  room.players = room.players.filter((x) => x.userId !== userId);
  if (!room.players.length) { clearTurnTimer(room); delete rooms[room.code]; return; }
  if (room.hostUserId === userId) room.hostUserId = room.players[0].userId;
  if (room.state === 'playing') {
    const winner = room.players[0];
    endGame(room, winner ? winner.userId : null, userId, 'left');
  } else {
    emitLobby(room);
  }
}

function cleanName(n) { return String(n || 'Player').replace(/[<>]/g, '').slice(0, 16) || 'Player'; }
function cleanAvatar(a) { a = String(a || '😀'); return a.slice(0, 4) || '😀'; }

// periodic cleanup of stale rooms
setInterval(() => {
  const now = Date.now();
  for (const code of Object.keys(rooms)) {
    const r = rooms[code];
    if (now - r.createdAt > ROOM_TTL_MS && r.state !== 'playing') { clearTurnTimer(r); delete rooms[code]; }
  }
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('WordSwap server listening on ' + PORT + ' — ' + DICT.size + ' words'));
