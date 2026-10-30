'use strict';
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map();
const sockets = new Set();

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, service: 'Court Clash multiplayer', rooms: rooms.size }));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});
const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });

function send(socket, data) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
}
function cleanName(value, fallback) {
  const name = String(value || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 16);
  return name || fallback;
}
function code() {
  let out;
  do {
    out = '';
    for (let i = 0; i < 6; i++) out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  } while (rooms.has(out));
  return out;
}
function closeRoom(room, reason = 'room_closed') {
  if (!room) return;
  rooms.delete(room.code);
  if (room.host) {
    room.host.roomCode = null;
    room.host.role = null;
  }
  if (room.guest) {
    room.guest.roomCode = null;
    room.guest.role = null;
    send(room.guest, { type: reason });
    try { room.guest.close(1000, 'Room closed'); } catch (_) {}
  }
}
function handle(socket, msg) {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'create_room') {
    if (socket.roomCode) {
      send(socket, { type: 'error', message: 'You are already in a room. Leave it first.' });
      return;
    }
    const roomCode = code();
    const hostName = cleanName(msg.name, 'Host');
    const room = { code: roomCode, host: socket, guest: null, hostName, guestName: 'Guest', latestState: null, createdAt: Date.now() };
    rooms.set(roomCode, room);
    socket.roomCode = roomCode;
    socket.role = 'host';
    send(socket, { type: 'room_created', code: roomCode, name: room.hostName });
    return;
  }
  if (msg.type === 'join_room') {
    if (socket.roomCode) {
      send(socket, { type: 'error', message: 'You are already in a room. Leave it first.' });
      return;
    }
    const roomCode = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const room = rooms.get(roomCode);
    if (!room || !room.host || room.host.readyState !== WebSocket.OPEN) {
      send(socket, { type: 'error', message: 'Room not found. Check the code and ask the host to create a room.' });
      return;
    }
    if (room.guest && room.guest.readyState === WebSocket.OPEN) {
      send(socket, { type: 'error', message: 'That room already has two players.' });
      return;
    }
    room.guest = socket;
    room.guestName = cleanName(msg.name, 'Guest');
    socket.roomCode = roomCode;
    socket.role = 'guest';
    send(socket, { type: 'room_joined', code: roomCode, hostName: room.hostName, guestName: room.guestName });
    send(room.host, { type: 'guest_joined', code: roomCode, name: room.guestName });
    if (room.latestState) send(socket, { type: 'game_state', state: room.latestState });
    return;
  }

  const room = socket.roomCode ? rooms.get(socket.roomCode) : null;
  if (!room) {
    if (msg.type !== 'leave_room' && msg.type !== 'close_room') send(socket, { type: 'error', message: 'You are not in a room.' });
    return;
  }
  if (msg.type === 'game_state' && socket.role === 'host') {
    if (!msg.state || typeof msg.state !== 'object') return;
    room.latestState = msg.state;
    send(room.guest, { type: 'game_state', state: msg.state });
    return;
  }
  if (msg.type === 'key_down' && socket.role === 'guest') {
    const key = String(msg.key || '').slice(0, 20).toLowerCase();
    send(room.host, { type: 'remote_key_down', key });
    return;
  }
  if (msg.type === 'key_up' && socket.role === 'guest') {
    const key = String(msg.key || '').slice(0, 20).toLowerCase();
    send(room.host, { type: 'remote_key_up', key });
    return;
  }
  if (msg.type === 'camera_look' && socket.role === 'guest') {
    const yaw = Number(msg.yaw);
    const pitch = Number(msg.pitch);
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return;
    send(room.host, { type: 'remote_camera_look', yaw: Math.max(-1000, Math.min(1000, yaw)), pitch: Math.max(-0.72, Math.min(0.72, pitch)) });
    return;
  }
  // Continuous guest movement heartbeat. This recovers from missed keydown/keyup events.
  if (msg.type === 'guest_input' && socket.role === 'guest') {
    const yaw = Number(msg.yaw);
    const pitch = Number(msg.pitch);
    const allowed = new Set(['keyw', 'keya', 'keys', 'keyd', 'shiftleft', 'shiftright']);
    const keys = Array.isArray(msg.keys) ? msg.keys.slice(0, 24).map(k => String(k).slice(0, 20).toLowerCase()).filter(k => allowed.has(k)) : [];
    send(room.host, { type: 'remote_guest_input', keys, yaw: Number.isFinite(yaw) ? Math.max(-1000, Math.min(1000, yaw)) : 0, pitch: Number.isFinite(pitch) ? Math.max(-0.72, Math.min(0.72, pitch)) : 0 });
    return;
  }
  if (msg.type === 'leave_room' && socket.role === 'guest') {
    room.guest = null;
    room.guestName = 'Guest';
    socket.roomCode = null;
    socket.role = null;
    send(room.host, { type: 'guest_left' });
    send(socket, { type: 'left_room' });
    return;
  }
  if (msg.type === 'close_room' && socket.role === 'host') {
    closeRoom(room);
    send(socket, { type: 'left_room' });
    return;
  }
}

wss.on('connection', socket => {
  sockets.add(socket);
  socket.roomCode = null;
  socket.role = null;
  socket.on('message', raw => {
    if (raw.length > 256 * 1024) return;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { send(socket, { type: 'error', message: 'Invalid message format.' }); return; }
    try { handle(socket, msg); } catch (err) { console.error('Message handling error:', err); send(socket, { type: 'error', message: 'The server could not process that request.' }); }
  });
  socket.on('close', () => {
    sockets.delete(socket);
    const room = socket.roomCode ? rooms.get(socket.roomCode) : null;
    if (!room) return;
    if (socket.role === 'host') {
      closeRoom(room, 'room_closed');
    } else if (socket.role === 'guest') {
      room.guest = null;
      room.guestName = 'Guest';
      send(room.host, { type: 'guest_left' });
    }
  });
  socket.on('error', err => console.error('WebSocket error:', err.message));
});

// Expire abandoned rooms if a browser disappears without completing its close handshake.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (!room.host || room.host.readyState === WebSocket.CLOSED || now - room.createdAt > 12 * 60 * 60 * 1000) closeRoom(room);
  }
}, 60 * 1000).unref();

server.listen(PORT, '0.0.0.0', () => console.log(`Court Clash multiplayer server listening on ${PORT}`));
