const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const auth = require('./auth');

const app = express();
const PORT = Number(process.env.PORT || 9000);
const NODE_ENV = process.env.NODE_ENV || 'development';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';

const PUBLIC_DIR = path.resolve(__dirname, 'public');
const CONTENT_DIR = path.resolve(__dirname, 'content');
const IMAGES_DIR = path.resolve(__dirname, 'images');

const ALLOWED_IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MAX_IMG_BYTES = 8 * 1024 * 1024; // 8 MB

fs.mkdirSync(CONTENT_DIR, { recursive: true });
fs.mkdirSync(IMAGES_DIR, { recursive: true });

if (process.env.TRUSTED_PROXY) {
  app.set('trust proxy', process.env.TRUSTED_PROXY);
}

// ============================================================================
// 1. Migración automática de archivos legacy a usr_admin (idempotente)
// ============================================================================
function migrateLegacyToAdmin() {
  const adminContent = path.join(CONTENT_DIR, 'usr_admin');
  const adminImages = path.join(IMAGES_DIR, 'usr_admin');
  fs.mkdirSync(adminContent, { recursive: true });
  fs.mkdirSync(adminImages, { recursive: true });

  for (const entry of fs.readdirSync(CONTENT_DIR)) {
    if (entry.startsWith('usr_') || entry.startsWith('.')) continue;
    const src = path.join(CONTENT_DIR, entry);
    const dest = path.join(adminContent, entry);
    if (!fs.existsSync(dest)) {
      fs.renameSync(src, dest);
    }
  }

  for (const entry of fs.readdirSync(IMAGES_DIR)) {
    if (entry.startsWith('usr_') || entry.startsWith('.')) continue;
    const src = path.join(IMAGES_DIR, entry);
    const dest = path.join(adminImages, entry);
    if (!fs.existsSync(dest)) {
      fs.renameSync(src, dest);
    }
  }
}

// ============================================================================
// 2. Cabeceras de seguridad (CSP estricta 'self') y protección CSRF básica
// ============================================================================
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'"
    ].join('; ')
  );
  next();
});

app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (ALLOWED_ORIGIN && origin && origin !== ALLOWED_ORIGIN) {
    return res.status(403).json({ error: 'Origen no permitido' });
  }
  next();
});

// Rate limiter en memoria para /api/auth/login y /api/auth/register
const authAttempts = new Map();
function rateLimitAuth(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const maxAttempts = 20;

  const record = authAttempts.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + windowMs;
  }
  record.count += 1;
  authAttempts.set(ip, record);

  if (record.count > maxAttempts) {
    return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
  }
  next();
}

app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: 'text/plain', limit: '12mb' }));

// ============================================================================
// 3. Helpers de aislamiento de archivos por usuario (Anti-Path Traversal)
// ============================================================================
function getUserDirs(userId) {
  const safeId = String(userId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) throw new Error('ID de usuario inválido');
  const contentRoot = path.join(CONTENT_DIR, safeId);
  const imagesRoot = path.join(IMAGES_DIR, safeId);
  fs.mkdirSync(contentRoot, { recursive: true });
  fs.mkdirSync(imagesRoot, { recursive: true });
  return { contentRoot, imagesRoot };
}

function resolveSafeMdPath(userId, relPathRaw) {
  const { contentRoot } = getUserDirs(userId);
  let clean = String(relPathRaw || 'doc.md').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean.endsWith('.md')) clean += '.md';
  const resolved = path.resolve(contentRoot, clean);
  if (resolved !== contentRoot && !resolved.startsWith(contentRoot + path.sep)) {
    return null;
  }
  return { resolved, rel: path.relative(contentRoot, resolved).replace(/\\/g, '/') };
}

function resolveSafeImgPath(userId, filenameRaw) {
  const { imagesRoot } = getUserDirs(userId);
  const base = path.basename(String(filenameRaw || ''));
  const ext = path.extname(base).toLowerCase();
  if (!base || !ALLOWED_IMG_EXT.has(ext)) return null;
  const safeName = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  const resolved = path.resolve(imagesRoot, safeName);
  if (!resolved.startsWith(imagesRoot + path.sep)) return null;
  return { resolved, safeName };
}

