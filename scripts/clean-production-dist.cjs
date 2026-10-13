'use strict';

const fs = require('node:fs');
const path = require('node:path');

function cleanProductionDist() {
  const projectRoot = fs.realpathSync(path.resolve(__dirname, '..'));
  const distPath = path.resolve(projectRoot, 'dist');
  const relativePath = path.relative(projectRoot, distPath);

  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith('..' + path.sep) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error('Refusing to clean a path outside the project root.');
  }

  let distStat;
  try {
    distStat = fs.lstatSync(distPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  if (distStat.isSymbolicLink() || !distStat.isDirectory()) {
    throw new Error('Refusing to clean dist because it is not a regular directory.');
  }

  const resolvedDistPath = fs.realpathSync(distPath);
  const resolvedRelativePath = path.relative(projectRoot, resolvedDistPath);
  if (
    resolvedRelativePath === '' ||
    resolvedRelativePath === '..' ||
    resolvedRelativePath.startsWith('..' + path.sep) ||
    path.isAbsolute(resolvedRelativePath)
  ) {
    throw new Error('Refusing to clean a resolved dist path outside the project root.');
  }

  fs.rmSync(distPath, { recursive: true, force: false });
}

try {
  cleanProductionDist();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Failed to safely clean production dist: ' + message);
  process.exitCode = 1;
}
