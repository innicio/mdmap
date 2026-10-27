const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const CONTENT_DIR = path.join(__dirname, 'content');
const IMAGES_DIR = path.join(__dirname, 'images');

// Asegurar que existe el directorio de contenido
fs.mkdirSync(CONTENT_DIR, { recursive: true });

app.use(express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(IMAGES_DIR));
app.use(express.text({ type: '*/*', limit: '10mb' }));

// Función auxiliar para escanear carpetas y extraer tags del Markdown
function scanMarkdownDir(dir, baseDir = dir) {
  let results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(scanMarkdownDir(fullPath, baseDir));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
      const folder = path.dirname(relPath) === '.' ? '' : path.dirname(relPath);
      
      // Extraer tags de las primeras 15 líneas (formato YAML o #hashtag)
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
  try {
    let files = scanMarkdownDir(CONTENT_DIR);
    if (files.length === 0) {
      fs.writeFileSync(path.join(CONTENT_DIR, 'doc.md'), '---\ntags: [general]\n---\n# Mi Mapa Mental\n\n## Rama 1\n- Elemento A', 'utf8');
      files = scanMarkdownDir(CONTENT_DIR);
    }
    res.json(files.sort((a, b) => a.path.localeCompare(b.path)));
  } catch (err) {
    res.status(500).json({ error: 'Error escaneando archivos' });
  }
});

// Listar imágenes disponibles en /images para insertarlas fácilmente
app.get('/api/images', (req, res) => {
  fs.readdir(IMAGES_DIR, (err, files) => {
    if (err) return res.json([]);
    const imgs = files.filter(f => /\.(png|jpe?g|gif|svg|webp)$/i.test(f)).sort();
    res.json(imgs);
  });
});

// Resuelve rutas con subcarpetas impidiendo salir de CONTENT_DIR
function resolveSafePath(relPath = 'doc.md') {
  const safeRel = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
  return path.join(CONTENT_DIR, safeRel);
}
// Obtener el contenido de un archivo concreto (?file=nombre.md)
app.get('/api/content', (req, res) => {
  const filePath = resolveSafePath(req.query.file || 'doc.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err && err.code === 'ENOENT') return res.send('');
    if (err) return res.status(500).send('Error leyendo contenido');
    res.send(data);
  });
});
// Subir una nueva imagen a /images (recibe Base64 en el body)
app.post('/api/images', (req, res) => {
  const fileName = path.basename(req.query.name || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!fileName) return res.status(400).send('Nombre de imagen inválido');
  const base64Data = req.body.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFile(path.join(IMAGES_DIR, fileName), Buffer.from(base64Data, 'base64'), err => {
    if (err) return res.status(500).send('Error guardando imagen');
    res.sendStatus(200);
  });
});



// Guardar el contenido en el archivo indicado (?file=nombre.md)
app.post('/api/content', (req, res) => {
  const filePath = resolveSafePath(req.query.file || 'doc.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFile(filePath, req.body, 'utf8', err => {
    if (err) return res.status(500).send('Error guardando contenido');
    res.sendStatus(200);
  });
});

// Renombrar un archivo .md
app.post('/api/rename', express.json(), (req, res) => {
  const { oldName, newName } = req.body;
  if (!oldName || !newName) return res.status(400).send('Nombres inválidos');
  
  const safeOld = path.basename(oldName);
  let safeNew = path.basename(newName);
  if (!safeNew.endsWith('.md')) safeNew += '.md';

  const oldPath = path.join(CONTENT_DIR, safeOld);
  const newPath = path.join(CONTENT_DIR, safeNew);

  fs.rename(oldPath, newPath, err => {
    if (err) return res.status(500).send('Error al renombrar el archivo');
    res.send(safeNew);
  });
});



// Eliminar un archivo .md
app.delete('/api/content', (req, res) => {
  const filePath = resolveSafePath(req.query.file || 'doc.md');
  if (!fileName || fileName === 'doc.md') {
    return res.status(400).send('No se puede eliminar doc.md base');
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.unlink(filePath, err => {
    if (err) return res.status(500).send('Error eliminando archivo');
    res.sendStatus(200);
  });
});

const PORT = process.env.PORT || 9000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor Markmap escuchando en http://localhost:${PORT}`);
});
