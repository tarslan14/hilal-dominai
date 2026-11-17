// Optional: tiny local server (node dev-server.js) -> http://localhost:8765
// The game also works by simply double-clicking index.html.
const http = require('http'), fs = require('fs'), path = require('path');
const root = __dirname;
const PORT = process.env.PORT || 8765;
http.createServer((req, res) => {
  let p = path.normalize(path.join(root, decodeURIComponent(req.url.split('?')[0])));
  if (!p.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
    const type = types[path.extname(p)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(PORT, () => console.log('HILAL running at http://localhost:' + PORT));
