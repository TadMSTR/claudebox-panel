const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../../config/config');

const router = express.Router();

function getAllowedBases() {
  return config.filePaths.map(p => p.path);
}

function isAllowed(resolvedPath) {
  const bases = getAllowedBases();
  return bases.some(base => {
    const resolvedBase = path.resolve(base);
    return resolvedPath === resolvedBase || resolvedPath.startsWith(resolvedBase + path.sep);
  });
}

function resolve(requestedPath) {
  const resolved = path.resolve(requestedPath);
  if (!isAllowed(resolved)) return null;
  return resolved;
}

// GET /api/files/roots
router.get('/roots', (req, res) => {
  res.json(config.filePaths.map(e => ({ label: e.label, path: e.path, type: e.type })));
});

// GET /api/files/browse?path=<path>
router.get('/browse', (req, res) => {
  const requestedPath = req.query.path;
  if (!requestedPath) return res.status(400).json({ error: 'path required' });
  const resolved = resolve(requestedPath);
  if (!resolved) return res.status(403).json({ error: 'path not allowed' });
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return res.status(400).json({ error: 'not a directory' });
    const entries = fs.readdirSync(resolved, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.') || e.name === '.gitignore')
      .map(e => {
        const fullPath = path.join(resolved, e.name);
        const isDir = e.isDirectory();
        let size = null;
        try { if (!isDir) size = fs.statSync(fullPath).size; } catch (_) {}
        return { name: e.name, path: fullPath, type: isDir ? 'dir' : 'file',
                 ext: isDir ? null : path.extname(e.name).toLowerCase(), size };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    res.json({ path: resolved, entries });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/files/read?path=<path>
router.get('/read', (req, res) => {
  const requestedPath = req.query.path;
  if (!requestedPath) return res.status(400).json({ error: 'path required' });
  const resolved = resolve(requestedPath);
  if (!resolved) return res.status(403).json({ error: 'path not allowed' });
  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) return res.status(400).json({ error: 'path is a directory' });
    if (stat.size > config.maxEditSize)
      return res.status(413).json({ error: `file too large (${stat.size} bytes)` });
    const ext = path.extname(resolved).toLowerCase();
    const editable = config.editableExtensions.includes(ext);
    const content = fs.readFileSync(resolved, 'utf-8');
    res.json({ path: resolved, content, editable, size: stat.size, ext });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/files/write
router.post('/write', (req, res) => {
  const { filePath, content } = req.body;
  if (!filePath || content === undefined)
    return res.status(400).json({ error: 'filePath and content required' });
  const resolved = resolve(filePath);
  if (!resolved) return res.status(403).json({ error: 'path not allowed' });
  const ext = path.extname(resolved).toLowerCase();
  if (!config.editableExtensions.includes(ext))
    return res.status(403).json({ error: 'file type not editable' });
  try {
    fs.writeFileSync(resolved, content, 'utf-8');
    res.json({ ok: true, path: resolved });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
