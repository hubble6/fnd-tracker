/**
 * FND Tracker — Local Server
 *
 * Runs on the local network (no internet required).
 * Both devices connect to this server via LAN.
 *
 * Usage:
 *   npm start          → production
 *   npm run dev        → auto-restart on changes
 *
 * Then open http://<server-ip>:3000 on each device.
 */

'use strict';

const express    = require('express');
const http       = require('http');
const path       = require('path');
const os         = require('os');
const { WebSocketServer } = require('ws');
const db         = require('./database');

const PORT = process.env.PORT || 3000;

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));   // serve index.html, app.js, etc. from root

/* ─── Connected clients ─────────────────────────────────────────
   Map of deviceId → { ws, name }
   ─────────────────────────────────────────────────────────────── */
const clients = new Map();

/** Send a message to every connected client except the sender. */
function broadcast(senderDeviceId, message) {
  const payload = JSON.stringify(message);
  for (const [id, { ws }] of clients) {
    if (id !== senderDeviceId && ws.readyState === 1 /* OPEN */) {
      ws.send(payload);
    }
  }
}

/** Send a message to every connected client including the sender. */
function broadcastAll(message) {
  const payload = JSON.stringify(message);
  for (const [, { ws }] of clients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

function connectedDeviceList() {
  return Array.from(clients.entries()).map(([id, { name }]) => ({ id, name }));
}

/* ─── WebSocket handler ──────────────────────────────────────── */
wss.on('connection', (ws) => {
  let deviceId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── register: device announces itself ──────────────────────
    if (msg.type === 'register') {
      deviceId = msg.deviceId;
      const name = msg.deviceName || deviceId;
      clients.set(deviceId, { ws, name });

      // Send full data snapshot to the newly connected device
      const allData = db.getAllData();
      ws.send(JSON.stringify({ type: 'full_sync', data: allData }));

      // Tell everyone a new device joined
      broadcastAll({ type: 'devices', devices: connectedDeviceList() });
      console.log(`[+] ${name} (${deviceId}) connected  — ${clients.size} device(s) online`);
    }

    // ── sync_batch: device pushes new / updated entries ────────
    if (msg.type === 'sync_batch') {
      if (!Array.isArray(msg.changes) || msg.changes.length === 0) return;

      const accepted = db.applyChanges(msg.changes, deviceId);

      // Acknowledge to sender
      ws.send(JSON.stringify({
        type: 'sync_ack',
        accepted: accepted.map(r => r.id),
      }));

      // Forward accepted changes to all other devices
      if (accepted.length > 0) {
        broadcast(deviceId, { type: 'sync_batch', changes: accepted });
      }
    }

    // ── delete: device deletes an entry ────────────────────────
    if (msg.type === 'delete') {
      db.softDelete(msg.id, deviceId);
      broadcast(deviceId, { type: 'delete', id: msg.id });
    }

    // ── ping: keep-alive ───────────────────────────────────────
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  });

  ws.on('close', () => {
    if (deviceId) {
      const name = clients.get(deviceId)?.name || deviceId;
      clients.delete(deviceId);
      broadcastAll({ type: 'devices', devices: connectedDeviceList() });
      console.log(`[-] ${name} disconnected  — ${clients.size} device(s) online`);
    }
  });

  ws.on('error', (err) => {
    console.error('WS error:', err.message);
    ws.terminate();
  });
});

/* ─── REST API (fallback for when WebSocket is unavailable) ─── */

/** GET /api/data — return the full dataset */
app.get('/api/data', (_req, res) => {
  try {
    res.json({ ok: true, data: db.getAllData() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** POST /api/sync — push a batch of changes */
app.post('/api/sync', (req, res) => {
  const { changes, deviceId: srcDevice } = req.body || {};
  if (!Array.isArray(changes)) {
    return res.status(400).json({ ok: false, error: 'changes must be an array' });
  }
  try {
    const accepted = db.applyChanges(changes, srcDevice || 'rest-api');
    // Broadcast to WebSocket clients
    if (accepted.length > 0) {
      broadcast(srcDevice, { type: 'sync_batch', changes: accepted });
    }
    res.json({ ok: true, accepted: accepted.map(r => r.id) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** DELETE /api/entry/:id — soft-delete one entry */
app.delete('/api/entry/:id', (req, res) => {
  try {
    db.softDelete(req.params.id, 'rest-api');
    broadcast(null, { type: 'delete', id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** GET /api/status — basic health check */
app.get('/api/status', (_req, res) => {
  res.json({
    ok: true,
    devices: connectedDeviceList(),
    uptime: Math.round(process.uptime()),
  });
});

/* ─── Start ──────────────────────────────────────────────────── */
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n─────────────────────────────────────');
  console.log(' FND Tracker server started');
  console.log('─────────────────────────────────────');
  console.log(` Local:   http://localhost:${PORT}`);

  // Print all non-internal IPv4 addresses so you can point other devices at it
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log(` Network: http://${iface.address}:${PORT}`);
      }
    }
  }
  console.log('─────────────────────────────────────\n');
});
