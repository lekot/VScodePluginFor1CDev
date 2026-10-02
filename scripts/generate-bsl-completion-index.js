const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { buildBslCompletionIndex } = require('../dist/providers/bslCompletionIndex');

async function main() {
  const extensionRoot = path.resolve(__dirname, '..');
  const databasePath = path.join(extensionRoot, 'resources', 'help', 'shcntx_help.db');
  const databaseBytes = fs.readFileSync(databasePath);
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(extensionRoot, 'node_modules', 'sql.js', 'dist', file),
  });
  const database = new SQL.Database(databaseBytes);
  try {
    const result = database.exec('SELECT id, name, path, content FROM nodes ORDER BY id')[0];
    if (!result || result.columns.join(',') !== 'id,name,path,content' || result.values.length === 0) {
      throw new Error('Unexpected syntax help database schema.');
    }
    const nodes = result.values.map(([id, name, itemPath, content]) => {
      if (!Number.isSafeInteger(id) || typeof name !== 'string' || typeof itemPath !== 'string'
        || typeof content !== 'string') {
        throw new Error('Invalid syntax help database row.');
      }
      return { id, name, path: itemPath.replace(/\\/g, '/'), content };
    });
    const sourceSha256 = crypto.createHash('sha256').update(databaseBytes).digest('hex');
    const completionIndex = buildBslCompletionIndex(nodes, sourceSha256);
    const outputPath = path.join(extensionRoot, 'resources', 'help', 'bsl-completion-index.json');
    fs.writeFileSync(outputPath, `${JSON.stringify(completionIndex, null, 2)}\n`, 'utf8');
    const stats = fs.statSync(outputPath);
    console.log(`Generated BSL completion index (${stats.size} bytes, ${completionIndex.types.length} types).`);
  } finally {
    database.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
