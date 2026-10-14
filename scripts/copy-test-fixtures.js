'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SOURCE_PARTS = ['test', 'fixtures'];
const DESTINATION_PARTS = ['out', 'test', 'fixtures'];

function getStatsIfPresent(entryPath) {
  try {
    return fs.lstatSync(entryPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function getEntryKind(stats, entryPath) {
  if (stats.isSymbolicLink()) {
    throw new Error(`Fixture copier refuses symbolic links: ${entryPath}`);
  }
  if (stats.isDirectory()) {
    return 'directory';
  }
  if (stats.isFile()) {
    return 'file';
  }
  throw new Error(`Fixture copier refuses unsupported filesystem entries: ${entryPath}`);
}

function getPathParts(directoryPath) {
  const resolvedPath = path.resolve(directoryPath);
  const rootPath = path.parse(resolvedPath).root;
  const segments = resolvedPath.slice(rootPath.length).split(path.sep).filter(Boolean);
  return { resolvedPath, rootPath, segments };
}

function assertDirectoryPath(directoryPath, label, allowMissing) {
  const { resolvedPath, rootPath, segments } = getPathParts(directoryPath);
  const rootStats = getStatsIfPresent(rootPath);
  if (!rootStats || getEntryKind(rootStats, rootPath) !== 'directory') {
    throw new Error(`Fixture copier expected a filesystem root while checking ${label}: ${rootPath}`);
  }

  let currentPath = rootPath;
  let missingSegmentSeen = false;
  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    const stats = getStatsIfPresent(currentPath);
    if (!stats) {
      missingSegmentSeen = true;
      if (!allowMissing) {
        throw new Error(`Fixture copier directory does not exist: ${currentPath}`);
      }
      continue;
    }
    if (getEntryKind(stats, currentPath) !== 'directory') {
      throw new Error(`Fixture copier expected ${label} path segment to be a directory: ${currentPath}`);
    }
  }
  return !missingSegmentSeen;
}

function isSameOrDescendant(parentPath, candidatePath) {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
}

function assertPathsDoNotOverlap(sourcePath, destinationPath) {
  if (isSameOrDescendant(sourcePath, destinationPath) || isSameOrDescendant(destinationPath, sourcePath)) {
    throw new Error(`Fixture copier refuses overlapping source and destination directories: ${sourcePath} and ${destinationPath}`);
  }
}

function getCanonicalPath(directoryPath) {
  return path.resolve(fs.realpathSync.native(directoryPath));
}

function getCanonicalPathForPossiblyMissingDirectory(directoryPath) {
  let currentPath = path.resolve(directoryPath);
  const suffix = [];
  let stats = getStatsIfPresent(currentPath);
  while (!stats) {
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      throw new Error(`Fixture copier could not find an existing ancestor for: ${directoryPath}`);
    }
    suffix.unshift(path.basename(currentPath));
    currentPath = parentPath;
    stats = getStatsIfPresent(currentPath);
  }
  const canonicalAncestor = getCanonicalPath(currentPath);
  return path.resolve(canonicalAncestor, ...suffix);
}

function validateTree(directoryPath) {
  for (const entryName of fs.readdirSync(directoryPath)) {
    const entryPath = path.join(directoryPath, entryName);
    const kind = getEntryKind(fs.lstatSync(entryPath), entryPath);
    if (kind === 'directory') {
      validateTree(entryPath);
    }
  }
}

function validateMerge(sourcePath, destinationPath) {
  for (const entryName of fs.readdirSync(sourcePath)) {
    const sourceEntryPath = path.join(sourcePath, entryName);
    const sourceKind = getEntryKind(fs.lstatSync(sourceEntryPath), sourceEntryPath);
    const destinationEntryPath = path.join(destinationPath, entryName);
    const destinationStats = getStatsIfPresent(destinationEntryPath);
    if (!destinationStats) {
      continue;
    }

    const destinationKind = getEntryKind(destinationStats, destinationEntryPath);
    if (sourceKind !== destinationKind) {
      throw new Error(`Fixture copier found incompatible source and destination entries: ${sourceEntryPath} and ${destinationEntryPath}`);
    }
    if (sourceKind === 'directory') {
      validateMerge(sourceEntryPath, destinationEntryPath);
    }
  }
}

function ensureDirectoryPath(directoryPath) {
  const { rootPath, segments } = getPathParts(directoryPath);
  let currentPath = rootPath;
  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    const stats = getStatsIfPresent(currentPath);
    if (!stats) {
      fs.mkdirSync(currentPath);
      continue;
    }
    if (getEntryKind(stats, currentPath) !== 'directory') {
      throw new Error(`Fixture copier expected a directory while preparing destination: ${currentPath}`);
    }
  }
}

function copyDirectory(sourcePath, destinationPath) {
  for (const entryName of fs.readdirSync(sourcePath)) {
    const sourceEntryPath = path.join(sourcePath, entryName);
    const sourceKind = getEntryKind(fs.lstatSync(sourceEntryPath), sourceEntryPath);
    const destinationEntryPath = path.join(destinationPath, entryName);
    const destinationStats = getStatsIfPresent(destinationEntryPath);

    if (sourceKind === 'directory') {
      if (destinationStats && getEntryKind(destinationStats, destinationEntryPath) !== 'directory') {
        throw new Error(`Fixture copier expected a destination directory: ${destinationEntryPath}`);
      }
      if (!destinationStats) {
        fs.mkdirSync(destinationEntryPath);
      }
      copyDirectory(sourceEntryPath, destinationEntryPath);
      continue;
    }

    if (destinationStats && getEntryKind(destinationStats, destinationEntryPath) !== 'file') {
      throw new Error(`Fixture copier expected a destination file: ${destinationEntryPath}`);
    }
    fs.copyFileSync(sourceEntryPath, destinationEntryPath);
  }
}

function copyRegularDirectory(sourcePath, destinationPath) {
  const resolvedSourcePath = path.resolve(sourcePath);
  const resolvedDestinationPath = path.resolve(destinationPath);
  assertPathsDoNotOverlap(resolvedSourcePath, resolvedDestinationPath);

  assertDirectoryPath(resolvedSourcePath, 'source', false);
  const destinationExists = assertDirectoryPath(resolvedDestinationPath, 'destination', true);
  const canonicalSourcePath = getCanonicalPath(resolvedSourcePath);
  const canonicalDestinationPath = destinationExists
    ? getCanonicalPath(resolvedDestinationPath)
    : getCanonicalPathForPossiblyMissingDirectory(resolvedDestinationPath);
  assertPathsDoNotOverlap(canonicalSourcePath, canonicalDestinationPath);

  validateTree(resolvedSourcePath);
  if (destinationExists) {
    validateTree(resolvedDestinationPath);
    validateMerge(resolvedSourcePath, resolvedDestinationPath);
  }

  ensureDirectoryPath(resolvedDestinationPath);
  copyDirectory(resolvedSourcePath, resolvedDestinationPath);
}

function copyTestFixtures(projectRoot = PROJECT_ROOT) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  assertDirectoryPath(resolvedProjectRoot, 'project root', false);
  const sourcePath = path.join(resolvedProjectRoot, ...SOURCE_PARTS);
  const destinationPath = path.join(resolvedProjectRoot, ...DESTINATION_PARTS);
  copyRegularDirectory(sourcePath, destinationPath);
}

if (require.main === module) {
  copyTestFixtures();
}

module.exports = { copyRegularDirectory, copyTestFixtures };
