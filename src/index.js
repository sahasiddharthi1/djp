// /**
//  * index.js — Entry point
//  * Run:  node src/index.js
//  *       npm start
//  *       npm run dev      (auto-restart on file changes)
//  */

// require('dotenv').config();

// const nodemailer = require('nodemailer');
// const WorkerPool = require('./workers/worker-pool');
// const createAPI  = require('./api/server');

// const transporter = nodemailer.createTransport({
//   service: 'gmail',
//   auth: {
//     user: process.env.EMAIL_USER,
//     pass: process.env.EMAIL_PASS,
//   },
// });

// async function main() {
//   console.log('');
//   console.log('╔══════════════════════════════════════════════╗');
//   console.log('║   Distributed Job Processor  (in-memory)    ║');
//   console.log('╚══════════════════════════════════════════════╝');
//   console.log('');

//   // ── Worker pool ────────────────────────────────────────────────────────
//   const pool = new WorkerPool({
//     minWorkers: parseInt(process.env.NUM_WORKERS || '2'),
//     maxWorkers: parseInt(process.env.NUM_WORKERS || '2') * 2,
//   });

//   // ── Register job handlers ───────────────────────────────────────────────
//   // Add your own below these examples.

//   pool.registerHandler('send-email', async (payload) => {
//     const result = await transporter.sendMail({
//       from:    process.env.EMAIL_USER,
//       to:      payload.to,
//       subject: payload.subject,
//       text:    payload.body || 'Hello from the Job Processor!',
//     });

//     console.log(`📧 Real email sent to ${payload.to} — id: ${result.messageId}`);
//     return { sent: true, messageId: result.messageId };
//   });

//   pool.registerHandler('process-image', async (payload) => {
//     console.log(`   🖼️   process-image → ${payload.imageId || payload.userId}`);
//     await sleep(100 + Math.random() * 400);
//     return { processed: true };
//   });

//   pool.registerHandler('send-webhook', async (payload) => {
//     console.log(`   🔔  send-webhook → ${payload.url || 'https://example.com'}`);
//     await sleep(80 + Math.random() * 200);
//     return { delivered: true, statusCode: 200 };
//   });

//   pool.registerHandler('generate-report', async (payload) => {
//     console.log(`   📊  generate-report → user ${payload.userId}`);
//     await sleep(200 + Math.random() * 800);
//     return { reportUrl: `https://cdn.example.com/reports/${payload.userId}.pdf` };
//   });

//   // ── Start workers ───────────────────────────────────────────────────────
//   await pool.start();

//   // ── Start HTTP API ──────────────────────────────────────────────────────
//   const app  = createAPI(pool);
//   const PORT = parseInt(process.env.API_PORT || '3000');

//   app.listen(PORT, () => {
//     console.log('');
//     console.log(`✅  Server ready on http://localhost:${PORT}`);
//     console.log('');
//     console.log(`   📡  Enqueue:  POST http://localhost:${PORT}/jobs`);
//     console.log(`   📊  Stats:        http://localhost:${PORT}/stats`);
//     console.log(`   ❤️   Health:       http://localhost:${PORT}/health`);
//     console.log(`   💀  DLQ:          http://localhost:${PORT}/dlq`);
//     console.log(`   📈  Metrics:      http://localhost:${PORT}/metrics`);
//     console.log('');
//     console.log(`   🖥️   Dashboard:   npm run dashboard  →  http://localhost:8080`);
//     console.log('');
//   });

//   // ── Graceful shutdown ──────────────────────────────────────────────────
//   const shutdown = async (sig) => {
//     console.log(`\n[main] ${sig} received — shutting down...`);
//     await pool.shutdown();
//     process.exit(0);
//   };
//   process.on('SIGTERM', () => shutdown('SIGTERM'));
//   process.on('SIGINT',  () => shutdown('SIGINT'));  // Ctrl+C
// }

// const sleep = ms => new Promise(r => setTimeout(r, ms));

// main().catch(err => { console.error('Startup error:', err); process.exit(1); });
/**
 * index.js — Entry point
 * Starts: APM instrumentation → Workers → HTTP API
 */

// require('dotenv').config();

// const nodemailer = require('nodemailer');

// const transporter = nodemailer.createTransport({
//   service: 'gmail',
//   auth: {
//     user: process.env.EMAIL_USER,
//     pass: process.env.EMAIL_PASS,
//   },
// });

// // ── Bootstrap APM FIRST (before anything else loads) ──────────────────────
// const { tracer }  = require('./apm/sdk/tracer');
// const traceStorage = require('./apm/storage/trace-storage');
// tracer.setStorage(traceStorage);  // wire tracer → storage

// const { patchHttp, startEventLoopMonitor, startMemoryMonitor } = require('./apm/sdk/patcher');
// patchHttp();
// startEventLoopMonitor();
// startMemoryMonitor();

