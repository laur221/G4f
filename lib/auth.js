const bcrypt = require('bcryptjs');
const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const USER_KEY = 'g4f-relay:friend:username';
const HASH_KEY = 'g4f-relay:friend:password_hash';

async function verifyCredentials(username, password) {
  const [storedUser, storedHash] = await Promise.all([
    redis.get(USER_KEY),
    redis.get(HASH_KEY),
  ]);

  if (!storedUser || !storedHash) return false;
  if (username !== storedUser) return false;

  return bcrypt.compare(password, storedHash);
}

// Foloseste asta o singura data (vezi seed-credentials.js) ca sa setezi
// user/parola prietenului tau in Upstash.
async function setCredentials(username, plainPassword) {
  const hash = await bcrypt.hash(plainPassword, 10);
  await redis.set(USER_KEY, username);
  await redis.set(HASH_KEY, hash);
}

module.exports = { verifyCredentials, setCredentials };
