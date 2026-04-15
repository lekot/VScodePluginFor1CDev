const fs = require('fs');
const path = require('path');

const sources = [
  'src/rolesEditor/rolesEditorWebview.html',
  'src/compositionEditor/compositionWebview.html',
];

const outDirs = ['dist', 'out/src'];

for (const src of sources) {
  const rel = src.replace(/^src\//, '');
  for (const outDir of outDirs) {
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}
