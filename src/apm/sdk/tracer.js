/**
 * APM SDK — Core Tracer using AsyncLocalStorage
 *
 * CONCEPT: AsyncLocalStorage (ALS) is like a "magic backpack" that follows
 * a request through every async hop — across await, Promises, callbacks.
 * Each request gets its own isolated context. This is how Datadog tracks
 * which spans belong to which request without you passing context manually.
 *
 *   Trace = one full request journey   (contains many spans)
 *   Span  = one unit of work           (has name, duration, tags, status)
 */

const { AsyncLocalStorage } = require('async_hooks');
const { v4: uuidv4 }        = require('uuid');

const als = new AsyncLocalStorage(); // THE magic — one per process

class Tracer {
  constructor(serviceName = 'job-processor') {
    this.serviceName  = serviceName;
    this._storage     = null; // set after storage module loads (avoid circular)
  }

  /** Call once after storage is ready */
  setStorage(storage) { this._storage = storage; }

  /**
   * startTrace — wraps a function in a root span + ALS context
   * Everything called inside fn() automatically inherits the trace context.
   */
  async startTrace(name, tags = {}, fn) {
    const traceId = uuidv4();
    const span    = this._makeSpan(name, null, traceId, tags);
    const ctx     = { traceId, currentSpanId: span.spanId, spans: [span] };

    return als.run(ctx, async () => {
      try {
        const result  = await fn();
        span.status   = 'ok';
        span.duration = this._finish(span);
        return result;
      } catch (err) {
        span.status   = 'error';
        span.error    = { message: err.message };
        span.duration = this._finish(span);
        throw err;
      } finally {
        if (this._storage) {
          await this._storage.saveTrace(traceId, ctx.spans, this.serviceName);
        }
      }
    });
  }

  /** Create a child span inside the current trace */
  startSpan(name, tags = {}) {
    const ctx = als.getStore();
    if (!ctx) return this._makeSpan(name, null, 'orphan', tags);

    const span         = this._makeSpan(name, ctx.currentSpanId, ctx.traceId, tags);
    const prevId       = ctx.currentSpanId;
    ctx.currentSpanId  = span.spanId;
    ctx.spans.push(span);
    span._restore = () => { ctx.currentSpanId = prevId; };
    return span;
  }

  endSpan(span, error = null) {
    if (!span || span._ended) return;
    span._ended   = true;
    span.duration = this._finish(span);
    span.status   = error ? 'error' : (span.status || 'ok');
    if (error) span.error = { message: error.message };
    if (span._restore) span._restore();
  }

  /** Convenience: auto start+end span around an async fn */
  async wrap(name, tags = {}, fn) {
    const span = this.startSpan(name, tags);
    try {
      const r = await fn();
      this.endSpan(span);
      return r;
    } catch (e) {
      this.endSpan(span, e);
      throw e;
    }
  }

  currentTraceId() { return als.getStore()?.traceId || null; }

  addTag(key, value) {
    const ctx = als.getStore();
    if (!ctx) return;
    const span = ctx.spans.find(s => s.spanId === ctx.currentSpanId);
    if (span) span.tags[key] = value;
  }

  addEvent(message, data = {}) {
    const ctx = als.getStore();
    if (!ctx) return;
    const span = ctx.spans.find(s => s.spanId === ctx.currentSpanId);
    if (span) {
      span.events = span.events || [];
      span.events.push({ message, data, ts: Date.now() });
    }
  }

  _makeSpan(name, parentSpanId, traceId, tags) {
    return {
      spanId: uuidv4(), traceId, parentSpanId,
      name, tags: { ...tags }, events: [],
      status: 'running', error: null,
      startNs: process.hrtime.bigint(),
      startMs: Date.now(),
      duration: null, _ended: false,
    };
  }

  _finish(span) {
    return Number(process.hrtime.bigint() - span.startNs) / 1_000_000; // ns→ms
  }
}

const tracer = new Tracer('job-processor');
module.exports = { tracer, Tracer };