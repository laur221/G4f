const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const https = require('https');

const STATE_PATH = path.join(__dirname, '..', 'storageState.json');

const debug = (...args) => console.log(...args);

const CAPTCHA_API_KEY = (process.env.CAPTCHA_API_KEY || '').trim();
const CAPTCHA_PROVIDER = (process.env.CAPTCHA_PROVIDER || '2captcha').trim().toLowerCase();
const REAL_CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

// Auto-închidere: dacă nu mai e folosit de N secunde, închidem browserul
// complet ca să nu depășim limita de 512MB a planului free Render.
// Intervalul e mai mic decât CHECK_INTERVAL (5 min), deci browserul se
// închide între verificări și se redeschide doar când e nevoie.
const IDLE_CLOSE_MS = 90 * 1000; // 90 de secunde fara activitate
let idleTimer = null;

// Contor de "hold": operațiunile lungi (ex. backup cu mai multe liste de
// directoare) incrementează pentru a împiedica idle-close să închidă
// browserul la mijloc. Trebuie eliberat în finally.
let holdCount = 0;
function holdBrowser() {
  holdCount++;
  clearTimeout(idleTimer);
}
function releaseHold() {
  holdCount = Math.max(0, holdCount - 1);
  scheduleIdleClose();
}

function scheduleIdleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    // Dacă o operație e în curs (extend poate dura minute prin solver)
    // sau cineva ține browserul (backup), nu închidem — reprogramăm.
    if (running || holdCount > 0) {
      scheduleIdleClose();
      return;
    }
    console.log('[browser] Inactiv — inchid Chromium pentru a elibera RAM.');
    closePersistent().catch(() => {});
  }, IDLE_CLOSE_MS);
}

async function getPersistentPage(opts = {}) {
  if (pageInstance && !pageInstance.isClosed()) {
    scheduleIdleClose();
    return pageInstance;
  }

  await closePersistent();

  browserInstance = await chromium.launch({
    headless: true,
    channel: 'chromium',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--no-first-run',
      '--disable-extensions',
      '--js-flags=--max-old-space-size=96',
      '--memory-pressure-off'
    ]
  });
  contextInstance = await browserInstance.newContext({
    storageState: STATE_PATH,
    userAgent: REAL_CHROME_UA
  });
  await addStealthInitScript(contextInstance);
  pageInstance = await contextInstance.newPage();
  if (opts.skipConsole) {
    // Backup/etc: avem nevoie doar de sesiunea logata, nu si de consola
    // (care poate fi lenesa si bloca asteptarea .status-pill).
    await pageInstance.goto('about:blank');
  } else {
    await openConsole(pageInstance);
  }

  scheduleIdleClose();
  return pageInstance;
}

async function closePersistent() {
  clearTimeout(idleTimer);
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
    // Pe pagina /suspended nu exista .status-pill — nu trebuie sa asteptam
    // (serverul e suspendat; auto-extend-ul va face RENEW & UNSUSPEND).
    if (!page.url().includes('/suspended')) {
      await page.locator('.status-pill').first().waitFor({ state: 'visible', timeout: 45000 });
    }
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

// ── Stealth: ascundem semnele de automatizare (navigator.webdriver etc.) ──
async function addStealthInitScript(context) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['ro-RO', 'ro', 'en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = window.chrome || { runtime: {} };
    const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) =>
        parameters && parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);
    }
  });
}

// ── CAPTCHA solver — portat din nodriver-extend.py (2Captcha / CapSolver) ──
// Nota: pentru CapSolver folosim tipul corect TurnstileTaskProxyLess (in
// varianta Python era ReCaptchaV2TaskProxyLess, care nu e valid pentru
// Turnstile si ar fi esuat).
function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
}

function httpPostJson(url, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(data));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function extractSitekey(page) {
  try {
    return await page.evaluate(() => {
      const scripts = [...document.scripts];
      const s = scripts.find((x) => (x.textContent || '').includes('turnstile.render'));
      if (!s) return null;
      const m = s.textContent.match(/sitekey:\s*['"]([^'"]+)['"]/);
      return m ? m[1] : null;
    });
  } catch (err) {
    debug(`[solver] Eroare la extragerea sitekey: ${err.message}`);
    return null;
  }
}

