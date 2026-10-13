#!/usr/bin/env bash
set -e

echo "=========================================================="
echo "           Cloud Stream Service - Worker 24/7             "
echo "=========================================================="

echo "[Daemon] Configuring permissions..."
mkdir -p /var/lib/tor /var/log/tor
chown -R debian-tor:debian-tor /var/lib/tor /var/log/tor 2>/dev/null || true
chmod 700 /var/lib/tor 2>/dev/null || true

echo "[Daemon] Starting background proxy..."
tor -f /etc/tor/torrc --User debian-tor --RunAsDaemon 1

echo "[Daemon] Waiting for port 9050 ready..."
node -e "
const net = require('net');
const check = () => new Promise(res => {
  const s = net.connect(9050, '127.0.0.1');
  s.once('connect', () => { s.destroy(); res(true); });
  s.once('error', () => { s.destroy(); res(false); });
});
(async () => {
  for (let i = 0; i < 45; i++) {
    if (await check()) {
      console.log('[Daemon] Port 9050 is active.');
      process.exit(0);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.error('[Daemon] Timed out waiting for port 9050.');
  process.exit(1);
})();
"

echo "[System] Starting supervisor server..."
exec node server.mjs
