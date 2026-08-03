# G4F Relay — control server fără să dai contul Google

Un mic serviciu care ține sesiunea ta de Google logată la
`control.gaming4free.net` și expune prietenului tău doar 3 butoane
(Start / Stop / Restart) protejate cu un user + parolă simple, alese de tine.

Cum funcționează: serverul rulează un Chromium headless (Playwright)
care se comportă exact ca tine în browser — deschide consola, apasă
butonul cerut. Prietenul tău nu vede niciodată contul tău Google.

---

## 1. Instalare locală (pentru pasul de login)

```bash
git clone <acest folder ca repo> g4f-relay
cd g4f-relay
npm install
```

Prima instalare descarcă și Chromium pentru Playwright (poate dura 1-2 minute).

## 2. Salvează sesiunea ta de login (o singură dată, sau când expiră)

```bash
npm run capture-session
```

Se va deschide un Chrome vizibil. Loghează-te manual cu Google, la fel
ca de obicei, până ajungi pe dashboard sau pe consola serverului.
Apoi revino în terminal și apasă **Enter**. Se va crea fișierul
`storageState.json` — acesta conține sesiunea ta și **nu trebuie
distribuit nimănui**, e echivalent cu parola ta.

> Sesiunile Google expiră de obicei după câteva zile/săptămâni. Când
> vezi erori de tip "sesiunea a expirat" în logurile serverului,
> repeți acest pas și reîncarci fișierul pe Render.

## 3. Creează un cont Upstash Redis (gratuit)

1. Mergi pe [upstash.com](https://upstash.com) → creează un database Redis gratuit.
2. Din pagina database-ului, copiază **REST URL** și **REST TOKEN**.

## 4. Setează user/parola pentru prietenul tău

```bash
cp .env.example .env
# editează .env și pune SERVER_CONSOLE_URL, SESSION_SECRET, UPSTASH_*

node seed-credentials.js numele_prietenului parola_aleasa
```

## 5. Deploy pe Render

1. Urcă acest folder pe un repo GitHub (privat, ideal).
2. Pe [render.com](https://render.com) → **New → Web Service** → conectează repo-ul.
3. **Build command:** `npm install`
4. **Start command:** `npm start`
5. La **Environment**, adaugă aceleași variabile din `.env`
   (SERVER_CONSOLE_URL, SESSION_SECRET, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN,
   și `PUBLIC_URL` = link-ul pe care ți-l dă Render dupa primul deploy, ex. `https://g4f-relay.onrender.com`).
6. După primul deploy, **încarcă manual `storageState.json`** pe server —
   cel mai simplu: adaugă-l temporar în repo într-un branch privat,
   sau folosește Render Shell (din dashboard → Shell) ca să-l urci prin `cat > storageState.json`.

   ⚠️ Recomandare: NU pune `storageState.json` într-un repo public —
   conține cookie-urile sesiunii tale Google.

7. Dă link-ul Render (ex: `https://g4f-relay.onrender.com`) prietenului tău,
   împreună cu userul și parola setate la pasul 4.

## Structura proiectului

```
g4f-relay/
├── server.js              # Express: login, dashboard, rutele /api/action/*
├── capture-session.js      # Rulezi local ca sa salvezi sesiunea Google
├── seed-credentials.js     # Setezi user/parola prietenului in Upstash
├── lib/
│   ├── auth.js              # Verificare user/parola in Upstash
│   └── browser.js           # Playwright: deschide consola, apasa butonul
├── public/
│   ├── login.html
│   └── dashboard.html
└── .env.example
```

## Verificarea timpului ramas — ceas live, fara refresh

Dashboard-ul afișează timpul rămas și îl numără descrescător **local, în
browser, secundă cu secundă** — nu trebuie dat refresh la pagină. O dată
pe minut, pagina se resincronizează automat cu serverul (care citește
valoarea reală din panoul Gaming4Free), ca să corecteze orice mică
deriva a ceasului local și să actualizeze starea online/offline.

Când timpul rămas scade **sub 30 de minute**, apare un banner roșu
de avertizare pe dashboard, care vă reamintește să intrați manual pe
gaming4free.net și să apăsați "+90 min" (necesită rezolvarea unui
captcha — asta nu poate fi automatizat, e pus intenționat de site
pentru a preveni exact acest tip de bot).

> Notă: acest buton "+90 min" adaugă doar 90 de minute la timpul
> curent, nu la cap-ul de 48h — deci va trebui repetat periodic,
> de câte ori sesiunea se apropie de expirare.

## Login persistent pentru prietenul tau

Sesiunea de login e ținută minte 30 de zile într-un cookie — prietenul
tău introduce user/parola o singură dată și rămâne logat pe dashboard
fără să mai fie nevoie să reintroducă datele, atâta timp cât nu apasă
"Ieșire" și nu șterge cookie-urile browserului.

## Self-ping anti-sleep (Render, plan gratuit)

Planul gratuit Render adoarme serviciul după ~15 minute fără cereri
HTTP primite din exterior. Am adăugat o rută `/health` și, dacă setezi
variabila de mediu `PUBLIC_URL` (link-ul public al serviciului tău de
pe Render, ex. `https://g4f-relay.onrender.com`), serverul își face
singur o cerere la acea rută la fiecare 4 minute, ca să rămână treaz.

⚠️ De reținut: planul gratuit Render are o limită de ~750 ore/lună
folosite de toate serviciile tale gratuite combinate. Cu self-ping activ,
serviciul rămâne pornit non-stop — adică va consuma toate cele ~750h
lunar (echivalentul unei luni întregi) doar cu acest serviciu. Dacă ai
și alte proiecte gratuite pe Render, ai putea rămâne fără ore disponibile
pentru ele. Dacă asta devine o problemă, poți opri self-ping-ul (nu
setezi `PUBLIC_URL`) și accepți doar cele ~30s de "trezire" la prima
cerere după o pauză.

## Note importante

- **Rate/concurență:** `lib/browser.js` are un mutex simplu — dacă
  vin două cereri simultan, a doua așteaptă să termine prima, ca să
  nu deschidă două Chromium-uri deodată.
- **Securitate:** parola prietenului e stocată hash-uită (bcrypt) în
  Upstash, nu în clar. `storageState.json` e singurul fișier cu adevărat
  sensibil — păstrează-l doar pe server, niciodată în repo public.
- **Costuri Render:** planul gratuit "spin down"-uiește serviciul după
  inactivitate — prima cerere după o pauză poate dura ~30s să pornească.
  Dacă vrei mereu instant, ai nevoie de planul plătit (~$7/lună).
