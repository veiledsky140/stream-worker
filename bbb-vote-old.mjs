#!/usr/bin/env node
/**
 * Vote for a contestant in the TamilGlitz "Bigg Boss Tamil Vote" poll
 * (Crowdsignal/Polldaddy embed on https://tamilglitz.in/bigg-boss-tamil-vote/).
 *
 *   node bbb-vote.mjs                              # one vote for Shathika
 *   node bbb-vote.mjs "Lakshmi Priya"              # any name on the ballot
 *   node bbb-vote.mjs Shathika --dry-run             # resolve poll + answer id, submit nothing
 *
 * The poll counts ONE vote per egress IP per ~3h window, so N votes need N IPs.
 * Verified: the server ignores the `b`/`cookie` params, so there is no client-side bypass —
 * distinct IPs are the only lever.
 *
 *   Tor (one fresh circuit per vote; measured 85% hit rate, 2.5 votes/min):
 *     node bbb-vote.mjs Shathika --tor --target 300
 *     node bbb-vote.mjs Shathika --tor --times 10
 *
 *   Tor with parallel isolated circuits (IsolateSOCKSAuth: every attempt uses an unused
 *   SOCKS username, so it gets its own circuit — no control port, no NEWNYM, no 10s limit):
 *     node bbb-vote.mjs Shathika --tor-streams 12 --target 300
 *
 * Above concurrency 1 a slice of accepted votes never reaches the tally: two circuits can exit
 * from the same IP and race the server's per-IP dedupe, so both answer "vote counted" while only
 * one is recorded (measured ~26% lost at 10-16 lanes, 0% at 1). Judge a run by the poll's own
 * counter, not the "counted" line — --tally-each prints it on every vote.
 *
 *   A proxy list you supply — one "host:port", "http://user:pass@host:port" or
 *   "socks5://host:port" per line:
 *     node bbb-vote.mjs Shathika --proxies proxies.txt --target 300 --concurrency 30
 *     HTTPS_PROXY=http://user:pass@host:port node bbb-vote.mjs
 *
 *   Both: the list is drained first, Tor carries the tail.
 *
 * --target N stops the run once N votes are actually counted (--times is the attempt cap).
 * --ledger  path to the spent-IP file (default spent-<pollId>.txt).
 *
 * Scraped free proxy lists were removed: 0.35% hit rate and 0.32 votes/min over 2,608 attempts,
 * against Tor's 85% and 2.5. A bought rotating list is the only proxy route with real headroom.
 * Every IP that returns "already counted" is appended to the ledger and skipped on later runs.
 *
 * --tor auto-detects the SOCKS and control ports (9050/9051, then Tor Browser's 9150/9151),
 * authenticates to the control port via TOR_COOKIE / TOR_CONTROL_PASSWORD / empty password,
 * and sends SIGNAL NEWNYM before every vote. Tor rate-limits NEWNYM to one per 10s, so
 * --tor alone forces concurrency 1 and an 11s delay unless you override both explicitly.
 */

import https from "node:https";
import http from "node:http";
import tls from "node:tls";
import net from "node:net";
import { readFileSync, appendFileSync, existsSync, statSync } from "node:fs";

const PAGE = process.env.POLL_PAGE ?? "https://tamilglitz.in/bigg-boss-tamil-vote/";
// Short UA on purpose: the full Chrome UA trips Cloudflare's bot rule on the blog page.
const UA = process.env.POLL_UA ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const TIMEOUT = Number(process.env.POLL_TIMEOUT ?? 15000);

// Multi-hour runs must survive a single wedged socket or stray rejection.
process.on("unhandledRejection", (e) => console.error(`unhandled rejection: ${e?.message ?? e}`));
process.on("uncaughtException", (e) => console.error(`uncaught exception: ${e?.message ?? e}`));

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i < 0 ? d : argv[i + 1]; };
const has = (n) => argv.includes(n);
const skipNext = new Set(["--times", "--delay", "--proxies", "--concurrency", "--target", "--ledger", "--tor-streams"]);
const name = argv.find((a, i) => !a.startsWith("--") && !skipNext.has(argv[i - 1])) ?? "Shathika";

