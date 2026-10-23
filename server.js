// Skin Changer — site local de configurações (http://127.0.0.1:3000)
// Node 18+, sem dependências. Rode: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const HOST = '127.0.0.1';
const ROOT = __dirname;
const SETTINGS = path.join(ROOT, 'settings.json');
const BUNDLED = path.join(ROOT, 'default-catalog.txt'); // dump enviado; usado se o workspace nao tiver catalog.txt

// pasta workspace do MATCHA (a que o readfile/writefile do script enxerga), nao a do projeto do site
const MATCHA_DEFAULT = 'C:/matcha/workspace';
let settings = { workspace: process.env.MATCHA_WORKSPACE || (fs.existsSync(MATCHA_DEFAULT) ? MATCHA_DEFAULT : path.join(ROOT, 'workspace')) };
try { Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))); } catch {}

const okHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const NAME_RE = /^[\w\-. ]{1,60}$/;

const cfgDir = () => path.join(settings.workspace, 'sapped_SkinChanger', 'Configs');
const catalogPath = () => path.join(settings.workspace, 'skinScan', 'catalog.txt');
const activePath = () => path.join(cfgDir(), 'active.txt');
const indexPath = () => path.join(cfgDir(), 'index.txt');

function ensureDirs() {
  fs.mkdirSync(cfgDir(), { recursive: true });
  fs.mkdirSync(path.dirname(catalogPath()), { recursive: true });
}
ensureDirs();

// escrita atômica: o Lua nunca lê um arquivo pela metade
function atomicWrite(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function listConfigs() {
  try {
    return fs.readdirSync(cfgDir()).filter(f => f.endsWith('.cfg')).map(f => f.slice(0, -4)).sort();
  } catch { return []; }
}
function writeIndex() { atomicWrite(indexPath(), listConfigs().join('\n') + '\n'); }
function readActive() {
  try { return fs.readFileSync(activePath(), 'utf8').trim() || null; } catch { return null; }
}
// o dump pode ter UTF-8 truncado no meio de um caractere (nomes longos); toString('utf8') troca por U+FFFD
function catalogFields() {
  try { return { catalog: fs.readFileSync(catalogPath()).toString('utf8'), catalogSource: 'workspace' }; } catch {}
  try { return { catalog: fs.readFileSync(BUNDLED).toString('utf8'), catalogSource: 'bundled' }; } catch {}
  return { catalog: null, catalogSource: 'none' };
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('corpo grande demais')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('JSON inválido')); }
    });
    req.on('error', reject);
  });
}

// proteção contra DNS rebinding / CSRF: o site só aceita Host local e, para escrita, Origin local
function guard(req, res) {
  if (!okHosts.has(req.headers.host)) { send(res, 403, { error: 'host inválido' }); return false; }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const o = (req.headers.origin || '').replace(/^https?:\/\//, '');
    if (!okHosts.has(o)) { send(res, 403, { error: 'origem inválida' }); return false; }
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    if (!guard(req, res)) return;
    const p = new URL(req.url, 'http://x').pathname;

    if (req.method === 'GET' && p === '/') {
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', 'index.html')), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && p === '/api/state') {
      try { writeIndex(); } catch {} // indexa arquivos .cfg colocados a mao na pasta
      return send(res, 200, {
        workspace: settings.workspace,
        ...catalogFields(),
        configs: listConfigs(),
        active: readActive(),
      });
    }

    if (req.method === 'POST' && p === '/api/workspace') {
      const { path: dir } = await readBody(req);
      const abs = path.resolve(String(dir || ''));
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return send(res, 400, { error: 'pasta não existe' });
      settings.workspace = abs;
      fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
      ensureDirs();
      try { writeIndex(); } catch {}
      return send(res, 200, { ok: true, workspace: abs, ...catalogFields(), configs: listConfigs(), active: readActive() });
    }

    if (req.method === 'POST' && p === '/api/catalog') {
      const { text } = await readBody(req);
      if (typeof text !== 'string' || !text.trim()) return send(res, 400, { error: 'catálogo vazio' });
      atomicWrite(catalogPath(), text);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/active') {
      const { name } = await readBody(req);
      if (name == null) { try { fs.unlinkSync(activePath()); } catch {} return send(res, 200, { ok: true, active: null }); }
      if (!NAME_RE.test(name) || !listConfigs().includes(name)) return send(res, 400, { error: 'config não existe' });
      atomicWrite(activePath(), name + '\n');
      return send(res, 200, { ok: true, active: name });
    }

    const m = p.match(/^\/api\/configs\/(.+)$/);
    if (m) {
      const name = decodeURIComponent(m[1]);
      if (!NAME_RE.test(name) || name.startsWith('.')) return send(res, 400, { error: 'nome inválido' });
      const file = path.join(cfgDir(), name + '.cfg');

      if (req.method === 'GET') {
        if (!fs.existsSync(file)) return send(res, 404, { error: 'não encontrada' });
        return send(res, 200, { name, text: fs.readFileSync(file, 'utf8') });
      }
      if (req.method === 'PUT') {
        const { text } = await readBody(req);
        if (typeof text !== 'string') return send(res, 400, { error: 'texto ausente' });
        atomicWrite(file, text);
        writeIndex();
        return send(res, 200, { ok: true, configs: listConfigs() });
      }
      if (req.method === 'DELETE') {
        try { fs.unlinkSync(file); } catch {}
        if (readActive() === name) { try { fs.unlinkSync(activePath()); } catch {} }
        writeIndex();
        return send(res, 200, { ok: true, configs: listConfigs(), active: readActive() });
      }
    }

    send(res, 404, { error: 'rota não encontrada' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

try { writeIndex(); } catch {}
server.listen(PORT, HOST, () => {
  console.log(`Skin Changer configs: http://${HOST}:${PORT}`);
  console.log(`Workspace: ${settings.workspace}`);
});