function extractTags(mdText) {
  const match = mdText.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return [];
  const tagLine = match[1].match(/^tags:\s*\[([^\]]*)\]/m);
  if (!tagLine) return [];
  return tagLine[1]
    .split(',')
    .map((t) => t.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function walkMarkdownFiles(dir, baseDir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkMarkdownFiles(full, baseDir));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const rel = path.relative(baseDir, full).replace(/\\/g, '/');
      const folder = path.dirname(rel) === '.' ? '' : path.dirname(rel);
      let tags = [];
      try {
        tags = extractTags(fs.readFileSync(full, 'utf8'));
      } catch {}
      results.push({ path: rel, name: entry.name, folder, tags });
    }
  }
  return results;
}

function ensureUserWelcomeDoc(userId, username) {
  const target = resolveSafeMdPath(userId, 'doc.md');
  if (target && !fs.existsSync(target.resolved)) {
    const welcome = `---\ntags: [inicio]\nmarkmap:\n  layout: tree\n  theme: classic\n---\n# Bienvenido a mdmap, ${username}\n\n## Primeros pasos\n- Crea nuevas notas desde el panel izquierdo\n- Usa la barra derecha para cambiar tema, layout y exportar\n`;
    fs.writeFileSync(target.resolved, welcome, 'utf8');
  }
}

// ============================================================================
// 4. Rutas públicas (Auth, PWA icon y estáticos no sensibles)
// ============================================================================
app.post('/api/auth/login', rateLimitAuth, async (req, res) => {
  const { username, password } = req.body || {};
  const user = await auth.loginUser(username, password);
  if (!user) return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });

  ensureUserWelcomeDoc(user.id, user.username);
  const token = auth.createSession(user);
  auth.setSessionCookie(res, token);
  res.json({ ok: true, user: { username: user.username, role: user.role } });
});

app.post('/api/auth/register', rateLimitAuth, async (req, res) => {
  const { username, password, code } = req.body || {};
  const result = await auth.registerWithInvite(username, password, code);
  if (result.error) return res.status(400).json({ error: result.error });

  ensureUserWelcomeDoc(result.user.id, result.user.username);
  const token = auth.createSession(result.user);
  auth.setSessionCookie(res, token);
  res.json({ ok: true, user: { username: result.user.username, role: result.user.role } });
});

app.post('/api/auth/logout', (req, res) => {
  const session = auth.getSessionFromReq(req);
  if (session) auth.destroySession(session.token);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', auth.requireAuth, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role });
});

app.get('/api/pwa-icon', (req, res) => {
  const size = Math.min(Math.max(parseInt(req.query.size, 10) || 192, 64), 512);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#16171b"/><circle cx="30" cy="50" r="10" fill="#7c6cf6"/><circle cx="72" cy="30" r="8" fill="#34d399"/><circle cx="72" cy="70" r="8" fill="#38bdf8"/><path d="M39 46 L65 33 M39 54 L65 67" stroke="#e4e6eb" stroke-width="5" stroke-linecap="round"/></svg>`;
  res.type('image/svg+xml').send(svg);
});

// Proteger explícitamente la app principal antes de servir public/
app.get(['/', '/index.html'], auth.requireAuth, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use(express.static(PUBLIC_DIR, { index: false }));

// ============================================================================
// 5. Rutas de Administración (Códigos de invitación)
// ============================================================================
app.get('/api/admin/invites', auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json(auth.listInvites());
});

app.post('/api/admin/invites', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const note = (req.body && req.body.note) || '';
  const invite = auth.createInvite(req.user.username, note);
  res.json(invite);
});

