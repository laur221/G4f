const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const STATE_PATH = path.join(__dirname, '..', 'storageState.json');

// ── Debug: salveaza URL/titlu/HTML cand ceva nu merge, ca sa putem
// diagnostica din logs fara acces vizual la browser ──
async function dumpDebugInfo(page, label) {
  try {
    const url = page.url();
    const title = await page.title().catch(() => '(fara titlu)');
    const html = await page.content().catch(() => '');
    console.error(`── DEBUG [${label}] ──`);
    console.error('URL:', url);
    console.error('Titlu:', title);
    console.error('HTML (primele 1500 caractere):', html.slice(0, 1500));
    console.error('────────────────────────');
  } catch (err) {
    console.error(`Nu am putut colecta debug info [${label}]:`, err.message);
  }
}

// Textul vizibil al fiecarui buton, asa cum apare in panoul Gaming4Free.
const BUTTON_LABELS = {
  start: 'Start',
  stop: 'Stop',
  restart: 'Restart',
};

// ── Mutex simplu pentru accesul la browser ──
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

// ── Browser persistent ──
let browserInstance = null;
let contextInstance = null;
let pageInstance = null;

async function getPersistentPage() {
  if (pageInstance && !pageInstance.isClosed()) {
    return pageInstance;
  }

  await closePersistent();

  browserInstance = await chromium.launch({ headless: true, channel: 'chromium' });
  contextInstance = await browserInstance.newContext({ storageState: STATE_PATH });
  pageInstance = await contextInstance.newPage();
  await openConsole(pageInstance);

  return pageInstance;
}

async function closePersistent() {
  try {
    if (browserInstance) await browserInstance.close();
  } catch (err) {
    // ignoram — browserul poate fi deja mort
  }
  browserInstance = null;
  contextInstance = null;
  pageInstance = null;
}

async function openConsole(page) {
  // Consola G4F face polling continuu (Livewire) cat timp serverul e ONLINE,
  // deci reteaua nu ajunge niciodata "idle" — folosim 'domcontentloaded' si
  // asteptam explicit elementul de status in loc de networkidle.
  await page.goto(process.env.SERVER_CONSOLE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  if (page.url().includes('accounts.google.com') || page.url().includes('/login')) {
    throw new Error(
      'Sesiunea salvata a expirat. Trebuie sa rulezi din nou "npm run capture-session".'
    );
  }

  try {
    await page.locator('.status-pill').first().waitFor({ state: 'visible', timeout: 45000 });
    lastFullSyncAt = Date.now();
  } catch (err) {
    await dumpDebugInfo(page, 'openConsole - .status-pill nu a aparut');
    throw err;
  }
}

// ── Asteapta ca un buton sa fie enabled (nu doar vizibil), cu reincercari
// scurte — G4F il dezactiveaza temporar (wire:loading.attr="disabled")
// ori de cate ori are un request Livewire in desfasurare (ex. polling-ul
// lor intern la 15s), asa ca poate flickeri disabled/enabled.
async function clickWhenEnabled(button, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await button.isEnabled().catch(() => false)) {
      await button.click();
      return true;
    }
    await button.page().waitForTimeout(400);
  }
  return false;
}

// ── Actiuni de baza (Start / Stop / Restart) ──
async function runAction(action) {
  if (!BUTTON_LABELS[action]) {
    throw new Error(`Actiune necunoscuta: ${action}`);
  }
  ensureSessionExists();

  return withLock(async () => {
    try {
      const page = await getPersistentPage();

      const label = BUTTON_LABELS[action];
      const button = page.getByRole('button', { name: label, exact: true }).first();
      await button.waitFor({ state: 'visible', timeout: 45000 });

      const clicked = await clickWhenEnabled(button, 20000);
      if (!clicked) {
        return {
          ok: false,
          error: 'Butonul e temporar indisponibil (G4F actualizeaza pagina) — incearca din nou peste cateva secunde.',
        };
      }

      await page.waitForTimeout(2000);

      return { ok: true, action };
    } catch (err) {
      await closePersistent();
      throw err;
    }
  });
}

