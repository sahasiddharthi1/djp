/**
 * TraceStorage — Write-optimized store + Query Engine
 *
 * Schema (mirroring how Jaeger/Tempo work):
 *   traces      Map<traceId, record>    primary store
 *   recentIds   string[]               ring buffer (newest first)
 *   errorIds    string[]               only error traces
 *   slowIds     string[]               traces > SLOW_THRESHOLD
 *   serviceIdx  Map<service, id[]>     by service name
 *   latencyBuckets Map<opName, ms[]>   for p95/p99 aggregations
 */

class TraceStorage {
  constructor() {
    this.traces        = new Map();
    this.recentIds     = [];
    this.errorIds      = [];
    this.slowIds       = [];
    this.serviceIdx    = new Map();
    this.latencyBuckets = new Map();

    this.SLOW_MS   = 500;
    this.MAX_TRACES = 5000;
  }

  async saveTrace(traceId, spans, serviceName) {
    if (!spans?.length) return;

    const root     = spans.find(s => !s.parentSpanId) || spans[0];
    const duration = root.duration || 0;
    const hasError = spans.some(s => s.status === 'error');

    const record = {
      traceId, serviceName,
      rootName: root.name,
      startMs:  root.startMs,
      duration,
      spanCount: spans.length,
      hasError,
      spans: spans.map(s => ({
        spanId:      s.spanId,
        traceId:     s.traceId,
        parentSpanId:s.parentSpanId || null,
        name:        s.name,
        tags:        s.tags || {},
        events:      s.events || [],
        status:      s.status || 'ok',
        error:       s.error  || null,
        startMs:     s.startMs,
        duration:    s.duration || 0,
      })),
    };

    this.traces.set(traceId, record);

    // Update indexes
    this.recentIds.unshift(traceId);
    if (this.recentIds.length > 1000) this.recentIds.pop();

    if (hasError)          { this.errorIds.unshift(traceId); }
    if (duration > this.SLOW_MS) { this.slowIds.unshift(traceId); }

    if (!this.serviceIdx.has(serviceName)) this.serviceIdx.set(serviceName, []);
    this.serviceIdx.get(serviceName).unshift(traceId);

    // Latency buckets for aggregations
    for (const s of spans) {
      if (!this.latencyBuckets.has(s.name)) this.latencyBuckets.set(s.name, []);
      const b = this.latencyBuckets.get(s.name);
      b.push(s.duration || 0);
      if (b.length > 500) b.shift();
    }

    if (this.traces.size > this.MAX_TRACES) this._evict();
  }

  query({ service, status, minDuration, maxDuration, search, since, limit = 50, offset = 0 } = {}) {
    let ids;
    if (status === 'error')       ids = this.errorIds;
    else if (status === 'slow')   ids = this.slowIds;
    else if (service && this.serviceIdx.has(service)) ids = this.serviceIdx.get(service);
    else ids = this.recentIds;

    const results = [];
    for (const id of ids) {
      const t = this.traces.get(id);
      if (!t) continue;
      if (service     && t.serviceName !== service)              continue;
      if (status === 'error' && !t.hasError)                     continue;
      if (status === 'ok'    && t.hasError)                      continue;
      if (minDuration && t.duration < minDuration)               continue;
      if (maxDuration && t.duration > maxDuration)               continue;
      if (since       && t.startMs   < since)                    continue;
      if (search      && !this._search(t, search))               continue;
      results.push(this._summary(t));
      if (results.length >= limit + offset) break;
    }

    return { traces: results.slice(offset, offset + limit), total: results.length };
  }

  getTrace(traceId) { return this.traces.get(traceId) || null; }

  /** Build flamegraph tree from flat span list */
  getFlamegraphData(traceId) {
    const t = this.traces.get(traceId);
    if (!t) return null;

    const byId = new Map(t.spans.map(s => [s.spanId, { ...s, children: [] }]));
    const roots = [];

    for (const s of byId.values()) {
      if (s.parentSpanId && byId.has(s.parentSpanId)) {
        byId.get(s.parentSpanId).children.push(s);
      } else roots.push(s);
    }

    const toNode = s => ({
      name:     s.name,
      value:    Math.max(s.duration || 0.1, 0.1),
      startMs:  s.startMs,
      status:   s.status,
      tags:     s.tags,
      error:    s.error,
      children: s.children.map(toNode),
    });

    return roots.map(toNode);
  }

  /** p50 / p95 / p99 per operation name */
  getAggregations() {
    return [...this.latencyBuckets.entries()].map(([name, samples]) => {
      const sorted = [...samples].sort((a, b) => a - b);
      const n = sorted.length;
      return {
        operation: name,
        count: n,
        avg: Math.round(samples.reduce((a, b) => a + b, 0) / n),
        p50: Math.round(sorted[Math.floor(n * 0.50)] || 0),
        p95: Math.round(sorted[Math.floor(n * 0.95)] || 0),
        p99: Math.round(sorted[Math.floor(n * 0.99)] || 0),
        max: Math.round(sorted[n - 1] || 0),
      };
    }).sort((a, b) => b.p95 - a.p95);
  }

  getStats() {
    return {
      totalTraces: this.traces.size,
      errorTraces: this.errorIds.length,
      slowTraces:  this.slowIds.length,
      services:    [...this.serviceIdx.keys()],
      operations:  this.latencyBuckets.size,
    };
  }

  _summary(t) {
    return {
      traceId:   t.traceId,
      rootName:  t.rootName,
      service:   t.serviceName,
      duration:  Math.round(t.duration),
      spanCount: t.spanCount,
      hasError:  t.hasError,
      startMs:   t.startMs,
      startTime: new Date(t.startMs).toISOString(),
    };
  }

  _search(t, term) {
    const q = term.toLowerCase();
    return t.rootName?.toLowerCase().includes(q) ||
      t.spans?.some(s => s.name?.toLowerCase().includes(q) ||
        JSON.stringify(s.tags).toLowerCase().includes(q));
  }

  _evict() {
    const remove = [...this.traces.keys()].slice(-Math.floor(this.MAX_TRACES * 0.1));
    remove.forEach(id => this.traces.delete(id));
  }
}

module.exports = new TraceStorage();