// ============================================================================
// 6. API de Notas e Imágenes (100% aislada por req.user.id)
// ============================================================================
app.get('/api/files', auth.requireAuth, (req, res) => {
  const { contentRoot } = getUserDirs(req.user.id);
  ensureUserWelcomeDoc(req.user.id, req.user.username);
  const files = walkMarkdownFiles(contentRoot, contentRoot);
  res.json(files);
});

app.get('/api/content', auth.requireAuth, (req, res) => {
  const target = resolveSafeMdPath(req.user.id, req.query.file || 'doc.md');
  if (!target) return res.status(400).send('Ruta inválida');
  if (!fs.existsSync(target.resolved)) {
    if (target.rel === 'doc.md') {
      ensureUserWelcomeDoc(req.user.id, req.user.username);
    } else {
      return res.status(404).send('Archivo no encontrado');
    }
  }
  res.type('text/plain; charset=utf-8').send(fs.readFileSync(target.resolved, 'utf8'));
});

app.post('/api/content', auth.requireAuth, (req, res) => {
  const target = resolveSafeMdPath(req.user.id, req.query.file);
  if (!target) return res.status(400).send('Ruta inválida');
  fs.mkdirSync(path.dirname(target.resolved), { recursive: true });
  fs.writeFileSync(target.resolved, typeof req.body === 'string' ? req.body : '', 'utf8');
  res.send('OK');
});

app.delete('/api/content', auth.requireAuth, (req, res) => {
  const target = resolveSafeMdPath(req.user.id, req.query.file);
  if (!target || target.rel === 'doc.md') return res.status(400).send('No permitido');
  if (fs.existsSync(target.resolved)) fs.unlinkSync(target.resolved);
  res.send('OK');
});

app.post('/api/rename', auth.requireAuth, (req, res) => {
  const oldTarget = resolveSafeMdPath(req.user.id, req.query.old);
  const newTarget = resolveSafeMdPath(req.user.id, req.query.new);
  if (!oldTarget || !newTarget || oldTarget.rel === 'doc.md') {
    return res.status(400).send('Ruta inválida');
  }
  if (!fs.existsSync(oldTarget.resolved)) return res.status(404).send('No encontrado');
  fs.mkdirSync(path.dirname(newTarget.resolved), { recursive: true });
  fs.renameSync(oldTarget.resolved, newTarget.resolved);
  res.type('text/plain').send(newTarget.rel);
});

app.get('/api/images', auth.requireAuth, (req, res) => {
  const { imagesRoot } = getUserDirs(req.user.id);
  const imgs = fs.readdirSync(imagesRoot).filter((f) => ALLOWED_IMG_EXT.has(path.extname(f).toLowerCase()));
  res.json(imgs);
});

app.post('/api/images', auth.requireAuth, (req, res) => {
  const target = resolveSafeImgPath(req.user.id, req.query.name);
  if (!target) return res.status(400).send('Nombre o extensión de imagen no permitida');

  const dataUri = typeof req.body === 'string' ? req.body : '';
  const match = dataUri.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return res.status(400).send('Formato Data URI inválido');

  const buf = Buffer.from(match[2], 'base64');
  if (buf.length > MAX_IMG_BYTES) return res.status(413).send('Imagen demasiado grande');

  fs.writeFileSync(target.resolved, buf);
  res.type('text/plain').send(target.safeName);
});

// Ruta protegida para servir imágenes únicamente del usuario autenticado
app.get('/images/:filename', auth.requireAuth, (req, res) => {
  const target = resolveSafeImgPath(req.user.id, req.params.filename);
  if (!target || !fs.existsSync(target.resolved)) return res.status(404).send('No encontrada');
  res.sendFile(target.resolved);
});

// ============================================================================
// 7. Arranque
// ============================================================================
(async () => {
  try {
    migrateLegacyToAdmin();
    await auth.ensureAdminUser();
    app.listen(PORT, () => {
      console.log(`mdmap escuchando en puerto ${PORT} (${NODE_ENV})`);
    });
  } catch (err) {
    console.error('Error al iniciar mdmap:', err.message);
    process.exit(1);
  }
})();