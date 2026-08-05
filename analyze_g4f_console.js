// Analiza pasiva a consolei G4F: implementare Turnstile + endpoint buton +90 min.
// Nu apasa nimic — doar citeste DOM si intercepteaza cererile.
const { chromium } = require('playwright');
const path = require('path');

const CONSOLE_URL = process.env.SERVER_CONSOLE_URL || 'https://control.gaming4free.net/server/48709f0f/console';
const STATE_PATH = path.join(__dirname, 'storageState.json');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: 'chromium',
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ storageState: STATE_PATH });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  const requests = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/livewire|extend|turnstile|api|server/i.test(u)) {
      requests.push({ method: r.method(), url: u, postData: (r.postData() || '').slice(0, 300) });
    }
  });

  await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(6000);

  console.log('=== URL final:', page.url());
  console.log('=== Titlu:', await page.title().catch(() => '(fara titlu)'));

  // 1. Scriptul inline cu turnstile.render
  const tsScript = await page.evaluate(() => {
    const scripts = [...document.scripts];
    const s = scripts.filter((x) => (x.textContent || '').includes('turnstile'));
    return s.map((x) => (x.textContent || '').slice(0, 2000));
  });
  console.log('\n=== Scripturi cu "turnstile" (', tsScript.length, '):');
  tsScript.forEach((t, i) => console.log(`--- script #${i} ---\n${t}`));

  // 2. Elemente Turnstile in DOM
  const tsDom = await page.evaluate(() => {
    const w = document.querySelector('#g4f-ts-widget');
    const inp = document.querySelector('input[name="cf-turnstile-response"]');
    return {
      widgetExists: !!w,
      widgetHTML: w ? w.outerHTML.slice(0, 500) : null,
      hiddenInput: inp ? inp.outerHTML.slice(0, 300) : null,
      windowKeys: Object.keys(window).filter((k) => /g4f|turnstile|ts/i.test(k)).slice(0, 40),
      widgetId: window._g4fTsWidgetId !== undefined ? window._g4fTsWidgetId : 'undefined',
      hasCallback: typeof window._g4fTsCallback === 'function',
    };
  });
  console.log('\n=== DOM Turnstile:', JSON.stringify(tsDom, null, 2));

  // 3. Scripturile externe turnstile
  const tsSrcs = await page.evaluate(() => [...document.scripts].map((s) => s.src).filter((s) => /turnstile|challenges\.cloudflare/i.test(s)));
  console.log('\n=== Src-uri externe Turnstile:', tsSrcs);

  // 4. Butonul +90 min
  const btnInfo = await page.evaluate(() => {
    const b = document.querySelector('.rt-btn-free');
    if (!b) return { found: false };
    return {
      found: true,
      text: b.textContent.trim().slice(0, 120),
      html: b.outerHTML.slice(0, 600),
      disabled: b.disabled === true || b.classList.contains('disabled') || b.getAttribute('aria-disabled') === 'true',
    };
  });
  console.log('\n=== Buton .rt-btn-free:', JSON.stringify(btnInfo, null, 2));

  // 5. Timp ramas
  const time = await page.evaluate(() => {
    const t = document.querySelector('.time span');
    return t ? t.textContent.trim() : null;
  });
  console.log('\n=== Timp ramas:', time);

  // 6. Cereri de retea observate
  console.log('\n=== Cereri de retea (extend/turnstile/api/livewire):');
  requests.slice(0, 40).forEach((r, i) => console.log(`[${i}] ${r.method} ${r.url}\n    body: ${r.postData || ''}`));

  await browser.close();
})().catch((e) => { console.error('EROARE:', e.message); process.exit(1); });
