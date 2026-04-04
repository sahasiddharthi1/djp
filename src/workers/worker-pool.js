/**
 * WorkerPool — manages multiple Worker instances + autoscaling + scheduler
 */

const Worker  = require('./worker');
const store   = require('../core/job-store');
const { metrics } = require('../observability/metrics');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const NUM_PARTITIONS = 8;

class WorkerPool {
  constructor(config = {}) {
    this.minWorkers         = config.minWorkers  || 2;
    this.maxWorkers         = config.maxWorkers  || parseInt(process.env.NUM_WORKERS || '4') * 2;
    this.scaleUpThreshold   = 0.8;
    this.scaleDownThreshold = 0.2;
    this.scaleCheckInterval = 10_000;
    this.cooldownMs         = 30_000;
    this.lastScaleEvent     = 0;
    this.isRunning          = false;

    this.workers        = new Map();   // workerId → Worker
    this.customHandlers = new Map();   // type     → { handler, options }
  }

  registerHandler(type, handler, options = {}) {
    this.customHandlers.set(type, { handler, options });
    for (const [, w] of this.workers) w.registerHandler(type, handler, options);
  }

  async start() {
    await store.connect();
    this.isRunning = true;

    // Start minimum workers
    for (let i = 0; i < this.minWorkers; i++) this._addWorker();

    // Scheduler: promote delayed/retry jobs to live queue
    this._schedulerLoop();

    // Autoscaler
    this._autoscaleLoop();

    console.log(`[WorkerPool] started with ${this.workers.size} workers`);
  }

  _addWorker() {
    const idx        = this.workers.size;
    const partitions = this._assignPartitions(idx);
    const workerId   = `worker-${idx}`;

    const w = new Worker({
      workerId,
      partitions,
      maxConcurrency: parseInt(process.env.MAX_CONCURRENCY || '10'),
    });

    for (const [type, { handler, options }] of this.customHandlers) {
      w.registerHandler(type, handler, options);
    }

    this.workers.set(workerId, w);
    w.start();

    metrics.workerCount = this.workers.size;
    console.log(`[WorkerPool] added ${workerId}, partitions: [${partitions.join(', ')}]`);
  }

  async _removeWorker() {
    if (this.workers.size <= this.minWorkers) return;
    const [id, w] = [...this.workers.entries()].pop();
    this.workers.delete(id);
    await w.shutdown(10_000);
    metrics.workerCount = this.workers.size;
  }

  async _autoscaleLoop() {
    while (this.isRunning) {
      await sleep(this.scaleCheckInterval);
      try {
        const now = Date.now();
        if (now - this.lastScaleEvent < this.cooldownMs) continue;

        const stats        = await store.getStats();
        const totalPending = Object.values(stats.partitions)
          .reduce((s, p) => s + p.streamLength + p.pendingCount, 0);

        let active = 0, capacity = 0;
        for (const [, w] of this.workers) {
          active   += w.activeJobs.size;
          capacity += w.maxConcurrency;
        }
        const util = capacity > 0 ? active / capacity : 0;
        metrics.workerUtilization = util;
        metrics.queueDepth        = totalPending;

        if (util > this.scaleUpThreshold && this.workers.size < this.maxWorkers) {
          console.log(`[WorkerPool] scaling UP (util ${(util*100).toFixed(0)}%)`);
          this._addWorker();
          this.lastScaleEvent = now;
        } else if (util < this.scaleDownThreshold && totalPending < 10 && this.workers.size > this.minWorkers) {
          console.log(`[WorkerPool] scaling DOWN (util ${(util*100).toFixed(0)}%)`);
          await this._removeWorker();
          this.lastScaleEvent = now;
        }
      } catch (err) {
        console.error('[WorkerPool] autoscale error:', err.message);
      }
    }
  }

  async _schedulerLoop() {
    while (this.isRunning) {
      try {
        const n = await store.promoteScheduledJobs();
        if (n > 0) console.log(`[WorkerPool] promoted ${n} scheduled jobs`);
      } catch (err) {
        console.error('[WorkerPool] scheduler error:', err.message);
      }
      await sleep(500);
    }
  }

  /** Evenly distribute 8 partitions across workers */
  _assignPartitions(workerIndex) {
    const total   = this.workers.size + 1;
    const perW    = Math.ceil(NUM_PARTITIONS / total);
    const start   = workerIndex * perW;
    const end     = Math.min(start + perW, NUM_PARTITIONS);
    return Array.from({ length: end - start }, (_, i) => start + i);
  }

  async shutdown() {
    this.isRunning = false;
    await Promise.all([...this.workers.values()].map(w => w.shutdown()));
    await store.disconnect();
  }

  // Expose store for API layer
  get store() { return store; }
}

module.exports = WorkerPool;