const torMode = has("--tor");
const streams = Math.max(0, Number(flag("--tor-streams", 0)));   // parallel isolated Tor circuits
const tallyEach = has("--tally-each");   // print the target's tally on every counted vote
const dryRun = has("--dry-run");
const proxySrc = flag("--proxies", null);
const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const hasProxies = Boolean(proxySrc || envProxy);
let times = Number(flag("--times", 1));
// proxies pace themselves; a bare --tor is throttled by Tor's 10s NEWNYM limit.
// --tor-streams is not: a fresh circuit per attempt needs no NEWNYM at all.
const delay = Number(flag("--delay", hasProxies || streams ? 0 : torMode ? 11000 : 300));
const concurrency = Math.max(1, Number(flag("--concurrency", streams || (hasProxies ? 20 : torMode ? 1 : 8))));
const target = Number(flag("--target", 0));   // stop as soon as N votes are actually counted
const ledgerFlag = flag("--ledger", null);    // override the spent-<pollId>.txt path (for A/B runs)

/* ---------------------------------------------------------------- tunnelling */

// node:https, not fetch: Cloudflare 403s undici's TLS fingerprint but serves node:https (HTTP/1.1).
const normalize = (p) => new URL(/^\w+:\/\//.test(p) ? p : `http://${p}`);
const isSocks = (u) => /^socks/i.test(u.protocol);
// Key on the egress IP: free lists carry the same host on many ports, and those extra
// attempts all land on one already-credited IP ("already counted" — measured 27/1800 wasted).
const key = (u) => (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(u.hostname) || u.hostname.includes(":"))
  ? u.hostname
  : `${u.hostname}:${u.port || (isSocks(u) ? 1080 : 80)}`;

function withTimeout(sock, label) {
  sock.setTimeout(TIMEOUT, () => sock.destroy(new Error(`${label} timeout`)));
  return sock;
}

const waitConnect = (sock) => new Promise((resolve, reject) => {
  sock.once("connect", resolve);
  sock.once("error", reject);
});

// CONNECT tunnel. The proxy only moves the egress IP, so no TLS termination
// (MITM) is involved and no certificate pinning is bypassed anywhere.
async function httpTunnel(proxy, host, port) {
  const raw = await new Promise((resolve, reject) => {
    const auth = proxy.username
      ? { "Proxy-Authorization": "Basic " + Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64") }
      : {};
    const req = http.request({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: "CONNECT",
      path: `${host}:${port}`,
      headers: auth,
      timeout: TIMEOUT,
    });
    req.on("connect", (res, socket) =>
      res.statusCode === 200 ? resolve(socket) : reject(new Error(`proxy CONNECT ${res.statusCode}`)));
    req.on("timeout", () => req.destroy(new Error("proxy connect timeout")));
    req.on("error", reject);
    req.end();
  });
  return raw;
}

// RFC 1928 CONNECT with the hostname sent as ATYP=3, so DNS resolves at the proxy
// (Tor and socks5h behaviour). RFC 1929 user/pass auth is supported.
function socks5Tunnel(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const sock = withTimeout(net.connect({ host: proxy.hostname, port: Number(proxy.port || 1080) }), "socks");
    let stage = 0;
    let buf = Buffer.alloc(0);
    let settled = false;
    // stays attached after resolve: a late RST must not surface as an uncaught error
    const fail = (e) => { if (settled) return; settled = true; sock.destroy(); reject(e); };

    const sendConnect = () => {
      const h = Buffer.from(host);
      sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([(port >> 8) & 0xff, port & 0xff])]));
      stage = 2;
      buf = Buffer.alloc(0);
    };

    sock.once("error", fail);
    sock.once("connect", () => sock.write(Buffer.from(proxy.username ? [5, 2, 0, 2] : [5, 1, 0])));
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      if (stage === 0) {                                    // greeting
        if (buf.length < 2) return;
        const [ver, method] = buf;
        if (ver !== 5) return fail(new Error("socks5 bad version"));
        if (method === 0xff) return fail(new Error("socks5 no acceptable auth method"));
        buf = buf.subarray(2);
        if (method === 2) {                                 // RFC 1929
          const u = Buffer.from(proxy.username ?? ""), p = Buffer.from(proxy.password ?? "");
          sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
          stage = 1;
          buf = Buffer.alloc(0);
        } else sendConnect();
        return;
      }

      if (stage === 1) {                                    // auth reply
        if (buf.length < 2) return;
        if (buf[1] !== 0) return fail(new Error("socks5 auth rejected"));
        buf = Buffer.alloc(0);
        sendConnect();
        return;
      }

      if (buf.length < 4) return;                           // connect reply
      const rep = buf[1], atyp = buf[3];
      const addrLen = atyp === 1 ? 4 : atyp === 4 ? 16 : 1 + buf[4];
      const need = 4 + addrLen + 2;
      if (buf.length < need) return;
      if (rep !== 0) return fail(new Error(`socks5 connect failed (rep=${rep})`));
      sock.setTimeout(0);
      const rest = buf.subarray(need);
      if (rest.length) sock.unshift(rest);
      settled = true;
      resolve(sock);
    });
  });
}