async function solveTurnstile2Captcha(sitekey, pageUrl) {
  debug(`[solver] 2Captcha: trimitem task (sitekey=${sitekey})...`);
  let raw;
  try {
    raw = await httpGetJson(
      'https://2captcha.com/in.php?' +
        new URLSearchParams({
          key: CAPTCHA_API_KEY,
          method: 'turnstile',
          sitekey,
          pageurl: pageUrl,
          json: '1',
        }).toString()
    );
  } catch (err) {
    debug(`[solver] 2Captcha submit — eroare retea: ${err.message}`);
    return null;
  }
  let submit;
  try {
    submit = JSON.parse(raw);
  } catch (err) {
    debug(`[solver] 2Captcha submit ne-JSON: ${raw.slice(0, 120)}`);
    return null;
  }
  if (submit.status !== 1) {
    debug(`[solver] 2Captcha submit esuat: ${submit.request}`);
    return null;
  }
  const taskId = submit.request;
  debug(`[solver] 2Captcha task id: ${taskId}. Asteptam rezolvarea...`);
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    try {
      raw = await httpGetJson(
        'https://2captcha.com/res.php?' +
          new URLSearchParams({
            key: CAPTCHA_API_KEY,
            action: 'get',
            id: taskId,
            json: '1',
          }).toString()
      );
    } catch (err) {
      continue;
    }
    let result;
    try {
      result = JSON.parse(raw);
    } catch (err) {
      continue;
    }
    if (result.status === 1) {
      debug(`[solver] TOKEN 2Captcha obtinut (${result.request.length} chars).`);
      return result.request;
    }
    if (result.request === 'CAPCHA_NOT_READY') continue;
    debug(`[solver] 2Captcha poll: ${result.request}`);
    return null;
  }
  debug(`[solver] 2Captcha: timeout (5 min).`);
  return null;
}

async function solveTurnstileCapSolver(sitekey, pageUrl) {
  debug(`[solver] CapSolver: trimitem task (sitekey=${sitekey})...`);
  let submit;
  try {
    const raw = await httpPostJson('https://api.capsolver.com/createTask', {
      clientKey: CAPTCHA_API_KEY,
      task: {
        type: 'TurnstileTaskProxyLess',
        websiteURL: pageUrl,
        websiteKey: sitekey,
        userAgent: REAL_CHROME_UA,
      },
    });
    submit = JSON.parse(raw);
  } catch (err) {
    debug(`[solver] CapSolver submit — eroare: ${err.message}`);
    return null;
  }
  if (submit.errorId !== 0) {
    debug(`[solver] CapSolver submit esuat: ${submit.errorDescription}`);
    return null;
  }
  const taskId = submit.taskId;
  debug(`[solver] CapSolver task id: ${taskId}. Asteptam rezolvarea...`);
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    try {
      const raw = await httpPostJson('https://api.capsolver.com/getTaskResult', {
        clientKey: CAPTCHA_API_KEY,
        taskId,
      });
      const result = JSON.parse(raw);
      if (result.status === 'ready') {
        const token = (result.solution && (result.solution.token || result.solution.gRecaptchaResponse)) || null;
        if (token) {
          debug(`[solver] TOKEN CapSolver obtinut (${token.length} chars).`);
          return token;
        }
      } else if (result.status === 'failed') {
        debug(`[solver] CapSolver: task failed.`);
        return null;
      }
    } catch (err) {
      // continuam poll-ul
    }
  }
  debug(`[solver] CapSolver: timeout (5 min).`);
  return null;
}

async function solveTurnstile(sitekey, pageUrl) {
  if (CAPTCHA_PROVIDER === 'capsolver') {
    return solveTurnstileCapSolver(sitekey, pageUrl);
  }
  return solveTurnstile2Captcha(sitekey, pageUrl);
}

