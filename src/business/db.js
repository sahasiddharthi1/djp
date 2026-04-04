// /**
//  * business/db.js — In-memory database
//  *
//  * Replaces a real DB (MongoDB/PostgreSQL) with plain JS Maps.
//  * Same structure you'd use with a real DB — just swap Maps for DB calls.
//  *
//  * Collections:
//  *   users     Map<userId,    User>
//  *   products  Map<productId, Product>
//  *   orders    Map<orderId,   Order>
//  *   reports   Map<reportId,  Report>
//  */

// const { v4: uuidv4 } = require('uuid');

// // ── USERS ──────────────────────────────────────────────────────────────────
// const users = new Map();

// // ── PRODUCTS ───────────────────────────────────────────────────────────────
// const products = new Map();

// // ── ORDERS ─────────────────────────────────────────────────────────────────
// const orders = new Map();

// // ── REPORTS ────────────────────────────────────────────────────────────────
// const reports = new Map();

// // ── SEED DATA — some products to start with ────────────────────────────────
// const seedProducts = [
//   { name: 'Wireless Headphones',  price: 2999, category: 'electronics', stock: 50,  imageUrl: null },
//   { name: 'Running Shoes',        price: 1499, category: 'footwear',    stock: 100, imageUrl: null },
//   { name: 'Coffee Maker',         price: 3499, category: 'appliances',  stock: 30,  imageUrl: null },
//   { name: 'Yoga Mat',             price: 799,  category: 'fitness',     stock: 75,  imageUrl: null },
//   { name: 'Mechanical Keyboard',  price: 4999, category: 'electronics', stock: 25,  imageUrl: null },
// ];

// for (const p of seedProducts) {
//   const id = uuidv4();
//   products.set(id, {
//     id, ...p,
//     createdAt: Date.now(),
//     updatedAt: Date.now(),
//   });
// }

// // ── HELPERS ────────────────────────────────────────────────────────────────

// // USERS
// const db = {
//   // ── User ops ──────────────────────────────────────────────────────────
//   createUser({ name, email, passwordHash }) {
//     const id = uuidv4();
//     const user = { id, name, email, passwordHash, createdAt: Date.now(), orders: [] };
//     users.set(id, user);
//     return user;
//   },

//   findUserByEmail(email) {
//     return [...users.values()].find(u => u.email === email) || null;
//   },

//   findUserById(id) {
//     return users.get(id) || null;
//   },

//   updateUser(id, updates) {
//     const user = users.get(id);
//     if (!user) return null;
//     Object.assign(user, updates, { updatedAt: Date.now() });
//     return user;
//   },

//   // ── Product ops ───────────────────────────────────────────────────────
//   getAllProducts() {
//     return [...products.values()];
//   },

//   getProductById(id) {
//     return products.get(id) || null;
//   },

//   createProduct({ name, price, category, stock, description = '' }) {
//     const id = uuidv4();
//     const product = { id, name, price, category, stock, description, imageUrl: null, createdAt: Date.now(), updatedAt: Date.now() };
//     products.set(id, product);
//     return product;
//   },

//   updateProduct(id, updates) {
//     const product = products.get(id);
//     if (!product) return null;
//     Object.assign(product, updates, { updatedAt: Date.now() });
//     return product;
//   },

//   // ── Order ops ─────────────────────────────────────────────────────────
//   createOrder({ userId, items, shippingAddress }) {
//     // items = [{ productId, quantity, price }]
//     const id       = uuidv4();
//     const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
//     const tax      = Math.round(subtotal * 0.18);   // 18% GST
//     const total    = subtotal + tax;

//     const order = {
//       id, userId, items, shippingAddress,
//       subtotal, tax, total,
//       status:    'confirmed',
//       invoiceUrl: null,
//       webhookSent: false,
//       createdAt: Date.now(),
//       updatedAt: Date.now(),
//     };
//     orders.set(id, order);

//     // Link order to user
//     const user = users.get(userId);
//     if (user) user.orders.push(id);

