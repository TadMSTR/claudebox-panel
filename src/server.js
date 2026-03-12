const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('../config/config');

const filesRouter = require('./routes/files');
const pm2Router = require('./routes/pm2');
const healthRouter = require('./routes/health');

const app = express();

app.use(cors({
  origin: config.allowedOrigins,
  methods: ['GET', 'POST'],
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '../public')));

app.use('/api/files', filesRouter);
app.use('/api/pm2', pm2Router);
app.use('/api/health', healthRouter);

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(config.port, '0.0.0.0', () => {
  console.log(`claudebox-panel running on port ${config.port}`);
});
