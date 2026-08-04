/* ============================================================
   Passlet — backend for Render.
   Serves the app (from /public) AND the shared API so every device
   sees the same passes.

   Storage:
   - If DATABASE_URL is set (a Render PostgreSQL database), data is stored
     there and PERSISTS across restarts and redeploys. (Recommended.)
   - Otherwise it falls back to a local data.json file, which is fine for
     a quick test but is WIPED whenever the free service restarts/sleeps.
   ============================================================ */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());                       // for real use, restrict to your site's origin
app.use(express.json({ limit: '2mb' }));

const DEFAULTS = { cards: [], log: [], host: null };

// ---------- storage layer ----------
let store;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const ready = pool.query('CREATE TABLE IF NOT EXISTS kv (key text PRIMARY KEY, value jsonb)');
  store = {
    async get(k) {
      await ready;
      const r = await pool.query('SELECT value FROM kv WHERE key=$1', [k]);
      return r.rows[0] ? r.rows[0].value : DEFAULTS[k];
    },
    async set(k, v) {
      await ready;
      await pool.query(
        'INSERT INTO kv(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2',
        [k, JSON.stringify(v)]
      );
    },
  };
  console.log('Storage: PostgreSQL (persistent)');
} else {
  const FILE = path.join(__dirname, 'data.json');
  const readAll = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { ...DEFAULTS }; } };
  const writeAll = (d) => fs.writeFileSync(FILE, JSON.stringify(d));
  store = {
    async get(k) { const d = readAll(); return (k in d) ? d[k] : DEFAULTS[k]; },
    async set(k, v) { const d = readAll(); d[k] = v; writeAll(d); },
  };
  console.log('Storage: local file (resets on restart). Add DATABASE_URL to persist.');
}

// ---------- API ----------
app.get('/cards', async (_req, res) => res.json((await store.get('cards')) || []));
app.put('/cards', async (req, res) => { await store.set('cards', req.body); res.json({ ok: true }); });

app.get('/host', async (_req, res) => res.json((await store.get('host')) ?? null));
app.put('/host', async (req, res) => { await store.set('host', req.body); res.json({ ok: true }); });

app.get('/log', async (_req, res) => res.json((await store.get('log')) || []));
app.post('/log', async (req, res) => {
  const l = (await store.get('log')) || [];
  l.unshift(req.body);
  await store.set('log', l.slice(0, 300));
  res.json({ ok: true });
});
app.delete('/log', async (_req, res) => { await store.set('log', []); res.json({ ok: true }); });

// ---------- door unlock (Shelly Cloud relay) ----------
// Set these in Render -> Environment for a real door:
//   SHELLY_SERVER     e.g. https://shelly-1-eu.shelly.cloud   (Shelly app: User Settings -> Authorization cloud key)
//   SHELLY_DEVICE_ID  the relay's device id (Shelly app: device -> Settings -> Device Info)
//   SHELLY_AUTH_KEY   your cloud auth key
//   DOOR_TOKEN        (recommended) a secret; the app must send it to unlock
// Read/write the door config from the app (kept in the shared store).
app.get('/door', async (_req, res) => {
  let d = {}; try { d = (await store.get('door')) || {}; } catch (e) {}
  res.json({ server: d.server || '', deviceId: d.deviceId || '', channel: d.channel || '0', hasKey: !!d.authKey });
});
app.put('/door', async (req, res) => {
  const b = req.body || {};
  const cur = (await store.get('door')) || {};
  const cfg = {
    server: (b.server || '').trim(),
    deviceId: (b.deviceId || '').trim(),
    channel: (b.channel || '0').toString().trim(),
    authKey: b.authKey ? b.authKey : (cur.authKey || ''),   // keep existing key if not re-entered
  };
  await store.set('door', cfg);
  res.json({ ok: true });
});

