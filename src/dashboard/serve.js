// src/dashboard/serve.js
// Serves the dashboard HTML on port 8080 so fetch() works without CORS errors.
// Run: node src/dashboard/serve.js   OR   npm run dashboard

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = 8080;
const FILE = path.join(__dirname, 'index.html');

http.createServer((req, res) => {
  fs.readFile(FILE, (err, data) => {
    if (err) { res.writeHead(404); return res.end('dashboard/index.html not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`\n🖥️  Dashboard → http://localhost:${PORT}`);
  console.log('   Make sure the job processor is running: npm start\n');
});