// /**
//  * Worker — processes jobs from assigned partitions
//  * Identical logic to the Redis version; only the store import changes.
//  */

// const store       = require('../core/job-store');       // singleton
// const RateLimiter = require('../core/rate-limiter');
// const { metrics } = require('../observability/metrics');

// const sleep = ms => new Promise(r => setTimeout(r, ms));

// class Worker {
//   constructor(config = {}) {
//     this.workerId       = config.workerId || `worker-${Date.now()}`;
//     this.partitions     = config.partitions     || [0, 1];
//     this.maxConcurrency = config.maxConcurrency || parseInt(process.env.MAX_CONCURRENCY || '10');
//     this.pollIntervalMs = config.pollIntervalMs || parseInt(process.env.QUEUE_POLL_INTERVAL_MS || '100');

//     this.activeJobs      = new Map();   // jobId → Promise
//     this.handlers        = new Map();   // type  → { fn, options }
//     this.isRunning       = false;
//     this.isShuttingDown  = false;
//     this.rateLimiter     = new RateLimiter();

//     this._registerDefaultHandlers();
//   }

//   registerHandler(type, handler, options = {}) {
//     this.handlers.set(type, { fn: handler, options });
//   }

//   start() {
//     this.isRunning = true;
//     console.log(`[Worker ${this.workerId}] started — partitions: ${this.partitions.join(', ')}`);
//     this._processingLoop();
//     this._reclaimLoop();
//     this._heartbeatLoop();
//   }

//   async _processingLoop() {
//     while (this.isRunning) {
//       try {
//         // Backpressure: don't pull more than capacity
//         if (this.activeJobs.size >= this.maxConcurrency) {
//           await sleep(this.pollIntervalMs);
//           continue;
//         }

//         const slots     = this.maxConcurrency - this.activeJobs.size;
//         const batchSize = Math.min(slots, 10);
//         const jobs      = await store.claimJobs(this.workerId, this.partitions, batchSize);

//         if (jobs.length === 0) {
//           await sleep(this.pollIntervalMs);
//           continue;
//         }

//         for (const job of jobs) {
//           const p = this._processJob(job).finally(() => this.activeJobs.delete(job.id));
//           this.activeJobs.set(job.id, p);
//         }

//       } catch (err) {
//         console.error(`[Worker ${this.workerId}] loop error:`, err.message);
//         await sleep(1000);
//       }
//     }
//   }

//   async _processJob(job) {
//     const start = Date.now();

//     try {
//       // Rate limit check per partition key
//       const rate = this.rateLimiter.checkLimit(job.partitionKey);
//       if (!rate.allowed) {
//         // Re-schedule instead of dropping
//         store.scheduled.push({ runAt: rate.resetAt, jobId: job.id });
//         store.scheduled.sort((a, b) => a.runAt - b.runAt);
//         store._removeFromStream(job._streamPartition, job._entryId);
//         metrics.rateLimitHits++;
//         return;
//       }

//       const entry = this.handlers.get(job.type);
//       if (!entry) throw new Error(`No handler for type: "${job.type}"`);

//       metrics.jobsProcessing++;

//       const result = await entry.fn(job.payload, job);

//       await store.acknowledgeJob(job, result);

//       const dur = (Date.now() - start) / 1000;
//       metrics.jobsCompleted++;
//       metrics.push(dur);

//       console.log(`[Worker ${this.workerId}] ✓ ${job.type} (${job.id.slice(0,8)}) ${dur.toFixed(2)}s`);

//     } catch (err) {
//       const dur = (Date.now() - start) / 1000;
//       metrics.jobsFailed++;
//       metrics.push(dur);

//       console.error(`[Worker ${this.workerId}] ✗ ${job.type} (${job.id.slice(0,8)}):`, err.message);

//       const result = await store.failJob(job, err);
//       if (result.dead) metrics.dlqJobs++;

//     } finally {
//       metrics.jobsProcessing--;
//     }
//   }

//   async _reclaimLoop() {
//     while (this.isRunning) {
//       await sleep(30_000);
//       for (const p of this.partitions) {
//         await store.reclaimStalledJobs(this.workerId, p);
//       }
//     }
//   }

//   async _heartbeatLoop() {
//     while (this.isRunning) {
//       metrics.workerActiveJobs = this.activeJobs.size;
//       await sleep(5000);
//     }
//   }

//   async shutdown(timeoutMs = 15_000) {
//     if (this.isShuttingDown) return;
//     this.isShuttingDown = true;
//     this.isRunning      = false;

//     console.log(`[Worker ${this.workerId}] shutting down, waiting for ${this.activeJobs.size} jobs...`);
//     const deadline = Date.now() + timeoutMs;
//     while (this.activeJobs.size > 0 && Date.now() < deadline) await sleep(200);
//     console.log(`[Worker ${this.workerId}] done`);
//   }

//   _registerDefaultHandlers() {
//     this.registerHandler('__ping', async () => ({ pong: true, ts: Date.now() }));
//   }
// }

// module.exports = Worker;

