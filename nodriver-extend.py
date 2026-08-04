#!/usr/bin/env python3
"""
Serviciu de extindere "+90 min" bazat pe nodriver (bypass Cloudflare/Turnstile).

Diferenta fata de varianta Playwright (lib/browser.js):
  - nodriver nu seteaza flagul navigator.webdriver si are evaziune mai buna,
    deci Cloudflare Turnstile are mai multe sanse sa treaca fara interventie.
  - Ruleaza headless pe Render cu sandbox=False (Render ruleaza ca root).

Configurare (env):
  SERVER_CONSOLE_URL           - URL consola (default: cel din .env.example)
  STORAGE_STATE_B64            - base64(storageState.json) cu cookie-uri G4F
                                 (daca lipseste, citim storageState.json local)
  NODRIVER_HEADLESS            - "true"/"false" (default true)
  NODRIVER_BROWSER_PATH        - cale executabil Chromium (default auto)
  CHECK_INTERVAL_SEC           - interval intre verificari (default 300)
  TARGET_SECONDS / BACKUP_SECONDS - si aici ca la auto-extend.js
  ONESHOT                      - "true" = o singura extindere apoi iesire
"""

import asyncio
import base64
import json
import os
import sys
import tempfile
import time
from datetime import datetime

import nodriver as uc

CONSOLE_URL = os.environ.get(
    "SERVER_CONSOLE_URL",
    "https://control.gaming4free.net/server/48709f0f/console",
)
HEADLESS = os.environ.get("NODRIVER_HEADLESS", "true").lower() == "true"
NODRIVER_BROWSER_PATH = os.environ.get("NODRIVER_BROWSER_PATH") or None
CHECK_INTERVAL_SEC = int(os.environ.get("CHECK_INTERVAL_SEC", "300"))
TARGET_SECONDS = int(os.environ.get("TARGET_SECONDS", "43200"))
BACKUP_SECONDS = int(os.environ.get("BACKUP_SECONDS", "7200"))
ONESHOT = os.environ.get("ONESHOT", "false").lower() == "true"

PROFILE_DIR = tempfile.mkdtemp(prefix="uc-nodriver-")


def log(msg):
    print(f"[{datetime.now().isoformat()}] {msg}", flush=True)


def load_storage_state():
    """Returneaza lista de cookie-uri din storageState.json (playwright format)."""
    b64 = os.environ.get("STORAGE_STATE_B64", "")
    data = None
    if b64:
        data = json.loads(base64.b64decode(b64).decode("utf-8"))
        log("Cookie-uri incarcate din STORAGE_STATE_B64.")
    else:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "storageState.json")
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            log(f"Cookie-uri incarcate din {path}.")
        else:
            log("Nu exista nici STORAGE_STATE_B64 nici storageState.json local!")
            return []
    return data.get("cookies", []) if data else []


def parse_hms(text):
    if not text:
        return None
    parts = text.strip().split(":")
    if len(parts) != 3:
        return None
    try:
        h, m, s = [int(p) for p in parts]
        return h * 3600 + m * 60 + s
    except (ValueError, TypeError):
        return None


def format_hms(seconds):
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:02d}"


async def inject_cookies(tab, cookies):
    """Importa cookie-urile prin CDP Network.setCookie, apoi reload."""
    from nodriver import cdp

    same_site_map = {
        "Strict": cdp.network.CookieSameSite.STRICT,
        "Lax": cdp.network.CookieSameSite.LAX,
        "None": cdp.network.CookieSameSite.NONE,
    }
    await tab.send(cdp.network.enable())
    domain = CONSOLE_URL.split("/")[2]  # control.gaming4free.net
    base_domain = ".".join(domain.split(".")[-2:])  # gaming4free.net

    injected = 0
    for c in cookies:
        name = c.get("name")
        cdomain = c.get("domain", "")
        if not (cdomain.endswith(base_domain) or domain in cdomain):
            continue
        # Cookie-urile de sesiune au expires=-1 in storageState; le trimitem fara expires
        expires = c.get("expires", -1)
        expires_param = expires if (isinstance(expires, (int, float)) and expires > 0) else None
        try:
            await tab.send(
                cdp.network.set_cookie(
                    name=name,
                    value=c.get("value", ""),
                    url="https://" + domain + "/",
                    domain=cdomain,
                    path=c.get("path", "/"),
                    secure=c.get("secure", False),
                    http_only=c.get("httpOnly", False),
                    same_site=same_site_map.get(c.get("sameSite"), cdp.network.CookieSameSite.NONE),
                    expires=expires_param,
                )
            )
            injected += 1
        except Exception as e:
            log(f"Skip cookie {name}: {e}")

    log(f"{injected} cookie-uri G4F injectate pentru {domain}.")
    await tab.send(cdp.network.disable())


