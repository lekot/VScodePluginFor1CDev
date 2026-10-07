import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { TreeNode } from '../../models/treeNode';
import { Logger } from '../../utils/logger';

export interface ResolvedPicture {
  success: boolean;
  dataUri?: string;
  mimeType?: string;
  format?: string;
  isZip?: boolean;
  entryName?: string;
  resolvedFilePath?: string;
  zipFilePath?: string;
  error?: string;
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const SUPPORTED_IMAGE_EXTS = new Set(['.png', '.svg', '.jpg', '.jpeg', '.gif', '.ico', '.bmp']);

function getMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.ico':
      return 'image/x-icon';
    case '.bmp':
      return 'image/bmp';
    default:
      return 'application/octet-stream';
  }
}

function getFormatName(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case '.png':
      return 'PNG';
    case '.svg':
      return 'SVG';
    case '.jpg':
    case '.jpeg':
      return 'JPEG';
    case '.gif':
      return 'GIF';
    case '.ico':
      return 'ICO';
    case '.bmp':
      return 'BMP';
    default:
      return 'UNKNOWN';
  }
}

function parseCentralDirectory(buf: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let off = 0;
  while (off < buf.length - 4) {
    if (buf.readUInt32LE(off) === 0x02014b50) {
      const method = buf.readUInt16LE(off + 10);
      const cSize = buf.readUInt32LE(off + 20);
      const uSize = buf.readUInt32LE(off + 24);
      const fnLen = buf.readUInt16LE(off + 28);
      const extraLen = buf.readUInt16LE(off + 30);
      const commentLen = buf.readUInt16LE(off + 32);
      const localOff = buf.readUInt32LE(off + 42);
      const name = buf.toString('utf8', off + 46, off + 46 + fnLen);
      entries.push({
        name,
        method,
        compressedSize: cSize,
        uncompressedSize: uSize,
        localHeaderOffset: localOff,
      });
      off += 46 + fnLen + extraLen + commentLen;
    } else {
      off++;
    }
  }
  return entries;
}

function extractZipEntryData(buf: Buffer, entry: ZipEntry): Buffer | null {
  try {
    const localOff = entry.localHeaderOffset;
    if (localOff + 30 > buf.length) {
      return null;
    }
    const localFnLen = buf.readUInt16LE(localOff + 26);
    const localExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + localFnLen + localExtraLen;
    if (dataStart + entry.compressedSize > buf.length) {
      return null;
    }
    const compData = buf.subarray(dataStart, dataStart + entry.compressedSize);
    if (entry.method === 8) {
      return zlib.inflateRawSync(compData);
    }
    return Buffer.from(compData);
  } catch (err) {
    Logger.warn(`Failed to decompress zip entry ${entry.name}`, err);
    return null;
  }
}

/**
 * Resolves underlying picture file and data URI for a CommonPicture metadata element.
 */
