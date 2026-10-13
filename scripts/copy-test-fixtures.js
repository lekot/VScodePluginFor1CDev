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

function assertDirectory(directoryPath, label) {
  const stats = fs.lstatSync(directoryPath);
  if (getEntryKind(stats, directoryPath) !== 'directory') {
    throw new Error(`Fixture copier expected ${label} to be a directory: ${directoryPath}`);
  }
}

function ensureDirectoryPath(projectRoot, parts, createMissing) {
  let currentPath = projectRoot;
  for (const part of parts) {
    currentPath = path.join(currentPath, part);
    const stats = getStatsIfPresent(currentPath);
    if (!stats) {
      if (!createMissing) {
        throw new Error(`Fixture copier directory does not exist: ${currentPath}`);
      }
      fs.mkdirSync(currentPath);
      continue;
    }
    if (getEntryKind(stats, currentPath) !== 'directory') {
      throw new Error(`Fixture copier expected a directory: ${currentPath}`);
    }
  }
  return currentPath;
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

function copyTestFixtures(projectRoot = PROJECT_ROOT) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  assertDirectory(resolvedProjectRoot, 'project root');

  const sourcePath = ensureDirectoryPath(resolvedProjectRoot, SOURCE_PARTS, false);
  validateTree(sourcePath);

  const destinationPath = ensureDirectoryPath(resolvedProjectRoot, DESTINATION_PARTS, true);
  validateTree(destinationPath);
  copyDirectory(sourcePath, destinationPath);
}

if (require.main === module) {
  copyTestFixtures();
}

module.exports = { copyTestFixtures };
