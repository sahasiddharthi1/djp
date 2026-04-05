/**
 * tests/load-test.js
 * Run: npm test   (server must be running first: npm start)
 */

const BASE = process.env.API_URL || 'https://djp-yc84.onrender.com';
const post = (path, body) =>
  fetch(`${BASE}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  }).then(r => r.json());

const get = (path) => fetch(`${BASE}${path}`).then(r => r.json());

// ── 1. Health ─────────────────────────────────────────────────────────────
async function testHealth() {
  console.log('\n❤️  Test 1: Health check');
  const h = await get('/health');
  console.log(`   status: ${h.status} | storage: ${h.storage} | workers: ${h.workers}`);
  console.log(`   ${h.status === 'healthy' ? '✅ PASS' : '❌ FAIL'}`);
}

// ── 2. Idempotency ────────────────────────────────────────────────────────
async function testIdempotency() {
  console.log('\n🔁 Test 2: Idempotency (same deduplicationId sent 3×)');
  const id = `dedup-${Date.now()}`;
  const results = await Promise.all([
    post('/jobs', { type: 'send-email', payload: { to: 'a@b.com' }, deduplicationId: id }),
    post('/jobs', { type: 'send-email', payload: { to: 'a@b.com' }, deduplicationId: id }),
    post('/jobs', { type: 'send-email', payload: { to: 'a@b.com' }, deduplicationId: id }),
  ]);
  const enqueued   = results.filter(r => r.jobId).length;
  const duplicates = results.filter(r => r.message?.includes('Duplicate')).length;
  console.log(`   enqueued: ${enqueued}, duplicates rejected: ${duplicates}`);
  console.log(`   ${duplicates === 2 ? '✅ PASS' : '❌ FAIL'}`);
}

// ── 3. Delayed job ────────────────────────────────────────────────────────
async function testScheduled() {
  console.log('\n⏰ Test 3: Scheduled job (5 seconds from now)');
  const runAt = new Date(Date.now() + 5000).toISOString();
  const r = await post('/jobs', {
    type: 'send-email', payload: { to: 'future@test.com' }, runAt,
  });
  console.log(`   jobId: ${r.jobId?.slice(0,8)}… | scheduled: ${r.scheduled}`);
  console.log(`   ${r.scheduled ? '✅ PASS' : '❌ FAIL'}`);
}

// ── 4. Throughput ─────────────────────────────────────────────────────────
async function testThroughput(count = 200) {
  console.log(`\n📊 Test 4: Throughput — enqueue ${count} jobs`);
  const types  = ['send-email', 'process-image', 'send-webhook', 'generate-report'];
  const t0     = Date.now();

  // Fire in parallel batches of 20
  for (let i = 0; i < count; i += 20) {
    const chunk = Math.min(20, count - i);
    await Promise.all(
      Array.from({ length: chunk }, (_, j) => post('/jobs', {
        type:         types[(i + j) % types.length],
        payload:      { userId: (i + j) % 50, index: i + j },
        partitionKey: `user-${(i + j) % 50}`,
        priority:     Math.ceil(Math.random() * 5),
      }))
    );
  }

  const elapsed    = (Date.now() - t0) / 1000;
  const perSec     = Math.round(count / elapsed);
  const perMin     = perSec * 60;
  console.log(`   ✅ ${count} jobs in ${elapsed.toFixed(2)}s`);
  console.log(`   🚀 ~${perSec.toLocaleString()} jobs/sec  (~${perMin.toLocaleString()} jobs/min)`);
}

// ── 5. Stats ──────────────────────────────────────────────────────────────
async function testStats() {
  console.log('\n📈 Test 5: Queue stats');
  const s = await get('/stats');
  const depth = Object.values(s.queue?.partitions || {})
    .reduce((a, p) => a + p.streamLength, 0);
  console.log(`   queue depth:  ${depth}`);
  console.log(`   scheduled:    ${s.queue?.scheduledCount}`);
  console.log(`   dlq:          ${s.queue?.dlqSize}`);
  console.log(`   workers:      ${s.workers?.workerCount}`);
  if (s.metrics) {
    console.log(`   completed:    ${s.metrics.jobs.completed}`);
    console.log(`   avg latency:  ${s.metrics.latency.avgSeconds}s`);
  }
}

// ── Run all ───────────────────────────────────────────────────────────────
(async () => {
  console.log('🧪 Load Test Suite');
  console.log(`   Target: ${BASE}`);
  try { await get('/health'); } catch {
    console.error('\n❌ Cannot reach server. Run  npm start  first.\n');
    process.exit(1);
  }

  await testHealth();
  await testIdempotency();
  await testScheduled();
  await testThroughput(200);
  await testStats();

  console.log('\n✅ All tests done!\n');
})();