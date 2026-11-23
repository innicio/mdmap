const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const IS_PROD = process.env.NODE_ENV === 'production';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ''; // Ej: https://mdmap.tudominio.es
const REQUIRE_CF_ACCESS = process.env.REQUIRE_CF_ACCESS === 'true';

const CONTENT_DIR = path.resolve(__dirname, 'content');
const IMAGES_DIR = path.resolve(__dirname, 'images');
const PUBLIC_DIR = path.resolve(__dirname, 'public');

fs.mkdirSync(CONTENT_DIR, { recursive: true });
fs.mkdirSync(IMAGES_DIR, { recursive: true });

// 1. Red y Proxy tras Cloudflare Tunnel (solo redes privadas de Docker)
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUSTED_PROXY || 'loopback, linklocal, uniquelocal');

// 2. Cabeceras de Seguridad
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  // Nota: si alojas KaTeX y Marked en /assets/, elimina https://cdn.jsdelivr.net de esta CSP
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
      "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
      "font-src 'self' data: https://cdn.jsdelivr.net",
      "img-src 'self' data: blob:",
      "connect-src 'self' https://cdn.jsdelivr.net",
      "frame-ancestors 'none'",
      "base-uri 'self'"
    ].join('; ')
  );
  next();
});

// 3. Control de Origin (CORS + anti-CSRF) y verificación Cloudflare Access en /api
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGIN && origin) {
    if (origin !== ALLOWED_ORIGIN) {
      return res.status(403).json({ error: 'Origen no autorizado' });
    }
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Vary', 'Origin');
  }

  // Bloquear mutaciones sin Origin válido en producción
  if (IS_PROD && ALLOWED_ORIGIN && ['POST', 'PUT', 'DELETE'].includes(req.method)) {
    if (origin !== ALLOWED_ORIGIN) {
      return res.status(403).json({ error: 'Petición bloqueada por política de origen' });
    }
  }

  // Defensa en profundidad si se usa Cloudflare Access
  if (REQUIRE_CF_ACCESS && !req.headers['cf-access-authenticated-user-email']) {
    return res.status(401).json({ error: 'Autenticación requerida' });
  }
  next();
});

// 4. Archivos estáticos seguros (dotfiles bloqueados y sandbox en /images)
app.use(express.static(PUBLIC_DIR, { dotfiles: 'deny' }));
app.use('/images', (req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}, express.static(IMAGES_DIR, { dotfiles: 'deny' }));

app.use(express.json({ limit: '2mb' }));
app.use(express.text({ type: 'text/*', limit: '5mb' }));

// 5. Validación estricta contra Path Traversal
function resolveSafeMdPath(relPath = 'doc.md') {
  if (typeof relPath !== 'string' || relPath.includes('\0')) {
    throw new Error('Ruta inválida');
  }
  let clean = relPath.trim().replace(/^\/+/, '');
  if (!clean.endsWith('.md')) clean += '.md';
  const resolved = path.resolve(CONTENT_DIR, clean);
  if (!resolved.startsWith(CONTENT_DIR + path.sep)) {
    throw new Error('Acceso fuera del directorio permitido');
  }
  return resolved;
}

// 6. Validación de Magic Bytes reales para imágenes (PNG, JPEG, GIF, WebP; bloquea SVG)
function detectImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 4).toString('ascii') === 'GIF8') return 'gif';
  if (
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'webp';
  return null;
}

function scanMarkdownDir(dir, baseDir = dir) {
  let results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(scanMarkdownDir(fullPath, baseDir));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
      const folder = path.dirname(relPath) === '.' ? '' : path.dirname(relPath);
      const head = fs.readFileSync(fullPath, 'utf8').split('\n').slice(0, 15).join('\n');
      const tags = new Set();
      const yamlMatch = head.match(/tags:\s*\[([^\]]+)\]/i);
      if (yamlMatch) {
        yamlMatch[1].split(',').forEach(t => tags.add(t.trim().replace(/^['"#]+|['"]+$/g, '')));
      }
      const hashMatches = head.match(/(?:^|\s)#([a-zA-Z0-9_-]+)/g);
      if (hashMatches) {
        hashMatches.forEach(t => tags.add(t.trim().substring(1)));
      }
      results.push({ path: relPath, name: entry.name, folder, tags: [...tags].filter(Boolean) });
    }
  }
  return results;
}

app.get('/api/files', (req, res) => {
  let files = scanMarkdownDir(CONTENT_DIR);
  if (files.length === 0) {
    fs.writeFileSync(
      path.join(CONTENT_DIR, 'doc.md'),
      '---\ntags: [general]\n---\n# Mi Mapa Mental\n\n## Rama 1\n- Elemento A',
      'utf8'
    );
    files = scanMarkdownDir(CONTENT_DIR);
  }
  res.json(files.sort((a, b) => a.path.localeCompare(b.path)));
});

app.get('/api/images', (req, res) => {
  fs.readdir(IMAGES_DIR, (err, files) => {
    if (err) return res.json([]);
    const imgs = files.filter(f => /\.(png|jpe?g|gif|webp)$/i.test(f)).sort();
    res.json(imgs);
  });
});

app.get('/api/content', (req, res) => {
  const filePath = resolveSafeMdPath(req.query.file || 'doc.md');
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err && err.code === 'ENOENT') return res.send('');
    if (err) return res.status(500).send('Error leyendo el documento');
    res.type('text/plain; charset=utf-8').send(data);
  });
});