export async function resolveCommonPicture(target: TreeNode | string): Promise<ResolvedPicture> {
  const metadataPath = typeof target === 'string' ? target : target.filePath;
  if (!metadataPath) {
    return { success: false, error: 'Файл объекта метаданных не указан' };
  }

  try {
    const exists = await fs.promises.access(metadataPath).then(() => true).catch(() => false);
    if (!exists) {
      return { success: false, error: `Файл метаданных не найден: ${metadataPath}` };
    }

    const dirOfMeta = path.dirname(metadataPath);
    const baseName = path.basename(metadataPath, path.extname(metadataPath));

    // Candidate locations
    const candidateDirs = [
      path.join(dirOfMeta, baseName, 'Ext'),
      path.join(dirOfMeta, baseName),
      dirOfMeta,
    ];

    let referencedFileName: string | undefined;

    // Check Picture.xml in Ext directory (Designer format)
    for (const cDir of candidateDirs) {
      const pictureXmlPath = path.join(cDir, 'Picture.xml');
      try {
        const xmlContent = await fs.promises.readFile(pictureXmlPath, 'utf8');
        const match = /<(?:\w+:)?Abs>([^<]+)<\/(?:\w+:)?Abs>/i.exec(xmlContent);
        if (match && match[1]) {
          referencedFileName = match[1].trim();
          break;
        }
      } catch {
        // Picture.xml not present in this candidate
      }
    }

    let resolvedAssetPath: string | undefined;

    if (referencedFileName) {
      // Look for the referenced file under Ext/Picture or candidateDirs
      const possibleAssetPaths = [
        path.join(dirOfMeta, baseName, 'Ext', 'Picture', referencedFileName),
        path.join(dirOfMeta, baseName, 'Ext', referencedFileName),
        path.join(dirOfMeta, baseName, referencedFileName),
        path.join(dirOfMeta, referencedFileName),
      ];

      for (const p of possibleAssetPaths) {
        if (await fs.promises.access(p).then(() => true).catch(() => false)) {
          resolvedAssetPath = p;
          break;
        }
      }
    }

    // If not found via Picture.xml, scan directories for image files or .zip
    if (!resolvedAssetPath) {
      const scanDirs = [
        path.join(dirOfMeta, baseName, 'Ext', 'Picture'),
        path.join(dirOfMeta, baseName, 'Ext'),
        path.join(dirOfMeta, baseName),
        dirOfMeta,
      ];

      for (const sDir of scanDirs) {
        try {
          const files = await fs.promises.readdir(sDir);
          // Prefer matching baseName, then svg, png, zip
          const found = files.find((f) => {
            const ext = path.extname(f).toLowerCase();
            return SUPPORTED_IMAGE_EXTS.has(ext) || ext === '.zip';
          });
          if (found) {
            resolvedAssetPath = path.join(sDir, found);
            break;
          }
        } catch {
          // directory does not exist
        }
      }
    }

    if (!resolvedAssetPath) {
      return { success: false, error: 'Файл изображения или архива не найден в каталоге объекта' };
    }

    const ext = path.extname(resolvedAssetPath).toLowerCase();

    if (ext === '.zip') {
      const zipBuffer = await fs.promises.readFile(resolvedAssetPath);
      const entries = parseCentralDirectory(zipBuffer);
      if (entries.length === 0) {
        return { success: false, error: 'Архив Picture.zip пуст или поврежден', resolvedFilePath: resolvedAssetPath };
      }

      // Prioritize: 1) SVG variant, 2) PNG density variant (higher or 100/150/200), 3) any image
      let chosenEntry = entries.find((e) => path.extname(e.name).toLowerCase() === '.svg');
      if (!chosenEntry) {
        const pngEntries = entries.filter((e) => path.extname(e.name).toLowerCase() === '.png');
        if (pngEntries.length > 0) {
          // Pick best density: e.g. 200.png or 150.png or 100.png or last
          chosenEntry =
            pngEntries.find((e) => e.name === '200.png') ??
            pngEntries.find((e) => e.name === '150.png') ??
            pngEntries.find((e) => e.name === '100.png') ??
            pngEntries[pngEntries.length - 1];
        }
      }
      if (!chosenEntry) {
        chosenEntry = entries.find((e) => SUPPORTED_IMAGE_EXTS.has(path.extname(e.name).toLowerCase()));
      }

      if (!chosenEntry) {
        return {
          success: false,
          error: 'В архиве Picture.zip не найдено поддерживаемых графических файлов',
          resolvedFilePath: resolvedAssetPath,
        };
      }

      const decompressed = extractZipEntryData(zipBuffer, chosenEntry);
      if (!decompressed) {
        return {
          success: false,
          error: `Не удалось извлечь изображение ${chosenEntry.name} из архива`,
          resolvedFilePath: resolvedAssetPath,
        };
      }

      const mimeType = getMimeType(chosenEntry.name);
      const format = getFormatName(chosenEntry.name);
      const dataUri = `data:${mimeType};base64,${decompressed.toString('base64')}`;

      // Extract specific entry to temp file so VS Code can open the image directly
      let extractedFilePath = resolvedAssetPath;
      try {
        const hash = crypto
          .createHash('sha256')
          .update(`${resolvedAssetPath}:${chosenEntry.name}`)
          .digest('hex')
          .slice(0, 12);
        const safeEntryBase = path.basename(chosenEntry.name);
        const tempPicDir = path.join(os.tmpdir(), '1cviewer-pictures', hash);
        await fs.promises.mkdir(tempPicDir, { recursive: true });
        extractedFilePath = path.join(tempPicDir, safeEntryBase);
        await fs.promises.writeFile(extractedFilePath, decompressed);
      } catch (err) {
        Logger.warn(`Failed to cache extracted picture entry ${chosenEntry.name} to disk`, err);
      }

      return {
        success: true,
        dataUri,
        mimeType,
        format,
        isZip: true,
        entryName: chosenEntry.name,
        resolvedFilePath: extractedFilePath,
        zipFilePath: resolvedAssetPath,
      };
    }

    // Direct image file
    const fileBuffer = await fs.promises.readFile(resolvedAssetPath);
    const mimeType = getMimeType(resolvedAssetPath);
    const format = getFormatName(resolvedAssetPath);
    const dataUri = `data:${mimeType};base64,${fileBuffer.toString('base64')}`;

    return {
      success: true,
      dataUri,
      mimeType,
      format,
      isZip: false,
      resolvedFilePath: resolvedAssetPath,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    Logger.warn(`Error resolving CommonPicture for ${metadataPath}`, err);
    return { success: false, error: msg };
  }
}
