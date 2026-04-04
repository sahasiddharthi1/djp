/**
 * Patcher — Auto-instrumentation via Monkey Patching
 *
 * Monkey patching = replace library functions with wrappers that
 * add tracing, then call the original. Zero changes to app code needed.
 *
 * We instrument:
 *  1. Express   — trace every inbound HTTP request automatically
 *  2. http/https — trace every outbound HTTP call
 *  3. Event loop — measure lag (detects CPU starvation)
 *  4. Memory     — track heap growth (detects leaks)
 */

const { tracer }  = require('./tracer');
const { metrics } = require('../../observability/metrics');

// ── 1. EXPRESS MIDDLEWARE ────────────────────────────────────────────────
// app.use(apmMiddleware) — one line, all requests traced
function apmMiddleware(req, res, next) {
  const routeName = `${req.method} ${req.path}`;

  tracer.startTrace(routeName, {
    'http.method':  req.method,
    'http.url':     req.url,
    'http.path':    req.path,
    'user_agent':   req.headers['user-agent'] || '',
  }, () => new Promise((resolve) => {
    res.setHeader('X-Trace-Id', tracer.currentTraceId() || '');

    res.on('finish', () => {
      tracer.addTag('http.status', res.statusCode);
      metrics.httpRequests++;
      if (res.statusCode >= 500) metrics.httpErrors++;
      resolve();
    });

    next();
  })).catch(() => {});
}

// ── 2. HTTP OUTBOUND PATCH ────────────────────────────────────────────────
function patchHttp() {
  const http  = require('http');
  const https = require('https');

  const wrap = (original) => function(options, callback) {
    const url    = typeof options === 'string' ? options
                 : `${options.hostname || options.host || ''}${options.path || '/'}`;
    const span   = tracer.startSpan('http.outbound', {
      'http.url': url, 'http.method': options.method || 'GET', 'span.kind': 'client',
    });

    const req = original.call(this, options, (res) => {
      tracer.addTag('http.status', res.statusCode);
      tracer.endSpan(span);
      if (callback) callback(res);
    });
    req.on('error', (e) => tracer.endSpan(span, e));
    return req;
  };

  http.request  = wrap(http.request.bind(http));
  https.request = wrap(https.request.bind(https));
  console.log('[APM] http/https patched');
}

// ── 3. EVENT LOOP LAG ─────────────────────────────────────────────────────
// Schedule a timer every 500ms and measure how late it actually fires.
// Late = event loop was busy (CPU-bound code blocking everything).
function startEventLoopMonitor() {
  const INTERVAL = 500;
  let last = Date.now();

  setInterval(() => {
    const now = Date.now();
    const lag = Math.max(0, now - last - INTERVAL);
    last = now;
    metrics.eventLoopLag = lag;
    metrics.loopSamples.push({ t: now, lag });
    if (metrics.loopSamples.length > 120) metrics.loopSamples.shift();
    if (lag > 100) console.warn(`[APM] ⚠️  Event loop lag: ${lag}ms`);
  }, INTERVAL).unref();

  console.log('[APM] Event loop monitor started');
}

// ── 4. MEMORY MONITOR ─────────────────────────────────────────────────────
function startMemoryMonitor() {
  setInterval(() => {
    const m = process.memoryUsage();
    metrics.heapUsedMB  = Math.round(m.heapUsed  / 1024 / 1024);
    metrics.heapTotalMB = Math.round(m.heapTotal / 1024 / 1024);
    metrics.rssMB       = Math.round(m.rss       / 1024 / 1024);
    metrics.memSamples.push({ t: Date.now(), heap: metrics.heapUsedMB });
    if (metrics.memSamples.length > 120) metrics.memSamples.shift();
  }, 5000).unref();

  console.log('[APM] Memory monitor started');
}

module.exports = { apmMiddleware, patchHttp, startEventLoopMonitor, startMemoryMonitor };