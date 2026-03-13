const express = require('express');
const pm2 = require('pm2');
const fs = require('fs');
const os = require('os');

const router = express.Router();

function connectPM2() {
  return new Promise((resolve, reject) => {
    pm2.connect(true, err => err ? reject(err) : resolve());
  });
}
function listPM2() {
  return new Promise((resolve, reject) => {
    pm2.list((err, list) => err ? reject(err) : resolve(list));
  });
}
function pm2Action(action, name) {
  return new Promise((resolve, reject) => {
    pm2[action](name, (err, result) => err ? reject(err) : resolve(result));
  });
}

// GET /api/pm2/list
router.get('/list', async (req, res) => {
  try {
    await connectPM2();
    const list = await listPM2();
    pm2.disconnect();
    const processes = list.map(proc => {
      const env = proc.pm2_env || {};
      return { name: proc.name, pid: proc.pid, status: env.status,
               uptime: env.pm_uptime, restarts: env.restart_time,
               cpu: proc.monit?.cpu ?? null, memory: proc.monit?.memory ?? null,
               cron: env.cron_restart || null, script: env.pm_exec_path || null };
    }).sort((a, b) => {
      if (a.status !== b.status) { if (a.status === 'online') return -1; if (b.status === 'online') return 1; }
      return a.name.localeCompare(b.name);
    });
    res.json(processes);
  } catch (err) { pm2.disconnect(); console.error('pm2 list error:', err); res.status(500).json({ error: 'pm2 error' }); }
});

// Processes that cannot be stopped/reloaded from the panel (restart is OK)
const PROTECTED_PROCESSES = ['agent-panel'];

// Validate name matches a real PM2 process (prevents path traversal in log reads too)
async function isValidPM2Process(name) {
  try {
    await connectPM2();
    const list = await listPM2();
    pm2.disconnect();
    return list.some(p => p.name === name);
  } catch (_) { pm2.disconnect(); return false; }
}

// POST /api/pm2/action
router.post('/action', async (req, res) => {
  const { action, name } = req.body;
  const allowed = ['restart', 'stop', 'reload'];
  if (!allowed.includes(action)) return res.status(400).json({ error: `action must be one of: ${allowed.join(', ')}` });
  if (!name) return res.status(400).json({ error: 'name required' });
  if (PROTECTED_PROCESSES.includes(name) && action !== 'restart')
    return res.status(403).json({ error: `cannot ${action} protected process: ${name}` });
  if (!(await isValidPM2Process(name)))
    return res.status(404).json({ error: `unknown process: ${name}` });
  try {
    await connectPM2();
    await pm2Action(action, name);
    pm2.disconnect();
    res.json({ ok: true, action, name });
  } catch (err) { pm2.disconnect(); console.error('pm2 action error:', err); res.status(500).json({ error: 'pm2 error' }); }
});

// GET /api/pm2/logs?name=<process>&lines=100
router.get('/logs', async (req, res) => {
  const { name, lines = 100 } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });
  // Validate against actual PM2 processes to prevent path traversal
  if (!(await isValidPM2Process(name)))
    return res.status(404).json({ error: `unknown process: ${name}` });
  const logPath = `${os.homedir()}/.pm2/logs/${name}-out.log`;
  const errPath = `${os.homedir()}/.pm2/logs/${name}-error.log`;
  function tailFile(filePath, n) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const clamped = Math.min(Math.abs(parseInt(n, 10) || 100), 1000);
      return content.split('\n').slice(-clamped).join('\n');
    } catch (_) { return null; }
  }
  res.json({ name, stdout: tailFile(logPath, lines), stderr: tailFile(errPath, lines) });
});

module.exports = router;
