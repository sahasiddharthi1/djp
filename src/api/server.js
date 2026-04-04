// /**
//  * API Server — Express REST API
//  * Uses the shared in-memory store singleton directly.
//  */

// const express    = require('express');
// const store      = require('../core/job-store');
// const { metrics } = require('../observability/metrics');

// function createAPI(workerPool = null) {
//   const app = express();
//   app.use(express.json());

//   // Allow dashboard HTML (opened from file://) to call this API
//   app.use((req, res, next) => {
//     res.setHeader('Access-Control-Allow-Origin', '*');
//     res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
//     res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
//     if (req.method === 'OPTIONS') return res.sendStatus(204);
//     next();
//   });

//   // ── POST /jobs — enqueue ───────────────────────────────────────────────
//   app.post('/jobs', async (req, res) => {
//     try {
//       const {
//         type, payload, partitionKey, priority,
//         runAt, deduplicationId, maxRetries,
//       } = req.body;

//       if (!type) return res.status(400).json({ error: 'type is required' });

//       // Backpressure check
//       const stats        = await store.getStats();
//       const depth        = Object.values(stats.partitions).reduce((s, p) => s + p.streamLength, 0);
//       const maxQueueSize = parseInt(process.env.MAX_QUEUE_SIZE || '100000');
//       const threshold    = parseFloat(process.env.BACKPRESSURE_THRESHOLD || '0.8');

//       if (depth > maxQueueSize * threshold) {
//         return res.status(429).json({
//           error: 'Backpressure: queue too full',
//           queueDepth: depth,
//           retryAfterMs: 1000,
//         });
//       }

//       const result = await store.enqueue({
//         type, payload, partitionKey, priority, runAt, deduplicationId, maxRetries,
//       });

//       if (result.duplicate) {
//         return res.status(200).json({ message: 'Duplicate ignored (idempotency key seen)', deduplicationId });
//       }

//       res.status(202).json({
//         jobId:      result.jobId,
//         partitionKey: result.partitionKey,
//         scheduled:  result.scheduled,
//         message:    result.scheduled ? 'Scheduled for future execution' : 'Queued',
//       });
//     } catch (err) {
//       res.status(500).json({ error: err.message });
//     }
//   });

//   // ── GET /jobs/:id ──────────────────────────────────────────────────────
//   app.get('/jobs/:id', async (req, res) => {
//     const job = await store.getJob(req.params.id);
//     if (!job) return res.status(404).json({ error: 'Not found' });
//     const { _streamPartition, _streamIndex, _entryId, ...pub } = job;
//     res.json(pub);
//   });

//   // ── GET /stats ─────────────────────────────────────────────────────────
//   app.get('/stats', async (req, res) => {
//     const qStats = await store.getStats();

//     let workerStats = null;
//     if (workerPool) {
//       workerStats = {
//         workerCount: workerPool.workers.size,
//         workers: [...workerPool.workers.entries()].map(([id, w]) => ({
//           id,
//           partitions:     w.partitions,
//           activeJobs:     w.activeJobs.size,
//           maxConcurrency: w.maxConcurrency,
//           utilization:    (w.activeJobs.size / w.maxConcurrency * 100).toFixed(1) + '%',
//         })),
//       };
//     }

//     res.json({
//       queue:     qStats,
//       workers:   workerStats,
//       metrics:   metrics.snapshot(),
//       timestamp: new Date().toISOString(),
//     });
//   });

//   // ── GET /dlq ───────────────────────────────────────────────────────────
//   app.get('/dlq', async (req, res) => {
//     const page  = parseInt(req.query.page  || '0');
//     const limit = parseInt(req.query.limit || '20');
//     const jobs  = await store.getDLQJobs(page * limit, page * limit + limit - 1);
//     res.json({ jobs, total: store.dlq.length, page, limit });
//   });

//   // ── POST /dlq/:id/retry ────────────────────────────────────────────────
//   app.post('/dlq/:id/retry', async (req, res) => {
//     const job = await store.retryDLQJob(req.params.id);
//     if (!job) return res.status(404).json({ error: 'Not found in DLQ' });
//     res.json({ message: 'Re-queued from DLQ', job });
//   });

