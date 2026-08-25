#!/bin/bash
# deploy-oracle.sh — Deploy automat g4f-relay pe Oracle Cloud Free Tier (ARM)
# Rulează pe VM-ul nou creat:  bash deploy-oracle.sh

set -euo pipefail

# Configurare
REPO_URL="https://github.com/laur221/G4f.git"
APP_DIR="/opt/g4f-relay"
SERVICE_NAME="g4f-relay"
PORT=3000

echo "=== Deploy g4f-relay pe Oracle Cloud Free Tier ==="
echo "VM: $(uname -m) | RAM: $(free -h | awk '/^Mem:/ {print $2}')"
echo

# 1. Actualizează sistemul și instalează dependențe
echo ">>> Instalez dependențe de sistem..."
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  docker.io docker-compose-v2 git \
  chromium chromium-driver xvfb \
  fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
  libcups2 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libxcomposite1 \
  libxdamage1 libxfixes3 libxkbcommon0 libxrandr2 libu2f-udev libxss1 \
  libappindicator3-1 lsb-release wget curl gnupg2

# Symlink-uri pentru SeleniumBase/Playwright
sudo ln -sf /usr/bin/chromium /usr/bin/google-chrome 2>/dev/null || true
sudo ln -sf /usr/bin/chromium /usr/bin/chrome 2>/dev/null || true

# 2. Docker Compose v2 (plugin)
sudo systemctl enable --now docker
sudo usermod -aG docker $USER

# 3. Clonează repo-ul
echo ">>> Clonez repo-ul..."
sudo rm -rf "$APP_DIR"
sudo git clone "$REPO_URL" "$APP_DIR"
sudo chown -R $USER:$USER "$APP_DIR"
cd "$APP_DIR"

# 4. Creează .env template (trebuie completat manual după deploy)
echo ">>> Creez .env template..."
cat > .env << 'ENVEOF'
# ==========================================
# g4f-relay — Variabile de mediu (COMPLETEAZĂ!)
# ==========================================

# 1. Session Google (din `npm run capture-session` local)
#    base64 -w0 storageState.json
STORAGE_STATE_B64=REPLACE_ME

# 2. Google Drive backup (rclone.conf cu credențialele Google)
#    base64 -w0 rclone.conf
RCLONE_CONF_B64=REPLACE_ME

# 3. CAPTCHA solver (2Captcha sau CapSolver)
CAPTCHA_API_KEY=REPLACE_ME
CAPTCHA_PROVIDER=2captcha

# 4. Secret pentru cookie-session (generează: openssl rand -hex 32)
SESSION_SECRET=REPLACE_ME

# 5. URL consola Gaming4Free (înlocuiește <ID_TAU>)
SERVER_CONSOLE_URL=https://gaming4free.com/server/<ID_TAU>/console

# 6. URL public al VM-ului (pentru self-ping și webhook-uri)
PUBLIC_URL=http://<IP_PUBLIC_VM>:3000

# 7. Auto-extend activat
AUTO_EXTEND_ENABLED=true

# 8. Backup la Google Drive (minute, 0=oprit)
BACKUP_INTERVAL_MINUTES=180

PORT=3000
ENVEOF

echo ">>> Fișier .env creat. TREBUIE SĂ COMPLETEZI VALORILE (vezi mai jos)."

# 5. Docker Compose
cat > docker-compose.yml << 'COMPOSEEOF'
version: '3.8'
services:
  app:
    build: .
    container_name: g4f-relay
    restart: unless-stopped
    environment:
      - STORAGE_STATE_B64=${STORAGE_STATE_B64}
      - RCLONE_CONF_B64=${RCLONE_CONF_B64}
      - CAPTCHA_API_KEY=${CAPTCHA_API_KEY}
      - CAPTCHA_PROVIDER=${CAPTCHA_PROVIDER}
      - SESSION_SECRET=${SESSION_SECRET}
      - SERVER_CONSOLE_URL=${SERVER_CONSOLE_URL}
      - PUBLIC_URL=${PUBLIC_URL}
      - AUTO_EXTEND_ENABLED=${AUTO_EXTEND_ENABLED}
      - BACKUP_INTERVAL_MINUTES=${BACKUP_INTERVAL_MINUTES}
      - PORT=${PORT}
    volumes:
      - ./storageState.json:/app/storageState.json
      - ./rclone.conf:/app/rclone.conf
    ports:
      - "3000:3000"
    shm_size: 2g
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
COMPOSEEOF

# 6. Dockerfile optimizat pentru ARM (dacă nu există sau e vechi)
cat > Dockerfile << 'DOCKEREOF'
FROM node:20-slim