async function tlsOver(raw, host) {
  const sock = tls.connect({ socket: raw, servername: host });
  sock.setTimeout(TIMEOUT, () => sock.destroy(new Error("tls timeout")));
  await new Promise((resolve, reject) => { sock.once("secureConnect", resolve); sock.once("error", reject); });
  sock.on("error", () => {});   // post-handshake failures are reported per-request instead
  return sock;
}

const dial = async (proxy, host, port = 443) => {
  if (!proxy) return null;
  const raw = isSocks(proxy) ? await socks5Tunnel(proxy, host, port) : await httpTunnel(proxy, host, port);
  return tlsOver(raw, host);
};

async function get(url, { referer = PAGE, proxy = null } = {}) {
  const u = new URL(url);
  const headers = { "User-Agent": UA, Accept: "text/html", ...(referer ? { Referer: referer } : {}) };
  let mod = https;
  let options = { hostname: u.hostname, path: u.pathname + u.search, headers, timeout: TIMEOUT };

  const sock = await dial(proxy, u.hostname);
  if (sock) {
    mod = http;   // socket is already TLS; speak plain HTTP over it
    options = {
      createConnection: () => sock,
      host: u.hostname, port: 443, path: u.pathname + u.search, setHost: false,
      // Connection: close is load-bearing — a pooled tunnel socket gets reused for a later
      // request through a dead proxy, and the run hangs on an unsettled promise
      headers: { Host: u.hostname, Connection: "close", ...headers }, timeout: TIMEOUT,
    };
  }

  return new Promise((resolve, reject) => {
    const req = mod.request(options, (res) => {
      if (res.statusCode >= 400) { res.resume(); return reject(new Error(`${res.statusCode} ${url}`)); }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

/* ------------------------------------------------------------------- tor ctrl */

const portOpen = (host, port) => new Promise((resolve) => {
  const s = net.connect({ host, port });
  const done = (ok) => { s.destroy(); resolve(ok); };
  s.setTimeout(400, () => done(false));
  s.once("connect", () => done(true));
  s.once("error", () => done(false));
});

async function firstOpen(envVal, candidates) {
  if (envVal) return Number(envVal);
  for (const p of candidates) if (await portOpen("127.0.0.1", p)) return p;
  return null;
}

const COOKIE_PATHS = [
  process.env.TOR_COOKIE,
  `${process.env.USERPROFILE ?? ""}/Desktop/Tor Browser/Browser/TorBrowser/Data/Tor/control_auth_cookie`,
  `${process.env.APPDATA ?? ""}/Tor Browser/Browser/TorBrowser/Data/Tor/control_auth_cookie`,
  "/var/run/tor/control.authcookie",
  "/var/lib/tor/control_auth_cookie",
].filter(Boolean);

async function torSetup() {
  const socksPort = await firstOpen(process.env.TOR_SOCKS_PORT, [9050, 9150]);
  if (!socksPort) throw new Error("no Tor SOCKS port on 9050/9150 — is Tor running? set TOR_SOCKS_PORT");
  const socks = new URL(`socks5://127.0.0.1:${socksPort}`);

  const ctrlPort = await firstOpen(process.env.TOR_CONTROL_PORT, [9051, 9151]);
  let control = null;
  if (ctrlPort) {
    try {
      control = await torControl(ctrlPort);
    } catch (e) {
      console.error(`Tor control port ${ctrlPort} unusable (${e.message}); votes will reuse circuits — exits repeat, so expect duplicates.`);
    }
  } else {
    console.error("no Tor control port on 9051/9151; cannot rotate circuits, expect duplicate exits.");
  }
  return { socks, control };
}

async function torControl(port) {
  const sock = net.connect({ host: "127.0.0.1", port });
  await waitConnect(sock);

  let acc = "";
  let pending = null;
  let dead = false;
  // Tor drops the control connection after a failed AUTHENTICATE. Without this the pending
  // reply never settles and the whole process exits 13 on an unsettled top-level await.
  sock.on("close", () => { dead = true; const p = pending; pending = null; p?.("551 control connection closed"); });
  sock.on("error", () => {});
  sock.on("data", (d) => {
    acc += d.toString();
    const lines = acc.split("\r\n");
    if (lines.length < 2) return;
    if (!/^\d{3} /.test(lines[lines.length - 2])) return;   // multi-line reply still open
    const reply = acc;
    acc = "";
    const p = pending;
    pending = null;
    p?.(reply);
  });
  // serialized: concurrent SIGNALs would clobber the single pending reply
  let chain = Promise.resolve();
  const send = (cmd) => (chain = chain.then(() => dead
    ? "551 control connection closed"
    : new Promise((resolve) => { pending = resolve; sock.write(cmd + "\r\n"); })));

  // Every existing cookie is tried, newest first: a stale Tor Browser cookie must not win
  // over the running instance's own.
  const cookies = COOKIE_PATHS.filter(existsSync)
    .map((p) => ({ p, m: statSync(p).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  const attempts = cookies.map((c) => `AUTHENTICATE ${readFileSync(c.p).toString("hex")}`);
  if (process.env.TOR_CONTROL_PASSWORD) attempts.push(`AUTHENTICATE "${process.env.TOR_CONTROL_PASSWORD.replace(/"/g, '\\"')}"`);
  attempts.push('AUTHENTICATE ""');   // CookieAuthentication 0

  let last = "";
  for (const cmd of attempts) {
    last = await send(cmd);
    if (/^250 /.test(last)) break;
  }
  if (!/^250 /.test(last)) throw new Error(`auth failed: ${last.trim()} — set TOR_COOKIE or TOR_CONTROL_PASSWORD`);

  return { newnym: () => send("SIGNAL NEWNYM") };
}

/* ----------------------------------------------------------------- poll logic */

// escape() semantics used by the poll's own vote-js URL builder
const esc = (s) => encodeURIComponent(s).replace(/%2F/g, "/").replace(/%3A/g, ":");

async function resolvePoll(proxy) {
  const html = await get(PAGE, { referer: null, proxy });
  const pollId = html.match(/secure\.polldaddy\.com\/p\/(\d+)\.js/)?.[1];
  if (!pollId) throw new Error("no Polldaddy poll embedded on page (poll may be closed/rotated)");

  const js = await get(`https://secure.polldaddy.com/p/${pollId}.js`, { proxy });
  const hash = js.match(new RegExp(`PDV_h${pollId} = '([^']+)'`))?.[1];
  const multiple = js.match(new RegExp(`PDV_pt${pollId} = (\\d+)`))?.[1] ?? "0";
  const va = js.match(new RegExp(`PDV_va${pollId} = (\\d+)`))?.[1] ?? "0";

  const answers = {};
  const re = new RegExp(`PDV_A${pollId}\\[\\d+\\]\\[0\\] = '(\\d+)'[\\s\\S]{0,80}?\\[1\\] = '([^']*)'`, "g");
  for (const m of js.matchAll(re)) answers[m[2]] = m[1];
  if (!hash || !Object.keys(answers).length) throw new Error("could not parse poll metadata");

  return { pollId, hash, multiple, va, answers };
}

async function vote(poll, answerId, proxy) {
  // nonce is short-lived: fetch and spend it in the same breath
  const hs = await get(`https://poll.fm/n/${poll.hash}/${poll.pollId}`, { proxy });
  const nonce = hs.match(new RegExp(`PDV_n${poll.pollId}='([^']+)'`))?.[1];
  if (!nonce) throw new Error(`no nonce in handshake response: ${hs.slice(0, 120)}`);

  const url = `https://polls.polldaddy.com/vote-js.php?p=${poll.pollId}&b=${poll.multiple}` +
    `&a=${answerId},&o=&va=${poll.va}&cookie=0&tags=${poll.pollId}-src:poll-embed` +
    `&n=${esc(nonce)}&url=${esc(PAGE)}`;
  const res = await get(url, { proxy });

  if (/alert\("(.*?)"\)/.test(res)) throw new Error(res.match(/alert\("(.*?)"\)/)[1]);
  const fresh = !/already counted/i.test(res);
  const tally = [...res.matchAll(/title="([^"]+)">[\s\S]*?pds-feedback-per">[^0-9]*([\d.]+)%[\s\S]*?\(([\d,]+) votes\)/g)]
    .map(m => ({ name: m[1], pct: m[2], votes: m[3] }));
  return { fresh, tally };
}

/* -------------------------------------------------------------- proxy sources */

// Proxies come from a file or HTTPS_PROXY only. The free-list scraper was deleted:
// measured 0.35% hit rate / 0.32 votes/min across 2,608 attempts, versus Tor's ~85% / 2.5.
// A bought rotating list still plugs straight in here.
if (proxySrc === "auto") {
  console.error("--proxies auto (scraped free lists) was removed. Pass a file path, or use --tor.");
  process.exit(1);
}
if (proxySrc && !existsSync(proxySrc)) {
  console.error(`proxy list not found: ${proxySrc}`);
  process.exit(1);
}
const staticProxies = proxySrc
  ? readFileSync(proxySrc, "utf8").split(/\s+/).filter(Boolean).map(normalize)
  : [];
const tor = torMode || streams ? await torSetup() : null;
let roundRobin = 0;
let lastTorAt = 0;

// Ledger of IPs the server already credited, so later runs do not re-spend attempts on them.
// Empty until the poll id (and so the default filename) is known.
let spent = new Set();
let ledgerPath = "";
const markSpent = (p) => {
  // a loopback proxy (Tor's SOCKS, ssh -D) votes from an exit IP that is not its own
  if (/^(?:127\.|localhost$|\[?::1\]?$)/.test(p.hostname)) return;
  const k = key(p);
  if (spent.has(k)) return;
  spent.add(k);
  appendFileSync(ledgerPath, k + "\n");
};

// An unused SOCKS username means an unused isolation key, so Tor builds a fresh circuit and
// the vote leaves from a different exit. That removes both the NEWNYM throttle and the control port.
const isolated = (port) => new URL(`socks5://s${Math.random().toString(36).slice(2, 10)}:x@127.0.0.1:${port}`);

async function nextProxy() {
  if (tor && !staticProxies.length) return streams ? isolated(tor.socks.port) : tor.socks;
  for (let n = 0; n < staticProxies.length; n++) {
    const p = staticProxies[roundRobin++ % staticProxies.length];
    if (!spent.has(key(p))) return p;
  }
  if (staticProxies.length) return undefined;   // list exhausted, nothing to fall back to
  if (tor) {
    const wait = 11000 - (Date.now() - lastTorAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastTorAt = Date.now();
    return tor.socks;
  }
  return envProxy ? normalize(envProxy) : null;
}

/* ----------------------------------------------------------------------- main */

const poll = await resolvePoll(null);   // direct: 2 requests, no vote, not worth a proxy failure mode
const answerId = poll.answers[name];
if (!answerId) {
  console.error(`"${name}" not on the ballot. Options: ${Object.keys(poll.answers).join(", ")}`);
  process.exit(1);
}
ledgerPath = ledgerFlag ?? `spent-${poll.pollId}.txt`;
spent = new Set(existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").split(/\s+/).filter(Boolean) : []);
const channels = [
  tor ? `tor 127.0.0.1:${tor.socks.port}${tor.control ? "+newnym" : ""}` : null,
  staticProxies.length ? `${staticProxies.length} proxies` : envProxy ? "env proxy" : null,
].filter(Boolean);
console.log(`poll ${poll.pollId} | "${name}" -> answer ${answerId} | ${channels.join(" + ") || "direct"} | ` +
  `plan ${times} @${concurrency} | ledger ${spent.size} spent${dryRun ? " | DRY RUN" : ""}`);

if (dryRun) {
  // prove the nonce handshake works without spending a vote
  const proxy = tor ? tor.socks : null;
  const hs = await get(`https://poll.fm/n/${poll.hash}/${poll.pollId}`, { proxy });
  console.log(`handshake ok${proxy ? " via tor" : ""}:`, hs.match(new RegExp(`PDV_n${poll.pollId}='([^']+)'`))?.[1]);
  process.exit(0);
}

if (times > 1 && !staticProxies.length && !envProxy && !tor) {
  console.error(`no proxy source: all ${times} attempts go out from this IP, so only the first one counts.`);
}

const stats = { counted: 0, dup: 0, failed: 0, startedAt: Date.now() };
let tallyShown = false;
let next = 0;
const finished = () => next >= times || (target > 0 && stats.counted >= target);

async function worker() {
  while (!finished()) {
    const i = next++;
    let proxy;
    try {
      proxy = await nextProxy();
    } catch (e) {
      stats.failed++;
      console.error(`[${i + 1}/${times}] proxy source failed: ${e.message}`);
      continue;
    }
    if (proxy === undefined) {
      console.error("proxy source exhausted; stopping");
      times = 0;
      break;
    }

    const label = proxy
      ? (proxy === tor?.socks ? "tor" : tor && proxy.hostname === "127.0.0.1" ? "tor-stream" : proxy.host)
      : "direct";
    try {
      if (tor?.control && proxy === tor.socks) await tor.control.newnym();   // fresh exit before every vote
      const { fresh, tally } = await vote(poll, answerId, proxy);
      if (fresh) stats.counted++;
      else stats.dup++;
      // either way this IP is now locked out of the poll for ~3h
      if (proxy && proxy !== tor?.socks) markSpent(proxy);
      console.log(`[${i + 1}/${times}] ${fresh ? "vote counted" : "already counted"} via ${label} (${stats.counted} counted)`);
      const mine = tally.find((t) => t.name === name);
      if (tallyEach && mine) console.log(`    tally: ${mine.name} ${mine.votes}`);
      if (!tallyShown && tally.length) {
        tallyShown = true;
        console.log(tally.map(t => `  ${t.name.padEnd(16)} ${t.pct.padStart(6)}%  ${t.votes}`).join("\n"));
      }
    } catch (e) {
      stats.failed++;
      console.error(`[${i + 1}/${times}] failed via ${label}: ${e.message}`);
    }
    if (delay) await new Promise(r => setTimeout(r, delay));
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(times, concurrency)) }, worker));
const secs = (Date.now() - stats.startedAt) / 1000;
const attempts = stats.counted + stats.dup + stats.failed;
console.log(`\ncounted ${stats.counted} | already-counted ${stats.dup} | failed ${stats.failed}`);
console.log(`win rate ${(100 * stats.counted / Math.max(1, attempts)).toFixed(1)}% of ${attempts} attempts | ` +
  `${secs.toFixed(0)}s | ${(stats.counted / secs * 60).toFixed(1)} votes/min | ` +
  `ledger ${spent.size} spent`);
process.exit(0);