app.post('/unlock', async (req, res) => {
  const { DOOR_TOKEN } = process.env;
  if (DOOR_TOKEN && req.get('X-Door-Token') !== DOOR_TOKEN)
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  let d = {}; try { d = (await store.get('door')) || {}; } catch (e) {}
  const server = d.server || process.env.SHELLY_SERVER;
  const deviceId = d.deviceId || process.env.SHELLY_DEVICE_ID;
  const authKey = d.authKey || process.env.SHELLY_AUTH_KEY;
  const channel = (d.channel != null && d.channel !== '') ? d.channel : '0';
  if (!server || !deviceId || !authKey)
    return res.json({ ok: false, note: 'door not configured' });
  try {
    // Tip: set the Shelly relay Auto-OFF timer to ~3s so a single "on" pulses the strike.
    const body = new URLSearchParams({ id: deviceId, channel: String(channel), turn: 'on', auth_key: authKey });
    const r = await fetch(server.replace(/\/+$/, '') + '/device/relay/control',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const data = await r.json().catch(() => ({}));
    res.json({ ok: true, shelly: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ================= MULTI-SPACE API (each "space" = one account/door) =================
const scode = c => String(c || '').trim().toLowerCase();

app.post('/s/:code/create', async (req, res) => {
  const c = scode(req.params.code);
  if (!c) return res.status(400).json({ ok:false, error:'bad code' });
  const key = 'space:' + c;
  const cur = await store.get(key);
  if (cur && cur.pass) return res.json({ ok:false, error:'exists' });
  await store.set(key, { pass: (req.body && req.body.pass) || '', created: Date.now() });
  res.json({ ok:true });
});
app.post('/s/:code/login', async (req, res) => {
  const sp = await store.get('space:' + scode(req.params.code));
  if (!sp) return res.json({ ok:false, error:'nospace' });
  if (sp.pass !== ((req.body && req.body.pass) || '')) return res.json({ ok:false, error:'badpass' });
  res.json({ ok:true });
});
app.post('/s/:code/setpass', async (req, res) => {
  const c = scode(req.params.code); const sp = await store.get('space:' + c);
  if (!sp) return res.json({ ok:false, error:'nospace' });
  if (sp.pass !== ((req.body && req.body.current) || '')) return res.json({ ok:false, error:'badpass' });
  sp.pass = (req.body && req.body.next) || '';
  await store.set('space:' + c, sp);
  res.json({ ok:true });
});
app.post('/s/:code/delete', async (req, res) => {
  const c = scode(req.params.code); const sp = await store.get('space:' + c);
  if (!sp) return res.json({ ok:true, note:'gone' });
  if (sp.pass !== ((req.body && req.body.pass) || '')) return res.json({ ok:false, error:'badpass' });
  await store.set('space:' + c, null);
  await store.set('cards:' + c, []);
  await store.set('log:' + c, []);
  await store.set('door:' + c, {});
  res.json({ ok:true });
});
app.get('/s/:code/exists', async (req, res) => {
  res.json({ exists: !!(await store.get('space:' + scode(req.params.code))) });
});
app.get('/s/:code/cards', async (req, res) => res.json((await store.get('cards:' + scode(req.params.code))) || []));
app.put('/s/:code/cards', async (req, res) => { await store.set('cards:' + scode(req.params.code), req.body); res.json({ ok:true }); });
app.get('/s/:code/log', async (req, res) => res.json((await store.get('log:' + scode(req.params.code))) || []));
app.post('/s/:code/log', async (req, res) => {
  const k = 'log:' + scode(req.params.code); const l = (await store.get(k)) || [];
  l.unshift(req.body); await store.set(k, l.slice(0, 300)); res.json({ ok:true });
});
app.delete('/s/:code/log', async (req, res) => { await store.set('log:' + scode(req.params.code), []); res.json({ ok:true }); });
app.get('/s/:code/door', async (req, res) => {
  const d = (await store.get('door:' + scode(req.params.code))) || {};
  res.json({ server:d.server||'', deviceId:d.deviceId||'', channel:d.channel||'0', hasKey:!!d.authKey });
});
app.put('/s/:code/door', async (req, res) => {
  const k = 'door:' + scode(req.params.code); const cur = (await store.get(k)) || {}; const b = req.body || {};
  const cfg = { server:(b.server||'').trim(), deviceId:(b.deviceId||'').trim(),
    channel:(b.channel||'0').toString().trim(), authKey: b.authKey ? b.authKey : (cur.authKey||'') };
  if (!cfg.server || !cfg.deviceId || !cfg.authKey)
    return res.json({ ok:false, error:'incomplete', message:'Fill in server, device ID, and auth key.' });
  // Verify it's a REAL Shelly: ask the Shelly cloud for the device status.
  try {
    const body = new URLSearchParams({ id: cfg.deviceId, auth_key: cfg.authKey });
    const r = await fetch(cfg.server.replace(/\/+$/, '') + '/device/status',
      { method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' }, body });
    const data = await r.json().catch(() => null);
    if (!data || data.isok !== true)
      return res.json({ ok:false, error:'invalid', message:'That isn\u2019t a valid Shelly device \u2014 check the server, device ID, and auth key.' });
  } catch (e) {
    return res.json({ ok:false, error:'unreachable', message:'Couldn\u2019t reach Shelly cloud to verify. Check the server address.' });
  }
  await store.set(k, cfg);
  res.json({ ok:true });
});
app.post('/s/:code/unlock', async (req, res) => {
  const d = (await store.get('door:' + scode(req.params.code))) || {};
  if (!d.server || !d.deviceId || !d.authKey) return res.json({ ok:false, note:'door not configured' });
  try {
    const body = new URLSearchParams({ id:d.deviceId, channel:String(d.channel||'0'), turn:'on', auth_key:d.authKey });
    const r = await fetch(d.server.replace(/\/+$/, '') + '/device/relay/control',
      { method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' }, body });
    const data = await r.json().catch(() => ({}));
    res.json({ ok:true, shelly:data });
  } catch (e) { res.status(500).json({ ok:false, error:String(e) }); }
});

// ---------- serve the app (public/ only, so data.json is never exposed) ----------
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Passlet running on port ' + PORT));
