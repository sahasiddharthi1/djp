/**
 * routes/user.routes.js
 *
 * GET  /users/me        → my profile + order count
 * PUT  /users/me        → update name / email
 * GET  /users/me/stats  → my spending summary
 */

const express         = require('express');
const db              = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// ── GET /users/me ─────────────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  const user = db.findUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { passwordHash, ...safe } = user;
  res.json({ user: safe });
});

// ── PUT /users/me ─────────────────────────────────────────────────────────
router.put('/me', requireAuth, (req, res) => {
  const { name, email } = req.body;
  const updates = {};
  if (name)  updates.name  = name;
  if (email) updates.email = email;

  const user = db.updateUser(req.user.id, updates);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { passwordHash, ...safe } = user;
  res.json({ message: 'Profile updated', user: safe });
});

// ── GET /users/me/stats ───────────────────────────────────────────────────
router.get('/me/stats', requireAuth, (req, res) => {
  const orders = db.getOrdersByUser(req.user.id);
  const total  = orders.reduce((s, o) => s + o.total, 0);
  const items  = orders.reduce((s, o) => s + o.items.reduce((a, i) => a + i.quantity, 0), 0);

  res.json({
    userId:       req.user.id,
    totalOrders:  orders.length,
    totalSpent:   total,
    totalItems:   items,
    recentOrders: orders.slice(-5).reverse(),
  });
});

module.exports = router;