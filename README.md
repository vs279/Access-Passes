# Passlet — GitHub + Render setup

This makes your barcode passes work on **every device in the world**: one Render
service hosts the app *and* a shared database, so a pass issued anywhere is
recognized by any scanner anywhere.

## Folder layout
```
access-passes/
├── server.js          # the Node/Express backend + serves the app
├── package.json       # dependencies
└── public/
    └── index.html     # the app itself
```

## 1. Put it on GitHub
1. Create a free account at https://github.com if you don't have one.
2. Make a new repository (e.g. `access-passes`). Keep it private if you like.
3. Upload these files, keeping the same folders (`index.html` must stay inside
   `public/`). Easiest way: on the repo page use **Add file → Upload files**,
   drag everything in, and commit.

## 2. Deploy on Render
1. Sign up at https://render.com (you can sign in **with GitHub** — easiest).
2. Click **New → Web Service**, then connect your GitHub repo.
3. Render auto-detects Node. Confirm:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
4. Click **Create Web Service**. Wait for the first deploy to finish.
5. Open the URL Render gives you (like `https://access-passes.onrender.com`).
   That's your live app — open it on any phone or computer.

That's it — the app is already coded to talk to its own Render URL, so there is
**nothing to edit**. Every device that opens that URL shares the same passes.

## 3. Make the data permanent (important)
On the free tier, without a database the pass list is stored in a file that gets
**wiped whenever the service sleeps or redeploys**. To keep it forever:

1. In Render: **New → PostgreSQL** → Free plan → Create.
2. Copy its **Internal Database URL**.
3. Go to your Web Service → **Environment** → **Add Environment Variable**:
   - Key: `DATABASE_URL`
   - Value: paste the database URL
4. Save. Render redeploys, and now everything persists.

> Note: Render's free Postgres and free web services have limits (the web
> service sleeps after ~15 min idle, so the first request after a nap takes
> ~30–60s to wake). Fine for testing and small use; upgrade for always-on.

## 4. Log in
The app ships with a demo host account:
- **Email:** `host@passlet.co.uk`
- **Password:** `passlet2026`

Use **Create account** (or **Reset host account** on the login screen) to make
your own. Then issue passes and email them to guests.

## Security — read before real use
- The API is currently open: anyone with the URL can read/write the pass list.
  For a real gym, add a secret token check on the server and restrict CORS to
  your own site. (Ask and I'll add this.)
- The host password is stored as plain text. Real use wants hashed passwords.
- To open a physical door, wire the `triggerDoor()` function in `index.html`
  to your smart lock or a relay.

## Hosting the app somewhere else (optional)
If you'd rather host the page on **GitHub Pages** and use Render only for the
API: in `public/index.html`, change
`const BACKEND = { url: location.origin };`
to your Render URL, e.g.
`const BACKEND = { url: "https://access-passes.onrender.com" };`