/**
 * Worker — now fully instrumented with APM tracing
 * Every job execution becomes a trace with child spans.
 */

const store       = require('../core/job-store');
const RateLimiter = require('../core/rate-limiter');
const { metrics } = require('../observability/metrics');
const { tracer }  = require('../apm/sdk/tracer');

const sleep = ms => new Promise(r => setTimeout(r, ms));

class Worker {
  constructor(config = {}) {
    this.workerId       = config.workerId || `worker-${Date.now()}`;
    this.partitions     = config.partitions     || [0, 1];
    this.maxConcurrency = config.maxConcurrency || parseInt(process.env.MAX_CONCURRENCY || '10');
    this.pollIntervalMs = config.pollIntervalMs || parseInt(process.env.QUEUE_POLL_INTERVAL_MS || '100');

    this.activeJobs     = new Map();
    this.handlers       = new Map();
    this.isRunning      = false;
    this.isShuttingDown = false;
    this.rateLimiter    = new RateLimiter();

    this.registerHandler('__ping', async () => ({ pong: true, ts: Date.now() }));
  }

  registerHandler(type, handler, options = {}) {
    this.handlers.set(type, { fn: handler, options });
  }

  start() {
    this.isRunning = true;
    console.log(`[Worker ${this.workerId}] started — partitions: ${this.partitions.join(', ')}`);
    this._processingLoop();
    this._reclaimLoop();
  }

  async _processingLoop() {
    while (this.isRunning) {
      try {
        if (this.activeJobs.size >= this.maxConcurrency) {
          await sleep(this.pollIntervalMs);
          continue;
        }
        const slots = this.maxConcurrency - this.activeJobs.size;
        const jobs  = await store.claimJobs(this.workerId, this.partitions, Math.min(slots, 10));

        if (!jobs.length) { await sleep(this.pollIntervalMs); continue; }

        for (const job of jobs) {
          const p = this._processJob(job).finally(() => this.activeJobs.delete(job.id));
          this.activeJobs.set(job.id, p);
        }
      } catch (err) {
        console.error(`[Worker ${this.workerId}] loop error:`, err.message);
        await sleep(1000);
      }
    }
  }

  async _processJob(job) {
    // ── Every job gets its own APM trace ──────────────────────────────────
    await tracer.startTrace(`job:${job.type}`, {
      'job.id':           job.id,
      'job.type':         job.type,
      'job.partitionKey': job.partitionKey,
      'job.attempt':      job.attempts,
      'worker.id':        this.workerId,
    }, async () => {

      // ── Rate limit span ────────────────────────────────────────────────
      const rateOk = await tracer.wrap('rate-limit.check', { key: job.partitionKey }, async () => {
        return this.rateLimiter.checkLimit(job.partitionKey);
      });

      if (!rateOk.allowed) {
        store.scheduled.push({ runAt: rateOk.resetAt, jobId: job.id });
        store.scheduled.sort((a, b) => a.runAt - b.runAt);
        store._removeFromStream(job._streamPartition, job._entryId);
        metrics.rateLimitHits++;
        return;
      }

      const entry = this.handlers.get(job.type);
      if (!entry) throw new Error(`No handler for type: "${job.type}"`);

      metrics.jobsProcessing++;

      try {
        // ── Handler execution span ────────────────────────────────────────
        const result = await tracer.wrap(`handler:${job.type}`, {
          'job.payload_keys': Object.keys(job.payload || {}).join(','),
        }, () => entry.fn(job.payload, job));

        // ── Acknowledge span ─────────────────────────────────────────────
        await tracer.wrap('job.acknowledge', {}, () => store.acknowledgeJob(job, result));

        const dur = job._startMs ? (Date.now() - job._startMs) : 0;
        metrics.jobsCompleted++;
        metrics.push(dur / 1000);
        tracer.addTag('job.status', 'completed');
        console.log(`[Worker ${this.workerId}] ✓ ${job.type} (${job.id.slice(0,8)})`);

      } catch (err) {
        metrics.jobsFailed++;
        tracer.addTag('job.status', 'failed');
        console.error(`[Worker ${this.workerId}] ✗ ${job.type}:`, err.message);

        const retryResult = await store.failJob(job, err);
        if (retryResult.dead) {
          metrics.dlqJobs++;
          tracer.addTag('job.dlq', true);
        } else {
          tracer.addTag('job.retry', retryResult.attempt);
        }
        throw err; // let tracer mark span as error
      } finally {
        metrics.jobsProcessing--;
      }
    }).catch(() => {}); // errors already handled above
  }

  async _reclaimLoop() {
    while (this.isRunning) {
      await sleep(30_000);
      for (const p of this.partitions) {
        await store.reclaimStalledJobs(this.workerId, p);
      }
    }
  }

  async shutdown(timeoutMs = 15_000) {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.isRunning      = false;
    const deadline      = Date.now() + timeoutMs;
    while (this.activeJobs.size > 0 && Date.now() < deadline) await sleep(200);
    console.log(`[Worker ${this.workerId}] shutdown complete`);
  }
}

module.exports = Worker;