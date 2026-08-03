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

// ---------- serve the app (public/ only, so data.json is never exposed) ----------
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Passlet running on port ' + PORT));
