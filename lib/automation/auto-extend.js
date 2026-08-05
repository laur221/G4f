/**
 * Auto Extend Server - Automatizează butonul "+90 min" pe G4F dashboard
 *
 * Rulează ca background service în server.js — verifică periodic
 * dacă serverul este online și timpul rămas e sub target-ul configurat,
 * apoi apelează extendServer() pentru extindere automată.
 *
 * Configurare (variabile de mediu sau valori implicite):
 *   AUTO_EXTEND_TARGET_SECONDS  - target de timp (default: 12h = 43200s)
 *   AUTO_EXTEND_BACKUP_SECONDS  - backup extend când scade sub (default: 2h = 7200s)
 *   AUTO_EXTEND_CHECK_INTERVAL  - interval verificare (default: 5 min = 300000ms)
 *   AUTO_EXTEND_COOLDOWN        - cooldown între extinderi (default: 10 min = 600000ms)
 *
 * Mod test (pentru testare fără a aștepta timer-ul real):
 *   AUTO_EXTEND_TEST_MODE       - activează modul test (default: false)
 *   AUTO_EXTEND_TEST_REMAINING  - timp rămas simulat în secunde (default: 0 = dezactivat)
 */

const { extendServer, renewServer } = require('../browser');
const { getCachedStatus, invalidate } = require('../status');

// ── Configurare (din mediu, modificabil la runtime) ──
let TARGET_SECONDS = parseInt(
  process.env.AUTO_EXTEND_TARGET_SECONDS || '43200', 10
);
let BACKUP_SECONDS = parseInt(
  process.env.AUTO_EXTEND_BACKUP_SECONDS || '7200', 10
);
const CHECK_INTERVAL_MS = parseInt(
  process.env.AUTO_EXTEND_CHECK_INTERVAL || '300000', 10
);
const COOLDOWN_AFTER_EXTEND_MS = parseInt(
  process.env.AUTO_EXTEND_COOLDOWN || '600000', 10
);

// ── Mod test ──
let testMode = process.env.AUTO_EXTEND_TEST_MODE === 'true';
let testRemainingSeconds = parseInt(
  process.env.AUTO_EXTEND_TEST_REMAINING || '0', 10
);

// ── Stare ──
let lastExtendAt = 0;
let isRunning = false;
let intervalId = null;
let consecutiveExtends = 0;

/**
 * Verifică dacă putem extinde (nu e în cooldown)
 */
function canExtend() {
  return Date.now() - lastExtendAt > COOLDOWN_AFTER_EXTEND_MS;
}

/**
 * O singură verificare + extindere automată dacă e nevoie
 */
async function checkAndExtend() {
  if (!canExtend()) {
    const remaining = Math.max(0, COOLDOWN_AFTER_EXTEND_MS - (Date.now() - lastExtendAt));
    console.log(`[auto-extend] ⏳ Cooldown activ — mai așteptăm ${Math.ceil(remaining / 1000)}s`);
    return;
  }

  try {
    const status = await getCachedStatus();

    if (!status.ok) {
      console.log('[auto-extend] Status check eșuat, ignorăm.');
      return;
    }

    // Server SUSPENDED (timer a ajuns la 0) — reactivare gratuită.
    // Fereastra de recuperare e de 48h înainte de ștergere permanentă.
    if (status.suspended) {
      console.log('[auto-extend] 🚨 Server SUSPENDED — reactivare automata (RENEW & UNSUSPEND)...');
      const result = await renewServer();
      lastExtendAt = Date.now();
      if (result.ok && result.suspended) {
        console.log(`[auto-extend] ✅ Renew reușit: ${result.message}`);
        invalidate();
      } else {
        console.log(`[auto-extend] ❌ Renew eșuat: ${result.error || result.message || 'necunoscut'}`);
      }
      return;
    }

    // NOTĂ: timer-ul G4F scade și când serverul Palworld e OFFLINE (e pe
    // sesiunea contului, nu pe server). Deci extindem în ambele cazuri, ca
    // timpul să nu ajungă la 0 când serverul stă oprit.
    if (typeof status.remainingSeconds !== 'number') {
      console.log('[auto-extend] Nu avem date despre timp, ignorăm.');
      return;
    }

    // În modul test, folosim timpul simulat în loc de cel real
    const remaining = testMode && testRemainingSeconds > 0
      ? testRemainingSeconds
      : status.remainingSeconds;

    const targetReached = remaining >= TARGET_SECONDS;
    const backupTriggered = remaining < BACKUP_SECONDS;

    if (targetReached) {
      console.log(
        `[auto-extend] ✅ Target atins (${formatH(remaining)} ≥ ${formatH(TARGET_SECONDS)}).`
      );
      consecutiveExtends = 0;
      return;
    }

    if (backupTriggered) {
      console.log(
        `[auto-extend] 🚨 BACKUP! Timp critic: ${formatH(remaining)} (< ${formatH(BACKUP_SECONDS)}). Extindere urgentă!`
      );
    } else {
      console.log(
        `[auto-extend] ⏰ Timp sub target: ${formatH(remaining)} / ${formatH(TARGET_SECONDS)} target. Extindere...`
      );
    }

    const result = await extendServer();
    lastExtendAt = Date.now();

    if (result.ok) {
      consecutiveExtends++;
      const addedMin = result.addedMinutes || 90;
      const newRemaining = result.remainingSeconds;
      console.log(
        `[auto-extend] ✅ Extindere #${consecutiveExtends} reușită! +${addedMin} min. ` +
        `Rămâne: ${newRemaining !== null ? formatH(newRemaining) : 'necunoscut'}`
      );
      invalidate();

      // Dacă target-ul e prea mic și 90 min nu ajunge, facem extend suplimentar
      if (
        newRemaining !== null &&
        newRemaining < TARGET_SECONDS &&
        newRemaining < BACKUP_SECONDS &&
        consecutiveExtends < 5
      ) {
        console.log(`[auto-extend] 🔄 Timpul e încă sub backup după extindere — extindere suplimentară...`);
        await new Promise(r => setTimeout(r, 10000));
        const result2 = await extendServer();
        lastExtendAt = Date.now();
        if (result2.ok) {
          consecutiveExtends++;
          console.log(
            `[auto-extend] ✅ Extindere suplimentară #${consecutiveExtends} reușită! ` +
            `+${result2.addedMinutes || 90} min. Rămâne: ${result2.remainingSeconds !== null ? formatH(result2.remainingSeconds) : 'necunoscut'}`
          );
          invalidate();
        } else {
          console.log(`[auto-extend] ❌ Extindere suplimentară eșuată: ${result2.error || 'necunoscută'}`);
        }
      }
    } else {
      console.log(`[auto-extend] ❌ Extindere eșuată: ${result.error || 'necunoscută'}`);
    }
  } catch (err) {
    console.error('[auto-extend] Eroare:', err.message);
  }
}

