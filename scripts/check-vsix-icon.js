'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yauzl = require('yauzl');

const MAX_ICON_DIMENSION = 1024;

function getIconEntryPath(iconPath) {
  if (typeof iconPath !== 'string' || iconPath.trim() === '') {
    throw new Error('package.json must define a non-empty "icon" path.');
  }

  const normalized = iconPath.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error('package.json icon path must stay inside the extension: ' + iconPath);
  }

  return 'extension/' + normalized;
}

function readPngDimensions(buffer, entryPath) {
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (
    buffer.length < 24 ||
    !buffer.subarray(0, 8).equals(pngSignature) ||
    buffer.readUInt32BE(8) !== 13 ||
    buffer.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throw new Error(entryPath + ' is not a valid PNG image.');
  }

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width < 1 || height < 1) {
    throw new Error(entryPath + ' has invalid dimensions ' + width + 'x' + height + '.');
  }

  return { width, height };
}

function inspectVsix(vsixPath, iconEntryPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(vsixPath, { lazyEntries: true, validateEntrySizes: true }, (openError, zipFile) => {
      if (openError) {
        reject(openError);
        return;
      }

      let foundIcon = false;

      zipFile.on('error', reject);
      zipFile.on('entry', (entry) => {
        if (entry.fileName !== iconEntryPath) {
          zipFile.readEntry();
          return;
        }

        foundIcon = true;
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            reject(streamError);
            return;
          }

          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => {
            try {
              resolve(readPngDimensions(Buffer.concat(chunks), iconEntryPath));
            } catch (error) {
              reject(error);
            } finally {
              zipFile.close();
            }
          });
        });
      });

      zipFile.on('end', () => {
        if (!foundIcon) {
          reject(new Error('VSIX does not contain ' + iconEntryPath + '.'));
        }
      });

      zipFile.readEntry();
    });
  });
}

async function main() {
  const manifestPath = path.resolve('package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const iconEntryPath = getIconEntryPath(manifest.icon);
  const vsixPath = path.resolve(
    process.argv[2] || manifest.name + '-' + manifest.version + '.vsix'
  );

  if (!fs.existsSync(vsixPath)) {
    throw new Error('VSIX file not found: ' + vsixPath);
  }

  const { width, height } = await inspectVsix(vsixPath, iconEntryPath);
  if (width > MAX_ICON_DIMENSION || height > MAX_ICON_DIMENSION) {
    throw new Error(
      'Marketplace icon ' +
        iconEntryPath +
        ' in ' +
        path.basename(vsixPath) +
        ' is ' +
        width +
        'x' +
        height +
        '; maximum allowed dimensions are ' +
        MAX_ICON_DIMENSION +
        'x' +
        MAX_ICON_DIMENSION +
        '.'
    );
  }

  console.log(
    'VSIX icon check passed: ' +
      iconEntryPath +
      ' is ' +
      width +
      'x' +
      height +
      ' (maximum ' +
      MAX_ICON_DIMENSION +
      'x' +
      MAX_ICON_DIMENSION +
      ').'
  );
}

main().catch((error) => {
  console.error('VSIX icon check failed: ' + error.message);
  process.exitCode = 1;
});
