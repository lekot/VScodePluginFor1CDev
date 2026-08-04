const esbuild = require('esbuild');
const path = require('path');

const rootDirectory = path.resolve(__dirname, '..');

esbuild.buildSync({
  entryPoints: [path.join(rootDirectory, 'src', 'agent', 'mcpAdapter', 'sessionRouter.ts')],
  outfile: path.join(rootDirectory, 'dist', 'agent', 'mcpAdapter', 'sessionRouter.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'es2020',
  external: ['vscode'],
});
