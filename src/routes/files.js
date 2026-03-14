const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../../config/config');

const router = express.Router();

const BACKUP_EXT = '.panelbak';
const BACKUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getAllowedBases() {
  return config.filePaths.map(p => p.path);
}

function isAllowed(resolvedPath) {
  const bases = getAllowedBases();
  return bases.some(base => {
    try {
      const resolvedBase = fs.realpathSync(base);
      return resolvedPath === resolvedBase || resolvedPath.startsWith(resolvedBase + path.sep);
    } catch (_) { return false; }
  });
}

// Allow access to .panelbak files that sit alongside an allowed file
function isAllowedBackup(resolvedPath) {
  if (!resolvedPath.endsWith(BACKUP_EXT)) return false;
  const original = resolvedPath.slice(0, -BACKUP_EXT.length);
  return isAllowed(original);
}

function resolve(requestedPath) {
  // For .panelbak files, the file itself may not exist yet (write hasn't happened), so we can't
  // realpathSync the full path. Instead, realpathSync the parent directory (which must exist) and
  // reconstruct — this dereferences any symlinks in the directory hierarchy without requiring the
  // backup file itself to be present.
  if (requestedPath.endsWith(BACKUP_EXT)) {
    const abs = path.resolve(requestedPath);
    let parentReal;
    try { parentReal = fs.realpathSync(path.dirname(abs)); } catch (_) { return null; }
    const resolved = path.join(parentReal, path.basename(abs));
    if (isAllowedBackup(resolved)) return resolved;
    return null;
  }
  try {
    const resolved = fs.realpathSync(requestedPath);
    if (!isAllowed(resolved)) return null;
    return resolved;
  } catch (_) { return null; }
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
      .filter(e => !e.name.endsWith(BACKUP_EXT)) // hide .panelbak files from tree
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
  } catch (err) { console.error('browse error:', err); res.status(500).json({ error: 'internal error' }); }
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
    // Check if a backup exists for this file
    const backupPath = resolved + BACKUP_EXT;
    const hasBackup = fs.existsSync(backupPath);
    res.json({ path: resolved, content, editable, size: stat.size, ext, hasBackup });
  } catch (err) { console.error('read error:', err); res.status(500).json({ error: 'internal error' }); }
});

// POST /api/files/write
router.post('/write', (req, res) => {
  const { filePath, content } = req.body;
  if (!filePath || content === undefined)
    return res.status(400).json({ error: 'filePath and content required' });
  if (Buffer.byteLength(content, 'utf-8') > config.maxEditSize)
    return res.status(413).json({ error: `content too large (max ${config.maxEditSize} bytes)` });
  const resolved = resolve(filePath);
  if (!resolved) return res.status(403).json({ error: 'path not allowed' });
  const ext = path.extname(resolved).toLowerCase();
  if (!config.editableExtensions.includes(ext))
    return res.status(403).json({ error: 'file type not editable' });
  try {
    // Back up the current file before overwriting (only if no backup exists yet —
    // preserves the true original across multiple saves in one session)
    const backupPath = resolved + BACKUP_EXT;
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(resolved, backupPath);
    }
    fs.writeFileSync(resolved, content, 'utf-8');
    res.json({ ok: true, path: resolved, backup: backupPath });
  } catch (err) { console.error('write error:', err); res.status(500).json({ error: 'internal error' }); }
});

// POST /api/files/restore  — restore from .panelbak, then delete the backup
router.post('/restore', (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'filePath required' });
  const resolved = resolve(filePath);
  if (!resolved) return res.status(403).json({ error: 'path not allowed' });
  const backupPath = resolved + BACKUP_EXT;
  if (!fs.existsSync(backupPath))
    return res.status(404).json({ error: 'no backup found for this file' });
  try {
    const backupContent = fs.readFileSync(backupPath, 'utf-8');
    fs.writeFileSync(resolved, backupContent, 'utf-8');
    fs.unlinkSync(backupPath);
    res.json({ ok: true, path: resolved, restored: true });
  } catch (err) { console.error('restore error:', err); res.status(500).json({ error: 'internal error' }); }
});

// DELETE /api/files/backup — discard the backup (call after intentional save is confirmed)
router.delete('/backup', (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'filePath required' });
  const resolved = resolve(filePath);
  if (!resolved) return res.status(403).json({ error: 'path not allowed' });
  const backupPath = resolved + BACKUP_EXT;
  try {
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
    res.json({ ok: true });
  } catch (err) { console.error('backup delete error:', err); res.status(500).json({ error: 'internal error' }); }
});

// Cleanup stale .panelbak files on startup
(function cleanupOldBackups() {
  const now = Date.now();
  for (const entry of config.filePaths) {
    if (entry.type !== 'dir') continue;
    try {
      const walk = [entry.path];
      while (walk.length) {
        const dir = walk.pop();
        for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, d.name);
          if (d.isDirectory()) { walk.push(full); continue; }
          if (!d.name.endsWith(BACKUP_EXT)) continue;
          try {
            const stat = fs.statSync(full);
            if (now - stat.mtimeMs > BACKUP_MAX_AGE_MS) {
              fs.unlinkSync(full);
              console.log(`cleaned up stale backup: ${full}`);
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
  }
})();

module.exports = router;
