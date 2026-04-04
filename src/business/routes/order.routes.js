/**
 * routes/order.routes.js
 *
 * POST /orders           → place order → triggers 3 background jobs
 * GET  /orders/my        → my order history
 * GET  /orders/:id       → single order status
 */

const express         = require('express');
const db              = require('../db');
const { requireAuth } = require('../auth');
const store           = require('../../core/job-store');

const router = express.Router();

// ── POST /orders ──────────────────────────────────────────────────────────
// This is the KEY endpoint — one order triggers 3 background jobs
router.post('/', requireAuth, async (req, res) => {
  try {
    const { items, shippingAddress } = req.body;
    // items = [{ productId, quantity }]

    if (!items || !items.length) {
      return res.status(400).json({ error: 'items array is required' });
    }
    if (!shippingAddress) {
      return res.status(400).json({ error: 'shippingAddress is required' });
    }

    // Validate products and build order items with prices
    const orderItems = [];
    for (const item of items) {
      const product = db.getProductById(item.productId);
      if (!product) return res.status(404).json({ error: `Product ${item.productId} not found` });
      if (product.stock < item.quantity) {
        return res.status(400).json({ error: `Insufficient stock for "${product.name}" (available: ${product.stock})` });
      }
      orderItems.push({ productId: item.productId, name: product.name, quantity: item.quantity, price: product.price });
    }

    // Create the order in DB
    const user  = db.findUserById(req.user.id);
    const order = db.createOrder({ userId: req.user.id, items: orderItems, shippingAddress });

    const jobIds = [];

    // ── Job 1: Generate invoice PDF ───────────────────────────────────
    const invoiceJob = await store.enqueue({
      type:           'generate-invoice',
      partitionKey:   `order-${order.id}`,
      deduplicationId:`invoice-${order.id}`,   // idempotent — never double-generate
      payload: {
        orderId:         order.id,
        userId:          req.user.id,
        customerName:    user?.name || req.user.name,
        customerEmail:   user?.email || req.user.email,
        items:           orderItems,
        subtotal:        order.subtotal,
        tax:             order.tax,
        total:           order.total,
        shippingAddress,
      },
    });
    jobIds.push({ job: 'generate-invoice', jobId: invoiceJob.jobId });

    // ── Job 2: Send order confirmation email ─────────────────────────
    const emailJob = await store.enqueue({
      type:           'send-email',
      partitionKey:   `user-${req.user.id}`,
      deduplicationId:`email-order-${order.id}`,
      payload: {
        to:      user?.email || req.user.email,
        subject: `Order Confirmed — #${order.id.slice(0, 8).toUpperCase()}`,
        body:    `Your order of ${orderItems.length} item(s) worth ₹${(order.total/100).toFixed(2)} has been confirmed.`,
        type:    'order-confirmation',
        orderId: order.id,
      },
    });
    jobIds.push({ job: 'send-email', jobId: emailJob.jobId });

    // ── Job 3: Notify shipping webhook ────────────────────────────────
    const webhookJob = await store.enqueue({
      type:           'send-webhook',
      partitionKey:   `order-${order.id}`,
      deduplicationId:`webhook-${order.id}`,
      payload: {
        event:   'order.created',
        orderId: order.id,
        userId:  req.user.id,
        total:   order.total,
        items:   orderItems.map(i => ({ productId: i.productId, quantity: i.quantity })),
        url:     process.env.SHIPPING_WEBHOOK_URL || 'https://webhook.site/your-id',
      },
    });
    jobIds.push({ job: 'send-webhook', jobId: webhookJob.jobId });

    res.status(201).json({
      message:         'Order placed successfully',
      orderId:         order.id,
      total:           order.total,
      status:          order.status,
      backgroundJobs:  jobIds,
      note:            '3 background jobs queued: invoice generation, confirmation email, shipping webhook',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /orders/my ────────────────────────────────────────────────────────
router.get('/my', requireAuth, (req, res) => {
  const myOrders = db.getOrdersByUser(req.user.id);
  res.json({ orders: myOrders, total: myOrders.length });
});

// ── GET /orders/:id ───────────────────────────────────────────────────────
router.get('/:id', requireAuth, (req, res) => {
  const order = db.getOrderById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.userId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
  res.json(order);
});

module.exports = router;