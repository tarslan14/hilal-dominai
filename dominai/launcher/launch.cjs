// dominAI desktop launcher (run by the desktop shortcut through launch.vbs, no console window).
//  1. starts the local Ollama server if it is not already running (for the in-game AI aide)
//  2. serves the built game (dist/) on http://localhost:5184
//  3. opens it in its own app window (Edge or Chrome, separate profile so saves stay with the game)
//  4. when that window is closed: stops the web server, and stops Ollama if this launcher started it
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = 5184;
const URL = `http://localhost:${PORT}/`;
const OLLAMA_URL = 'http://localhost:11434/api/version';
const LOG = path.join(__dirname, 'launcher.log');
const log = (m) => { try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${m}\n`); } catch { /* ignore */ } };

const firstExisting = (list) => list.find((p) => p && fs.existsSync(p));
const ping = (url, ms = 1500) => new Promise((res) => {
  const req = http.get(url, { timeout: ms }, (r) => { r.resume(); res(r.statusCode === 200); });
  req.on('error', () => res(false));
  req.on('timeout', () => { req.destroy(); res(false); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findOllama() {
  const env = process.env;
  const fromPath = spawnSync('where', ['ollama'], { encoding: 'utf8', windowsHide: true });
  return firstExisting([
    env.DOMINAI_OLLAMA,
    fromPath.status === 0 ? fromPath.stdout.split(/\r?\n/)[0].trim() : null,
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'),
    'C:\\Program Files\\Ollama\\ollama.exe',
  ]);
}

async function ensureOllama() {
  if (await ping(OLLAMA_URL)) { log('Ollama already running'); return null; }
  const exe = findOllama();
  if (!exe) { log('Ollama not found: the game will use the offline aide'); return null; }
  log('starting Ollama: ' + exe);
  const child = spawn(exe, ['serve'], { windowsHide: true, stdio: 'ignore' });
  child.on('error', (e) => log('Ollama failed to start: ' + e.message));
  for (let i = 0; i < 30; i++) {
    if (await ping(OLLAMA_URL, 800)) { log('Ollama is up'); return child; }
    await sleep(500);
  }
  log('Ollama did not answer in time (the game retries on its own)');
  return child;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json' };
function serve() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent((req.url || '/').split('?')[0]);
      let file = path.normalize(path.join(DIST, rel === '/' ? 'index.html' : rel));
      if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
    });
    server.on('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

function openWindow() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const browser = firstExisting([
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]);
  if (!browser) {
    log('no Edge/Chrome found: opening the default browser');
    spawn('cmd', ['/c', 'start', '', URL], { windowsHide: true, stdio: 'ignore' });
    return null;
  }
  const profile = path.join(process.env.LOCALAPPDATA || __dirname, 'dominAI', 'profile');
  fs.mkdirSync(profile, { recursive: true });
  log('opening window with ' + browser);
  return spawn(browser, [`--app=${URL}`, `--user-data-dir=${profile}`, '--window-size=1500,920', '--no-first-run', '--no-default-browser-check', '--disable-features=Translate'], { stdio: 'ignore' });
}

(async () => {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) { log('dist/ is missing: run "npm run build" in ' + ROOT); process.exit(1); }
  // already running? just bring up another window on the same server
  if (await ping(URL, 800)) { log('game server already running: opening a window'); openWindow(); return; }
  const server = await serve();
  log('serving ' + DIST + ' at ' + URL);
  // open the window at once; Ollama warms up in the background and the game picks it up when ready
  const win = openWindow();
  let ollama = null;
  ensureOllama().then((c) => (ollama = c)).catch((e) => log('Ollama start error: ' + e.message));
  const shutdown = () => {
    log('window closed: shutting down' + (ollama ? ' (and stopping Ollama)' : ''));
    try { server.close(); } catch { /* ignore */ }
    if (ollama && ollama.pid) spawnSync('taskkill', ['/pid', String(ollama.pid), '/T', '/F'], { windowsHide: true });
    process.exit(0);
  };
  if (win) win.on('exit', shutdown);
  // with the default-browser fallback we cannot see the window close: stay up, the next launch reuses us
})().catch((e) => { log('launcher error: ' + (e && e.stack || e)); process.exit(1); });