// ── Extindere +90 min (cu Turnstile auto-rezolvare) ──
async function extendServer() {
  ensureSessionExists();

  return withLock(async () => {
    try {
      const page = await getPersistentPage();

      // Reincarcam pagina pentru stare proaspata
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });

      if (page.url().includes('accounts.google.com') || page.url().includes('/login')) {
        throw new Error('Sesiunea a expirat.');
      }

      await page.locator('.time span').first().waitFor({ state: 'visible', timeout: 45000 });

      // Citeste timpul ramas inainte de extindere
      const beforeText = await page.locator('.time span').first().textContent({ timeout: 10000 });
      const beforeSeconds = parseHms(beforeText);

      // Gaseste si apasa butonul "+ 90 min" (.rt-btn-free)
      const btn = page.locator('.rt-btn-free').first();
      await btn.waitFor({ state: 'visible', timeout: 45000 });

      // Verifica daca butonul e dezactivat (cooldown activ)
      const isDisabled = await btn.isDisabled();
      if (isDisabled) {
        const label = await btn.locator('span').textContent().catch(() => 'cooldown');
        return { ok: false, error: `Extindere indisponibila: ${(label || 'cooldown').trim()}` };
      }

      await btn.click();

      // Turnstile poate dura pana la ~30s pentru auto-rezolvare.
      // Facem polling la fiecare 2s, verificand daca timpul afisat a crescut.
      let extended = false;
      const startMs = Date.now();

      while (Date.now() - startMs < 50000) {
        await page.waitForTimeout(2000);

        const currentText = await page.locator('.time span').first()
          .textContent({ timeout: 5000 }).catch(() => null);
        const currentSeconds = parseHms(currentText);

        // Daca timpul a crescut cu >30 min, extinderea a reusit
        if (
          currentSeconds !== null &&
          beforeSeconds !== null &&
          (currentSeconds - beforeSeconds) > 1800
        ) {
          extended = true;
          break;
        }

        // Verifica daca widgetul Turnstile s-a inchis (nereusit)
        const tsVisible = await page.locator('#g4f-ts-widget')
          .isVisible().catch(() => false);

        if (!tsVisible && Date.now() - startMs > 6000) {
          // Widgetul nu mai e vizibil — mai asteptam 3s pentru cazul in care
          // Livewire proceseaza raspunsul serverului.
          await page.waitForTimeout(3000);
          const afterText = await page.locator('.time span').first()
            .textContent({ timeout: 5000 }).catch(() => null);
          const afterSeconds = parseHms(afterText);
          if (
            afterSeconds !== null &&
            beforeSeconds !== null &&
            (afterSeconds - beforeSeconds) > 1800
          ) {
            extended = true;
          }
          break;
        }
      }

      if (!extended) {
        // Inchide modalul Turnstile daca a ramas deschis
        await page.evaluate(() => {
          if (typeof g4fCloseTurnstile === 'function') g4fCloseTurnstile();
        }).catch(() => {});

        return {
          ok: false,
          error: 'Nu s-a putut extinde automat — Turnstile necesita interventie manuala pe gaming4free.net.',
        };
      }

      // Citeste noul timp ramas
      const afterText = await page.locator('.time span').first().textContent({ timeout: 10000 });
      const afterSeconds = parseHms(afterText);

      return {
        ok: true,
        action: 'extend',
        remainingSeconds: afterSeconds,
        remainingLabel: afterText ? afterText.trim() : null,
        addedMinutes:
          beforeSeconds !== null && afterSeconds !== null
            ? Math.round((afterSeconds - beforeSeconds) / 60)
            : null,
      };
    } catch (err) {
      await closePersistent();
      throw err;
    }
  });
}

// ── Status server (timp ramas, online/offline, resurse) ──
// Citim live din DOM la fiecare verificare (rapid). Dar din moment ce nu
// stim sigur daca .status-pill se auto-actualizeaza prin polling-ul intern
// Livewire al paginii G4F (s-a observat ca uneori ramane "inghetata" la
// OFFLINE dupa ce serverul a pornit de fapt), facem un reload complet de
// resincronizare periodica, ca sa nu ramanem cu date vechi.
const FULL_RESYNC_INTERVAL_MS = 120000; // 2 minute
let lastFullSyncAt = 0;

// ── Debounce pentru status ONLINE/OFFLINE ──
// O singura citire "gresita" (ex. imediat dupa reload-ul de resincronizare,
// inainte ca Livewire sa afiseze starea reala) nu trebuie sa schimbe instant
// ce vede utilizatorul. Cerem 2 citiri consecutive la fel inainte sa
// acceptam o schimbare reala de stare.
let confirmedOnline = null;
let pendingOnlineValue = null;
let pendingOnlineCount = 0;