WORKDIR /app

# Instalează Chromium + dependențe pentru Playwright
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    chromium-driver \
    xvfb \
    fonts-liberation \
    libasound2 libatk-bridge2.0-0 libatk1.0.0 libcups2 \
    libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
    libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 \
    libxrandr2 libxss1 libappindicator3-1 lsb-release \
    && rm -rf /var/lib/apt/lists/*

# Symlink pentru Playwright/SeleniumBase
RUN ln -sf /usr/bin/chromium /usr/bin/google-chrome \
    && ln -sf /usr/bin/chromium /usr/bin/chrome

# Copiază package.json și instalează deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copiază codul aplicației
COPY . .

# Variabile de mediu pentru Chromium
ENV CHROME_BIN=/usr/bin/chromium
ENV CHROMIUM_BIN=/usr/bin/chromium
ENV CHROMEDRIVER_PATH=/usr/bin/chromedriver
ENV DISPLAY=:99

EXPOSE 3000

CMD ["node", "server.js"]
DOCKEREOF

# 7. .dockerignore
cat > .dockerignore << 'DOCKERIGNOREEOF'
node_modules
.git
.gitignore
.env
.env.example
*.log
*.png
debug-*.png
storageState.json
rclone.conf
*.md
.vscode
.backups
__pycache__
*.py
*.sh
docker-compose.yml
Dockerfile
DOCKERIGNOREEOF

# 8. Firewall (ufw + Oracle Security List hint)
echo ">>> Configurez firewall..."
sudo ufw --force enable
sudo ufw allow 22/tcp
sudo ufw allow 3000/tcp

# 9. Systemd service pentru auto-start la reboot
sudo tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null << SVC
[Unit]
Description=g4f-relay Docker Container
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
SVC

sudo systemctl daemon-reload
sudo systemctl enable ${SERVICE_NAME}

# 10. Construiește și pornește
echo ">>> Construiesc imaginea Docker (poate dura 3-5 min pe ARM)..."
docker compose build

echo ">>> Pornez containerul..."
docker compose up -d

# 11. Verificare
sleep 5
echo
echo "=== Status container ==="
docker compose ps
echo
echo "=== Log-uri recente ==="
docker logs --tail 30 g4f-relay

# 11. Instrucțiuni finale
PUB_IP=$(curl -s ifconfig.me || curl -s ipinfo.io/ip || echo "<IP_PUBLIC_VM>")

cat << EOF

=== DEPLOY FINALIZAT ===

Containerul rulează pe port 3000.
Accesează: http://${PUB_IP}:3000

=== URMĂTORII PAȘI OBLIGATORII ===

1. Editează .env cu valorile reale:
   cd ${APP_DIR}
   nano .env

   Completează TOATE câmpurile marcate REPLACE_ME:
   - STORAGE_STATE_B64      (base64 -w0 storageState.json)
   - RCLONE_CONF_B64        (base64 -w0 rclone.conf)
   - CAPTCHA_API_KEY        (cheia 2Captcha/CapSolver)
   - SESSION_SECRET         (openssl rand -hex 32)
   - SERVER_CONSOLE_URL     (https://gaming4free.com/server/<ID_TAU>/console)
   - PUBLIC_URL             (http://${PUB_IP}:3000)

2. Repornește după editare:
   cd ${APP_DIR} && docker compose up -d --build

3. Verifică log-urile:
   docker logs -f g4f-relay

4. Testează health:
   curl http://${PUB_IP}:3000/health

=== COMENZI UTILE ===
- Log-uri live:     docker logs -f g4f-relay
- Restart:          docker compose restart
- Stop:             docker compose down
- Update cod:       cd ${APP_DIR} && git pull && docker compose up -d --build
- Status service:   systemctl status ${SERVICE_NAME}

=== FIREWALL ORACLE ===
În Oracle Console → Networking → Security Lists → Default Security List
→ Add Ingress Rules:
  - Source: 0.0.0.0/0 | IP Protocol: TCP | Destination Port Range: 3000
  - Source: 0.0.0.0/0 | IP Protocol: TCP | Destination Port Range: 22

=== NOTE ===
- ARM architecture: Chromium rulează nativ (nu emulare x86)
- Memorie: 24 GB RAM disponibile (Chromium folosește ~200-400MB)
- Self-ping la 4 min ține VM-ul activ (nu există sleep pe Oracle)
- Backup-uri Google Drive la fiecare 3h (dacă BACKUP_INTERVAL_MINUTES>0)

EOF

echo "Script completat. Urmează instrucțiunile de mai sus!"