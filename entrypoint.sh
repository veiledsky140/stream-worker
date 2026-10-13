#!/usr/bin/env bash
set -e

echo "=========================================================="
echo "    Bigg Boss Tamil Voting Automation - Railway 24/7"
echo "=========================================================="

echo "[Tor] Configuring directories & permissions..."
mkdir -p /var/lib/tor /var/log/tor
chown -R debian-tor:debian-tor /var/lib/tor /var/log/tor 2>/dev/null || true
chmod 700 /var/lib/tor 2>/dev/null || true

echo "[Tor] Launching Tor daemon..."
tor -f /etc/tor/torrc --User debian-tor --RunAsDaemon 1

echo "[Tor] Waiting for SOCKS proxy on 127.0.0.1:9050..."
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
      console.log('[Tor] Port 9050 is ready and listening!');
      process.exit(0);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.error('[Tor] Timed out waiting for Tor port 9050.');
  process.exit(1);
})();
"

echo "[System] Starting 24/7 Supervisor Server..."
exec node server.mjs
