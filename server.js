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

// La fel pentru rclone.conf (credentialele Google Drive) — RCLONE_CONF_B64.
const RCLONE_CONF_PATH = path.join(__dirname, 'rclone.conf');
if (process.env.RCLONE_CONF_B64) {
  try {
    fs.writeFileSync(RCLONE_CONF_PATH, Buffer.from(process.env.RCLONE_CONF_B64, 'base64'));
    console.log('rclone.conf reconstruit din RCLONE_CONF_B64.');
  } catch (err) {
    console.error('Nu am putut scrie rclone.conf din RCLONE_CONF_B64:', err);
  }
} else {
  console.warn('RCLONE_CONF_B64 nu e setat — backup-ul Google Drive va esua.');
}

const { verifyCredentials } = require('./lib/auth');
const { runAction, extendServer, renewServer } = require('./lib/browser');
const { getCachedStatus, invalidate } = require('./lib/status');
const { startAutoExtend, stopAutoExtend, setTarget, setBackup, CONFIG, setTestMode, setTestRemaining } = require('./lib/automation/auto-extend');
const { runBackup } = require('./lib/backup');

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

function requireAdmin(req, res, next) {
  if (req.session && req.session.loggedIn && req.session.role === 'admin') return next();
  return res.status(403).json({ ok: false, error: 'Acces interzis — cont admin necesar.' });
}

function homeForRole(role) {
  return role === 'admin' ? '/admin' : '/nicu';
}

// ── Login ──
app.get('/login', (req, res) => {
  // Deja autentificat? Trimitem direct la pagina lui.
  if (req.session && req.session.loggedIn) {
    return res.redirect(homeForRole(req.session.role));
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const auth = await verifyCredentials(username, password);
    if (!auth.ok) return res.redirect('/login?error=1');
    req.session.loggedIn = true;
    req.session.username = auth.username;
    req.session.role = auth.role;
    res.redirect(homeForRole(auth.role));
  } catch (err) {
    console.error('Eroare login:', err);
    res.redirect('/login?error=1');
  }
});

app.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

// ── Pagini (Admin / Nicu) ──
app.get('/', requireAuth, (req, res) => {
  res.redirect(homeForRole(req.session.role));
});

