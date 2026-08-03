const { getStatus } = require('./browser');

const CACHE_TTL_MS = 4 * 60 * 1000; // 4 minute — evita sa deschidem Chromium la fiecare refresh
const WARNING_THRESHOLD_SECONDS = 30 * 60; // sub 30 min ramase => avertizare pe dashboard

let cached = null;
let cachedAt = 0;
let pending = null;

async function getCachedStatus() {
  const now = Date.now();

  if (cached && now - cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  // Daca deja e o verificare in curs, asteptam rezultatul ei in loc sa pornim alta.
  if (pending) return pending;

  pending = getStatus()
    .then((result) => {
      cached = {
        ...result,
        warning: typeof result.remainingSeconds === 'number'
          ? result.remainingSeconds < WARNING_THRESHOLD_SECONDS
          : false,
      };
      cachedAt = Date.now();
      return cached;
    })
    .catch((err) => {
      console.error('Eroare la getStatus():', err.message);
      cached = { ok: false, error: err.message, checkedAt: new Date().toISOString() };
      cachedAt = Date.now();
      return cached;
    })
    .finally(() => {
      pending = null;
    });

  return pending;
}

// Invalidam cache-ul dupa orice actiune (start/stop/restart) ca urmatoarea
// verificare de status sa reflecte imediat schimbarea, nu valoarea veche.
function invalidate() {
  cached = null;
  cachedAt = 0;
}

module.exports = { getCachedStatus, invalidate, WARNING_THRESHOLD_SECONDS };
