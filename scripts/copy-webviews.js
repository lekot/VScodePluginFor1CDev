const fs = require('fs');
const path = require('path');

const pairs = [
  ['src/rolesEditor/rolesEditorWebview.html', 'dist/rolesEditor/rolesEditorWebview.html'],
  ['src/subsystemCompositionEditor/subsystemCompositionWebview.html', 'dist/subsystemCompositionEditor/subsystemCompositionWebview.html'],
];

for (const [src, dest] of pairs) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}