app.get('/admin', requireAuth, (req, res) => {
  if (req.session.role !== 'admin') return res.redirect('/nicu');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/nicu', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'nicu.html'));
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
// Acceptă și parametri opționali pentru extindere manuală cu minute personalizate
app.post('/api/extend', requireAdmin, async (req, res) => {
  const minutes = parseInt(req.body?.minutes, 10) || 90;
  try {
    const result = await extendServer(minutes);
    if (result.ok) invalidate(); // forteaza refresh la status dupa extindere
    res.json(result);
  } catch (err) {
    console.error('Eroare la extindere:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── RENEW & UNSUSPEND manual (reactivare server suspendat) ──
app.post('/api/renew', requireAdmin, async (req, res) => {
  try {
    const result = await renewServer();
    if (result.ok && result.suspended) invalidate();
    res.json(result);
  } catch (err) {
    console.error('Eroare la renew:', err.message);
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

// ── Auto-extend config ──
app.get('/api/auto-extend/config', requireAdmin, (req, res) => {
  res.json({
    ok: true,
    targetSeconds: CONFIG.targetSeconds,
    backupSeconds: CONFIG.backupSeconds,
    checkIntervalMs: CONFIG.checkIntervalMs,
    cooldownMs: CONFIG.cooldownMs,
    isRunning: require('./lib/automation/auto-extend').isRunning(),
  });
});

app.post('/api/auto-extend/config', requireAdmin, async (req, res) => {
  const { targetSeconds, backupSeconds } = req.body || {};
  if (targetSeconds !== undefined) {
    setTarget(targetSeconds);
  }
  if (backupSeconds !== undefined) {
    setBackup(backupSeconds);
  }
  res.json({
    ok: true,
    targetSeconds: CONFIG.targetSeconds,
    backupSeconds: CONFIG.backupSeconds,
    isRunning: require('./lib/automation/auto-extend').isRunning(),
  });
});

// ── Oprire/pornire auto-extend la runtime ──
app.post('/api/auto-extend/state', requireAdmin, async (req, res) => {
  const { enabled } = req.body || {};
  if (enabled === true) {
    startAutoExtend();
  } else if (enabled === false) {
    stopAutoExtend();
  }
  res.json({
    ok: true,
    isRunning: require('./lib/automation/auto-extend').isRunning(),
  });
});

// ── Test mode endpoints ──
app.get('/api/auto-extend/test-mode', requireAdmin, (req, res) => {
  res.json({
    ok: true,
    testMode: CONFIG.testMode,
    testRemainingSeconds: CONFIG.testRemainingSeconds,
  });
});

app.post('/api/auto-extend/test-mode', requireAdmin, async (req, res) => {
  const { enabled, remainingSeconds } = req.body || {};
  setTestMode(enabled === true, remainingSeconds || 0);
  res.json({
    ok: true,
    testMode: CONFIG.testMode,
    testRemainingSeconds: CONFIG.testRemainingSeconds,
  });
});

app.post('/api/auto-extend/test-set-remaining', requireAdmin, async (req, res) => {
  const { seconds } = req.body || {};
  setTestRemaining(parseInt(seconds, 10) || 0);
  res.json({
    ok: true,
    testRemainingSeconds: CONFIG.testRemainingSeconds,
  });
});

// ── Manual extend trigger (for testing) ──
app.post('/api/auto-extend/test-extend', requireAdmin, async (req, res) => {
  try {
    const result = await extendServer();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Health check (folosit si de self-ping-ul anti-sleep) ──
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// ── Memorie proces (debug — doar admin) ──
// Ajuta sa vedem daca memoria creste spre limita de 512MB a planului free Render.
app.get('/api/memory', requireAdmin, (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    rssMB: Math.round(mem.rss / 1024 / 1024),
    heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
    externalMB: Math.round(mem.external / 1024 / 1024),
    arrayBuffersMB: Math.round((mem.arrayBuffers || 0) / 1024 / 1024),
    limitMB: 512,
    uptimeSec: Math.round(process.uptime()),
    host: process.env.RENDER_INSTANCE_ID || 'local',
  });
});

// ── Backup save -> Google Drive ──
let backupRunning = false;
let lastBackup = null;
let backupTimer = null;

app.post('/api/backup', requireAdmin, async (req, res) => {
  if (backupRunning) return res.status(409).json({ ok: false, error: 'Un backup e deja in curs' });
  backupRunning = true;
  try {
    const report = await runBackup();
    lastBackup = report;
    res.json(report);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    backupRunning = false;
  }
});

app.get('/api/backup/status', requireAdmin, (req, res) => {
  res.json({
    ok: true,
    lastBackup,
    running: backupRunning,
    scheduleMinutes: process.env.BACKUP_INTERVAL_MINUTES ? parseInt(process.env.BACKUP_INTERVAL_MINUTES, 10) : 180,
  });
});

// Backup programat: la fiecare BACKUP_INTERVAL_MINUTES (default 3h).
// Se dezactiveaza explicit cu BACKUP_INTERVAL_MINUTES=0.
function startBackupSchedule() {
  const intervalMin = parseInt(process.env.BACKUP_INTERVAL_MINUTES, 10);
  if (!intervalMin || intervalMin <= 0) {
    console.log('BACKUP_INTERVAL_MINUTES nu e setat — backup-ul periodic e dezactivat (manual prin /api/backup).');
    return;
  }
  backupTimer = setInterval(async () => {
    if (backupRunning) return;
    console.log(`[backup] Program: pornesc backup (la ${intervalMin} min).`);
    backupRunning = true;
    try {
      lastBackup = await runBackup();
    } catch (err) {
      console.error('[backup] Program: eroare:', err.message);
      lastBackup = { ok: false, error: err.message, timestamp: new Date().toISOString() };
    } finally {
      backupRunning = false;
    }
  }, intervalMin * 60 * 1000);
  console.log(`Backup-ul save -> Google Drive va rula la fiecare ${intervalMin} min.`);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`g4f-relay ruleaza pe portul ${PORT}`);
  // Porneste background service-ul de auto-extindere +90 min
  // (doar daca AUTO_EXTEND_ENABLED nu e explicit "false")
  if (process.env.AUTO_EXTEND_ENABLED !== 'false') {
    startAutoExtend();
  } else {
    console.log('[auto-extend] OPRIT prin AUTO_EXTEND_ENABLED=false.');
  }
  // Porneste programul de backup al save-urilor (daca e configurat)
  startBackupSchedule();
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
