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

// Listar todos los archivos .md disponibles
app.get('/api/files', (req, res) => {
  fs.readdir(CONTENT_DIR, (err, files) => {
    if (err) return res.status(500).json({ error: 'Error leyendo directorio' });
    const mdFiles = files.filter(f => f.endsWith('.md')).sort();
    if (mdFiles.length === 0) {
      fs.writeFileSync(path.join(CONTENT_DIR, 'doc.md'), '# Mi Mapa Mental\n\n## Rama 1\n- Elemento A\n- Elemento B', 'utf8');
      mdFiles.push('doc.md');
    }
    res.json(mdFiles);
  });
});

// Listar imágenes disponibles en /images para insertarlas fácilmente
app.get('/api/images', (req, res) => {
  fs.readdir(IMAGES_DIR, (err, files) => {
    if (err) return res.json([]);
    const imgs = files.filter(f => /\.(png|jpe?g|gif|svg|webp)$/i.test(f)).sort();
    res.json(imgs);
  });
});

// Obtener el contenido de un archivo concreto (?file=nombre.md)
app.get('/api/content', (req, res) => {
  const fileName = path.basename(req.query.file || 'doc.md');
  const filePath = path.join(CONTENT_DIR, fileName);
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
  const fileName = path.basename(req.query.file || 'doc.md');
  const filePath = path.join(CONTENT_DIR, fileName);
  fs.writeFile(filePath, req.body, 'utf8', err => {
    if (err) return res.status(500).send('Error guardando contenido');
    res.sendStatus(200);
  });
});

// Eliminar un archivo .md
app.delete('/api/content', (req, res) => {
  const fileName = path.basename(req.query.file || '');
  if (!fileName || fileName === 'doc.md') {
    return res.status(400).send('No se puede eliminar doc.md base');
  }
  const filePath = path.join(CONTENT_DIR, fileName);
  fs.unlink(filePath, err => {
    if (err) return res.status(500).send('Error eliminando archivo');
    res.sendStatus(200);
  });
});

const PORT = process.env.PORT || 9000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor Markmap escuchando en http://localhost:${PORT}`);
});