function formatH(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m (${seconds}s)`;
}

/**
 * Porneste background service-ul de auto-extindere
 */
function startAutoExtend() {
  if (isRunning) {
    console.log('[auto-extend] deja rulează.');
    return;
  }

  isRunning = true;
  console.log(`[auto-extend] ▶️  Pornit`);
  console.log(`[auto-extend]   Target: ${formatH(TARGET_SECONDS)}`);
  console.log(`[auto-extend]   Backup: ${formatH(BACKUP_SECONDS)}`);
  console.log(`[auto-extend]   Interval: ${CHECK_INTERVAL_MS / 1000 / 60} min`);
  console.log(`[auto-extend]   Cooldown: ${COOLDOWN_AFTER_EXTEND_MS / 1000 / 60} min`);
  if (testMode) {
    console.log(`[auto-extend] 🧪 Mod test ACTIV — timp simulat: ${formatH(testRemainingSeconds)}`);
  }

  checkAndExtend();
  intervalId = setInterval(checkAndExtend, CHECK_INTERVAL_MS);
}

/**
 * Oprește background service-ul
 */
function stopAutoExtend() {
  if (!isRunning) return;

  isRunning = false;
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  console.log('[auto-extend] ⏹️  Oprit.');
}

/**
 * Actualizează targetul la runtime
 */
function setTarget(seconds) {
  TARGET_SECONDS = parseInt(seconds, 10);
  console.log(`[auto-extend] 🎯 Target schimbat la ${formatH(TARGET_SECONDS)}`);
}

/**
 * Actualizează backup-ul la runtime
 */
function setBackup(seconds) {
  BACKUP_SECONDS = parseInt(seconds, 10);
  console.log(`[auto-extend] 🛡️ Backup schimbat la ${formatH(BACKUP_SECONDS)}`);
}

/**
 * Activează/dezactivează modul test
 */
function setTestMode(enabled, simulatedRemainingSeconds = 0) {
  testMode = enabled;
  testRemainingSeconds = parseInt(simulatedRemainingSeconds, 10);
  console.log(
    `[auto-extend] 🧪 Mod test ${enabled ? 'ACTIV' : 'dezactivat'}${enabled ? ` — timp simulat: ${formatH(testRemainingSeconds)}` : ''}`
  );
}

/**
 * Setează timpul rămas simulat (doar în modul test)
 */
function setTestRemaining(seconds) {
  testRemainingSeconds = parseInt(seconds, 10);
  console.log(`[auto-extend] 🧪 Timp simulat schimbat la ${formatH(testRemainingSeconds)}`);
}

module.exports = {
  startAutoExtend,
  stopAutoExtend,
  isRunning: () => isRunning,
  setTarget,
  setBackup,
  setTestMode,
  setTestRemaining,
  CONFIG: {
    get targetSeconds() { return TARGET_SECONDS; },
    get backupSeconds() { return BACKUP_SECONDS; },
    get checkIntervalMs() { return CHECK_INTERVAL_MS; },
    get cooldownMs() { return COOLDOWN_AFTER_EXTEND_MS; },
    get testMode() { return testMode; },
    get testRemainingSeconds() { return testRemainingSeconds; },
  },
};
