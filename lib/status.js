const { getStatus } = require('./browser');

const CACHE_TTL_MS = 7000; // 7 secunde — cat mai aproape de live, fara sa exageram cu resursele
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

// Invalidam cache-ul dupa orice actiune (start/stop/restart/extend)
// ca urmatoarea verificare sa reflecte imediat schimbarea.
function invalidate() {
  cached = null;
  cachedAt = 0;
}

module.exports = { getCachedStatus, invalidate, WARNING_THRESHOLD_SECONDS };
