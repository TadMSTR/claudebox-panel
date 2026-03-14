const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const config = require('../config/config');

// Load .env manually — no dotenv dependency needed
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) return;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    if (key) process.env[key] = val;
  });
}

const PANEL_TOKEN = process.env.PANEL_TOKEN;
if (!PANEL_TOKEN) {
  console.error('FATAL: PANEL_TOKEN not set. Refusing to start.');
  process.exit(1);
}

function tokenAuth(req, res, next) {
  const token = req.headers['x-panel-token'];
  if (token && token.length === PANEL_TOKEN.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(PANEL_TOKEN))) {
    return next();
  }
  res.status(401).json({ error: 'unauthorized' });
}

const filesRouter    = require('./routes/files');
const pm2Router      = require('./routes/pm2');
const healthRouter   = require('./routes/health');
const systemRouter   = require('./routes/system');
const dockerRouter   = require('./routes/docker');
const backrestRouter     = require('./routes/backrest');
const diagnosticsRouter  = require('./routes/diagnostics');

const app = express();

app.use(cors({
  origin: config.allowedOrigins,
  methods: ['GET', 'POST', 'DELETE'],
  credentials: true,
}));
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; " +
    "connect-src 'self'; " +
    "img-src 'none'; frame-src 'none';"
  );
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, '../public')));

app.use('/api/files', tokenAuth, filesRouter);
app.use('/api/pm2', tokenAuth, pm2Router);
app.use('/api/health', tokenAuth, healthRouter);
app.use('/api/system', tokenAuth, systemRouter);
app.use('/api/docker',   tokenAuth, dockerRouter);
app.use('/api/backrest', tokenAuth, backrestRouter);
app.use('/api/diagnostics', tokenAuth, diagnosticsRouter);

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(config.port, '0.0.0.0', () => {
  console.log(`claudebox-panel running on port ${config.port}`);
});
