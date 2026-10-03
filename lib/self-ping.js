// Lightweight public HTTP traffic; does not launch Chromium or access Redis.
function startSelfPing(env = process.env) {
  const publicUrl = env.PUBLIC_URL?.trim() || env.RENDER_EXTERNAL_URL?.trim();
  if (!publicUrl) {
    console.log('[self-ping] Dezactivat: lipseste PUBLIC_URL / RENDER_EXTERNAL_URL.');
    return;
  }

  let healthUrl;
  try {
    healthUrl = new URL('/health', publicUrl);
    if (!['http:', 'https:'].includes(healthUrl.protocol)) throw new Error('protocol invalid');
    healthUrl.username = '';
    healthUrl.password = '';
  } catch {
    console.error('[self-ping] URL invalid; foloseste un URL http(s) public.');
    return;
  }

  const configured = Number(env.SELF_PING_INTERVAL_MS || 50000);
  if (!Number.isSafeInteger(configured) || configured < 10000 || configured > 600000) {
    console.error('[self-ping] SELF_PING_INTERVAL_MS trebuie sa fie intre 10000 si 600000.');
    return;
  }

  let running = false;
  async function ping() {
    if (running) return;
    running = true;
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
        headers: { 'Cache-Control': 'no-cache' },
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (err) {
      console.error('[self-ping] esuat:', err.message);
    } finally {
      running = false;
    }
  }

  void ping();
  const timer = setInterval(ping, configured);
  timer.unref();
  console.log(`[self-ping] Activ catre ${healthUrl.origin}/health la fiecare ${configured / 1000}s.`);
  return () => clearInterval(timer);
}

module.exports = { startSelfPing };
