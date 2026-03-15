const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const http = require('http');
const config = require('../../config/config');

const router = express.Router();
const cfg = config.depUpdates;

// In-memory task map: taskId → { status, output, error, startedAt }
const tasks = new Map();
let taskCounter = 0;

// In-process mutex — prevents concurrent apply runs within the same panel process
// (panel-vs-cron conflicts are handled by the shell script's own flock)
let updateInProgress = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

function readSidecar() {
  try {
    const raw = fs.readFileSync(cfg.jsonPath, 'utf-8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function mergePinningAndAllowlist(sidecar) {
  if (!sidecar) return null;
  const deps = sidecar.dependencies.map(dep => {
    const pinned = cfg.pinned[dep.name] || null;
    // breaking = majorBump AND not in allowlist, OR pinned
    // allowlist presence overrides majorBump (allowlist IS the override mechanism)
    const breaking = !!(dep.majorBump && !cfg.safeUpdateCommands[dep.name]) || !!pinned;
    const canSafeUpdate = !!(
      cfg.safeUpdateCommands[dep.name] &&
      !pinned &&
      dep.updateAvailable &&
      !breaking
    );
    return { ...dep, pinned: !!pinned, pinnedReason: pinned?.reason || null, breaking, canSafeUpdate };
  });
  return { ...sidecar, dependencies: deps };
}

function appendAuditEntry(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFileSync(cfg.auditLogPath, line, { encoding: 'utf-8' });
}

// Lazy expiration — remove tasks older than 1 hour on access
function getTask(id) {
  const task = tasks.get(id);
  if (!task) return null;
  if (Date.now() - task.startedAt > 3600000) { tasks.delete(id); return null; }
  return task;
}

// ── GET /api/updates ──────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const sidecar = readSidecar();
  if (!sidecar) return res.json({ data: null, message: 'No check data yet — run a check first.' });
  res.json({ data: mergePinningAndAllowlist(sidecar) });
});

// ── POST /api/updates/check ───────────────────────────────────────────────────

router.post('/check', (req, res) => {
  execFile('bash', [cfg.checkScript], { timeout: 120000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: 'Check script failed', details: stderr || err.message });
    const sidecar = readSidecar();
    res.json({ ok: true, data: mergePinningAndAllowlist(sidecar) });
  });
});

// ── POST /api/updates/apply ───────────────────────────────────────────────────

router.post('/apply', (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });

  const cmd = cfg.safeUpdateCommands[name];
  if (!cmd) return res.status(403).json({ error: 'Package not in safe-update allowlist' });

  if (cfg.pinned[name]) return res.status(403).json({ error: 'Package is pinned' });

  // In-process mutex — prevents concurrent applies from the same panel process
  if (updateInProgress) return res.status(409).json({ error: 'Update already in progress' });
  updateInProgress = true;

  const taskId = `task-${++taskCounter}`;
  tasks.set(taskId, { status: 'running', output: '', error: null, startedAt: Date.now() });

  // Note: commands in safeUpdateCommands must not use quoted/space-containing arguments
  const parts = cmd.split(/\s+/);
  const proc = execFile(parts[0], parts.slice(1), { timeout: 120000 }, (err, stdout, stderr) => {
    updateInProgress = false;
    const task = tasks.get(taskId);
    if (!task) return;
    const duration = Date.now() - task.startedAt;
    if (err) {
      tasks.set(taskId, { ...task, status: 'failed', output: stdout, error: stderr || err.message, duration });
      appendAuditEntry({ pkg: name, type: 'safe-update', method: 'panel', status: 'failed', notes: stderr || err.message });
    } else {
      tasks.set(taskId, { ...task, status: 'success', output: stdout, error: null, duration });
      appendAuditEntry({ pkg: name, type: 'safe-update', method: 'panel', status: 'success', notes: `cmd: ${cmd}` });
    }
  });

  proc.on('error', err => {
    updateInProgress = false;
    const task = tasks.get(taskId);
    if (task) tasks.set(taskId, { ...task, status: 'failed', error: err.message, duration: Date.now() - task.startedAt });
  });

  res.json({ taskId });
});

// ── GET /api/updates/task/:id ─────────────────────────────────────────────────

router.get('/task/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found or expired' });
  res.json(task);
});

// ── POST /api/updates/delegate ────────────────────────────────────────────────

router.post('/delegate', (req, res) => {
  const { name, type, from, to } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });

  // Validate name against known tracked dependencies
  const sidecar = readSidecar();
  const knownNames = sidecar ? sidecar.dependencies.map(d => d.name) : [];
  if (!knownNames.includes(name)) return res.status(400).json({ error: 'Unknown package' });

  const message = `Update ${name} (${type || 'unknown'}) from ${from || '?'} to ${to || 'latest'}.\n\nThis is a breaking change (major version bump). Check the changelog, apply the update, verify the service, and write an audit entry.`;

  const postBody = JSON.stringify({
    projectPath: cfg.depUpdatesProject,
    message,
    provider: 'claude',
  });

  const reqOpts = {
    hostname: '127.0.0.1',
    port: 3004,
    path: '/api/agent',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postBody) },
  };

  const proxyReq = http.request(reqOpts, proxyRes => {
    proxyRes.resume(); // we don't need the stream body
    appendAuditEntry({ pkg: name, type: type || 'unknown', from, to, method: 'agent', status: 'delegated', notes: 'Sent to CloudCLI dep-updates project' });
    res.json({ ok: true, message: 'Delegated to CloudCLI agent' });
  });

  proxyReq.on('error', err => {
    res.status(502).json({ error: 'CloudCLI unreachable', details: err.message });
  });

  proxyReq.setTimeout(5000, () => {
    proxyReq.destroy();
    res.status(504).json({ error: 'CloudCLI timeout' });
  });

  proxyReq.write(postBody);
  proxyReq.end();
});

// ── GET /api/updates/audit ────────────────────────────────────────────────────

router.get('/audit', (req, res) => {
  try {
    const raw = fs.readFileSync(cfg.auditLogPath, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const entries = lines.slice(-50).map(line => {
      try { return JSON.parse(line); } catch (_) { return null; }
    }).filter(Boolean);
    res.json({ entries: entries.reverse() }); // newest first
  } catch (err) {
    if (err.code === 'ENOENT') return res.json({ entries: [] });
    res.status(500).json({ error: 'Failed to read audit log' });
  }
});

module.exports = router;
