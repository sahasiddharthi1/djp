/**
 * RateLimiter — Sliding window, pure in-memory
 *
 * Replaces Redis sorted-set + Lua script with a plain Map of timestamp arrays.
 * Same algorithm, same API — just stored in process memory.
 */

class RateLimiter {
  constructor(config = {}) {
    this.windowMs = config.windowMs || parseInt(process.env.RATE_LIMIT_WINDOW_MS || '1000');
    this.maxJobs  = config.maxJobs  || parseInt(process.env.RATE_LIMIT_MAX_JOBS  || '100');

    // partitionKey → array of timestamps within current window
    this.windows = new Map();

    // Clean up idle keys every 10s
    setInterval(() => this._cleanup(), 10_000);
  }

  checkLimit(partitionKey) {
    const now         = Date.now();
    const windowStart = now - this.windowMs;

    if (!this.windows.has(partitionKey)) this.windows.set(partitionKey, []);

    const timestamps = this.windows.get(partitionKey);

    // Remove expired timestamps (older than window)
    while (timestamps.length > 0 && timestamps[0] < windowStart) {
      timestamps.shift();
    }

    if (timestamps.length >= this.maxJobs) {
      return {
        allowed:   false,
        count:     timestamps.length,
        limit:     this.maxJobs,
        remaining: 0,
        resetAt:   timestamps[0] + this.windowMs,
      };
    }

    timestamps.push(now);

    return {
      allowed:   true,
      count:     timestamps.length,
      limit:     this.maxJobs,
      remaining: this.maxJobs - timestamps.length,
      resetAt:   now + this.windowMs,
    };
  }

  async waitForSlot(partitionKey, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = this.checkLimit(partitionKey);
      if (result.allowed) return result;
      await sleep(50);
    }
    throw new Error(`Rate limit timeout for key: ${partitionKey}`);
  }

  _cleanup() {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, timestamps] of this.windows) {
      if (timestamps.length === 0 || timestamps[timestamps.length - 1] < cutoff) {
        this.windows.delete(key);
      }
    }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = RateLimiter;