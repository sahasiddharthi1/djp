// /**
//  * metrics.js — Simple in-memory counters & gauges
//  * No prom-client needed. The /metrics endpoint returns plain JSON.
//  */

// const metrics = {
//   // Counters (only go up)
//   jobsCompleted:  0,
//   jobsFailed:     0,
//   dlqJobs:        0,
//   rateLimitHits:  0,
//   scaleUpEvents:  0,
//   scaleDownEvents:0,

//   // Gauges (can go up or down)
//   jobsProcessing:   0,
//   workerCount:      0,
//   workerActiveJobs: 0,
//   workerUtilization:0,
//   queueDepth:       0,

//   // Simple duration array for avg latency
//   _durations: [],

//   // Helpers
//   inc()  { /* called as metrics.jobsCompleted++ directly */ },
//   dec()  { /* called as metrics.jobsProcessing-- directly */ },
//   push(val) { this._durations.push(val); if (this._durations.length > 1000) this._durations.shift(); },

//   snapshot() {
//     const durs   = this._durations;
//     const avgDur = durs.length ? (durs.reduce((a, b) => a + b, 0) / durs.length).toFixed(3) : 0;
//     const p95    = durs.length ? durs.slice().sort((a,b)=>a-b)[Math.floor(durs.length * 0.95)] || 0 : 0;
//     return {
//       jobs: {
//         completed:    this.jobsCompleted,
//         failed:       this.jobsFailed,
//         processing:   this.jobsProcessing,
//         dlq:          this.dlqJobs,
//         rateLimited:  this.rateLimitHits,
//       },
//       workers: {
//         count:       this.workerCount,
//         activeJobs:  this.workerActiveJobs,
//         utilization: (this.workerUtilization * 100).toFixed(1) + '%',
//         scaleUp:     this.scaleUpEvents,
//         scaleDown:   this.scaleDownEvents,
//       },
//       queue: {
//         depth: this.queueDepth,
//       },
//       latency: {
//         avgSeconds: parseFloat(avgDur),
//         p95Seconds: parseFloat(p95.toFixed(3)),
//         samples:    durs.length,
//       },
//     };
//   }
// };

// // Make inc/dec work as direct property mutations
// metrics.inc = function() {};  // not needed; callers do metrics.jobsCompleted++
// metrics.dec = function() {};

// module.exports = { metrics };
/**
 * metrics.js — Unified metrics for both Job Processor + APM
 */

const metrics = {
  // ── Job Processor ──────────────────────────────────────────────────────
  jobsCompleted:    0,
  jobsFailed:       0,
  dlqJobs:          0,
  rateLimitHits:    0,
  jobsProcessing:   0,
  workerCount:      0,
  workerActiveJobs: 0,
  workerUtilization:0,
  queueDepth:       0,
  jobDuration:      [],   // array — use metrics.push(dur)

  // ── APM / Runtime ──────────────────────────────────────────────────────
  httpRequests:   0,
  httpErrors:     0,
  eventLoopLag:   0,   // ms
  heapUsedMB:     0,
  heapTotalMB:    0,
  rssMB:          0,

  // Time-series sample arrays (keep last 2 minutes @ 5s intervals = 24 samples)
  memSamples:  [],   // { t, heap }
  loopSamples: [],   // { t, lag }

  // Helper used by worker.js
  push(val) {
    this.jobDuration.push(val);
    if (this.jobDuration.length > 1000) this.jobDuration.shift();
  },

  snapshot() {
    const durs = this.jobDuration;
    const avg  = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : 0;
    const sorted = [...durs].sort((a, b) => a - b);
    return {
      jobs: {
        completed:   this.jobsCompleted,
        failed:      this.jobsFailed,
        processing:  this.jobsProcessing,
        dlq:         this.dlqJobs,
        rateLimited: this.rateLimitHits,
      },
      workers: {
        count:       this.workerCount,
        activeJobs:  this.workerActiveJobs,
        utilization: (this.workerUtilization * 100).toFixed(1) + '%',
      },
      queue:  { depth: this.queueDepth },
      latency: {
        avgMs: parseFloat(avg.toFixed(2)),
        p95Ms: parseFloat((sorted[Math.floor(sorted.length * 0.95)] || 0).toFixed(2)),
        samples: durs.length,
      },
      runtime: {
        httpRequests:   this.httpRequests,
        httpErrors:     this.httpErrors,
        eventLoopLagMs: this.eventLoopLag,
        heapUsedMB:     this.heapUsedMB,
        heapTotalMB:    this.heapTotalMB,
        rssMB:          this.rssMB,
        uptimeSeconds:  Math.round(process.uptime()),
      },
    };
  },
};

module.exports = { metrics };