const express = require('express');
const router = express.Router();

const BACKREST_URL      = (process.env.BACKREST_URL ?? 'http://localhost:9898').replace(/\/$/, '');
const BACKREST_USERNAME = process.env.BACKREST_USERNAME ?? '';
const BACKREST_PASSWORD = process.env.BACKREST_PASSWORD ?? '';

function authHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (BACKREST_USERNAME && BACKREST_PASSWORD) {
    const encoded = Buffer.from(`${BACKREST_USERNAME}:${BACKREST_PASSWORD}`).toString('base64');
    headers['Authorization'] = `Basic ${encoded}`;
  }
  return headers;
}

const ID_PATTERN = /^[\w-]{1,128}$/;

// GET /api/backrest/operations?limit=20&planId=...&repoId=...
router.get('/operations', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const selector = {};
    if (req.query.planId) {
      if (!ID_PATTERN.test(req.query.planId)) return res.status(400).json({ error: 'invalid planId' });
      selector.planId = req.query.planId;
    }
    if (req.query.repoId) {
      if (!ID_PATTERN.test(req.query.repoId)) return res.status(400).json({ error: 'invalid repoId' });
      selector.repoId = req.query.repoId;
    }

    const response = await fetch(`${BACKREST_URL}/v1.Backrest/GetOperations`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ selector }),
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      return res.status(502).json({ error: `Backrest API error ${response.status}: ${text}` });
    }

    const data = await response.json();
    const operations = (data.operations ?? []).reverse().slice(0, limit);
    res.json({ operations });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
