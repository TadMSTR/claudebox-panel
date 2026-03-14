const express = require('express');
const http = require('http');
const https = require('https');
const net = require('net');
const dns = require('dns');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const pm2 = require('pm2');
const config = require('../../config/config');

const router = express.Router();
const diag = config.diagnostics;

let cache = null;

// ── Helpers ──

const ALLOWED_DOCKER_PATHS = [
  '/containers/json',
  '/containers/',
  '/system/df',
  '/version',
  '/info',
];

function dockerGet(apiPath) {
  const basePath = apiPath.split('?')[0];
  if (!ALLOWED_DOCKER_PATHS.some(p => basePath === p || basePath.startsWith(p))) {
    return Promise.reject(new Error(`Docker API path not allowed: ${basePath}`));
  }
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath: '/var/run/docker.sock', path: apiPath, headers: { Host: 'localhost' } }, res => {
      let body = '';
      res.on('data', c => { body += c; if (body.length > 2 * 1024 * 1024) { req.destroy(); reject(new Error('too large')); } });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function httpPing(url, timeoutMs = 5000) {
  return new Promise(resolve => {
    const start = Date.now();
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, res => {
      res.destroy();
      resolve({ ok: true, statusCode: res.statusCode, latency: Date.now() - start });
    });
    req.on('error', () => resolve({ ok: false, statusCode: null, latency: Date.now() - start }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, statusCode: null, latency: timeoutMs }); });
  });
}