async def do_extend(browser):
    tab = None
    try:
        tab = await browser.get(CONSOLE_URL, new_window=True)
        await tab.sleep(5)

        if "/login" in tab.url or "accounts.google.com" in tab.url:
            log(f"⚠️  Sesiune invalida -> URL: {tab.url}")
            return False

        time_el = await tab.select(".time span", timeout=15000)
        if not time_el:
            log("⚠️  .time span nu a aparut.")
            await tab.sleep(3)
            time_el = await tab.select(".time span", timeout=10000)

        before_text = await time_el.text() if time_el else None
        before_seconds = parse_hms(before_text)
        log(f"Timp inainte: {before_text.strip() if before_text else 'N/A'} ({before_seconds}s)")

        btn = await tab.select(".rt-btn-free", timeout=10000)
        if not btn:
            log("⚠️  Buton .rt-btn-free nu a aparut.")
            return False

        btn_state = await tab.evaluate(
            "(() => { const b = document.querySelector('.rt-btn-free');"
            " if (!b) return null;"
            " const span = b.querySelector('span');"
            " return { text: span ? span.textContent.trim() : b.textContent.trim(),"
            "  disabled: b.disabled === true || b.classList.contains('disabled') || b.getAttribute('aria-disabled') === 'true' }; })()"
        )
        btn_text = (btn_state or {}).get("text", "")
        is_disabled = bool((btn_state or {}).get("disabled"))
        log(f"Buton: \"{btn_text}\" disabled={is_disabled}")

        if is_disabled or "+ 90 min" not in btn_text:
            log(f"⏳ Buton indisponibil: \"{btn_text.strip()}\" — de adaugat mai tarziu.")
            return False

        await btn.click()
        log("Click pe +90 min. Asteptam raspunsul...")

        extended = False
        start = time.time()
        for i in range(15):  # ~45s
            await tab.sleep(3)
            ts_widget = await tab.select("#g4f-ts-widget", timeout=2000)
            ts_visible = ts_widget is not None

            cur_el = await tab.select(".time span", timeout=5000)
            cur_text = await cur_el.text() if cur_el else None
            cur_seconds = parse_hms(cur_text)

            log(f"  check #{i + 1}: turnstile={ts_visible} "
                f"time={cur_text.strip() if cur_text else 'N/A'} "
                f"diff={cur_seconds - before_seconds if (cur_seconds is not None and before_seconds is not None) else 'N/A'}s")

            if cur_seconds is not None and before_seconds is not None and (cur_seconds - before_seconds) > 1800:
                extended = True
                log(f"✅ EXTINDERE REUSITA! +{round((cur_seconds - before_seconds) / 60)} min.")
                break

            if ts_visible and i >= 5:
                log("  Turnstile inca vizibil dupa ~18s — nodriver nu l-a auto-rezolvat.")

        if not extended:
            log("❌ Timpul nu a crescut. Salvam screenshot pentru debug.")
            try:
                ts = time.strftime("%Y%m%d-%H%M%S")
                await tab.save_screenshot(f"/tmp/g4f-extend-failed-{ts}.png")
                log(f"Screenshot esec salvat: /tmp/g4f-extend-failed-{ts}.png")
            except Exception as e:
                log(f"Nu am putut salva screenshot: {e}")

        return extended
    finally:
        if tab is not None:
            try:
                await tab.close()
            except Exception:
                pass


async def main():
    log(f"nodriver {uc.__version__} pornit. headless={HEADLESS}")
    log(f"Console URL: {CONSOLE_URL}")
    log(f"Target: {format_hms(TARGET_SECONDS)} / Backup: {format_hms(BACKUP_SECONDS)}")

    cookies = load_storage_state()

    browser = await uc.start(
        headless=HEADLESS,
        sandbox=False,
        user_data_dir=PROFILE_DIR,
        browser_executable_path=NODRIVER_BROWSER_PATH,
        browser_args=[
            "--disable-blink-features=AutomationControlled",
            "--no-first-run",
            "--disable-extensions",
            "--window-size=1280,800",
        ],
    )
    log("Browser pornit.")

    # Primul tab il folosim pentru injectarea cookie-urilor pe domeniul tinta,
    # apoi il inchidem (do_extend deschide tab-uri noi).
    seed = await browser.get(CONSOLE_URL, new_window=True)
    try:
        await inject_cookies(seed, cookies)
        if "/login" not in seed.url and "accounts.google.com" not in seed.url:
            log(f"Seed OK, sesiune acceptata: {seed.url[:60]}")
        else:
            log(f"⚠️  Seed arata login: {seed.url}")
    finally:
        await seed.close()

    if ONESHOT:
        await do_extend(browser)
        await browser.stop()
        sys.exit(0)

    log(f"Loop pornit. Verific la fiecare {CHECK_INTERVAL_SEC}s.")
    while True:
        try:
            await do_extend(browser)
        except Exception as e:
            log(f"Eroare in do_extend: {e}")
        try:
            for _ in range(CHECK_INTERVAL_SEC):
                await asyncio.sleep(1)
        except asyncio.CancelledError:
            raise


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log("Oprire manuala (Ctrl+C).")
        sys.exit(0)