// // ── App modules ────────────────────────────────────────────────────────────
// const WorkerPool = require('./workers/worker-pool');
// const createAPI  = require('./api/server');

// async function main() {
//   console.log('');
//   console.log('╔══════════════════════════════════════════════════════╗');
//   console.log('║   Datadog-Lite  =  Job Processor  +  APM Engine     ║');
//   console.log('╚══════════════════════════════════════════════════════╝');
//   console.log('');

//   const pool = new WorkerPool({
//     minWorkers: parseInt(process.env.NUM_WORKERS || '2'),
//     maxWorkers: parseInt(process.env.NUM_WORKERS || '2') * 2,
//   });

//   // ── Job Handlers ──────────────────────────────────────────────────────
//   pool.registerHandler('send-email', async (payload) => {
//     const result = await transporter.sendMail({
//       from:    process.env.EMAIL_USER,
//       to:      payload.to,
//       subject: payload.subject,
//       text:    payload.body || 'Hello from the Job Processor!',
//     });

//     console.log(`📧 Real email sent to ${payload.to} — id: ${result.messageId}`);
//     return { sent: true, messageId: result.messageId };
//   });

//   pool.registerHandler('process-image', async (payload) => {
//     console.log(`   🖼️   process-image → ${payload.imageId || payload.userId}`);
//     await sleep(100 + Math.random() * 400);
//     return { processed: true };
//   });

//   pool.registerHandler('send-webhook', async (payload) => {
//     console.log(`   🔔  send-webhook → ${payload.url || 'https://example.com'}`);
//     await sleep(80 + Math.random() * 200);
//     return { delivered: true, statusCode: 200 };
//   });

//   pool.registerHandler('generate-report', async (payload) => {
//     console.log(`   📊  generate-report → user ${payload.userId}`);
//     await sleep(200 + Math.random() * 800);
//     return { reportUrl: `https://cdn.example.com/reports/${payload.userId}.pdf` };
//   });

//   await pool.start();

//   const app  = createAPI(pool);
//   const PORT = parseInt(process.env.API_PORT || '3000');

//   app.listen(PORT, () => {
//     console.log('');
//     console.log(`✅  Server ready → http://localhost:${PORT}`);
//     console.log('');
//     console.log('   ── Job Processor ──────────────────────────────');
//     console.log(`   📡  POST  http://localhost:${PORT}/jobs`);
//     console.log(`   📊  GET   http://localhost:${PORT}/stats`);
//     console.log(`   ❤️   GET   http://localhost:${PORT}/health`);
//     console.log(`   💀  GET   http://localhost:${PORT}/dlq`);
//     console.log('');
//     console.log('   ── APM Engine ─────────────────────────────────');
//     console.log(`   🔍  GET   http://localhost:${PORT}/apm/traces`);
//     console.log(`   📈  GET   http://localhost:${PORT}/apm/aggregations`);
//     console.log(`   📊  GET   http://localhost:${PORT}/apm/stats`);
//     console.log(`   🔥  GET   http://localhost:${PORT}/apm/traces/:id/flamegraph`);
//     console.log('');
//     console.log(`   🖥️   Dashboard → npm run dashboard  (http://localhost:8080)`);
//     console.log('');
//   });

//   process.on('SIGINT',  () => shutdown('SIGINT'));
//   process.on('SIGTERM', () => shutdown('SIGTERM'));

//   async function shutdown(sig) {
//     console.log(`\n[main] ${sig} — shutting down...`);
//     await pool.shutdown();
//     process.exit(0);
//   }
// }

// const sleep = ms => new Promise(r => setTimeout(r, ms));
// main().catch(err => { console.error('Fatal:', err); process.exit(1); });


/**
 * index.js — Entry point
 * Boot order: APM → Workers (with business handlers) → HTTP API
 */

require('dotenv').config();

// ── 1. APM FIRST ───────────────────────────────────────────────────────────
const { tracer }    = require('./apm/sdk/tracer');
const traceStorage  = require('./apm/storage/trace-storage');
tracer.setStorage(traceStorage);

const { patchHttp, startEventLoopMonitor, startMemoryMonitor } = require('./apm/sdk/patcher');
patchHttp();
startEventLoopMonitor();
startMemoryMonitor();