//     // Decrement stock
//     for (const item of items) {
//       const product = products.get(item.productId);
//       if (product) product.stock = Math.max(0, product.stock - item.quantity);
//     }

//     return order;
//   },

//   getOrderById(id) {
//     return orders.get(id) || null;
//   },

//   getOrdersByUser(userId) {
//     return [...orders.values()].filter(o => o.userId === userId);
//   },

//   updateOrder(id, updates) {
//     const order = orders.get(id);
//     if (!order) return null;
//     Object.assign(order, updates, { updatedAt: Date.now() });
//     return order;
//   },

//   // ── Report ops ────────────────────────────────────────────────────────
//   createReport({ userId, type, params }) {
//     const id     = uuidv4();
//     const report = { id, userId, type, params, status: 'pending', url: null, createdAt: Date.now() };
//     reports.set(id, report);
//     return report;
//   },

//   getReportById(id) {
//     return reports.get(id) || null;
//   },

//   updateReport(id, updates) {
//     const report = reports.get(id);
//     if (!report) return null;
//     Object.assign(report, updates);
//     return report;
//   },

//   getReportsByUser(userId) {
//     return [...reports.values()].filter(r => r.userId === userId);
//   },

//   // ── Stats ─────────────────────────────────────────────────────────────
//   getStats() {
//     return {
//       users:    users.size,
//       products: products.size,
//       orders:   orders.size,
//       reports:  reports.size,
//       revenue:  [...orders.values()].reduce((s, o) => s + o.total, 0),
//     };
//   },
// };

// module.exports = db;

/**
 * business/db.js — File-persisted database
 *
 * Saves all data to data/db.json on disk.
 * Loads it back on every server restart — data survives restarts.
 *
 * Collections:
 *   users     Map<userId,    User>
 *   products  Map<productId, Product>
 *   orders    Map<orderId,   Order>
 *   reports   Map<reportId,  Report>
 */

const { v4: uuidv4 } = require('uuid');
const fs   = require('fs');
const path = require('path');

// ── FILE PATH ──────────────────────────────────────────────────────────────
const DATA_DIR  = path.join(__dirname, '../../data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

// Make sure data/ folder exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── COLLECTIONS ────────────────────────────────────────────────────────────
let users    = new Map();
let products = new Map();
let orders   = new Map();
let reports  = new Map();

// ── LOAD FROM DISK ─────────────────────────────────────────────────────────
function load() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      console.log('[DB] No db.json found — starting fresh');
      seed();
      save();
      return;
    }
    const raw  = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    users    = new Map(Object.entries(data.users    || {}));
    products = new Map(Object.entries(data.products || {}));
    orders   = new Map(Object.entries(data.orders   || {}));
    reports  = new Map(Object.entries(data.reports  || {}));
    console.log(`[DB] Loaded from disk — ${users.size} users, ${products.size} products, ${orders.size} orders`);

    // Always make sure seed products exist
    if (products.size === 0) { seed(); save(); }
  } catch(err) {
    console.error('[DB] Load error — starting fresh:', err.message);
    seed();
    save();
  }
}

// ── SAVE TO DISK ───────────────────────────────────────────────────────────
// Debounced — won't write more than once every 500ms even if many ops happen
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const data = {
        users:    Object.fromEntries(users),
        products: Object.fromEntries(products),
        orders:   Object.fromEntries(orders),
        reports:  Object.fromEntries(reports),
        savedAt:  new Date().toISOString(),
      };
      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch(err) {
      console.error('[DB] Save error:', err.message);
    }
  }, 500);
}

