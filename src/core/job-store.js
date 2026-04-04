/**
 * JobStore — Pure in-memory job store (no Redis, no Docker)
 *
 * Replaces Redis data structures with plain JS equivalents:
 *
 *  Redis Stream        →  Map of Arrays (partitioned queues)
 *  Redis Hash          →  Map<jobId, jobObject>
 *  Redis SortedSet     →  Array sorted by runAt (scheduled jobs)
 *  Redis List          →  Array (dead letter queue)
 *  Redis String NX     →  Set<deduplicationId> (idempotency)
 *
 * Trade-offs vs Redis version:
 *  ✅ Zero install — runs with plain Node.js
 *  ✅ Same API surface — workers/API code unchanged
 *  ❌ Data lost on restart
 *  ❌ Single process only (no multi-instance scaling)
 */

const { v4: uuidv4 } = require('uuid');

class JobStore {
  constructor() {
    // jobId → job object
    this.jobs = new Map();

    // partition number → Array of job entries (our "streams")
    this.streams = new Map();

    // Set of deduplication IDs (with TTL cleanup)
    this.idempotencyKeys = new Map(); // key → expiresAt timestamp

    // Dead letter queue — array of jobIds
    this.dlq = [];

    // Scheduled jobs — array of { runAt, jobId } sorted by runAt
    this.scheduled = [];

    // Pending entries — jobs claimed by a worker but not yet acked
    // workerId → Map<streamEntryId, jobId>
    this.pending = new Map();

    // Auto-increment stream entry IDs per partition
    this.streamCounters = new Map();

    // Consumer group name (kept for API compatibility)
    this.CONSUMER_GROUP = 'djp-workers';

    // Clean up expired idempotency keys every 60s
    setInterval(() => this._cleanIdempotencyKeys(), 60_000);
  }

  // connect/disconnect are no-ops (kept for API compatibility with Redis version)
  async connect()    { console.log('[JobStore] In-memory store ready (no Redis needed)'); }
  async disconnect() { console.log('[JobStore] In-memory store closed'); }

  // ── ENQUEUE ────────────────────────────────────────────────────────────
  async enqueue(jobData) {
    const {
      type,
      payload,
      partitionKey  = 'default',
      priority      = 5,
      runAt         = null,
      maxRetries    = parseInt(process.env.MAX_RETRIES || '3'),
      deduplicationId = null,
      ttl           = 3600,
    } = jobData;

    // ── Idempotency check ──────────────────────────────────────────────
    if (deduplicationId) {
      const existing = this.idempotencyKeys.get(deduplicationId);
      if (existing && existing > Date.now()) {
        console.log(`[JobStore] Duplicate rejected: ${deduplicationId}`);
        return { duplicate: true, deduplicationId };
      }
      // Mark as seen with TTL
      this.idempotencyKeys.set(deduplicationId, Date.now() + ttl * 1000);
    }

    const jobId = uuidv4();
    const now   = Date.now();
    const job   = {
      id:              jobId,
      type,
      payload,                        // stored as-is (no JSON.stringify needed)
      partitionKey,
      priority,
      status:          'pending',
      attempts:        0,
      maxRetries,
      createdAt:       now,
      runAt:           runAt ? new Date(runAt).getTime() : now,
      deduplicationId: deduplicationId || null,
    };

    this.jobs.set(jobId, job);

    if (job.runAt > now) {
      // Delayed — insert into sorted scheduled list
      this.scheduled.push({ runAt: job.runAt, jobId });
      this.scheduled.sort((a, b) => a.runAt - b.runAt);
      console.log(`[JobStore] Scheduled job ${jobId} for ${new Date(job.runAt).toISOString()}`);
    } else {
      this._appendToStream(job);
    }

    return { jobId, partitionKey, scheduled: job.runAt > now };
  }

  // ── CLAIM — worker pulls next batch ───────────────────────────────────
  async claimJobs(workerId, partitions, batchSize = 10) {
    const claimed = [];

    for (const partition of partitions) {
      const stream = this.streams.get(partition) || [];
      let taken = 0;

      for (let i = 0; i < stream.length && taken < batchSize; i++) {
        const entry = stream[i];
        if (entry.claimedBy) continue;         // already taken
        if (entry.claimedUntil > Date.now()) continue; // still locked

        // Claim: lock for 60 seconds (worker must ack or it gets reclaimed)
        entry.claimedBy    = workerId;
        entry.claimedAt    = Date.now();
        entry.claimedUntil = Date.now() + 60_000;

        const job = this.jobs.get(entry.jobId);
        if (job && job.status !== 'completed' && job.status !== 'dead') {
          claimed.push({
            ...job,
            _streamPartition: partition,
            _streamIndex:     i,
            _entryId:         entry.id,
          });
          taken++;
        }
      }
    }

    return claimed;
  }

  // ── ACKNOWLEDGE — job done successfully ───────────────────────────────
  async acknowledgeJob(job, result = null) {
    this._removeFromStream(job._streamPartition, job._entryId);

    const stored = this.jobs.get(job.id);
    if (stored) {
      stored.status      = 'completed';
      stored.completedAt = Date.now();
      stored.result      = result;
    }
  }