function resolveOnline(rawOnline) {
  if (confirmedOnline === null) {
    confirmedOnline = rawOnline;
    return confirmedOnline;
  }
  if (rawOnline === confirmedOnline) {
    pendingOnlineValue = null;
    pendingOnlineCount = 0;
    return confirmedOnline;
  }
  if (pendingOnlineValue === rawOnline) {
    pendingOnlineCount += 1;
  } else {
    pendingOnlineValue = rawOnline;
    pendingOnlineCount = 1;
  }
  if (pendingOnlineCount >= 2) {
    confirmedOnline = rawOnline;
    pendingOnlineValue = null;
    pendingOnlineCount = 0;
  }
  return confirmedOnline;
}

async function readLiveStatus(page) {
  await page.locator('.time span').first().waitFor({ state: 'visible', timeout: 10000 });

  const timeText = await page.locator('.time span').first().textContent({ timeout: 10000 });
  const remainingSeconds = parseHms(timeText);

  const rawOnline = await page
    .locator('.status-pill')
    .first()
    .textContent({ timeout: 10000 })
    .then((text) => (text || '').toUpperCase().includes('ONLINE'))
    .catch(() => false);

  const isOnline = resolveOnline(rawOnline);

  const resources = await readResources(page);

  return {
    ok: true,
    remainingSeconds,
    remainingLabel: timeText ? timeText.trim() : null,
    online: isOnline,
    resources,
    checkedAt: new Date().toISOString(),
  };
}

async function getStatus() {
  ensureSessionExists();

  return withLock(async () => {
    try {
      const page = await getPersistentPage();

      if (page.url().includes('accounts.google.com') || page.url().includes('/login')) {
        throw new Error(
          'Sesiunea salvata a expirat. Trebuie sa rulezi din nou "npm run capture-session".'
        );
      }

      const needsFullSync = Date.now() - lastFullSyncAt > FULL_RESYNC_INTERVAL_MS;

      if (needsFullSync) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });

        if (page.url().includes('accounts.google.com') || page.url().includes('/login')) {
          throw new Error(
            'Sesiunea salvata a expirat. Trebuie sa rulezi din nou "npm run capture-session".'
          );
        }

        try {
          await page.locator('.time span').first().waitFor({ state: 'visible', timeout: 45000 });
          await page.locator('.status-pill').first().waitFor({ state: 'visible', timeout: 15000 });
        } catch (err) {
          await dumpDebugInfo(page, 'getStatus - resync periodic a esuat');
          throw err;
        }

        lastFullSyncAt = Date.now();
        return readLiveStatus(page);
      }

      try {
        return await readLiveStatus(page);
      } catch (err) {
        // Fallback: pagina poate fi blocata (ex. dupa idle lung) — incercam
        // un reload complet, o singura data, inainte sa renuntam.
        console.warn('Citire live esuata, incerc reload complet:', err.message);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });

        if (page.url().includes('accounts.google.com') || page.url().includes('/login')) {
          throw new Error(
            'Sesiunea salvata a expirat. Trebuie sa rulezi din nou "npm run capture-session".'
          );
        }

        try {
          await page.locator('.time span').first().waitFor({ state: 'visible', timeout: 45000 });
          await page.locator('.status-pill').first().waitFor({ state: 'visible', timeout: 15000 });
          lastFullSyncAt = Date.now();
          return await readLiveStatus(page);
        } catch (err2) {
          await dumpDebugInfo(page, 'getStatus - fallback reload a esuat si el');
          throw err2;
        }
      }
    } catch (err) {
      await closePersistent();
      throw err;
    }
  });
}

// ── Citeste CPU / MEMORY / NETWORK din panoul RESOURCES ──
async function readResources(page) {
  try {
    let gauges = page.locator('.gauge');
    let count = await gauges.count();

    // Dupa un reload, panoul de resurse poate aparea cu o mica intarziere
    // fata de .time span — mai incercam o data inainte sa renuntam.
    if (count === 0) {
      await page.waitForTimeout(1500);
      gauges = page.locator('.gauge');
      count = await gauges.count();
    }

    const result = {};

    for (let i = 0; i < count; i++) {
      const gauge = gauges.nth(i);
      const label = (await gauge.locator('.glabel').first().textContent().catch(() => '')) || '';
      const rawValue = (await gauge.locator('.gval').first().textContent().catch(() => '')) || '';
      const value = rawValue.replace(/\s+/g, ' ').trim();
      const key = label.trim().toLowerCase();
      if (key) {
        result[key] = value;
        const match = value.match(/[\d.]+/);
        result[key + 'Num'] = match ? parseFloat(match[0]) : null;
      }
    }

    return result;
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

module.exports = { runAction, getStatus, extendServer };