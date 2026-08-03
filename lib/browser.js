const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const STATE_PATH = path.join(__dirname, '..', 'storageState.json');

// Textul vizibil al fiecarui buton, asa cum apare in panoul Gaming4Free.
// Am confirmat aceste texte direct din HTML-ul paginii /console.
const BUTTON_LABELS = {
  start: 'Start',
  stop: 'Stop',
  restart: 'Restart',
};

// Un singur browser rulat o data (mutex simplu) ca sa nu pornim
// mai multe instante Chromium simultan daca vin doua cereri deodata
// (fie click pe buton, fie verificare automata a timpului ramas).
let running = false;
const queue = [];

function withLock(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (running || queue.length === 0) return;
  running = true;
  const { fn, resolve, reject } = queue.shift();
  try {
    resolve(await fn());
  } catch (err) {
    reject(err);
  } finally {
    running = false;
    processQueue();
  }
}

function ensureSessionExists() {
  if (!fs.existsSync(STATE_PATH)) {
    throw new Error(
      'Lipseste storageState.json — trebuie sa rulezi mai intai "npm run capture-session" ' +
      'de pe calculatorul tau (cu Chrome vizibil) ca sa salvezi sesiunea de login Google.'
    );
  }
}

async function openConsole(page) {
  await page.goto(process.env.SERVER_CONSOLE_URL, { waitUntil: 'networkidle', timeout: 30000 });

  // Daca sesiunea a expirat, Google ne redirectioneaza la login.
  if (page.url().includes('accounts.google.com') || page.url().includes('/login')) {
    throw new Error(
      'Sesiunea salvata a expirat. Trebuie sa rulezi din nou "npm run capture-session".'
    );
  }
}

async function runAction(action) {
  if (!BUTTON_LABELS[action]) {
    throw new Error(`Actiune necunoscuta: ${action}`);
  }
  ensureSessionExists();

  return withLock(async () => {
    const browser = await chromium.launch({ headless: true, channel: 'chromium' });
    try {
      const context = await browser.newContext({ storageState: STATE_PATH });
      const page = await context.newPage();

      await openConsole(page);

      const label = BUTTON_LABELS[action];
      const button = page.getByRole('button', { name: label, exact: true }).first();
      await button.waitFor({ state: 'visible', timeout: 15000 });
      await button.click();

      // Fara modal de confirmare pentru Start/Stop/Restart pe acest panou —
      // actiunea se executa direct la click. Lasam putin timp sa se proceseze.
      await page.waitForTimeout(2000);

      return { ok: true, action };
    } finally {
      await browser.close();
    }
  });
}

// Citeste timpul ramas afisat in panoul de sesiune (ex. "05:57:28")
// si starea (online/offline) a serverului, direct din pagina consolei.
async function getStatus() {
  ensureSessionExists();

  return withLock(async () => {
    const browser = await chromium.launch({ headless: true, channel: 'chromium' });
    try {
      const context = await browser.newContext({ storageState: STATE_PATH });
      const page = await context.newPage();

      await openConsole(page);

      // Textul din ".time span" e randat de server la incarcarea paginii
      // (ex. "05:57:28"), inainte ca Alpine.js sa preia numaratoarea local.
      const timeText = await page.locator('.time span').first().textContent({ timeout: 10000 });
      const remainingSeconds = parseHms(timeText);

      const isOnline = await page
        .locator('.status-pill.running')
        .first()
        .isVisible()
        .catch(() => false);

      const resources = await readResources(page);

      return {
        ok: true,
        remainingSeconds,
        remainingLabel: timeText ? timeText.trim() : null,
        online: isOnline,
        resources,
        checkedAt: new Date().toISOString(),
      };
    } finally {
      await browser.close();
    }
  });
}

// Citeste cele 3 gauge-uri (CPU / MEMORY / NETWORK) direct din panoul
// "RESOURCES" al consolei Gaming4Free. Fiecare .gauge are un .glabel
// (eticheta) si un .gval (valoarea curenta, uneori cu un <span class="max">
// cu maximul alaturi, ex. "23 / 100%").
async function readResources(page) {
  try {
    const gauges = page.locator('.gauge');
    const count = await gauges.count();
    const result = {};

    for (let i = 0; i < count; i++) {
      const gauge = gauges.nth(i);
      const label = (await gauge.locator('.glabel').first().textContent().catch(() => '')) || '';
      const rawValue = (await gauge.locator('.gval').first().textContent().catch(() => '')) || '';
      // Normalizam whitespace-ul (textul vine cu tab-uri/newline-uri din markup).
      const value = rawValue.replace(/\s+/g, ' ').trim();
      const key = label.trim().toLowerCase();
      if (key) result[key] = value;
    }

    return result; // ex. { cpu: '23 / 100%', memory: '1.20 / 4.00 GiB', network: '↓ 12 KB/s ↑ 3 KB/s' }
  } catch (err) {
    console.error('Eroare la citirea resurselor:', err.message);
    return null;
  }
}

function parseHms(text) {
  if (!text) return null;
  const parts = text.trim().split(':').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  const [h, m, s] = parts;
  return h * 3600 + m * 60 + s;
}

module.exports = { runAction, getStatus };