// ── Apel direct $wire.extend(token) pe componenta renewal-timer ──
// Confirmat empiric: POST-ul Livewire ajunge la server, dar token-ul e
// validat prin siteverify Cloudflare — un token fals e respins (timpul nu
// creste), deci avem nevoie de token real de la solver.
async function callWireExtend(page, token) {
  return page.evaluate((tok) => {
    const btn = document.querySelector('.rt-btn-free');
    const root = btn ? btn.closest('[wire\\:id]') : null;
    if (!root) return { ok: false, error: 'renewal-timer root negasit' };
    if (typeof Alpine === 'undefined' || !Alpine.evaluate) {
      return { ok: false, error: 'Alpine indisponibil' };
    }
    try {
      const result = Alpine.evaluate(root, `$wire.extend(${JSON.stringify(tok)})`);
      return { ok: true, result: result === undefined ? 'undefined' : String(result) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }, token);
}

// Fallback pentru cazul in care Alpine nu e disponibil: deschidem modalul si
// injectam token-ul direct in callback-ul G4F.
async function injectTurnstileToken(page, token) {
  return page.evaluate((tok) => {
    const cb = window._g4fTsCallback;
    if (typeof cb === 'function') {
      try {
        cb(tok);
        return 'injected-callback';
      } catch (e) {
        return 'callback-error: ' + e.message;
      }
    }
    const inp = document.querySelector('input[name="cf-turnstile-response"]');
    if (inp) {
      inp.value = tok;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return 'injected-input';
    }
    return 'no-callback-no-input';
  }, token);
}

// ── Click cu miscare de mouse (mai putin detectabil decat click instant) ──
async function clickHuman(page, locator) {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) {
    await locator.click();
    return;
  }
  const jitter = 3;
  const x = box.x + box.width / 2 + Math.round((Math.random() * 2 - 1) * jitter);
  const y = box.y + box.height / 2 + Math.round((Math.random() * 2 - 1) * jitter);
  await page.mouse.move(x, y, { steps: 8 });
  await page.waitForTimeout(150 + Math.random() * 300);
  await page.mouse.click(x, y);
}

// Asteapta pana la timeoutMs sa creasca timpul ramas cu >30 min (1800s).
async function waitForTimeIncrease(page, beforeSeconds, timeoutMs) {
  const start = Date.now();
  let lastText = null;
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(2000);
    lastText = await page
      .locator('.time span').first()
      .textContent({ timeout: 5000 }).catch(() => null);
    const lastSeconds = parseHms(lastText);
    if (
      lastSeconds !== null &&
      beforeSeconds !== null &&
      (lastSeconds - beforeSeconds) > 1800
    ) {
      return { extended: true, text: lastText, seconds: lastSeconds };
    }
  }
  return { extended: false, text: lastText, seconds: parseHms(lastText) };
}

async function buildSuccessResult(page, beforeSeconds) {
  const afterText = await page
    .locator('.time span').first()
    .textContent({ timeout: 10000 });
  const afterSeconds = parseHms(afterText);
  debug(`[extend] ✅ Extindere finalizata cu succes! +${Math.round((afterSeconds - beforeSeconds) / 60)} min.`);
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
}