  // ── FAIL — retry with exponential backoff or send to DLQ ──────────────
  async failJob(job, error) {
    const stored   = this.jobs.get(job.id);
    if (!stored) return {};

    const attempts   = (stored.attempts || 0) + 1;
    const maxRetries = stored.maxRetries || 3;

    stored.attempts    = attempts;
    stored.lastError   = error.message || String(error);
    stored.lastFailedAt = Date.now();

    // Remove from stream (we'll re-add after delay if retrying)
    this._removeFromStream(job._streamPartition, job._entryId);

    if (attempts >= maxRetries) {
      stored.status = 'dead';
      this.dlq.push(job.id);
      console.log(`[JobStore] Job ${job.id} → DLQ after ${attempts} attempts`);
      return { dead: true };
    }

    // Exponential backoff with ±10% jitter
    const initial     = parseInt(process.env.INITIAL_BACKOFF_MS  || '1000');
    const multiplier  = parseFloat(process.env.BACKOFF_MULTIPLIER || '2');
    const maxBackoff  = parseInt(process.env.MAX_BACKOFF_MS       || '30000');
    const base        = initial * Math.pow(multiplier, attempts - 1);
    const jitter      = base * 0.1 * (Math.random() * 2 - 1);
    const delay       = Math.min(base + jitter, maxBackoff);

    stored.status = 'retrying';
    stored.runAt  = Date.now() + delay;

    this.scheduled.push({ runAt: stored.runAt, jobId: job.id });
    this.scheduled.sort((a, b) => a.runAt - b.runAt);

    console.log(`[JobStore] Job ${job.id} retry ${attempts}/${maxRetries} in ${Math.round(delay)}ms`);
    return { retrying: true, delay, attempt: attempts };
  }

  // ── RECLAIM — recover jobs from stalled workers ───────────────────────
  async reclaimStalledJobs(workerId, partition) {
    const stream    = this.streams.get(partition) || [];
    const now       = Date.now();
    const reclaimed = [];

    for (const entry of stream) {
      if (entry.claimedBy && entry.claimedBy !== workerId && entry.claimedUntil < now) {
        entry.claimedBy    = workerId;
        entry.claimedAt    = now;
        entry.claimedUntil = now + 60_000;

        const job = this.jobs.get(entry.jobId);
        if (job) {
          reclaimed.push({
            ...job,
            _streamPartition: partition,
            _streamIndex:     stream.indexOf(entry),
            _entryId:         entry.id,
          });
        }
      }
    }

    if (reclaimed.length > 0) {
      console.log(`[JobStore] Reclaimed ${reclaimed.length} stalled jobs on partition ${partition}`);
    }
    return reclaimed;
  }

  // ── SCHEDULER — promote delayed jobs whose time has come ──────────────
  async promoteScheduledJobs() {
    const now       = Date.now();
    let   promoted  = 0;

    while (this.scheduled.length > 0 && this.scheduled[0].runAt <= now) {
      const { jobId } = this.scheduled.shift();
      const job       = this.jobs.get(jobId);
      if (job) {
        job.status = 'pending';
        this._appendToStream(job);
        promoted++;
      }
    }

    return promoted;
  }

  // ── GETTERS ───────────────────────────────────────────────────────────
  async getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  async getDLQJobs(start = 0, end = 99) {
    return this.dlq
      .slice(start, end + 1)
      .map(id => this.jobs.get(id))
      .filter(Boolean);
  }

  async retryDLQJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    this.dlq = this.dlq.filter(id => id !== jobId);
    job.status   = 'pending';
    job.attempts = 0;
    this._appendToStream(job);
    return job;
  }

  async getStats() {
    const stats = { partitions: {}, dlqSize: 0, scheduledCount: 0 };

    stats.dlqSize       = this.dlq.length;
    stats.scheduledCount = this.scheduled.length;

    for (const [partition, stream] of this.streams) {
      const pendingCount = stream.filter(e => e.claimedBy && e.claimedUntil > Date.now()).length;
      stats.partitions[String(partition)] = {
        streamLength: stream.length,
        pendingCount,
      };
    }

    // Include empty partitions so dashboard shows all 8
    for (let i = 0; i < 8; i++) {
      if (!stats.partitions[String(i)]) {
        stats.partitions[String(i)] = { streamLength: 0, pendingCount: 0 };
      }
    }

    return stats;
  }

  // ── INTERNALS ─────────────────────────────────────────────────────────
  _appendToStream(job) {
    const partition = this._getPartition(job.partitionKey);
    if (!this.streams.has(partition)) this.streams.set(partition, []);

    const counter = (this.streamCounters.get(partition) || 0) + 1;
    this.streamCounters.set(partition, counter);

    this.streams.get(partition).push({
      id:           `${partition}-${counter}`,
      jobId:        job.id,
      claimedBy:    null,
      claimedAt:    null,
      claimedUntil: 0,
    });
  }

  _removeFromStream(partition, entryId) {
    if (!this.streams.has(partition)) return;
    const stream = this.streams.get(partition);
    const idx    = stream.findIndex(e => e.id === entryId);
    if (idx !== -1) stream.splice(idx, 1);
  }

  /** Consistent hash: partitionKey → 0..7 */
  _getPartition(partitionKey, numPartitions = 8) {
    let hash = 0;
    for (let i = 0; i < partitionKey.length; i++) {
      hash = ((hash << 5) - hash) + partitionKey.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash) % numPartitions;
  }

  _cleanIdempotencyKeys() {
    const now = Date.now();
    for (const [key, expiresAt] of this.idempotencyKeys) {
      if (expiresAt < now) this.idempotencyKeys.delete(key);
    }
  }
}

// Export a singleton so all modules share the same in-memory state
module.exports = new JobStore();