/**
 * business/auth.js — JWT Authentication
 *
 * Two exports:
 *   generateToken(user)   → creates a signed JWT
 *   requireAuth           → Express middleware, verifies token on protected routes
 *
 * Usage on any route:
 *   router.get('/orders/my', requireAuth, (req, res) => {
 *     const userId = req.user.id;  // injected by requireAuth
 *   })
 */

const jwt = require('jsonwebtoken');

const SECRET  = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const EXPIRES = process.env.JWT_EXPIRES || '7d';

function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name },
    SECRET,
    { expiresIn: EXPIRES }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header', hint: 'Use: Authorization: Bearer <token>' });
  }

  const token = header.slice(7);
  try {
    const decoded = jwt.verify(token, SECRET);
    req.user = decoded;   // { id, email, name, iat, exp }
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired — please login again' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

module.exports = { generateToken, requireAuth };