// ── Calea 0 (gratuita, FARA captcha): apel direct $wire.extendWebAd() ──
// Confirmat empiric (aug 2026): serverul NU valideaza vizionarea reclamei.
// POST-ul Livewire adauga direct +90 min, fara token Turnstile si fara ad.
async function tryWebAdExtend(page, beforeSeconds) {
  debug(`[extend] Calea 0 (gratuita): apel direct $wire.extendWebAd()`);
  const callResult = await page.evaluate(() => {
    const btn = document.querySelector('.rt-btn-free');
    const root = btn ? btn.closest('[wire\\:id]') : null;
    if (!root) return { ok: false, error: 'renewal-timer root negasit' };
    if (typeof Alpine === 'undefined' || !Alpine.evaluate) {
      return { ok: false, error: 'Alpine indisponibil' };
    }
    try {
      const result = Alpine.evaluate(root, '$wire.extendWebAd()');
      return { ok: true, result: result === undefined ? 'undefined' : String(result) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  debug(`[extend] Apel $wire.extendWebAd: ${JSON.stringify(callResult)}`);

  // Livewire actualizeaza timer-ul cu intarziere — 60s ca sa prinda cresterea.
  const check = await waitForTimeIncrease(page, beforeSeconds, 60000);
  if (check.extended) {
    return buildSuccessResult(page, beforeSeconds);
  }
  debug(`[extend] Calea 0 esuata — continuam cu calea A/B`);
  return null;
}

// Calea A (gratuita): click pe .rt-btn-free + click pe checkbox-ul Turnstile
// din iframe. Managed widget-urile se auto-rezolva uneori cu scor bun; in
// headless pur de obicei esueaza — atunci trecem la calea B.
async function tryFreeTurnstileExtend(page, beforeSeconds) {
  debug(`[extend] Calea A (gratuita): click pe .rt-btn-free + checkbox Turnstile`);
  await saveScreenshot(page, 'before-click');

  const btn = page.locator('.rt-btn-free').first();
  await clickHuman(page, btn);
  debug(`[extend] Butonul a fost apasat`);
  await saveScreenshot(page, 'after-click');

  let turnstileWasVisible = false;
  try {
    await page.locator('#g4f-ts-widget').waitFor({ state: 'visible', timeout: 10000 });
    turnstileWasVisible = true;
    debug(`[extend] Widget Turnstile vizibil — incerc click pe checkbox (iframe)`);
  } catch (err) {
    debug(`[extend] Widget Turnstile nu a aparut (10s): ${err.message}`);
  }

  if (turnstileWasVisible) {
    try {
      await page
        .frameLocator('#g4f-ts-widget iframe').first()
        .locator('body')
        .click({ position: { x: 12, y: 12 }, timeout: 8000 });
      debug(`[extend] Click pe checkbox Turnstile (iframe)`);
    } catch (err) {
      debug(`[extend] Click pe iframe esuat: ${err.message}`);
    }
  }

  const check = await waitForTimeIncrease(page, beforeSeconds, 20000);
  if (check.extended) {
    return buildSuccessResult(page, beforeSeconds);
  }

  // Inchidem modalul ca sa nu ramana blocat pe ecran
  await page.evaluate(() => {
    if (typeof g4fCloseTurnstile === 'function') g4fCloseTurnstile();
  }).catch(() => {});
  debug(`[extend] Calea A esuata (${check.text?.trim() || 'N/A'}) — inchid Turnstile`);
  return null;
}

// Calea B (solver): token real de la 2Captcha/CapSolver + apel direct
// $wire.extend(token) — fara modal, fara Xvfb, headless pur.
async function trySolverExtend(page, beforeSeconds, minutes) {
  if (!CAPTCHA_API_KEY) {
    debug(`[extend] Calea B (solver) sarita — CAPTCHA_API_KEY lipseste`);
    return null;
  }

  debug(`[extend] Calea B (${CAPTCHA_PROVIDER}): extrag sitekey...`);
  const sitekey = await extractSitekey(page);
  if (!sitekey) {
    debug(`[extend] ❌ Sitekey Turnstile negasit in pagina`);
    return null;
  }
  debug(`[extend] Sitekey: ${sitekey}`);

  debug(`[extend] Rezolvam Turnstile prin ${CAPTCHA_PROVIDER}...`);
  const token = await solveTurnstile(sitekey, page.url());
  if (!token) {
    debug(`[extend] ❌ Solverul nu a returnat token`);
    return null;
  }
  debug(`[extend] Token obtinut (${token.length} chars) — apel direct $wire.extend(...)`);

  const callResult = await callWireExtend(page, token);
  debug(`[extend] Apel $wire.extend: ${JSON.stringify(callResult)}`);

  if (!callResult.ok) {
    // Fallback: deschidem modalul si injectam token-ul in callback-ul G4F
    debug(`[extend] Alpine.evaluate esuat — fallback: click + injectare token`);
    const btn = page.locator('.rt-btn-free').first();
    await clickHuman(page, btn).catch(() => {});
    await page.waitForTimeout(2500);
    const injected = await injectTurnstileToken(page, token);
    debug(`[extend] Injectie token: ${injected}`);
  }

  const check = await waitForTimeIncrease(page, beforeSeconds, 40000);
  if (check.extended) {
    return buildSuccessResult(page, beforeSeconds);
  }

  debug(
    `[extend] ⚠️ Timpul nu a crescut cu token de la solver — token respins? ` +
    `(sold insuficient, IP suspect, sau sitekey schimbat)`
  );
  return null;
}

// ── Extindere +90 min (headless-safe, pentru Render) ──
// Acceptă și parametri opționali pentru extindere manuală cu minute personalizate
async function extendServer(minutes = 90) {
  ensureSessionExists();

  return withLock(async () => {
    let page = null;
    try {
      page = await getPersistentPage();

      debug(`[extend] ── START extindere ──`);
      debug(`[extend] URL inainte de reload: ${page.url()}`);

      // Consola G4F face polling continuu (Livewire), deci reload-ul poate
      // expira chiar si pe o conexiune buna. Incercam reload-ul cu retry,
      // dar daca tot esueaza continuam pe pagina existenta daca e functionala
      // (pentru $wire.extendWebAd() nu e necesar reload-ul).
      let reloaded = false;
      for (let attempt = 1; attempt <= 2 && !reloaded; attempt++) {
        try {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
          reloaded = true;
        } catch (err) {
          debug(`[extend] Reload atempt ${attempt} timeout: ${err.message.split('\n')[0]}`);
          if (attempt === 1) await page.waitForTimeout(3000);
        }
      }
      debug(`[extend] URL dupa reload (reloaded=${reloaded}): ${page.url()}`);

      if (page.url().includes('accounts.google.com') || page.url().includes('/login')) {
        throw new Error('Sesiunea a expirat.');
      }

      try {
        await page.locator('.time span').first().waitFor({ state: 'visible', timeout: 60000 });
        debug(`[extend] .time span gasit, pagina incarcata`);
      } catch (err) {
        if (reloaded) throw err;
        debug(`[extend] .time span nu e vizibil dupa reload esuat — continuam cu pagina existenta`);
        await page.locator('.time span').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {
          throw err;
        });
      }

      const beforeText = await page.locator('.time span').first().textContent({ timeout: 10000 });
      const beforeSeconds = parseHms(beforeText);
      debug(`[extend] Timp inainte: "${beforeText?.trim()}" (${beforeSeconds}s)`);

      // Calea 0: apel direct $wire.extendWebAd() — gratuit, fara captcha.
      // Confirmat empiric: serverul nu valideaza vizionarea reclamei.
      const webAdResult = await tryWebAdExtend(page, beforeSeconds);
      if (webAdResult) return webAdResult;

      const btn = page.locator('.rt-btn-free').first();
      await btn.waitFor({ state: 'visible', timeout: 45000 });

      const isDisabled = await btn.isDisabled();
      const btnTextRaw = await btn.locator('span').textContent().catch(() => '');
      const btnText = btnTextRaw.trim();
      debug(`[extend] Buton gasit: disabled=${isDisabled}, text="${btnText}"`);

      if (isDisabled) {
        return { ok: false, error: `Extindere indisponibila: ${btnText || 'cooldown'}` };
      }

      const isAdBased =
        btnText.toLowerCase().includes('watch ad') || btnText.toLowerCase().includes(' ad');
      debug(`[extend] Tip buton: ${isAdBased ? 'AD-BASED' : 'TURNSTILE'}`);

      // Calea A: click gratuit (zero cost, dar de obicei esueaza headless)
      if (!isAdBased) {
        const freeResult = await tryFreeTurnstileExtend(page, beforeSeconds);
        if (freeResult) return freeResult;
      } else {
        debug(`[extend] Buton ad-based — sarim peste calea A, incercam direct $wire.extend`);
      }

      // Calea B: solver + apel direct $wire.extend(token)
      const solverResult = await trySolverExtend(page, beforeSeconds, minutes);
      if (solverResult) return solverResult;

      // Inchidem orice modal ramas si raportam esecul cu detalii
      await page.evaluate(() => {
        if (typeof g4fCloseTurnstile === 'function') g4fCloseTurnstile();
      }).catch(() => {});

      await saveScreenshot(page, 'extend-failed');
      await dumpPageDebug(page, 'extend-failed');

      const currentText = await page.locator('.time span').first()
        .textContent({ timeout: 5000 }).catch(() => null);
      const currentSeconds = parseHms(currentText);

      const solverHint = CAPTCHA_API_KEY
        ? `Solverul (${CAPTCHA_PROVIDER}) a rulat, dar token-ul a fost respins sau nu a ajuns — verifica cheia API, soldul si sitekey-ul.`
        : `Nu exista CAPTCHA_API_KEY — pentru bypass headless sigur, seteaza o cheie 2Captcha/CapSolver in Render (Environment).`;

      const errorMsg =
        `Extinderea nu a marit timpul. Inainte: ${beforeText?.trim()} (${beforeSeconds}s), ` +
        `Dupa: ${currentText?.trim() || 'necunoscut'} (${currentSeconds !== null ? currentSeconds : 'N/A'}s). ` +
        `Butonul era: "${btnText}". ` +
        `Timp ramas: ${currentSeconds !== null ? formatHms(currentSeconds) : 'necunoscut'}. ` +
        solverHint;

      debug(`[extend] ❌ ${errorMsg}`);

      return { ok: false, error: errorMsg };
    } catch (err) {
      console.error(`[extend] ❌ Exceptie: ${err.message}`);
      if (page) {
        await saveScreenshot(page, 'error');
        await dumpPageDebug(page, 'error');
        await closePersistent();
      }
      throw err;
    }
  });
}

// ── RENEW & UNSUSPEND (reactivare server suspendat, gratuit) ──
// Când timer-ul G4F ajunge la 0, serverul e SUSPENDED și pagina redirecționează
// la /suspended. Acolo e butonul "RENEW & UNSUSPEND" care resetează sesiunea
// la ~3h (fereastră de recuperare de 48h înainte de ștergere permanentă).
async function renewServer() {
  ensureSessionExists();

  return withLock(async () => {
    let page = null;
    try {
      page = await getPersistentPage();

      debug(`[renew] ── START RENEW & UNSUSPEND ──`);
      debug(`[renew] URL curent: ${page.url()}`);

      // Dacă nu suntem deja pe pagina /suspended, navigăm la ea direct
      // (pagina de consolă ar redirecționa singură, dar sigur e mai bine
      // să mergem explicit la URL-ul de suspendare).
      if (!page.url().includes('/suspended')) {
        const base = process.env.SERVER_CONSOLE_URL || '';
        // /server/<id>/console -> /server/<id>/suspended
        const suspendedUrl = base.replace(/\/console\/?$/, '/suspended');
        debug(`[renew] Navighez la ${suspendedUrl}`);
        await page.goto(suspendedUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      }

      if (page.url().includes('accounts.google.com') || page.url().includes('/login')) {
        throw new Error('Sesiunea a expirat.');
      }

      if (!page.url().includes('/suspended')) {
        debug(`[renew] Serverul NU e suspendat (URL: ${page.url()}) — nu e nimic de facut.`);
        return { ok: true, suspended: false, message: 'Serverul nu e suspendat.' };
      }

      // Butonul "RENEW & UNSUSPEND" — open e via wire:click mountAction('renew_unsuspend')
      debug(`[renew] Server SUSPENDED — caut butonul RENEW & UNSUSPEND...`);
      const renewBtn = page.locator('button[wire\\:click*="renew_unsuspend"]').first();
      await renewBtn.waitFor({ state: 'visible', timeout: 30000 });
      debug(`[renew] Buton RENEW & UNSUSPEND gasit — click.`);
      await renewBtn.click();

      // Modal-ul de confirmare: buton "Unsuspend Now" (Filament, type=submit).
      // Poate să apară cu întârziere.
      const confirmBtn = page.locator(
        'button[type="submit"][wire\\:target="callMountedAction"], button:has-text("Unsuspend Now")'
      ).first();
      await confirmBtn.waitFor({ state: 'visible', timeout: 30000 });
      debug(`[renew] Modal confirmare gasit — click Unsuspend Now.`);
      await confirmBtn.click();

      // După confirmare, serverul trece prin /warmup (~2-3 min) și apoi
      // ajunge înapoi pe /console cu timer-ul resetat la ~3h.
      debug(`[renew] Confirmat. Aștept warmup (poate dura până la 3-4 min)...`);
      const warmupStart = Date.now();
      const WARMUP_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
      let finalUrl = page.url();

      while (Date.now() - warmupStart < WARMUP_TIMEOUT_MS) {
        await page.waitForTimeout(5000);
        const currentUrl = page.url();
        if (!currentUrl.includes('/suspended') && !currentUrl.includes('/warmup')) {
          finalUrl = currentUrl;
          debug(`[renew] Am ieșit din warmup — URL: ${finalUrl}`);
          break;
        }
      }

      // Un reload final ca să citim timer-ul resetat (dacă pagina e consola).
      if (finalUrl.includes('/console')) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        finalUrl = page.url();
      }

      debug(`[renew] ✅ Renew finalizat — URL: ${finalUrl}`);
      return {
        ok: true,
        suspended: true,
        message: 'RENEW & UNSUSPEND finalizat — serverul e din nou activ.',
        finalUrl,
      };
    } catch (err) {
      console.error(`[renew] ❌ Exceptie: ${err.message}`);
      if (page) {
        await saveScreenshot(page, 'renew-failed');
        await dumpPageDebug(page, 'renew-failed');
        await closePersistent();
      }
      return { ok: false, suspended: true, error: err.message };
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
  const suspended = await detectSuspended(page);
  if (suspended) return suspended;

  await page.locator('.time span').first().waitFor({ state: 'visible', timeout: 45000 });

  const timeText = await page.locator('.time span').first().textContent({ timeout: 45000 });
  const remainingSeconds = parseHms(timeText);

  const rawOnline = await page
    .locator('.status-pill')
    .first()
    .textContent({ timeout: 15000 })
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

// ── Detectare server SUSPENDED ──
// Când timer-ul G4F ajunge la 0, serverul e suspendat și pagina e
// redirecționată la .../suspended (în loc de /console). Le detectăm aici
// ca status să raporteze clar starea, iar auto-extend-ul să reacționeze.
function detectSuspended(page) {
  const url = page.url();
  if (url.includes('/suspended')) {
    return Promise.resolve({
      ok: true,
      suspended: true,
      remainingSeconds: 0,
      remainingLabel: 'SUSPENDED',
      online: false,
      resources: null,
      checkedAt: new Date().toISOString(),
    });
  }
  return Promise.resolve(null);
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

        const suspended = await detectSuspended(page);
        if (suspended) {
          lastFullSyncAt = Date.now();
          return suspended;
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

          const suspended = await detectSuspended(page);
          if (suspended) {
            lastFullSyncAt = Date.now();
            return suspended;
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

function formatHms(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function saveScreenshot(page, label) {
  try {
    const path = require('path');
    const filename = path.join(__dirname, '..', `debug-${label}-${Date.now()}.png`);
    await page.screenshot({ path: filename, fullPage: true });
    console.log(`[debug] Screenshot salvat: ${filename}`);
  } catch (err) {
    console.error(`[debug] Nu am putut salva screenshot-ul [${label}]:`, err.message);
  }
}

async function dumpPageDebug(page, label) {
  try {
    const url = page.url();
    const title = await page.title().catch(() => '(fara titlu)');
    const html = await page.content().catch(() => '');
    console.error(`── DEBUG [${label}] ──`);
    console.error('URL:', url);
    console.error('Titlu:', title);
    console.error('HTML (primele 2000 caractere):', html.slice(0, 2000));
    console.error('── END DEBUG ──');
  } catch (err) {
    console.error(`[debug] Nu am putut colecta debug info [${label}]:`, err.message);
  }
}

module.exports = { runAction, getStatus, extendServer, renewServer, getPersistentPage, holdBrowser, releaseHold };