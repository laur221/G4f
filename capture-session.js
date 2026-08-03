// Ruleaza acest script PE CALCULATORUL TAU (nu pe Render), o data,
// de fiecare data cand sesiunea expira. Deschide un Chrome vizibil
// in care te loghezi manual cu Google, apoi salveaza cookie-urile
// intr-un fisier storageState.json pe care il incarci pe server.
//
// Rulare:  npm run capture-session

const { chromium } = require('playwright');
const path = require('path');

const LOGIN_URL = 'https://control.gaming4free.net'; // ajusteaza daca link-ul de login e altul
const STATE_PATH = path.join(__dirname, 'storageState.json');

(async () => {
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome', // foloseste Chrome-ul REAL instalat pe calculator, nu Chromium-ul Playwright
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    viewport: null,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  await page.goto(LOGIN_URL);

  console.log('\n──────────────────────────────────────────────');
  console.log(' Logheaza-te manual cu contul tau Google in fereastra');
  console.log(' care s-a deschis. Dupa ce esti pe dashboard/consola,');
  console.log(' revino aici si apasa ENTER.');
  console.log('──────────────────────────────────────────────\n');

  process.stdin.resume();
  process.stdin.once('data', async () => {
    await context.storageState({ path: STATE_PATH });
    console.log(`\n✓ Sesiune salvata in: ${STATE_PATH}`);
    console.log('  Incarca acest fisier pe server (Render) si repornește serviciul.\n');
    await browser.close();
    process.exit(0);
  });
})();