//   // ── GET /health ────────────────────────────────────────────────────────
//   app.get('/health', (req, res) => {
//     res.json({
//       status:  'healthy',
//       storage: 'in-memory',
//       workers: workerPool ? workerPool.workers.size : 0,
//       uptime:  process.uptime().toFixed(1) + 's',
//       memory:  {
//         heapUsedMB:  (process.memoryUsage().heapUsed  / 1024 / 1024).toFixed(1),
//         heapTotalMB: (process.memoryUsage().heapTotal / 1024 / 1024).toFixed(1),
//       },
//       timestamp: new Date().toISOString(),
//     });
//   });

//   // ── GET /metrics (JSON, no Prometheus needed) ─────────────────────────
//   app.get('/metrics', (req, res) => res.json(metrics.snapshot()));

//   return app;
// }

// module.exports = createAPI;
/**
 * api/server.js — Express REST API
 * Jobs endpoints + APM routes mounted at /apm
 */

// const express           = require('express');
// const store             = require('../core/job-store');
// const { metrics }       = require('../observability/metrics');
// const { apmMiddleware } = require('../apm/sdk/patcher');
// const apmRoutes         = require('../apm/api/apm-routes');

// function createAPI(workerPool = null) {
//   const app = express();
//   app.use(express.json());

//   // CORS — allow dashboard opened from file:// or localhost:8080
//   app.use((req, res, next) => {
//     res.setHeader('Access-Control-Allow-Origin',  '*');
//     res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
//     res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
//     if (req.method === 'OPTIONS') return res.sendStatus(204);
//     next();
//   });

//   // APM middleware — auto-traces every request
//   app.use(apmMiddleware);

//   // ── POST /jobs ────────────────────────────────────────────────────────
//   app.post('/jobs', async (req, res) => {
//     try {
//       const { type, payload, partitionKey, priority, runAt, deduplicationId, maxRetries } = req.body;
//       if (!type) return res.status(400).json({ error: 'type is required' });

//       const stats = await store.getStats();
//       const depth = Object.values(stats.partitions).reduce((s, p) => s + p.streamLength, 0);
//       const max   = parseInt(process.env.MAX_QUEUE_SIZE || '100000');
//       const thr   = parseFloat(process.env.BACKPRESSURE_THRESHOLD || '0.8');

//       if (depth > max * thr) {
//         return res.status(429).json({ error: 'Backpressure: queue too full', retryAfterMs: 1000 });
//       }

//       const result = await store.enqueue({ type, payload, partitionKey, priority, runAt, deduplicationId, maxRetries });
//       if (result.duplicate) {
//         return res.status(200).json({ message: 'Duplicate ignored (idempotency key seen)', deduplicationId });
//       }

//       res.status(202).json({
//         jobId:        result.jobId,
//         partitionKey: result.partitionKey,
//         scheduled:    result.scheduled,
//         message:      result.scheduled ? 'Scheduled' : 'Queued',
//       });
//     } catch (err) {
//       res.status(500).json({ error: err.message });
//     }
//   });

//   // ── GET /jobs/:id ─────────────────────────────────────────────────────
//   app.get('/jobs/:id', async (req, res) => {
//     const job = await store.getJob(req.params.id);
//     if (!job) return res.status(404).json({ error: 'Not found' });
//     const { _streamPartition, _streamIndex, _entryId, ...pub } = job;
//     res.json(pub);
//   });

//   // ── GET /stats ────────────────────────────────────────────────────────
//   app.get('/stats', async (req, res) => {
//     const qStats = await store.getStats();
//     res.json({
//       queue: qStats,
//       workers: workerPool ? {
//         workerCount: workerPool.workers.size,
//         workers: [...workerPool.workers.entries()].map(([id, w]) => ({
//           id,
//           partitions:     w.partitions,
//           activeJobs:     w.activeJobs.size,
//           maxConcurrency: w.maxConcurrency,
//           utilization:    (w.activeJobs.size / w.maxConcurrency * 100).toFixed(1) + '%',
//         })),
//       } : null,
//       metrics:   metrics.snapshot(),
//       timestamp: new Date().toISOString(),
//     });
//   });

//   // ── GET /dlq ──────────────────────────────────────────────────────────
//   app.get('/dlq', async (req, res) => {
//     const jobs = await store.getDLQJobs();
//     res.json({ jobs, total: store.dlq.length });
//   });

//   // ── POST /dlq/:id/retry ───────────────────────────────────────────────
//   app.post('/dlq/:id/retry', async (req, res) => {
//     const job = await store.retryDLQJob(req.params.id);
//     job ? res.json({ message: 'Re-queued from DLQ', job })
//         : res.status(404).json({ error: 'Not found in DLQ' });
//   });

