const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const config = require('../config/config');

// Load .env manually — no dotenv dependency needed
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
  });
}

const PANEL_TOKEN = process.env.PANEL_TOKEN;
if (!PANEL_TOKEN) {
  console.error('FATAL: PANEL_TOKEN not set. Refusing to start.');
  process.exit(1);
}

function tokenAuth(req, res, next) {
  const token = req.headers['x-panel-token'];
  if (token && token === PANEL_TOKEN) return next();
  res.status(401).json({ error: 'unauthorized' });
}

const filesRouter = require('./routes/files');
const pm2Router = require('./routes/pm2');
const healthRouter = require('./routes/health');
const systemRouter = require('./routes/system');
const dockerRouter = require('./routes/docker');

const app = express();

app.use(cors({
  origin: config.allowedOrigins,
  methods: ['GET', 'POST'],
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '../public')));

app.use('/api/files', tokenAuth, filesRouter);
app.use('/api/pm2', tokenAuth, pm2Router);
app.use('/api/health', tokenAuth, healthRouter);
app.use('/api/system', tokenAuth, systemRouter);
app.use('/api/docker', tokenAuth, dockerRouter);

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(config.port, '0.0.0.0', () => {
  console.log(`claudebox-panel running on port ${config.port}`);
});
