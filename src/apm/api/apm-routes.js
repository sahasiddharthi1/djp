const express      = require('express');
const traceStorage = require('../storage/trace-storage');
const { metrics }  = require('../../observability/metrics');
const router       = express.Router();

router.get('/traces',              (req, res) => res.json(traceStorage.query(req.query)));
router.get('/traces/:id',          (req, res) => {
  const t = traceStorage.getTrace(req.params.id);
  t ? res.json(t) : res.status(404).json({ error: 'Not found' });
});
router.get('/traces/:id/flamegraph',(req, res) => {
  const d = traceStorage.getFlamegraphData(req.params.id);
  d ? res.json({ traceId: req.params.id, flamegraph: d })
    : res.status(404).json({ error: 'Not found' });
});
router.get('/aggregations', (req, res) => res.json(traceStorage.getAggregations()));
router.get('/stats',        (req, res) => res.json({ traces: traceStorage.getStats(), runtime: metrics.snapshot() }));
router.get('/services',     (req, res) => res.json({ services: traceStorage.getStats().services }));

module.exports = router;