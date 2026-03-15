const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../../config/config');

const router = express.Router();

const AGENTS_DIR = config.agentsDir;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Validate a bare directory name — no slashes, no traversal
function isValidDirName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  if (name === '.' || name === '..') return false;
  return true;
}

// Resolve a path and confirm it stays within AGENTS_DIR
function resolveAgentPath(requestedPath) {
  try {
    const resolved = fs.realpathSync(requestedPath);
    const base = fs.realpathSync(AGENTS_DIR);
    if (resolved === base || resolved.startsWith(base + path.sep)) return resolved;
    return null;
  } catch (_) { return null; }
}

// Validate a project dir name and return its resolved path, or null
function validateProjectDir(encoded) {
  if (!isValidDirName(encoded)) return null;
  const candidate = path.join(AGENTS_DIR, encoded);
  return resolveAgentPath(candidate);
}

// Read the first `cwd` field from the beginning of a JSONL file (8KB read)
function extractCwd(jsonlPath) {
  try {
    const fd = fs.openSync(jsonlPath, 'r');
    const buf = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const chunk = buf.slice(0, bytesRead).toString('utf-8');
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.cwd) return obj.cwd;
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

// GET /api/agents/projects — list dirs with JSONL sessions (for chat pane)
router.get('/projects', (req, res) => {
  try {
    const entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });
    const projects = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(AGENTS_DIR, entry.name);
      let jsonlFiles;
      try {
        jsonlFiles = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
      } catch (_) { continue; }
      if (!jsonlFiles.length) continue;

      // Display name: basename of cwd from JSONL, fallback to encoded dir name
      let displayName = entry.name;
      const cwd = extractCwd(path.join(dirPath, jsonlFiles[0]));
      if (cwd) displayName = path.basename(cwd);

      // Last activity: most recent JSONL mtime
      let lastActivity = null;
      for (const jf of jsonlFiles) {
        try {
          const mtime = fs.statSync(path.join(dirPath, jf)).mtimeMs;
          if (!lastActivity || mtime > lastActivity) lastActivity = mtime;
        } catch (_) {}
      }

      projects.push({ encoded: entry.name, displayName, sessionCount: jsonlFiles.length, lastActivity });
    }
    projects.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
    res.json(projects);
  } catch (err) {
    console.error('agents/projects error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /api/agents/file-projects — all project dirs (for file pane selector)
router.get('/file-projects', (req, res) => {
  try {
    const entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });
    const projects = entries
      .filter(e => e.isDirectory())
      .map(e => ({ name: e.name, path: path.join(AGENTS_DIR, e.name) }))
      .sort((a, b) => {
        // Short names (no leading -) before encoded ones
        const aEnc = a.name.startsWith('-');
        const bEnc = b.name.startsWith('-');
        if (aEnc !== bEnc) return aEnc ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
    res.json(projects);
  } catch (err) {
    console.error('agents/file-projects error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /api/agents/sessions?encoded=<dirname>
router.get('/sessions', (req, res) => {
  const { encoded } = req.query;
  const dirPath = validateProjectDir(encoded);
  if (!dirPath) return res.status(400).json({ error: 'invalid project' });
  try {
    const jsonlFiles = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
    const sessions = jsonlFiles.map(f => {
      const sessionId = f.replace('.jsonl', '');
      const fullPath = path.join(dirPath, f);
      let created = null, messageCount = 0, preview = '';
      try {
        const stat = fs.statSync(fullPath);
        created = stat.birthtimeMs || stat.ctimeMs;
        const lines = fs.readFileSync(fullPath, 'utf-8').split('\n').filter(l => l.trim());
        let previewFound = false;
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'user' || obj.type === 'assistant') messageCount++;
            if (!previewFound && obj.type === 'user' && Array.isArray(obj.message?.content)) {
              const text = obj.message.content.find(c => c.type === 'text')?.text || '';
              if (text) {
                if (text.length > 80) {
                  const cut = text.slice(0, 80);
                  const lastSpace = cut.lastIndexOf(' ');
                  preview = (lastSpace > 20 ? cut.slice(0, lastSpace) : cut) + '\u2026';
                } else {
                  preview = text;
                }
                previewFound = true;
              }
            }
          } catch (_) {}
        }
      } catch (_) {}
      return { sessionId, created, messageCount, preview };
    });
    sessions.sort((a, b) => (b.created || 0) - (a.created || 0));
    res.json(sessions);
  } catch (err) {
    console.error('agents/sessions error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /api/agents/messages?encoded=<dirname>&session=<uuid>
router.get('/messages', (req, res) => {
  const { encoded, session } = req.query;
  const dirPath = validateProjectDir(encoded);
  if (!dirPath) return res.status(400).json({ error: 'invalid project' });
  if (!UUID_RE.test(session)) return res.status(400).json({ error: 'invalid session id' });

  const jsonlPath = path.join(dirPath, session + '.jsonl');
  const resolved = resolveAgentPath(jsonlPath);
  if (!resolved) return res.status(403).json({ error: 'path not allowed' });

  try {
    const lines = fs.readFileSync(resolved, 'utf-8').split('\n').filter(l => l.trim());

    // Parse user + assistant messages
    const rawMessages = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'user' || obj.type === 'assistant') rawMessages.push(obj);
      } catch (_) {}
    }

    // Deduplicate assistant messages by message.id — keep last per id (streaming chunks)
    const lastAssistant = new Map();
    for (const msg of rawMessages) {
      if (msg.type === 'assistant' && msg.message?.id) {
        lastAssistant.set(msg.message.id, msg);
      }
    }

    const seenIds = new Set();
    const deduped = [];
    for (const msg of rawMessages) {
      if (msg.type === 'user') {
        deduped.push(msg);
      } else if (msg.type === 'assistant' && msg.message?.id) {
        const id = msg.message.id;
        if (!seenIds.has(id)) {
          seenIds.add(id);
          deduped.push(lastAssistant.get(id));
        }
      }
    }

    const slice = deduped.slice(-200);

    const messages = slice.map(msg => {
      if (msg.type === 'user') {
        const content = msg.message?.content || [];
        const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        const toolResultCount = content.filter(c => c.type === 'tool_result').length;
        return { role: 'user', text, toolResultCount, timestamp: msg.timestamp };
      } else {
        const content = msg.message?.content || [];
        const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        const tools = content.filter(c => c.type === 'tool_use').map(c => c.name || 'tool');
        return { role: 'assistant', text, tools, timestamp: msg.timestamp };
      }
    });

    res.json({ messages, total: deduped.length });
  } catch (err) {
    console.error('agents/messages error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /api/agents/files/browse?path=<path>
router.get('/files/browse', (req, res) => {
  const requestedPath = req.query.path;
  if (!requestedPath) return res.status(400).json({ error: 'path required' });
  const resolved = resolveAgentPath(requestedPath);
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
  } catch (err) {
    console.error('agents/files/browse error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /api/agents/files/read?path=<path>  (read-only, no write endpoint)
router.get('/files/read', (req, res) => {
  const requestedPath = req.query.path;
  if (!requestedPath) return res.status(400).json({ error: 'path required' });
  const resolved = resolveAgentPath(requestedPath);
  if (!resolved) return res.status(403).json({ error: 'path not allowed' });
  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) return res.status(400).json({ error: 'path is a directory' });
    if (stat.size > config.maxEditSize) return res.status(413).json({ error: 'file too large' });
    const content = fs.readFileSync(resolved, 'utf-8');
    const ext = path.extname(resolved).toLowerCase();
    res.json({ path: resolved, content, size: stat.size, ext });
  } catch (err) {
    console.error('agents/files/read error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
