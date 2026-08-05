const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { execFile } = require('child_process');

const { getPersistentPage, holdBrowser, releaseHold } = require('./browser');

const STATE_PATH = path.join(__dirname, '..', 'storageState.json');
const STAGING_ROOT = process.env.BACKUP_STAGING_DIR || path.join(__dirname, '..', '.backups');
const RCLONE_BIN = process.env.RCLONE_BIN || 'rclone';
const RCLONE_CONFIG = process.env.RCLONE_CONFIG || path.join(__dirname, '..', 'rclone.conf');
const GDRIVE_REMOTE = (process.env.GDRIVE_REMOTE || 'gdrive').trim();
const GDRIVE_BACKUP_FOLDER = (process.env.GDRIVE_BACKUP_FOLDER || 'g4f-palworld-backups').trim();
// Câte backup-uri păstrăm pe Drive (cele mai vechi se șterg). 0 = păstrează toate.
const BACKUP_KEEP_COUNT = (() => {
  const n = parseInt(process.env.BACKUP_KEEP_COUNT, 10);
  return Number.isNaN(n) ? 1 : n;
})();

const debug = (...args) => console.log(...args);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout ${label} (${ms / 1000}s)`)), ms)
    ),
  ]);
}

// Rădăcina fișierelor serverului, derivată din SERVER_CONSOLE_URL.
// Exemplu: https://control.gaming4free.net/server/48709f0f/console
//   -> https://control.gaming4free.net/server/48709f0f/files
function getFilesBase() {
  const consoleUrl = (process.env.SERVER_CONSOLE_URL || '').trim();
  const m = /^(https?:\/\/[^/]+\/server\/[^/]+)/.exec(consoleUrl);
  if (!m) throw new Error('SERVER_CONSOLE_URL invalid — nu pot deriva baza de fisiere');
  return `${m[1]}/files`;
}

// Directorul save-ului Palworld (în raport cu root-ul de fișiere).
const SAVE_PATH =
  (process.env.G4F_SAVE_PATH || '').trim() ||
  'Pal/Saved/SaveGames/0/20C6479BE3F944D2BEC73FEF41CDA733';

// Cookie-urile de sesiune din storageState.json (pentru download-ul direct).
function getCookieStr() {
  if (!fs.existsSync(STATE_PATH)) {
    throw new Error('Lipseste storageState.json — ruleaza "npm run capture-session"');
  }
  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  return (state.cookies || [])
    .filter((c) => c.domain.includes('gaming4free'))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

// GET cu redirect-uri urmarite (control.gaming4free.net -> serverul de fisiere
// cu token JWT). Returneaza Buffer.
function getWithRedirects(url, cookieStr) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(
      url,
      {
        headers: {
          'Cookie': cookieStr,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0',
        },
      },
      (res) => {
        const loc = res.headers['location'];
        if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
          res.resume();
          resolve(getWithRedirects(new URL(loc, url).toString(), cookieStr));
          return;
        }
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            disposition: res.headers['content-disposition'] || null,
            buf: Buffer.concat(chunks),
          })
        );
      }
    );
    req.on('error', reject);
    // Timeout de siguranta — fara el, un server care nu raspunde blocheaza
    // backup-ul la infinit (running=true pentru totdeauna).
    req.setTimeout(30000, () => {
      req.destroy(new Error(`Timeout la GET ${url} (30s)`));
    });
  });
}

// Lista link-urilor de download dintr-un director de fișiere, prin browser
// (componentul Filament/Livewire). Deschide un tab separat în contextul
// persistent, ca să nu deranjeze pagina de console a auto-extend-ului.
async function listDownloadLinks(dirUrl) {
  const page = await getPersistentPage({ skipConsole: true });
  const context = page.context();
  const tab = await context.newPage();
  try {
    await tab.goto(dirUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (tab.url().includes('accounts.google.com') || tab.url().includes('/login')) {
      throw new Error('Sesiunea a expirat — ruleaza "npm run capture-session"');
    }
    // Tabelul Filament se incarca prin Livewire dupa primul paint.
    await tab.waitForSelector('a[href*="/files/download/"]', { state: 'attached', timeout: 20000 }).catch(() => {});
    await tab.waitForTimeout(2500);
    return await tab.evaluate(() =>
      [...new Set([...document.querySelectorAll('a[href*="/files/download/"]')].map((a) => a.href))]
    );  } finally {
    await tab.close().catch(() => {});
  }
}

// Descarca toate fișierele salvării într-un director staging local.
// Structură: <staging>/Level.sav + <staging>/Players/<playerid>.sav
async function downloadSave(stagingDir) {
  const cookieStr = getCookieStr();
  const filesBase = getFilesBase();
  const saveDirUrl = `${filesBase}/${SAVE_PATH.split('/').map(encodeURIComponent).join('/')}`;
  const playersDirUrl = `${saveDirUrl}/Players`;

  debug(`[backup] Director save: ${saveDirUrl}`);
  holdBrowser();
  let all;
  try {
    const links = await withTimeout(listDownloadLinks(saveDirUrl), 180000, 'listare director save');
    const playerLinks = await withTimeout(listDownloadLinks(playersDirUrl), 180000, 'listare director Players');
    all = [...links, ...playerLinks];
  } finally {
    releaseHold();
  }

  if (all.length === 0) {
    throw new Error('Nu am gasit niciun fisier de download in directorul de save');
  }

  debug(`[backup] Am gasit ${all.length} fisier(e) de descarcat.`);
  const downloaded = [];
  for (const url of all) {
    const r = await withTimeout(getWithRedirects(url, cookieStr), 40000, `GET ${url.split('/').pop()}`);
    if (r.status !== 200 || r.buf.length === 0) {
      debug(`[backup] Sari peste (status ${r.status}): ${url}`);
      continue;
    }
    // Numele fișierului: din Content-Disposition, altfel ultimul segment din URL.
    let name = null;
    const dm = /filename[^;=\n]*=\s*(?:"([^"]*)"|([^;\n]*))/i.exec(r.disposition || '');
    if (dm) name = (dm[1] || dm[2] || '').trim();
    if (!name) name = decodeURIComponent(url.split('/').filter(Boolean).pop() || 'fisier.sav');

    // Fișierele din /Players/ ajung în subfolderul Players/.
    let destPath = path.join(stagingDir, name);
    if (url.includes('/Players/')) {
      destPath = path.join(stagingDir, 'Players', name);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
    }
    fs.writeFileSync(destPath, r.buf);
    debug(`[backup]  + ${path.relative(stagingDir, destPath)} (${r.buf.length} bytes)`);
    downloaded.push({ name, size: r.buf.length, players: url.includes('/Players/') });
  }
  return downloaded;
}

// Ruleaza rclone cu config-ul nostru (fișierul rclone.conf).
function runRclone(args) {
  return new Promise((resolve, reject) => {
    execFile(
      RCLONE_BIN,
      ['--config', RCLONE_CONFIG, '--no-check-certificate', ...args],
      { maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`rclone ${args[0]} esuat: ${err.message} | ${stderr}`));
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

// Incarca directorul de backup in Google Drive, in g4f-backups/<timestamp>/.
async function uploadToDrive(stagingDir) {
  const dest = `${GDRIVE_REMOTE}:${GDRIVE_BACKUP_FOLDER}/${path.basename(stagingDir)}`;
  debug(`[backup] Upload catre ${dest}`);
  await runRclone(['copy', stagingDir, dest, '--transfers', '1']);
  debug('[backup] Upload complet.');
}

// Sterge backup-urile vechi de pe Drive, pastrand doar cele mai recente
// BACKUP_KEEP_COUNT (sortate alfabetic — numele incep cu timestamp ISO).
async function pruneOldBackups() {
  if (BACKUP_KEEP_COUNT <= 0) return { deleted: 0 };
  const folder = `${GDRIVE_REMOTE}:${GDRIVE_BACKUP_FOLDER}`;
  const r = await runRclone(['lsf', folder, '--dirs-only']);
  const dirs = r.stdout.split('\n').map((d) => d.trim()).filter(Boolean);
  if (dirs.length <= BACKUP_KEEP_COUNT) return { deleted: 0, kept: dirs.length };

  dirs.sort();
  const toDelete = dirs.slice(0, dirs.length - BACKUP_KEEP_COUNT);
  for (const d of toDelete) {
    debug(`[backup] Sterg backup-ul vechi: ${d}`);
    await runRclone(['purge', `${folder}/${d}`]);
  }
  return { deleted: toDelete.length, kept: BACKUP_KEEP_COUNT };
}

// Backup complet: descarca save-ul, il incarca in Google Drive si sterge
// backup-urile mai vechi (nu cheltuim loc inutil pe Drive).
async function runBackup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19) + 'Z';
  const stagingDir = path.join(STAGING_ROOT, stamp);
  fs.mkdirSync(path.join(stagingDir, 'Players'), { recursive: true });

  const report = { timestamp: stamp, files: [], error: null };
  try {
    report.files = await downloadSave(stagingDir);
    const total = report.files.reduce((s, f) => s + f.size, 0);
    report.totalBytes = total;
    report.totalFiles = report.files.length;
    await uploadToDrive(stagingDir);
    report.pruned = await pruneOldBackups();
    report.ok = true;
    debug(`[backup] Gata: ${report.totalFiles} fisier(e), ${total} bytes -> Google Drive.`);
  } catch (err) {
    report.ok = false;
    report.error = err.message;
    debug('[backup] EROARE:', err.message);
  } finally {
    // Curatam staging-ul (Render nu are disc persistent oricum).
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
  return report;
}

module.exports = { runBackup, getFilesBase };