app.post('/api/content', (req, res) => {
  const filePath = resolveSafeMdPath(req.query.file || 'doc.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const bodyStr = typeof req.body === 'string' ? req.body : '';
  fs.writeFile(filePath, bodyStr, 'utf8', err => {
    if (err) return res.status(500).send('Error guardando el documento');
    res.sendStatus(200);
  });
});

app.post('/api/images', (req, res) => {
  const rawName = path.basename(String(req.query.name || '')).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!rawName) return res.status(400).send('Nombre de imagen inválido');

  const bodyStr = typeof req.body === 'string' ? req.body : '';
  const base64Data = bodyStr.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
  const buffer = Buffer.from(base64Data, 'base64');

  const detectedExt = detectImageType(buffer);
  if (!detectedExt) {
    return res.status(415).send('Formato de imagen no permitido (solo PNG, JPG, GIF, WebP)');
  }

  const baseName = rawName.replace(/\.[^.]+$/, '');
  const safeFileName = `${baseName}.${detectedExt}`;
  const targetPath = path.resolve(IMAGES_DIR, safeFileName);
  if (!targetPath.startsWith(IMAGES_DIR + path.sep)) {
    return res.status(400).send('Ruta inválida');
  }

  fs.writeFile(targetPath, buffer, err => {
    if (err) return res.status(500).send('Error guardando imagen');
    res.status(200).send(safeFileName);
  });
});

app.post('/api/rename', (req, res) => {
  const oldName = req.query.old || (req.body && req.body.oldName);
  const newName = req.query.new || (req.body && req.body.newName);
  if (!oldName || !newName) return res.status(400).send('Nombres inválidos');

  const oldPath = resolveSafeMdPath(oldName);
  const newPath = resolveSafeMdPath(newName);
  if (path.relative(CONTENT_DIR, oldPath) === 'doc.md') {
    return res.status(400).send('No se puede renombrar doc.md base');
  }

  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  fs.rename(oldPath, newPath, err => {
    if (err) return res.status(500).send('Error al renombrar el archivo');
    res.send(path.relative(CONTENT_DIR, newPath).replace(/\\/g, '/'));
  });
});

app.delete('/api/content', (req, res) => {
  const filePath = resolveSafeMdPath(req.query.file || '');
  if (path.relative(CONTENT_DIR, filePath) === 'doc.md') {
    return res.status(400).send('No se puede eliminar doc.md base');
  }
  fs.unlink(filePath, err => {
    if (err) return res.status(500).send('Error eliminando archivo');
    res.sendStatus(200);
  });
});

app.get('/api/pwa-icon', (req, res) => {
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgBAMAAACBVGfHAAAAGFBMVEUce28/f39/bfl/pf9/v/+fpf+/v/////86wW7fAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAAQUlEQVQokWNgGAWjYBSMAggwMjI6AglG52B0cHAIIsH4Hw2D+f8ZMP7HgOH/B4b/Hxn+f2L4/5nh/xeG/98YBgEArRcX0b5L2pAAAAAASUVORK5CYII=';
  res.setHeader('Content-Type', 'image/png');
  res.send(Buffer.from(pngBase64, 'base64'));
});

// 7. Manejador global de errores (sin filtrar stack traces en producción)
app.use((err, req, res, next) => {
  if (!IS_PROD) console.error(err);
  const status = err.message && err.message.includes('Ruta') ? 400 : 500;
  res.status(status).json({ error: 'Error procesando la solicitud' });
});

const PORT = process.env.PORT || 9000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`mdmap escuchando en puerto ${PORT} (${IS_PROD ? 'production' : 'development'})`);
});