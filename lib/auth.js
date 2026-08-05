const bcrypt = require('bcryptjs');
const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ── Conturi hardcodate (admin + prietenul Nicu) ──
// Hash-uri bcrypt generate cu node -e "bcrypt.hash('parola', 10)".
// Variabilele de mediu pot suprascrie (util in dev / pentru schimbarea parolei
// fara redeploy):  AUTH_ADMIN_USER / AUTH_ADMIN_HASH / AUTH_NICU_USER / AUTH_NICU_HASH
const ACCOUNTS = {
  admin: {
    username: process.env.AUTH_ADMIN_USER || 'fr4me',
    passwordHash: process.env.AUTH_ADMIN_HASH || '$2a$10$1MfablaL1.yn1xx85E1zR.o.aovt2HOiDzDimhSvw7/JgrFZxS9R.',
    role: 'admin',
  },
  nicu: {
    username: process.env.AUTH_NICU_USER || 'nicu_23',
    passwordHash: process.env.AUTH_NICU_HASH || '$2a$10$H4s9iVVuHZY.b61NSDn/e.ue36NZIDdPsTTPvYWNWg/iV9qqhBpYm',
    role: 'nicu',
  },
};

// Suport inapoi: daca se foloseste inca vechea cheie din Upstash
// (g4f-relay:friend:username / password_hash), o consultam ca al treilea
// cont "friend" cu rolul nicu. Nu aruncam eroare daca Redis nu e configurat.
const USER_KEY = 'g4f-relay:friend:username';
const HASH_KEY = 'g4f-relay:friend:password_hash';

async function verifyCredentials(username, password) {
  for (const acc of Object.values(ACCOUNTS)) {
    if (username === acc.username) {
      const ok = await bcrypt.compare(password, acc.passwordHash);
      if (ok) return { ok: true, role: acc.role, username: acc.username };
      return { ok: false, role: null };
    }
  }

  // Fallback la vechea cheie Upstash (daca exista si nu se potriveste cu un cont hardcodat)
  try {
    const [storedUser, storedHash] = await Promise.all([
      redis.get(USER_KEY),
      redis.get(HASH_KEY),
    ]);
    if (storedUser && storedHash && username === storedUser) {
      const ok = await bcrypt.compare(password, storedHash);
      if (ok) return { ok: true, role: 'nicu', username: storedUser };
    }
  } catch (err) {
    // Redis indisponibil — ignoram, folosim doar conturile hardcodate.
  }

  return { ok: false, role: null };
}

// Foloseste asta o singura data (vezi seed-credentials.js) ca sa setezi
// user/parola prietenului tau in Upstash.
async function setCredentials(username, plainPassword) {
  const hash = await bcrypt.hash(plainPassword, 10);
  await redis.set(USER_KEY, username);
  await redis.set(HASH_KEY, hash);
}

module.exports = { verifyCredentials, setCredentials };
