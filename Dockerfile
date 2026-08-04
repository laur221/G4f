# Imagine Node "slim" (mult mai mica decat imaginea completa Playwright,
# care include si Firefox + WebKit — noi avem nevoie doar de Chromium).
FROM node:20-bookworm-slim

WORKDIR /app

# Dependinte de sistem minime necesare ca Chromium sa ruleze (fonturi,
# librarii grafice). Suntem root in Docker, deci nu avem problema cu sudo
# pe care am avut-o pe Render.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcups2 \
    libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
    libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 \
    libxrandr2 xdg-utils wget \
    && rm -rf /var/lib/apt/lists/*

# Copiem intai doar fisierele de dependinte, ca sa profitam de cache-ul
# Docker — daca nu s-au schimbat package.json/package-lock.json, pasii de
# mai jos (npm install + descarcarea Chromium) nu se repeta la fiecare build.
COPY package*.json ./
RUN npm install --omit=dev

# Descarcam DOAR Chromium (~150 MB), nu tot pachetul Playwright complet.
RUN npx playwright install chromium chromium-headless-shell

# rclone (client Google Drive) — binary static, de la releases oficiale.
RUN cd /tmp \
    && wget -q https://downloads.rclone.org/rclone-current-linux-amd64.zip \
    && apt-get install -y --no-install-recommends unzip \
    && unzip -q rclone-current-linux-amd64.zip \
    && cp rclone-*-linux-amd64/rclone /usr/local/bin/rclone \
    && chmod +x /usr/local/bin/rclone \
    && rclone version

# Acum copiem restul codului sursa.
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]