const express = require('express');
const http = require('http');

const router = express.Router();

function dockerGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      socketPath: '/var/run/docker.sock',
      path,
      headers: { Host: 'localhost' },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('Docker socket timeout')); });
  });
}

// GET /api/docker/containers
router.get('/containers', async (req, res) => {
  try {
    const raw = await dockerGet('/containers/json?all=1');
    const containers = raw.map(c => ({
      id: c.Id.slice(0, 12),
      name: (c.Names[0] || '?').replace(/^\//, ''),
      image: c.Image,
      state: c.State,
      status: c.Status,
      created: c.Created,
    })).sort((a, b) => {
      if (a.state !== b.state) {
        if (a.state === 'running') return -1;
        if (b.state === 'running') return 1;
      }
      return a.name.localeCompare(b.name);
    });
    res.json(containers);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
