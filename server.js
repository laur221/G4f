require('dotenv').config();
const express = require('express');
const cookieSession = require('cookie-session');
const path = require('path');
const fs = require('fs');

// Render (plan gratuit) nu are disc persistent — reconstruim storageState.json
// din variabila de mediu STORAGE_STATE_B64 (continut base64).
const STATE_PATH = path.join(__dirname, 'storageState.json');
if (process.env.STORAGE_STATE_B64) {
  try {
    fs.writeFileSync(STATE_PATH, Buffer.from(process.env.STORAGE_STATE_B64, 'base64'));
    console.log('storageState.json reconstruit din STORAGE_STATE_B64.');
  } catch (err) {
    console.error('Nu am putut scrie storageState.json din STORAGE_STATE_B64:', err);
  }
} else if (!fs.existsSync(STATE_PATH)) {
  console.warn(
    'Atentie: lipseste atat storageState.json cat si STORAGE_STATE_B64 — ' +
    'actiunile vor esua pana setezi una din ele.'
  );
}

const { verifyCredentials } = require('./lib/auth');
const { runAction, extendServer } = require('./lib/browser');
const { getCachedStatus, invalidate } = require('./lib/status');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  cookieSession({
    name: 'g4f-relay-session',
    keys: [process.env.SESSION_SECRET || 'dev-secret-schimba-ma'],
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 zile
    httpOnly: true,
    sameSite: 'lax',
  })
);

function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  return res.redirect('/login');
}

// ── Login ──
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const ok = await verifyCredentials(username, password);
    if (!ok) return res.redirect('/login?error=1');
    req.session.loggedIn = true;
    req.session.username = username;
    res.redirect('/');
  } catch (err) {
    console.error('Eroare login:', err);
    res.redirect('/login?error=1');
  }
});

app.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

// ── Dashboard ──
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ── Actiuni server (Start / Stop / Restart) ──
app.post('/api/action/:action', requireAuth, async (req, res) => {
  const { action } = req.params;
  if (!['start', 'stop', 'restart'].includes(action)) {
    return res.status(400).json({ ok: false, error: 'Actiune invalida' });
  }
  try {
    const result = await runAction(action);
    invalidate();
    res.json(result);
  } catch (err) {
    console.error(`Eroare la actiunea ${action}:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Extindere +90 min (cu Turnstile auto-rezolvare) ──
app.post('/api/extend', requireAuth, async (req, res) => {
  try {
    const result = await extendServer();
    if (result.ok) invalidate(); // forteaza refresh la status dupa extindere
    res.json(result);
  } catch (err) {
    console.error('Eroare la extindere:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Status server (timp ramas, online/offline) ──
app.get('/api/status', requireAuth, async (req, res) => {
  try {
    const status = await getCachedStatus();
    res.json(status);
  } catch (err) {
    console.error('Eroare la verificarea statusului:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Health check (folosit si de self-ping-ul anti-sleep) ──
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`g4f-relay ruleaza pe portul ${PORT}`);
});

// ── Self-ping anti-sleep ──
if (process.env.PUBLIC_URL) {
  const PING_INTERVAL_MS = 4 * 60 * 1000;
  setInterval(() => {
    fetch(`${process.env.PUBLIC_URL.replace(/\/$/, '')}/health`)
      .then((r) => console.log(`[self-ping] ${r.status}`))
      .catch((err) => console.error('[self-ping] esuat:', err.message));
  }, PING_INTERVAL_MS);
  console.log(`Self-ping activ catre ${process.env.PUBLIC_URL}/health la fiecare 4 minute.`);
} else {
  console.log('PUBLIC_URL nu e setat — self-ping dezactivat (serviciul poate adormi pe planul gratuit Render).');
}