// ── SEED DATA ──────────────────────────────────────────────────────────────
function seed() {
  const seedProducts = [
    { name: 'Wireless Headphones',  price: 2999, category: 'electronics', stock: 50  },
    { name: 'Running Shoes',        price: 1499, category: 'footwear',    stock: 100 },
    { name: 'Coffee Maker',         price: 3499, category: 'appliances',  stock: 30  },
    { name: 'Yoga Mat',             price: 799,  category: 'fitness',     stock: 75  },
    { name: 'Mechanical Keyboard',  price: 4999, category: 'electronics', stock: 25  },
    { name: 'Keyboard',             price: 4999, category: 'electronics', stock: 25  },
  ];
 
  for (const p of seedProducts) {
    const id = uuidv4();
    products.set(id, { id, ...p, imageUrl: null, description: '', createdAt: Date.now(), updatedAt: Date.now() });
  }
  console.log('[DB] Seeded 5 default products');
}

// ── DB API ─────────────────────────────────────────────────────────────────
const db = {

  // ── USERS ────────────────────────────────────────────────────────────────
  createUser({ name, email, passwordHash }) {
    const id   = uuidv4();
    const user = { id, name, email, passwordHash, createdAt: Date.now(), orders: [] };
    users.set(id, user);
    save();
    return user;
  },

  findUserByEmail(email) {
    return [...users.values()].find(u => u.email === email) || null;
  },

  findUserById(id) {
    return users.get(id) || null;
  },

  updateUser(id, updates) {
    const user = users.get(id);
    if (!user) return null;
    Object.assign(user, updates, { updatedAt: Date.now() });
    save();
    return user;
  },

  // ── PRODUCTS ─────────────────────────────────────────────────────────────
  getAllProducts() {
    return [...products.values()];
  },

  getProductById(id) {
    return products.get(id) || null;
  },

  createProduct({ name, price, category, stock, description = '' }) {
    const id      = uuidv4();
    const product = { id, name, price, category, stock, description, imageUrl: null, createdAt: Date.now(), updatedAt: Date.now() };
    products.set(id, product);
    save();
    return product;
  },

  updateProduct(id, updates) {
    const product = products.get(id);
    if (!product) return null;
    Object.assign(product, updates, { updatedAt: Date.now() });
    save();
    return product;
  },

  // ── ORDERS ───────────────────────────────────────────────────────────────
  createOrder({ userId, items, shippingAddress }) {
    const id       = uuidv4();
    const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
    const tax      = Math.round(subtotal * 0.18);
    const total    = subtotal + tax;

    const order = {
      id, userId, items, shippingAddress,
      subtotal, tax, total,
      status:      'confirmed',
      invoiceUrl:  null,
      webhookSent: false,
      createdAt:   Date.now(),
      updatedAt:   Date.now(),
    };
    orders.set(id, order);

    // Link order to user
    const user = users.get(userId);
    if (user) { user.orders.push(id); }

    // Decrement stock
    for (const item of items) {
      const product = products.get(item.productId);
      if (product) product.stock = Math.max(0, product.stock - item.quantity);
    }

    save();
    return order;
  },

  getOrderById(id)         { return orders.get(id) || null; },
  getOrdersByUser(userId)  { return [...orders.values()].filter(o => o.userId === userId); },

  updateOrder(id, updates) {
    const order = orders.get(id);
    if (!order) return null;
    Object.assign(order, updates, { updatedAt: Date.now() });
    save();
    return order;
  },

  // ── REPORTS ──────────────────────────────────────────────────────────────
  createReport({ userId, type, params }) {
    const id     = uuidv4();
    const report = { id, userId, type, params, status: 'pending', url: null, createdAt: Date.now() };
    reports.set(id, report);
    save();
    return report;
  },

  getReportById(id)        { return reports.get(id) || null; },
  getReportsByUser(userId) { return [...reports.values()].filter(r => r.userId === userId); },

  updateReport(id, updates) {
    const report = reports.get(id);
    if (!report) return null;
    Object.assign(report, updates);
    save();
    return report;
  },

  // ── STATS ─────────────────────────────────────────────────────────────────
  getStats() {
    return {
      users:    users.size,
      products: products.size,
      orders:   orders.size,
      reports:  reports.size,
      revenue:  [...orders.values()].reduce((s, o) => s + o.total, 0),
    };
  },
};

// ── BOOT — load data immediately ───────────────────────────────────────────
load();

module.exports = db;