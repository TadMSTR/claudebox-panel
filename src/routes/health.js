const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const config = require('../../config/config');

const router = express.Router();
let cache = {};
let lastCheck = 0;

function httpPing(url, timeoutMs = 5000) {
  return new Promise(resolve => {
    const start = Date.now();
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, res => {
      res.destroy();
      resolve({ ok: res.statusCode < 500, latency: Date.now() - start, statusCode: res.statusCode });
    });
    req.on('error', () => resolve({ ok: false, latency: Date.now() - start, statusCode: null }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, latency: timeoutMs, statusCode: null }); });
  });
}

function mountCheck(mountpoint) {
  try {
    fs.statSync(mountpoint);
    const mounts = fs.readFileSync('/proc/mounts', 'utf-8');
    const mounted = mounts.split('\n').some(line => line.includes(mountpoint));
    return { ok: mounted, latency: 0, statusCode: null };
  } catch (_) { return { ok: false, latency: 0, statusCode: null }; }
}

async function runChecks() {
  const results = {};
  await Promise.all(config.services.map(async svc => {
    let result;
    if (svc.mountpoint) result = mountCheck(svc.mountpoint);
    else if (svc.url) result = await httpPing(svc.url);
    else result = { ok: null, latency: null, statusCode: null };
    results[svc.label] = {
      label: svc.label, link: svc.link || null,
      status: result.ok === true ? 'up' : result.ok === false ? 'down' : 'unknown',
      latency: result.latency, statusCode: result.statusCode, checkedAt: Date.now(),
    };
  }));
  cache = results;
  lastCheck = Date.now();
}

runChecks();
setInterval(runChecks, config.healthCheckInterval);

// GET /api/health
router.get('/', async (req, res) => {
  if (!lastCheck || Date.now() - lastCheck > config.healthCheckInterval * 2) await runChecks();
  res.json({ services: Object.values(cache), lastCheck, nextCheck: lastCheck + config.healthCheckInterval });
});

// POST /api/health/refresh
router.post('/refresh', async (req, res) => {
  await runChecks();
  res.json({ ok: true, services: Object.values(cache), lastCheck });
});

module.exports = router;
