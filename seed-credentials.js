// Ruleaza o singura data (local sau pe Render prin shell) ca sa setezi
// user + parola pe care le vei da prietenului tau.
//
// Rulare:  node seed-credentials.js nume_utilizator parola_aleasa

require('dotenv').config();
const { setCredentials } = require('./lib/auth');

const [, , username, password] = process.argv;

if (!username || !password) {
  console.error('Foloseste: node seed-credentials.js <username> <parola>');
  process.exit(1);
}

setCredentials(username, password)
  .then(() => {
    console.log(`✓ Credentiale salvate pentru utilizatorul "${username}".`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('Eroare la salvare:', err);
    process.exit(1);
  });
