import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const OUT_ASSETS = path.resolve('public/assets');
const KATEX_SRC = path.resolve('node_modules/katex/dist');
const KATEX_DEST = path.join(OUT_ASSETS, 'katex');

fs.mkdirSync(OUT_ASSETS, { recursive: true });

// 1. Empaquetar @markmap/* + marked + dompurify en un único módulo ESM
await esbuild.build({
  entryPoints: ['src/vendor-entry.js'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  outfile: path.join(OUT_ASSETS, 'mdmap-vendor.js')
});

// 2. Copiar KaTeX (CSS, JS y fuentes .woff2) para la Vista Knit y PDF sin CDN
fs.mkdirSync(path.join(KATEX_DEST, 'fonts'), { recursive: true });
fs.copyFileSync(path.join(KATEX_SRC, 'katex.min.css'), path.join(KATEX_DEST, 'katex.min.css'));
fs.copyFileSync(path.join(KATEX_SRC, 'katex.min.js'), path.join(KATEX_DEST, 'katex.min.js'));
fs.cpSync(path.join(KATEX_SRC, 'fonts'), path.join(KATEX_DEST, 'fonts'), { recursive: true });

console.log('Assets compilados en public/assets/mdmap-vendor.js y public/assets/katex/');