function checkPort(port, host = '127.0.0.1', timeoutMs = 2000) {
  return new Promise(resolve => {
    const sock = net.createConnection({ port, host });
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}

function execPromise(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10000, ...opts }, (err, stdout, stderr) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

function pm2List() {
  return new Promise((resolve, reject) => {
    pm2.connect(err => {
      if (err) return reject(err);
      pm2.list((err, list) => {
        pm2.disconnect();
        if (err) reject(err); else resolve(list);
      });
    });
  });
}

function result(id, label, status, message, detail = null, duration = 0) {
  return { id, label, status, message, detail, duration };
}

function worstStatus(checks) {
  if (checks.some(c => c.status === 'fail')) return 'fail';
  if (checks.some(c => c.status === 'warn')) return 'warn';
  return 'pass';
}

// ── Check functions ──
// Each returns a result object or null (if thorough-only and not in thorough mode)

async function checkDockerContainers(opts) {
  const start = Date.now();
  try {
    const containers = await dockerGet('/containers/json?all=1');
    const running = new Set(containers.filter(c => c.State === 'running').map(c => (c.Names[0] || '').replace(/^\//, '')));
    const missing = diag.expectedContainers.filter(name => !running.has(name));
    if (missing.length === 0) {
      return result('docker-containers', 'Docker containers', 'pass', `All ${diag.expectedContainers.length} expected containers running`, null, Date.now() - start);
    }
    return result('docker-containers', 'Docker containers', 'fail', `${missing.length} expected container(s) not running`, `Missing: ${missing.join(', ')}`, Date.now() - start);
  } catch (e) {
    return result('docker-containers', 'Docker containers', 'fail', 'Cannot query Docker', e.message, Date.now() - start);
  }
}

async function checkPM2Processes(opts) {
  const start = Date.now();
  try {
    const list = await pm2List();
    const problems = [];
    const warns = [];
    for (const name of diag.expectedPM2) {
      const proc = list.find(p => p.name === name);
      if (!proc) { problems.push(`${name}: missing`); continue; }
      if (proc.pm2_env.status !== 'online') { problems.push(`${name}: ${proc.pm2_env.status}`); continue; }
      if (proc.pm2_env.restart_time > 5) { warns.push(`${name}: ${proc.pm2_env.restart_time} restarts`); }
    }
    if (problems.length > 0) return result('pm2-processes', 'PM2 processes', 'fail', `${problems.length} process(es) unhealthy`, problems.join('; '), Date.now() - start);
    if (warns.length > 0) return result('pm2-processes', 'PM2 processes', 'warn', 'High restart counts detected', warns.join('; '), Date.now() - start);
    return result('pm2-processes', 'PM2 processes', 'pass', `All ${diag.expectedPM2.length} expected processes online`, null, Date.now() - start);
  } catch (e) {
    return result('pm2-processes', 'PM2 processes', 'fail', 'Cannot query PM2', e.message, Date.now() - start);
  }
}

async function checkDockerRestarts(opts) {
  if (!opts.thorough) return null;
  const start = Date.now();
  try {
    const containers = await dockerGet('/containers/json?all=1');
    const looping = [];
    for (const c of containers) {
      const name = (c.Names[0] || '').replace(/^\//, '');
      try {
        const inspect = await dockerGet(`/containers/${c.Id}/json`);
        if (inspect.RestartCount > 10) looping.push(`${name}: ${inspect.RestartCount} restarts`);
        else if (inspect.RestartCount > 3) looping.push(`${name}: ${inspect.RestartCount} restarts (warn)`);
      } catch (_) {}
    }
    const fails = looping.filter(l => !l.includes('(warn)'));
    const warns = looping.filter(l => l.includes('(warn)'));
    if (fails.length > 0) return result('docker-restarts', 'Docker restart loops', 'fail', `${fails.length} container(s) restarting excessively`, looping.join('; '), Date.now() - start);
    if (warns.length > 0) return result('docker-restarts', 'Docker restart loops', 'warn', `${warns.length} container(s) with elevated restarts`, looping.join('; '), Date.now() - start);
    return result('docker-restarts', 'Docker restart loops', 'pass', 'No restart loops detected', null, Date.now() - start);
  } catch (e) {
    return result('docker-restarts', 'Docker restart loops', 'fail', 'Cannot inspect containers', e.message, Date.now() - start);
  }
}

async function checkDeepEndpoints(opts) {
  if (!opts.thorough) return null;
  const start = Date.now();
  const problems = [];
  const warns = [];
  for (const ep of diag.deepChecks) {
    const res = await httpPing(ep.url, 5000);
    if (!res.ok || (ep.expectStatus && res.statusCode !== ep.expectStatus)) {
      problems.push(`${ep.label}: ${res.ok ? `status ${res.statusCode}` : 'unreachable'}`);
    } else if (res.latency > 2000) {
      warns.push(`${ep.label}: ${res.latency}ms`);
    }
  }
  if (problems.length > 0) return result('deep-endpoints', 'Service deep checks', 'fail', `${problems.length} endpoint(s) unhealthy`, problems.join('; '), Date.now() - start);
  if (warns.length > 0) return result('deep-endpoints', 'Service deep checks', 'warn', 'Slow endpoints detected', warns.join('; '), Date.now() - start);
  return result('deep-endpoints', 'Service deep checks', 'pass', `All ${diag.deepChecks.length} endpoints healthy`, null, Date.now() - start);
}

async function checkNFSMounts(opts) {
  const start = Date.now();
  const missing = [];
  let mounts;
  try { mounts = fs.readFileSync('/proc/mounts', 'utf-8'); } catch (_) { mounts = ''; }
  for (const mp of diag.nfsMounts) {
    const mounted = mounts.split('\n').some(line => line.includes(mp));
    if (!mounted) {
      try { fs.statSync(mp); } catch (_) { missing.push(mp); }
    }
  }
  if (missing.length > 0) return result('nfs-mounts', 'NFS mounts', 'fail', `${missing.length} mount(s) unavailable`, `Missing: ${missing.join(', ')}`, Date.now() - start);
  return result('nfs-mounts', 'NFS mounts', 'pass', `All ${diag.nfsMounts.length} NFS mounts present`, null, Date.now() - start);
}

async function checkNFSResponsive(opts) {
  if (!opts.thorough) return null;
  const start = Date.now();
  const slow = [];
  const failed = [];
  for (const mp of diag.nfsMounts) {
    const t0 = Date.now();
    try {
      await execPromise('ls', [mp], { timeout: 5000 });
      const elapsed = Date.now() - t0;
      if (elapsed > 2000) slow.push(`${mp}: ${elapsed}ms`);
    } catch (_) {
      failed.push(mp);
    }
  }
  if (failed.length > 0) return result('nfs-responsive', 'NFS responsiveness', 'fail', `${failed.length} mount(s) unresponsive`, `Timeout: ${failed.join(', ')}`, Date.now() - start);
  if (slow.length > 0) return result('nfs-responsive', 'NFS responsiveness', 'warn', 'Slow NFS response', slow.join('; '), Date.now() - start);
  return result('nfs-responsive', 'NFS responsiveness', 'pass', 'All mounts responsive', null, Date.now() - start);
}

async function checkPorts(opts) {
  const start = Date.now();
  const down = [];
  await Promise.all(diag.expectedPorts.map(async ({ port, label }) => {
    const up = await checkPort(port);
    if (!up) down.push(`${label} (:${port})`);
  }));
  if (down.length > 0) return result('ports', 'Port listening', 'fail', `${down.length} expected port(s) not listening`, `Down: ${down.join(', ')}`, Date.now() - start);
  return result('ports', 'Port listening', 'pass', `All ${diag.expectedPorts.length} expected ports listening`, null, Date.now() - start);
}

async function checkDNS(opts) {
  if (!opts.thorough) return null;
  const start = Date.now();
  const failed = [];
  const slow = [];
  for (const domain of diag.dnsChecks) {
    const t0 = Date.now();
    try {
      await dns.promises.resolve4(domain);
      const elapsed = Date.now() - t0;
      if (elapsed > 500) slow.push(`${domain}: ${elapsed}ms`);
    } catch (_) {
      failed.push(domain);
    }
  }
  if (failed.length > 0) return result('dns', 'DNS resolution', 'fail', `${failed.length} domain(s) failed to resolve`, `Failed: ${failed.join(', ')}`, Date.now() - start);
  if (slow.length > 0) return result('dns', 'DNS resolution', 'warn', 'Slow DNS resolution', slow.join('; '), Date.now() - start);
  return result('dns', 'DNS resolution', 'pass', `All ${diag.dnsChecks.length} domains resolved`, null, Date.now() - start);
}

async function checkCrossHost(opts) {
  if (!opts.thorough) return null;
  const start = Date.now();
  const failed = [];
  const slow = [];
  for (const { label, host } of diag.pingHosts) {
    try {
      const out = await execPromise('ping', ['-c', '1', '-W', '2', host], { timeout: 5000 });
      const match = out.match(/time=([0-9.]+)/);
      const rtt = match ? parseFloat(match[1]) : 0;
      if (rtt > 100) slow.push(`${label}: ${rtt}ms`);
    } catch (_) {
      failed.push(label);
    }
  }
  if (failed.length > 0) return result('cross-host', 'Cross-host connectivity', 'fail', `${failed.length} host(s) unreachable`, `Unreachable: ${failed.join(', ')}`, Date.now() - start);
  if (slow.length > 0) return result('cross-host', 'Cross-host connectivity', 'warn', 'High latency to hosts', slow.join('; '), Date.now() - start);
  return result('cross-host', 'Cross-host connectivity', 'pass', `All ${diag.pingHosts.length} hosts reachable`, null, Date.now() - start);
}

async function checkDiskUsage(opts) {
  const start = Date.now();
  const mounts = ['/', '/mnt/atlas/claudebox'];
  const warns = [];
  const fails = [];
  for (const mount of mounts) {
    try {
      const out = execFileSync('df', ['-B1', '--output=size,used', mount], { timeout: 5000 }).toString().trim().split('\n');
      const [total, used] = out[1].trim().split(/\s+/).map(Number);
      const pct = Math.round((used / total) * 100);
      if (pct > 90) fails.push(`${mount}: ${pct}%`);
      else if (pct > 80) warns.push(`${mount}: ${pct}%`);
    } catch (_) {
      fails.push(`${mount}: cannot read`);
    }
  }
  if (fails.length > 0) return result('disk-usage', 'Disk usage', 'fail', 'Critical disk usage', fails.concat(warns).join('; '), Date.now() - start);
  if (warns.length > 0) return result('disk-usage', 'Disk usage', 'warn', 'Elevated disk usage', warns.join('; '), Date.now() - start);
  return result('disk-usage', 'Disk usage', 'pass', 'All filesystems within limits', null, Date.now() - start);
}

async function checkDockerDisk(opts) {
  if (!opts.thorough) return null;
  const start = Date.now();
  try {
    const df = await dockerGet('/system/df');
    const totalSize = (df.Images || []).reduce((s, i) => s + (i.Size || 0), 0)
      + (df.Containers || []).reduce((s, c) => s + (c.SizeRw || 0), 0)
      + (df.Volumes || []).reduce((s, v) => s + (v.UsageData?.Size || 0), 0);
    const gb = (totalSize / (1024 ** 3)).toFixed(1);
    return result('docker-disk', 'Docker disk usage', 'pass', `${gb} GB total Docker disk usage`, null, Date.now() - start);
  } catch (e) {
    return result('docker-disk', 'Docker disk usage', 'warn', 'Cannot query Docker disk', e.message, Date.now() - start);
  }
}

async function checkLogSize(opts) {
  if (!opts.thorough) return null;
  const start = Date.now();
  const logDir = `${os.homedir()}/.pm2/logs`;
  try {
    const out = await execPromise('du', ['-sb', logDir], { timeout: 5000 });
    const bytes = parseInt(out.split('\t')[0], 10);
    const mb = Math.round(bytes / (1024 * 1024));
    if (bytes > 1024 * 1024 * 1024) return result('log-size', 'PM2 log size', 'fail', `${mb} MB — exceeds 1 GB`, null, Date.now() - start);
    if (bytes > 500 * 1024 * 1024) return result('log-size', 'PM2 log size', 'warn', `${mb} MB — above 500 MB`, null, Date.now() - start);
    return result('log-size', 'PM2 log size', 'pass', `${mb} MB total`, null, Date.now() - start);
  } catch (_) {
    return result('log-size', 'PM2 log size', 'warn', 'Cannot measure log directory', null, Date.now() - start);
  }
}

async function checkTLSCert(opts) {
  const start = Date.now();
  try {
    const out = execFileSync('openssl', ['x509', '-enddate', '-noout', '-in', diag.tlsCertPath], { timeout: 5000 }).toString().trim();
    const match = out.match(/notAfter=(.+)/);
    if (!match) return result('tls-cert', 'TLS certificate', 'warn', 'Cannot parse cert date', out, Date.now() - start);
    const expiry = new Date(match[1]);
    const daysLeft = Math.floor((expiry - Date.now()) / (1000 * 60 * 60 * 24));
    if (daysLeft < 7) return result('tls-cert', 'TLS certificate', 'fail', `Expires in ${daysLeft} day(s)`, `Expiry: ${expiry.toISOString().slice(0, 10)}`, Date.now() - start);
    if (daysLeft < 14) return result('tls-cert', 'TLS certificate', 'warn', `Expires in ${daysLeft} days`, `Expiry: ${expiry.toISOString().slice(0, 10)}`, Date.now() - start);
    return result('tls-cert', 'TLS certificate', 'pass', `Valid for ${daysLeft} days`, `Expiry: ${expiry.toISOString().slice(0, 10)}`, Date.now() - start);
  } catch (e) {
    return result('tls-cert', 'TLS certificate', 'fail', 'Cannot read certificate', e.message, Date.now() - start);
  }
}

async function checkAuthelia(opts) {
  const start = Date.now();
  const res = await httpPing('http://127.0.0.1:9091/', 3000);
  if (res.ok && res.statusCode === 200) return result('authelia', 'Authelia health', 'pass', `Responding (${res.latency}ms)`, null, Date.now() - start);
  return result('authelia', 'Authelia health', 'fail', 'Not responding', `Status: ${res.statusCode}`, Date.now() - start);
}

async function checkExpectedContainers(opts) {
  const start = Date.now();
  try {
    const containers = await dockerGet('/containers/json?all=1');
    const names = new Set(containers.map(c => (c.Names[0] || '').replace(/^\//, '')));
    const extra = [...names].filter(n => !diag.expectedContainers.includes(n));
    const missing = diag.expectedContainers.filter(n => !names.has(n));
    if (missing.length > 0) return result('expected-containers', 'Expected containers', 'fail', `${missing.length} expected container(s) missing entirely`, `Missing: ${missing.join(', ')}`, Date.now() - start);
    if (extra.length > 0) return result('expected-containers', 'Expected containers', 'warn', `${extra.length} unexpected container(s) found`, `Extra: ${extra.join(', ')}`, Date.now() - start);
    return result('expected-containers', 'Expected containers', 'pass', 'Container list matches expected', null, Date.now() - start);
  } catch (e) {
    return result('expected-containers', 'Expected containers', 'fail', 'Cannot query Docker', e.message, Date.now() - start);
  }
}

async function checkExpectedPM2(opts) {
  const start = Date.now();
  try {
    const list = await pm2List();
    const names = new Set(list.map(p => p.name));
    const missing = diag.expectedPM2.filter(n => !names.has(n));
    const extra = [...names].filter(n => !diag.expectedPM2.includes(n) && list.find(p => p.name === n)?.pm2_env?.status === 'online');
    if (missing.length > 0) return result('expected-pm2', 'Expected PM2 processes', 'fail', `${missing.length} expected process(es) missing`, `Missing: ${missing.join(', ')}`, Date.now() - start);
    if (extra.length > 0) return result('expected-pm2', 'Expected PM2 processes', 'warn', `${extra.length} unexpected online process(es)`, `Extra: ${extra.join(', ')}`, Date.now() - start);
    return result('expected-pm2', 'Expected PM2 processes', 'pass', 'PM2 process list matches expected', null, Date.now() - start);
  } catch (e) {
    return result('expected-pm2', 'Expected PM2 processes', 'fail', 'Cannot query PM2', e.message, Date.now() - start);
  }
}

async function checkGitDirty(opts) {
  if (!opts.thorough) return null;
  const start = Date.now();
  const dirty = [];
  for (const { label, path } of diag.gitRepos) {
    try {
      const out = execFileSync('git', ['-C', path, 'status', '--porcelain'], { timeout: 5000 }).toString().trim();
      if (out.length > 0) {
        const count = out.split('\n').length;
        dirty.push(`${label}: ${count} file(s)`);
      }
    } catch (_) {
      dirty.push(`${label}: cannot check`);
    }
  }
  if (dirty.length > 0) return result('git-dirty', 'Git repo state', 'warn', `${dirty.length} repo(s) have uncommitted changes`, dirty.join('; '), Date.now() - start);
  return result('git-dirty', 'Git repo state', 'pass', 'All repos clean', null, Date.now() - start);
}

// ── Agent behavioral health checks ──

async function checkMemsearchContent(opts) {
  const start = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const now = Date.now();
  const twoHours = 2 * 60 * 60 * 1000;
  const twoDays = 48 * 60 * 60 * 1000;

  const emptyFiles = [];
  const staleFiles = [];

  let projectDirs;
  try {
    projectDirs = fs.readdirSync(projectsDir)
      .filter(d => !d.startsWith('-') && !d.startsWith('.'))
      .map(d => path.join(projectsDir, d));
  } catch (_) {
    return result('memsearch-content', 'Memsearch memory content', 'pass', 'Cannot read projects dir — skipping', null, Date.now() - start);
  }

  for (const dir of projectDirs) {
    const memFile = path.join(dir, '.memsearch', 'memory', `${today}.md`);
    try {
      const stat = fs.statSync(memFile);
      const age = now - stat.mtimeMs;
      if (age < twoHours) continue;

      const content = fs.readFileSync(memFile, 'utf8');
      const hasContent = content.includes('### ');

      if (!hasContent) {
        const name = path.basename(dir);
        if (age > twoDays) staleFiles.push(name);
        else emptyFiles.push(name);
      }
    } catch (_) {
      // File doesn't exist — no sessions in this project today, skip
    }
  }

  if (staleFiles.length > 0) {
    return result('memsearch-content', 'Memsearch memory content', 'fail',
      `${staleFiles.length} project(s) have memory files with no summaries for 48h+`,
      `Missing content: ${staleFiles.join(', ')}`, Date.now() - start);
  }
  if (emptyFiles.length > 0) {
    return result('memsearch-content', 'Memsearch memory content', 'warn',
      `${emptyFiles.length} project(s) have memory files with no summaries today`,
      `Missing content: ${emptyFiles.join(', ')}`, Date.now() - start);
  }
  return result('memsearch-content', 'Memsearch memory content', 'pass',
    'All active project memory files have content', null, Date.now() - start);
}

async function checkDocHealthReport(opts) {
  const start = Date.now();
  const reportPath = path.join(os.homedir(), '.claude', 'memory', 'shared', 'doc-health-report.md');
  const warnAge = 14 * 24 * 60 * 60 * 1000;
  const failAge = 21 * 24 * 60 * 60 * 1000;

  try {
    const stat = fs.statSync(reportPath);
    const age = Date.now() - stat.mtimeMs;
    const days = Math.floor(age / (24 * 60 * 60 * 1000));
    const lastRun = new Date(stat.mtimeMs).toISOString().slice(0, 10);

    if (age > failAge) {
      return result('doc-health-report', 'Doc-health report', 'fail',
        `Report is ${days} days old — agent may not be running`, `Last: ${lastRun}`, Date.now() - start);
    }
    if (age > warnAge) {
      return result('doc-health-report', 'Doc-health report', 'warn',
        `Report is ${days} days old`, `Last: ${lastRun}`, Date.now() - start);
    }
    return result('doc-health-report', 'Doc-health report', 'pass',
      `Last run ${days === 0 ? 'today' : `${days} day(s) ago`}`, `Last: ${lastRun}`, Date.now() - start);
  } catch (_) {
    return result('doc-health-report', 'Doc-health report', 'warn',
      'Report file not found — doc-health may never have run', null, Date.now() - start);
  }
}

async function checkMemorySync(opts) {
  const start = Date.now();
  const sharedDir = path.join(os.homedir(), '.claude', 'memory', 'shared');
  const warnAge = 7 * 24 * 60 * 60 * 1000;

  try {
    const files = fs.readdirSync(sharedDir).filter(f => f.endsWith('.md'));
    if (files.length === 0) {
      return result('memory-sync', 'Memory sync activity', 'warn',
        'No memory files found in shared/', null, Date.now() - start);
    }

    const newest = files.reduce((latest, f) => {
      try {
        const mtime = fs.statSync(path.join(sharedDir, f)).mtimeMs;
        return mtime > latest ? mtime : latest;
      } catch (_) { return latest; }
    }, 0);

    const age = Date.now() - newest;
    const days = Math.floor(age / (24 * 60 * 60 * 1000));

    if (age > warnAge) {
      return result('memory-sync', 'Memory sync activity', 'warn',
        `No memory writes in ${days} days`, null, Date.now() - start);
    }
    return result('memory-sync', 'Memory sync activity', 'pass',
      `Memory last written ${days === 0 ? 'today' : `${days} day(s) ago`}`, null, Date.now() - start);
  } catch (_) {
    return result('memory-sync', 'Memory sync activity', 'warn',
      'Cannot read memory/shared directory', null, Date.now() - start);
  }
}

// ── Check runner ──

const checksByCategory = {
  services: [checkDockerContainers, checkPM2Processes, checkDockerRestarts, checkDeepEndpoints],
  network:  [checkNFSMounts, checkNFSResponsive, checkPorts, checkDNS, checkCrossHost],
  storage:  [checkDiskUsage, checkDockerDisk, checkLogSize],
  security: [checkTLSCert, checkAuthelia],
  config:   [checkExpectedContainers, checkExpectedPM2, checkGitDirty],
  agents:   [checkMemsearchContent, checkDocHealthReport, checkMemorySync],
};

async function runChecks(thorough = false) {
  const opts = { thorough };
  const categories = {};

  for (const [cat, fns] of Object.entries(checksByCategory)) {
    const results = (await Promise.all(fns.map(fn => fn(opts)))).filter(Boolean);
    categories[cat] = { status: worstStatus(results), checks: results };
  }

  const allChecks = Object.values(categories).flatMap(c => c.checks);
  const summary = {
    pass: allChecks.filter(c => c.status === 'pass').length,
    warn: allChecks.filter(c => c.status === 'warn').length,
    fail: allChecks.filter(c => c.status === 'fail').length,
    total: allChecks.length,
  };

  cache = { categories, summary, lastRun: Date.now(), mode: thorough ? 'thorough' : 'lightweight' };
  return cache;
}

function sendNtfy(data) {
  const failures = Object.values(data.categories)
    .flatMap(c => c.checks)
    .filter(c => c.status === 'fail');

  if (failures.length === 0 || !diag.ntfyUrl) return;

  const body = failures.map(f => `FAIL: ${f.label} \u2014 ${f.message}${f.detail ? ` (${f.detail})` : ''}`).join('\n');
  try {
    const url = new URL(diag.ntfyUrl);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: 'POST',
      headers: { Title: `Claudebox: ${failures.length} diagnostic failure(s)`, Priority: 'high', Tags: 'warning' },
    }, () => {});
    req.on('error', () => {});
    req.end(body);
  } catch (_) {}
}

// ── Routes ──

// GET /api/diagnostics — return cached results
router.get('/', (req, res) => {
  if (!cache) return res.json({ categories: {}, summary: { pass: 0, warn: 0, fail: 0, total: 0 }, lastRun: null, mode: null });
  res.json(cache);
});

// POST /api/diagnostics/run — thorough checks
router.post('/run', async (req, res) => {
  try {
    const data = await runChecks(true);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/diagnostics/run-lightweight — lightweight checks + ntfy on failures
router.post('/run-lightweight', async (req, res) => {
  try {
    const data = await runChecks(false);
    sendNtfy(data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
