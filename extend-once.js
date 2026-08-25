// extend-once.js — ruleaza UN ciclu de extindere (pentru GitHub Actions cron)
const fs = require('fs');
const path = require('path');

// Reconstruieste storageState.json din secretul STORAGE_STATE_B64
// (suporta gzip: magic bytes 1f 8b — secretul GitHub are limita de 48KB)
const STATE_PATH = path.join(__dirname, 'storageState.json');
if (process.env.STORAGE_STATE_B64) {
  const buf = Buffer.from(process.env.STORAGE_STATE_B64, 'base64');
  let data;
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    data = require('zlib').gunzipSync(buf);
    console.log('[init] storageState decomprimat din gzip.');
  } else {
    data = buf;
    console.log('[init] storageState plain base64.');
  }
  fs.writeFileSync(STATE_PATH, data);
} else {
  console.error('[init] Lipseste STORAGE_STATE_B64!');
  process.exit(1);
}

const { extendServer, runAction, renewServer, getStatus } = require('./lib/browser');

(async () => {
  const ACTION = (process.env.GH_ACTION || 'extend').toLowerCase();
  console.log(`[run] Actiune: ${ACTION}`);

  try {
    if (ACTION === 'extend') {
      const minutes = parseInt(process.env.EXTEND_MINUTES || '90', 10);
      console.log(`[run] Extindere (${minutes} min per reclama, pana la ${process.env.WEB_AD_MAX || 15} reclame)...`);
      const result = await extendServer(minutes);
      console.log('[result]', JSON.stringify(result, null, 2));
      if (!result.ok) {
        console.error('[!] Extinderea nu a reusit complet.');
        process.exitCode = 1;
      } else {
        console.log(`[OK] Timer acum: ${result.remainingLabel} (+${result.addedMinutes} min, ${result.adsUsed || '?'} reclame)`);
      }
    } else if (ACTION === 'renew') {
      const result = await renewServer();
      console.log('[result]', JSON.stringify(result, null, 2));
    } else if (ACTION === 'status') {
      const { getStatus } = require('./lib/browser');
      const result = await getStatus();
      console.log('[result]', JSON.stringify(result, null, 2));
    } else if (['start', 'stop', 'restart'].includes(ACTION)) {
      const result = await runAction(ACTION);
      console.log('[result]', JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    } else {
      console.error(`[!] Actiune necunoscuta: ${ACTION}`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('[ERR]', err.message);
    process.exitCode = 1;
  }
})();
