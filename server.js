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
const crypto = require('crypto');
const scode = c => String(c || '').trim().toLowerCase();
const newToken = () => crypto.randomBytes(24).toString('hex');
function hashPass(pw){
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return 'scrypt:' + salt + ':' + hash;
}
function verifyPass(pw, stored){
  if (!stored) return false;
  if (!String(stored).startsWith('scrypt:')) return stored === pw;   // legacy plaintext
  const [, salt, hash] = String(stored).split(':');
  const h = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Owner-only guard for management endpoints.
async function requireOwner(req, res, next){
  const sp = await store.get('space:' + scode(req.params.code));
  if (!sp) return res.status(404).json({ ok:false, error:'nospace' });
  if (!sp.token || req.get('X-Owner-Token') !== sp.token)
    return res.status(401).json({ ok:false, error:'unauthorized' });
  req._space = sp; next();
}
function statusOfServer(c){
  if (c.expiry && new Date(c.expiry + 'T23:59:59') < new Date()) return 'expired';
  if (c.maxUses && (c.used || 0) >= c.maxUses) return 'depleted';
  return 'active';
}
const fmtServer = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

// ---- auth ----
app.post('/s/:code/create', async (req, res) => {
  const c = scode(req.params.code);
  if (!c) return res.status(400).json({ ok:false, error:'bad code' });
  const key = 'space:' + c;
  const cur = await store.get(key);
  if (cur && cur.pass) return res.json({ ok:false, error:'exists' });
  const token = newToken();
  await store.set(key, { pass: hashPass((req.body && req.body.pass) || ''), token, created: Date.now() });
  res.json({ ok:true, token });
});
app.post('/s/:code/login', async (req, res) => {
  const c = scode(req.params.code);
  const sp = await store.get('space:' + c);
  if (!sp) return res.json({ ok:false, error:'nospace' });
  if (!verifyPass((req.body && req.body.pass) || '', sp.pass)) return res.json({ ok:false, error:'badpass' });
  let changed = false;
  if (!String(sp.pass).startsWith('scrypt:')) { sp.pass = hashPass((req.body && req.body.pass) || ''); changed = true; }
  if (!sp.token) { sp.token = newToken(); changed = true; }
  if (changed) await store.set('space:' + c, sp);
  res.json({ ok:true, token: sp.token });
});
app.post('/s/:code/setpass', requireOwner, async (req, res) => {
  const sp = req._space;
  sp.pass = hashPass((req.body && req.body.next) || '');
  await store.set('space:' + scode(req.params.code), sp);
  res.json({ ok:true });
});
app.post('/s/:code/delete', requireOwner, async (req, res) => {
  const c = scode(req.params.code);
  await store.set('space:' + c, null);
  await store.set('cards:' + c, []);
  await store.set('log:' + c, []);
  await store.set('door:' + c, {});
  res.json({ ok:true });
});
app.get('/s/:code/exists', async (req, res) => {
  res.json({ exists: !!(await store.get('space:' + scode(req.params.code))) });
});

// ---- management (owner token required) ----
app.get('/s/:code/cards', requireOwner, async (req, res) => res.json((await store.get('cards:' + scode(req.params.code))) || []));
app.put('/s/:code/cards', requireOwner, async (req, res) => { await store.set('cards:' + scode(req.params.code), req.body); res.json({ ok:true }); });
app.get('/s/:code/log', requireOwner, async (req, res) => res.json((await store.get('log:' + scode(req.params.code))) || []));
app.delete('/s/:code/log', requireOwner, async (req, res) => { await store.set('log:' + scode(req.params.code), []); res.json({ ok:true }); });
app.get('/s/:code/door', requireOwner, async (req, res) => {
  const d = (await store.get('door:' + scode(req.params.code))) || {};
  res.json({ server:d.server||'', deviceId:d.deviceId||'', channel:d.channel||'0', hasKey:!!d.authKey });
});
app.put('/s/:code/door', requireOwner, async (req, res) => {
  const k = 'door:' + scode(req.params.code); const cur = (await store.get(k)) || {}; const b = req.body || {};
  const cfg = { server:(b.server||'').trim(), deviceId:(b.deviceId||'').trim(),
    channel:(b.channel||'0').toString().trim(), authKey: b.authKey ? b.authKey : (cur.authKey||'') };
  if (!cfg.server || !cfg.deviceId || !cfg.authKey)
    return res.json({ ok:false, error:'incomplete', message:'Fill in server, device ID, and auth key.' });
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
app.post('/s/:code/unlock', requireOwner, async (req, res) => {
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

// ---- scanner devices: must be approved by the space owner ----
app.post('/s/:code/scanner/register', async (req, res) => {
  const c = scode(req.params.code);
  const sp = await store.get('space:' + c);
  if (!sp) return res.json({ ok:false, error:'nospace' });
  const b = req.body || {}; const did = String(b.deviceId || '').trim();
  if (!did) return res.json({ ok:false, error:'noid' });
  const k = 'scanners:' + c; const list = (await store.get(k)) || [];
  let dev = list.find(d => d.id === did);
  if (!dev) { dev = { id: did, name: String(b.name || 'Scanner').slice(0, 40), status: 'pending', created: Date.now() }; list.push(dev); await store.set(k, list); }
  res.json({ ok:true, status: dev.status });
});
app.post('/s/:code/scanner/status', async (req, res) => {
  const list = (await store.get('scanners:' + scode(req.params.code))) || [];
  const dev = list.find(d => d.id === String((req.body && req.body.deviceId) || '').trim());
  res.json({ status: dev ? dev.status : 'none' });
});
app.get('/s/:code/scanners', requireOwner, async (req, res) => res.json((await store.get('scanners:' + scode(req.params.code))) || []));
app.post('/s/:code/scanner/approve', requireOwner, async (req, res) => {
  const c = scode(req.params.code); const k = 'scanners:' + c; const list = (await store.get(k)) || [];
  const dev = list.find(d => d.id === String((req.body && req.body.deviceId) || '').trim());
  if (dev) { dev.status = 'approved'; await store.set(k, list); }
  res.json({ ok:true });
});
app.post('/s/:code/scanner/revoke', requireOwner, async (req, res) => {
  const c = scode(req.params.code); const k = 'scanners:' + c;
  let list = (await store.get(k)) || [];
  list = list.filter(d => d.id !== String((req.body && req.body.deviceId) || '').trim());
  await store.set(k, list);
  res.json({ ok:true });
});

// ---- scanner (tokenless): validate + count use + auto-renew + log + unlock, all server-side ----
app.post('/s/:code/scan', async (req, res) => {
  const c = scode(req.params.code);
  const code = String((req.body && req.body.code) || '').trim().toUpperCase();
  if (!code) return res.json({ granted:false, who:'No code' });
  const did = String((req.body && req.body.deviceId) || '').trim();
  const scanners = (await store.get('scanners:' + c)) || [];
  const dev = scanners.find(d => d.id === did);
  if (!dev || dev.status !== 'approved') return res.json({ granted:false, who:'Scanner not approved' });
  const cards = (await store.get('cards:' + c)) || [];
  const card = cards.find(x => String(x.code || '').toUpperCase() === code);
  let granted = false, who = 'Pass not recognized';
  if (card) {
    let st = statusOfServer(card);
    if (st === 'expired' && card.autoRenew && card.autoRenew !== 'off') {
      const within = card.renewUntil && Date.now() < card.renewUntil;
      if (within) {
        const cyc = card.durationDays || 7;
        const nd = new Date(); nd.setHours(0,0,0,0); nd.setDate(nd.getDate() + cyc);
        card.expiry = fmtServer(nd); card.used = 0; st = statusOfServer(card);
      }
    }
    if (st === 'active') {
      granted = true; card.used = (card.used || 0) + 1;
      const left = card.maxUses ? (card.maxUses - card.used) : null;
      who = card.name + (left !== null ? ' \u00b7 ' + left + ' use' + (left === 1 ? '' : 's') + ' left' : '');
      await store.set('cards:' + c, cards);
    } else if (st === 'expired') { who = card.name + ' \u00b7 pass expired'; }
    else { who = card.name + ' \u00b7 no uses left'; }
  }
  try {
    const k = 'log:' + c; const l = (await store.get(k)) || [];
    l.unshift({ t: Date.now(), result: granted ? 'granted' : 'denied', name: card ? card.name : 'Unknown', code });
    await store.set(k, l.slice(0, 300));
  } catch (e) {}
  if (granted) {
    const d = (await store.get('door:' + c)) || {};
    if (d.server && d.deviceId && d.authKey) {
      try {
        const body = new URLSearchParams({ id:d.deviceId, channel:String(d.channel||'0'), turn:'on', auth_key:d.authKey });
        await fetch(d.server.replace(/\/+$/, '') + '/device/relay/control',
          { method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' }, body });
      } catch (e) {}
    }
  }
  res.json({ granted, who });
});

// ---------- serve the app (public/ only, so data.json is never exposed) ----------
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Passlet running on port ' + PORT));
