/**
 * routes/product.routes.js
 *
 * GET  /products         → list all products
 * GET  /products/:id     → single product
 * POST /products         → add product (triggers image processing job)
 * PUT  /products/:id     → update product
 */

const express        = require('express');
const db             = require('../db');
const { requireAuth } = require('../auth');
const store          = require('../../core/job-store');

const router = express.Router();

// ── GET /products ─────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const { category, minPrice, maxPrice, search } = req.query;
  let list = db.getAllProducts();

  if (category) list = list.filter(p => p.category === category);
  if (minPrice) list = list.filter(p => p.price >= parseInt(minPrice));
  if (maxPrice) list = list.filter(p => p.price <= parseInt(maxPrice));
  if (search)   list = list.filter(p => p.name.toLowerCase().includes(search.toLowerCase()));

  res.json({ products: list, total: list.length });
});

// ── GET /products/:id ─────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const product = db.getProductById(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json(product);
});

// ── POST /products (auth required) ───────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, price, category, stock, description, imageBase64 } = req.body;

    if (!name || !price || !category) {
      return res.status(400).json({ error: 'name, price and category are required' });
    }

    const product = db.createProduct({ name, price, category, stock: stock || 0, description });

    // Background job: process product image if provided
    if (imageBase64) {
      await store.enqueue({
        type:         'process-image',
        partitionKey: `product-${product.id}`,
        payload: {
          productId:   product.id,
          imageBase64,
          sizes:       ['thumbnail', 'medium', 'large'],
          context:     'product-upload',
        },
      });
    }

    res.status(201).json({
      message: 'Product created',
      product,
      jobs: imageBase64 ? ['Image processing queued'] : [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /products/:id (auth required) ────────────────────────────────────
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const product = db.updateProduct(req.params.id, req.body);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json({ message: 'Product updated', product });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;