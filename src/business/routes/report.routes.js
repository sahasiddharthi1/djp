/**
 * routes/report.routes.js
 *
 * POST /reports/generate   → queue a report generation job
 * GET  /reports            → my reports list
 * GET  /reports/:id        → single report status + download url
 */

const express         = require('express');
const db              = require('../db');
const { requireAuth } = require('../auth');
const store           = require('../../core/job-store');

const router = express.Router();

// ── POST /reports/generate ────────────────────────────────────────────────
router.post('/generate', requireAuth, async (req, res) => {
  try {
    const { type = 'order-history', params = {} } = req.body;

    const validTypes = ['order-history', 'spending-summary', 'product-report'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
    }

    // Create report record in DB (status: pending)
    const report = db.createReport({ userId: req.user.id, type, params });

    // Background job: generate the report
    const job = await store.enqueue({
      type:         'generate-report',
      partitionKey: `user-${req.user.id}`,
      payload: {
        reportId: report.id,
        userId:   req.user.id,
        type,
        params,
      },
    });

    res.status(202).json({
      message:  'Report generation queued',
      reportId: report.id,
      jobId:    job.jobId,
      status:   'pending',
      note:     `Poll GET /reports/${report.id} to check when ready`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /reports ──────────────────────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const myReports = db.getReportsByUser(req.user.id);
  res.json({ reports: myReports, total: myReports.length });
});

// ── GET /reports/:id ──────────────────────────────────────────────────────
router.get('/:id', requireAuth, (req, res) => {
  const report = db.getReportById(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  if (report.userId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
  res.json(report);
});

module.exports = router;