//   // ── GET /health ───────────────────────────────────────────────────────
//   app.get('/health', (req, res) => {
//     res.json({
//       status:  'healthy',
//       storage: 'in-memory',
//       workers: workerPool?.workers.size || 0,
//       uptime:  process.uptime().toFixed(1) + 's',
//       memory:  { heapUsedMB: metrics.heapUsedMB, heapTotalMB: metrics.heapTotalMB },
//       timestamp: new Date().toISOString(),
//     });
//   });

//   // ── GET /metrics ──────────────────────────────────────────────────────
//   app.get('/metrics', (req, res) => res.json(metrics.snapshot()));

//   // ── /apm/* ────────────────────────────────────────────────────────────
//   app.use('/apm', apmRoutes);

//   return app;
// }

// module.exports = createAPI;



const express           = require('express');
const store             = require('../core/job-store');
const { metrics }       = require('../observability/metrics');
const { apmMiddleware } = require('../apm/sdk/patcher');
const apmRoutes         = require('../apm/api/apm-routes');

// Business routes
const authRoutes    = require('../business/routes/auth.routes');
const productRoutes = require('../business/routes/product.routes');
const orderRoutes   = require('../business/routes/order.routes');
const reportRoutes  = require('../business/routes/report.routes');
const userRoutes    = require('../business/routes/user.routes');

function createAPI(workerPool = null) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // CORS
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // APM — traces every request automatically
  app.use(apmMiddleware);

  // ── Business API ────────────────────────────────────────────────────────
  app.use('/auth',     authRoutes);
  app.use('/products', productRoutes);
  app.use('/orders',   orderRoutes);
  app.use('/reports',  reportRoutes);
  app.use('/users',    userRoutes);

  // ── Infrastructure API ─────────────────────────────────────────────────
  app.post('/jobs', async (req, res) => {
    try {
      const { type, payload, partitionKey, priority, runAt, deduplicationId, maxRetries } = req.body;
      if (!type) return res.status(400).json({ error: 'type is required' });
      const stats = await store.getStats();
      const depth = Object.values(stats.partitions).reduce((s, p) => s + p.streamLength, 0);
      const max   = parseInt(process.env.MAX_QUEUE_SIZE || '100000');
      if (depth > max * parseFloat(process.env.BACKPRESSURE_THRESHOLD || '0.8')) {
        return res.status(429).json({ error: 'Backpressure: queue too full', retryAfterMs: 1000 });
      }
      const result = await store.enqueue({ type, payload, partitionKey, priority, runAt, deduplicationId, maxRetries });
      if (result.duplicate) return res.status(200).json({ message: 'Duplicate ignored', deduplicationId });
      res.status(202).json({ jobId: result.jobId, partitionKey: result.partitionKey, scheduled: result.scheduled });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/jobs/:id', async (req, res) => {
    const job = await store.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Not found' });
    const { _streamPartition, _streamIndex, _entryId, ...pub } = job;
    res.json(pub);
  });

  app.get('/stats', async (req, res) => {
    const qStats = await store.getStats();
    res.json({
      queue: qStats,
      workers: workerPool ? {
        workerCount: workerPool.workers.size,
        workers: [...workerPool.workers.entries()].map(([id, w]) => ({
          id, partitions: w.partitions,
          activeJobs: w.activeJobs.size, maxConcurrency: w.maxConcurrency,
          utilization: (w.activeJobs.size / w.maxConcurrency * 100).toFixed(1) + '%',
        })),
      } : null,
      metrics:   metrics.snapshot(),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/dlq',             async (req, res) => res.json({ jobs: await store.getDLQJobs(), total: store.dlq.length }));
  app.post('/dlq/:id/retry',  async (req, res) => {
    const job = await store.retryDLQJob(req.params.id);
    job ? res.json({ message: 'Re-queued', job }) : res.status(404).json({ error: 'Not found' });
  });

  app.get('/health', (req, res) => res.json({
    status: 'healthy', storage: 'in-memory',
    workers: workerPool?.workers.size || 0,
    uptime:  process.uptime().toFixed(1) + 's',
    memory:  { heapUsedMB: metrics.heapUsedMB, heapTotalMB: metrics.heapTotalMB },
    timestamp: new Date().toISOString(),
  }));

  app.get('/metrics', (req, res) => res.json(metrics.snapshot()));

  // ── APM routes ──────────────────────────────────────────────────────────
  app.use('/apm', apmRoutes);

  return app;
}

module.exports = createAPI;