// ── 2. APP MODULES ─────────────────────────────────────────────────────────
const WorkerPool = require('./workers/worker-pool');
const createAPI  = require('./api/server');
const db         = require('./business/db');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   ShopFlow  =  E-Commerce API  +  Job Processor  + APM  ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  const pool = new WorkerPool({
    minWorkers: parseInt(process.env.NUM_WORKERS || '2'),
    maxWorkers: parseInt(process.env.NUM_WORKERS || '2') * 2,
  });

  // ── JOB HANDLERS ──────────────────────────────────────────────────────
  // These are what workers actually DO when they pick up a job.

  // Send email (welcome, order confirmation, alerts)
  pool.registerHandler('send-email', async (payload) => {
    console.log(`   📧  send-email → ${payload.to} [${payload.type || 'general'}]`);
    await sleep(50 + Math.random() * 150);
    // Swap this for real Nodemailer when ready:
    // await transporter.sendMail({ from, to: payload.to, subject: payload.subject, text: payload.body })
    return { sent: true, messageId: `msg_${Date.now()}`, to: payload.to };
  });

  // Process product images (resize to thumbnail/medium/large)
  pool.registerHandler('process-image', async (payload) => {
    console.log(`   🖼️   process-image → product ${payload.productId} [${payload.sizes?.join(',')}]`);
    await sleep(200 + Math.random() * 600);
    // Swap for real Sharp.js:
    // const urls = await Promise.all(payload.sizes.map(s => sharp(payload.imageBase64).resize(sizeMap[s]).toBuffer()))
    const urls = { thumbnail: `https://cdn.shopflow.com/products/${payload.productId}/thumb.jpg`, medium: `https://cdn.shopflow.com/products/${payload.productId}/medium.jpg`, large: `https://cdn.shopflow.com/products/${payload.productId}/large.jpg` };
    db.updateProduct(payload.productId, { imageUrl: urls.medium });
    return { processed: true, urls };
  });

  // Notify shipping partner via webhook
  pool.registerHandler('send-webhook', async (payload) => {
    console.log(`   🔔  send-webhook → ${payload.event} for order ${payload.orderId}`);
    await sleep(80 + Math.random() * 200);
    // Swap for real fetch():
    // await fetch(payload.url, { method: 'POST', body: JSON.stringify(payload) })
    db.updateOrder(payload.orderId, { webhookSent: true });
    return { delivered: true, event: payload.event, statusCode: 200 };
  });

  // Generate invoice PDF for an order
  pool.registerHandler('generate-invoice', async (payload) => {
    console.log(`   🧾  generate-invoice → order ${payload.orderId}`);
    await sleep(300 + Math.random() * 700);
    // Swap for real PDF generation (PDFKit, Puppeteer, etc.)
    const invoiceUrl = `https://cdn.shopflow.com/invoices/${payload.orderId}.pdf`;
    db.updateOrder(payload.orderId, { invoiceUrl, status: 'processing' });
    return { invoiceUrl, orderId: payload.orderId };
  });

  // Generate reports (order history, spending summary)
  pool.registerHandler('generate-report', async (payload) => {
    console.log(`   📊  generate-report → ${payload.type} for user ${payload.userId}`);
    await sleep(400 + Math.random() * 800);
    const orders  = db.getOrdersByUser(payload.userId);
    const reportUrl = `https://cdn.shopflow.com/reports/${payload.reportId}.pdf`;
    db.updateReport(payload.reportId, { status: 'ready', url: reportUrl, generatedAt: Date.now(), summary: { totalOrders: orders.length, totalSpent: orders.reduce((s, o) => s + o.total, 0) } });
    return { reportUrl, reportId: payload.reportId };
  });

  await pool.start();

  // ── HTTP API ───────────────────────────────────────────────────────────
  const app  = createAPI(pool);
  const PORT = parseInt(process.env.PORT || process.env.API_PORT || '3000');

  app.listen(PORT, () => {
    console.log('');
    console.log(`✅  ShopFlow API ready → http://localhost:${PORT}`);
    console.log('');
    console.log('   ── Business API ────────────────────────────────────');
    console.log(`   POST  /auth/register     → create account`);
    console.log(`   POST  /auth/login        → get JWT token`);
    console.log(`   GET   /products          → list products`);
    console.log(`   POST  /products          → add product`);
    console.log(`   POST  /orders            → place order (triggers 3 jobs)`);
    console.log(`   GET   /orders/my         → my orders`);
    console.log(`   POST  /reports/generate  → queue report`);
    console.log(`   GET   /users/me          → my profile`);
    console.log('');
    console.log('   ── Infrastructure ──────────────────────────────────');
    console.log(`   GET   /stats             → queue stats`);
    console.log(`   GET   /health            → health check`);
    console.log(`   GET   /apm/traces        → APM traces`);
    console.log(`   GET   /apm/aggregations  → p50/p95/p99 latency`);
    console.log('');
    console.log(`   🖥️   Dashboard → npm run dashboard  (http://localhost:8080)`);
    console.log('');
    console.log(`   📦  ${db.getStats().products} products seeded and ready`);
    console.log('');
  });

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  async function shutdown(sig) {
    console.log(`\n[main] ${sig} — shutting down...`);
    await pool.shutdown();
    process.exit(0);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });