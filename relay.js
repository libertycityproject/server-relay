#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
//  LIBERTY CITY RELAY SERVER
//  Standalone WebSocket relay — routes messages between players
//  in named rooms. Zero dependencies beyond `ws`.
//
//  QUICK START:
//    npm install ws
//    node relay.js
//
//  DEPLOY FREE TO RENDER.COM (keeps awake, no credit card):
//    1. Push this file to a GitHub repo
//    2. Go to render.com → New Web Service → connect repo
//    3. Build: npm install ws   Start: node relay.js
//    4. Copy the wss://your-name.onrender.com URL into the game
//
//  DEPLOY FREE TO RAILWAY.APP:
//    1. railway init → railway up  (or connect GitHub repo)
//    2. Copy the wss:// URL into the game
//
//  LOCAL LAN (no internet needed):
//    node relay.js
//    Share ws://YOUR_LAN_IP:8765 with friends on same WiFi
//    Find your LAN IP: ipconfig (Windows) / ifconfig (Mac/Linux)
// ═══════════════════════════════════════════════════════════════

const WebSocket = require('ws');
const http      = require('http');
const PORT      = process.env.PORT || 8765;

// ── HTTP server (required for Render/Railway health checks) ──────────────────
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    const roomList = [];
    for (const [code, room] of rooms) {
      roomList.push({ code, players: room.clients.size });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: Math.round(process.uptime()),
      rooms: roomList,
      totalPlayers: [...rooms.values()].reduce((s, r) => s + r.clients.size, 0),
    }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Liberty City Relay — WebSocket server active\n');
  }
});

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server: httpServer });

// rooms: Map<roomCode, { clients: Set<WebSocket>, lastActivity: number }>
const rooms = new Map();

function getOrCreateRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, { clients: new Set(), lastActivity: Date.now() });
    console.log(`[room] Created: ${code}`);
  }
  return rooms.get(code);
}

function broadcast(room, msg, exclude) {
  const data = JSON.stringify(msg);
  for (const client of room.clients) {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      try { client.send(data); } catch (_) {}
    }
  }
}

function cleanupRooms() {
  const IDLE_MS = 5 * 60 * 1000; // remove empty rooms after 5 min
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.clients.size === 0 && now - room.lastActivity > IDLE_MS) {
      rooms.delete(code);
      console.log(`[room] Cleaned up idle room: ${code}`);
    }
  }
}
setInterval(cleanupRooms, 60_000);

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  ws._lc = { room: null, id: null, name: 'unknown', ip };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    // ── Join: first message must set the room ───────────────────────────────
    if (!ws._lc.room) {
      if (msg.type !== 'join' || !msg.room) {
        ws.send(JSON.stringify({ type: 'error', text: 'Send {type:"join",room:"CODE",...} first' }));
        return;
      }
      const code = String(msg.room).toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 32);
      const room = getOrCreateRoom(code);
      ws._lc.room = code;
      ws._lc.id   = msg.fromId   || ('P_' + Math.random().toString(36).slice(2, 8).toUpperCase());
      ws._lc.name = msg.fromName || ws._lc.id;
      room.clients.add(ws);
      room.lastActivity = Date.now();

      console.log(`[+] ${ws._lc.name} (${ws._lc.id}) joined ${code} | room now has ${room.clients.size} players`);

      // Ack to the joining client
      ws.send(JSON.stringify({
        type: 'ack',
        room: code,
        yourId: ws._lc.id,
        playerCount: room.clients.size,
      }));

      // Broadcast join to everyone else
      broadcast(room, { ...msg, fromId: ws._lc.id, fromName: ws._lc.name }, ws);
      return;
    }

    const room = rooms.get(ws._lc.room);
    if (!room) return;
    room.lastActivity = Date.now();

    // ── Room count query ─────────────────────────────────────────────────────
    if (msg.type === 'room_count_query') {
      const counts = {};
      for (const [c, r] of rooms) counts[c] = r.clients.size;
      try { ws.send(JSON.stringify({ type: 'room_counts', counts })); } catch {}
      return;
    }

    // ── Ping / keepalive ─────────────────────────────────────────────────────
    if (msg.type === 'ping_keepalive') {
      try { ws.send(JSON.stringify({ type: 'pong_keepalive' })); } catch {}
      return;
    }

    // ── Relay all other messages to the room ─────────────────────────────────
    // Stamp with server-verified sender ID so clients can't spoof each other
    broadcast(room, { ...msg, fromId: ws._lc.id, fromName: ws._lc.name }, ws);
  });

  ws.on('close', () => {
    const { room: code, id, name } = ws._lc;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    room.clients.delete(ws);
    room.lastActivity = Date.now();
    console.log(`[-] ${name} (${id}) left ${code} | room now has ${room.clients.size} players`);
    broadcast(room, { type: 'leave', fromId: id, fromName: name, ts: Date.now() }, null);
  });

  ws.on('error', (err) => {
    console.warn(`[ws error] ${ws._lc?.name}: ${err.message}`);
  });
});

httpServer.listen(PORT, () => {
  console.log('');
  console.log('  ╔════════════════════════════════════════╗');
  console.log(`  ║  Liberty City Relay  —  port ${PORT}     ║`);
  console.log('  ║  /health  →  room status JSON          ║');
  console.log('  ╚════════════════════════════════════════╝');
  console.log('');
  console.log('  Local:    ws://localhost:' + PORT);
  const os = require('os');
  const nets = os.networkInterfaces();
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log(`  LAN:      ws://${iface.address}:${PORT}`);
      }
    }
  }
  console.log('');
});
