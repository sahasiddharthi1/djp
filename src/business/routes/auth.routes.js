/**
 * routes/auth.routes.js
 *
 * POST /auth/register   → create account, returns JWT
 * POST /auth/login      → verify password, returns JWT
 */

const express          = require('express');
const bcrypt           = require('bcryptjs');
const db               = require('../db');
const { generateToken } = require('../auth');
const store            = require('../../core/job-store');

const router = express.Router();

// ── POST /auth/register ───────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Check duplicate email
    if (db.findUserByEmail(email)) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);
    const user         = db.createUser({ name, email, passwordHash });
    const token        = generateToken(user);

    // Background job: send welcome email
    await store.enqueue({
      type:         'send-email',
      partitionKey: `user-${user.id}`,
      payload: {
        to:      email,
        subject: 'Welcome to ShopFlow!',
        body:    `Hi ${name}, your account has been created successfully.`,
        type:    'welcome',
      },
    });

    res.status(201).json({
      message: 'Account created successfully',
      token,
      user: { id: user.id, name: user.name, email: user.email },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /auth/login ──────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const user = db.findUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = generateToken(user);

    res.json({
      message: 'Login successful',
      token,
      user: { id: user.id, name: user.name, email: user.email },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;