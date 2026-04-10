// Best-effort removal of temp dirs left by tests / extension snapshots.
// Called from cleanup-1cviewer-temp.bat and can be run directly: node scripts/cleanup-1cviewer-temp.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const prefixes = [
  '1cviewer-',
  '1cv-deploy-',
  '1cv-ibcmd-',
  '1cv-ib-compare-',
  'ibcmd-',
  'p7b4-test-',
  'cdt-bridge-test-',
  'form-engine-save-',
];
const yamlGlob = /^1cviewer-ibcmd-.*\.yaml$/;

const tmp = os.tmpdir();
let entries;
try { entries = fs.readdirSync(tmp); } catch { process.exit(0); }

let removed = 0;
for (const name of entries) {
  const match = prefixes.some((p) => name.startsWith(p));
  if (match) {
    try {
      fs.rmSync(path.join(tmp, name), { recursive: true, force: true });
      removed++;
    } catch { /* locked — skip */ }
  } else if (yamlGlob.test(name)) {
    try {
      fs.unlinkSync(path.join(tmp, name));
      removed++;
    } catch { /* skip */ }
  }
}
if (removed) { console.log(`cleanup: removed ${removed} temp entries from ${tmp}`); }
