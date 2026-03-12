const express = require('express');
const os = require('os');
const { execFileSync } = require('child_process');

const router = express.Router();

function getDisk(mountpoint) {
  try {
    const out = execFileSync('df', ['-B1', '--output=size,used,avail', mountpoint], { timeout: 5000 })
      .toString().trim().split('\n');
    const [total, used, free] = out[1].trim().split(/\s+/).map(Number);
    return { total, used, free };
  } catch (_) { return null; }
}

// GET /api/system
router.get('/', (req, res) => {
  const [load1, load5, load15] = os.loadavg();
  const cores = os.cpus().length;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  const diskMounts = ['/', '/mnt/atlas/claudebox'];
  const disks = diskMounts.map(mount => {
    const d = getDisk(mount);
    return d ? { mount, ...d } : null;
  }).filter(Boolean);

  res.json({
    cpu: { load1, load5, load15, cores },
    memory: { total: totalMem, free: freeMem, used: totalMem - freeMem },
    disks,
    uptime: os.uptime(),
  });
});

module.exports = router;
