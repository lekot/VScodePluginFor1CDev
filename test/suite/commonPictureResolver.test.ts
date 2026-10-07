import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';
import { TreeNode, MetadataType } from '../../src/models/treeNode';
import { resolveCommonPicture } from '../../src/services/picture/commonPictureResolver';

suite('CommonPictureResolver', () => {
  let tempDir: string;

  setup(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1c-test-pic-'));
  });

  teardown(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  function createZipBuffer(files: { name: string; content: Buffer | string }[]): Buffer {
    // Helper to build a valid zip archive in memory using deflate/store
    const localHeaders: Buffer[] = [];
    const centralEntries: Buffer[] = [];
    let offset = 0;

    for (const f of files) {
      const nameBuf = Buffer.from(f.name, 'utf8');
      const rawContent = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf8');
      const deflated = zlib.deflateRawSync(rawContent);
      const isDeflated = deflated.length < rawContent.length;
      const compData = isDeflated ? deflated : rawContent;
      const method = isDeflated ? 8 : 0;
      const crc = 0; // simple zip reader doesn't require CRC validation

      // Local file header: 30 bytes + name + compData
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); // signature
      lh.writeUInt16LE(20, 4); // version needed
      lh.writeUInt16LE(0, 6); // flags
      lh.writeUInt16LE(method, 8); // compression method
      lh.writeUInt16LE(0, 10); // mod time
      lh.writeUInt16LE(0, 12); // mod date
      lh.writeUInt32LE(crc, 14); // crc32
      lh.writeUInt32LE(compData.length, 18); // comp size
      lh.writeUInt32LE(rawContent.length, 22); // uncomp size
      lh.writeUInt16LE(nameBuf.length, 26); // name length
      lh.writeUInt16LE(0, 28); // extra field length

      localHeaders.push(lh, nameBuf, compData);

      // Central directory header: 46 bytes + name
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0); // signature
      cd.writeUInt16LE(20, 4); // version made by
      cd.writeUInt16LE(20, 6); // version needed
      cd.writeUInt16LE(0, 8); // flags
      cd.writeUInt16LE(method, 10); // compression method
      cd.writeUInt16LE(0, 12); // mod time
      cd.writeUInt16LE(0, 14); // mod date
      cd.writeUInt32LE(crc, 16); // crc32
      cd.writeUInt32LE(compData.length, 20); // comp size
      cd.writeUInt32LE(rawContent.length, 24); // uncomp size
      cd.writeUInt16LE(nameBuf.length, 28); // name length
      cd.writeUInt16LE(0, 30); // extra length
      cd.writeUInt16LE(0, 32); // comment length
      cd.writeUInt16LE(0, 34); // disk start
      cd.writeUInt16LE(0, 36); // internal attr
      cd.writeUInt32LE(0, 38); // external attr
      cd.writeUInt32LE(offset, 42); // relative offset of local header

      centralEntries.push(cd, nameBuf);
      offset += lh.length + nameBuf.length + compData.length;
    }

    const cdTotalSize = centralEntries.reduce((sum, b) => sum + b.length, 0);
    const cdOffset = offset;

    // End of central directory record (22 bytes)
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(cdTotalSize, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([...localHeaders, ...centralEntries, eocd]);
  }

  test('resolves Designer format CommonPicture with direct PNG and Picture.xml', async () => {
    const picDir = path.join(tempDir, 'CommonPictures', 'Logo');
    const extDir = path.join(picDir, 'Ext');
    const subPicDir = path.join(extDir, 'Picture');
    await fs.promises.mkdir(subPicDir, { recursive: true });

    const metadataXml = path.join(tempDir, 'CommonPictures', 'Logo.xml');
    await fs.promises.writeFile(metadataXml, '<MetaDataObject><CommonPicture><Name>Logo</Name></CommonPicture></MetaDataObject>', 'utf8');

    const pictureXml = path.join(extDir, 'Picture.xml');
    await fs.promises.writeFile(pictureXml, '<ExtPicture><Picture><xr:Abs>Picture.png</xr:Abs></Picture></ExtPicture>', 'utf8');

    const fakePngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x01]);
    const pngPath = path.join(subPicDir, 'Picture.png');
    await fs.promises.writeFile(pngPath, fakePngBytes);

    const node: TreeNode = {
      id: 'CommonPictures.Logo',
      name: 'Logo',
      type: MetadataType.CommonPicture,
      properties: {},
      filePath: metadataXml,
    };

    const result = await resolveCommonPicture(node);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.format, 'PNG');
    assert.strictEqual(result.mimeType, 'image/png');
    assert.ok(result.dataUri?.startsWith('data:image/png;base64,'));
    assert.strictEqual(result.resolvedFilePath, pngPath);
  });

  test('resolves Designer format CommonPicture with SVG', async () => {
    const picDir = path.join(tempDir, 'CommonPictures', 'VectorIcon');
    const extDir = path.join(picDir, 'Ext');
    const subPicDir = path.join(extDir, 'Picture');
    await fs.promises.mkdir(subPicDir, { recursive: true });

    const metadataXml = path.join(tempDir, 'CommonPictures', 'VectorIcon.xml');
    await fs.promises.writeFile(metadataXml, '<CommonPicture><Name>VectorIcon</Name></CommonPicture>', 'utf8');

    const pictureXml = path.join(extDir, 'Picture.xml');
    await fs.promises.writeFile(pictureXml, '<ExtPicture><Picture><xr:Abs>Picture.svg</xr:Abs></Picture></ExtPicture>', 'utf8');

    const svgContent = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>';
    const svgPath = path.join(subPicDir, 'Picture.svg');
    await fs.promises.writeFile(svgPath, svgContent, 'utf8');

    const result = await resolveCommonPicture(metadataXml);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.format, 'SVG');
    assert.strictEqual(result.mimeType, 'image/svg+xml');
    assert.ok(result.dataUri?.startsWith('data:image/svg+xml;base64,') || result.dataUri?.startsWith('data:image/svg+xml;utf8,'));
    assert.strictEqual(result.resolvedFilePath, svgPath);
  });

  test('resolves Designer format CommonPicture with Picture.zip containing multiple variants', async () => {
    const picDir = path.join(tempDir, 'CommonPictures', 'MultiRes');
    const extDir = path.join(picDir, 'Ext');
    const subPicDir = path.join(extDir, 'Picture');
    await fs.promises.mkdir(subPicDir, { recursive: true });

    const metadataXml = path.join(tempDir, 'CommonPictures', 'MultiRes.xml');
    await fs.promises.writeFile(metadataXml, '<CommonPicture><Name>MultiRes</Name></CommonPicture>', 'utf8');

    const pictureXml = path.join(extDir, 'Picture.xml');
    await fs.promises.writeFile(pictureXml, '<ExtPicture><Picture><xr:Abs>Picture.zip</xr:Abs></Picture></ExtPicture>', 'utf8');

    const manifestXml = '<Picture><PictureVariant name="100.png" screenDensity="ldpi"/><PictureVariant name="200.png" screenDensity="hdpi"/></Picture>';
    const png100 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x00]);
    const png200 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x02, 0x00]);

    const zipBuf = createZipBuffer([
      { name: 'manifest.xml', content: manifestXml },
      { name: '100.png', content: png100 },
      { name: '200.png', content: png200 },
    ]);

    const zipPath = path.join(subPicDir, 'Picture.zip');
    await fs.promises.writeFile(zipPath, zipBuf);

    const result = await resolveCommonPicture(metadataXml);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.isZip, true);
    assert.strictEqual(result.format, 'PNG');
    assert.strictEqual(result.mimeType, 'image/png');
    assert.ok(result.entryName === '100.png' || result.entryName === '200.png');
    assert.ok(result.dataUri?.startsWith('data:image/png;base64,'));
    assert.notStrictEqual(result.resolvedFilePath, zipPath, 'resolvedFilePath must not be the raw zip archive');
    assert.strictEqual(result.zipFilePath, zipPath, 'zipFilePath must point to the zip archive');
    assert.ok(fs.existsSync(result.resolvedFilePath!), 'extracted entry image must exist on disk');
    assert.strictEqual(path.basename(result.resolvedFilePath!), result.entryName);
  });

  test('prefers SVG variant when Picture.zip contains both SVG and PNG', async () => {
    const picDir = path.join(tempDir, 'CommonPictures', 'VectorZip');
    const extDir = path.join(picDir, 'Ext');
    const subPicDir = path.join(extDir, 'Picture');
    await fs.promises.mkdir(subPicDir, { recursive: true });

    const metadataXml = path.join(tempDir, 'CommonPictures', 'VectorZip.xml');
    await fs.promises.writeFile(metadataXml, '<CommonPicture><Name>VectorZip</Name></CommonPicture>', 'utf8');

    const pictureXml = path.join(extDir, 'Picture.xml');
    await fs.promises.writeFile(pictureXml, '<ExtPicture><Picture><xr:Abs>Picture.zip</xr:Abs></Picture></ExtPicture>', 'utf8');

    const svgData = '<svg><circle cx="5" cy="5" r="5"/></svg>';
    const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]);

    const zipBuf = createZipBuffer([
      { name: 'raster.png', content: pngData },
      { name: 'vector.svg', content: svgData },
    ]);

    const zipPath = path.join(subPicDir, 'Picture.zip');
    await fs.promises.writeFile(zipPath, zipBuf);

    const result = await resolveCommonPicture(metadataXml);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.isZip, true);
    assert.strictEqual(result.format, 'SVG');
    assert.strictEqual(result.entryName, 'vector.svg');
    assert.strictEqual(result.mimeType, 'image/svg+xml');
    assert.notStrictEqual(result.resolvedFilePath, zipPath, 'resolvedFilePath must point to extracted svg, not zip');
    assert.ok(fs.existsSync(result.resolvedFilePath!), 'extracted svg file must exist on disk');
    assert.strictEqual(path.basename(result.resolvedFilePath!), 'vector.svg');
  });

  test('resolves EDT layout where image is placed alongside CommonPicture.mdo', async () => {
    const picDir = path.join(tempDir, 'src', 'CommonPictures', 'EdtIcon');
    await fs.promises.mkdir(picDir, { recursive: true });

    const mdoPath = path.join(picDir, 'CommonPicture.mdo');
    await fs.promises.writeFile(mdoPath, '<md:CommonPicture xmlns:md="http://v8.1c.ru/8.3/MDClasses"/>', 'utf8');

    const iconPath = path.join(picDir, 'EdtIcon.png');
    await fs.promises.writeFile(iconPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x05]));

    const node: TreeNode = {
      id: 'CommonPictures.EdtIcon',
      name: 'EdtIcon',
      type: MetadataType.CommonPicture,
      properties: {},
      filePath: mdoPath,
    };

    const result = await resolveCommonPicture(node);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.format, 'PNG');
    assert.strictEqual(result.resolvedFilePath, iconPath);
  });

  test('returns graceful failure when image files are missing', async () => {
    const metadataXml = path.join(tempDir, 'CommonPictures', 'EmptyPic.xml');
    await fs.promises.mkdir(path.dirname(metadataXml), { recursive: true });
    await fs.promises.writeFile(metadataXml, '<CommonPicture/>', 'utf8');

    const result = await resolveCommonPicture(metadataXml);
    assert.strictEqual(result.success, false);
    assert.ok(result.error);
  });

  test('returns failure and does not return zip path when extraction writeFile fails', async () => {
    const picDir = path.join(tempDir, 'CommonPictures', 'FailWriteZip');
    const extDir = path.join(picDir, 'Ext');
    const subPicDir = path.join(extDir, 'Picture');
    await fs.promises.mkdir(subPicDir, { recursive: true });

    const metadataXml = path.join(tempDir, 'CommonPictures', 'FailWriteZip.xml');
    await fs.promises.writeFile(metadataXml, '<CommonPicture><Name>FailWriteZip</Name></CommonPicture>', 'utf8');

    const pictureXml = path.join(extDir, 'Picture.xml');
    await fs.promises.writeFile(pictureXml, '<ExtPicture><Picture><xr:Abs>Picture.zip</xr:Abs></Picture></ExtPicture>', 'utf8');

    const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]);
    const zipBuf = createZipBuffer([{ name: 'icon.png', content: pngData }]);
    const zipPath = path.join(subPicDir, 'Picture.zip');
    await fs.promises.writeFile(zipPath, zipBuf);

    const originalWriteFile = fs.promises.writeFile;
    try {
      (fs.promises as any).writeFile = async (...args: any[]) => {
        const filePath = String(args[0]);
        if (filePath.includes('1cviewer-pictures')) {
          throw new Error('EACCES: disk write failure simulated');
        }
        return (originalWriteFile as any).apply(fs.promises, args);
      };

      const result = await resolveCommonPicture(metadataXml);
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('Не удалось сохранить'));
      assert.strictEqual(result.resolvedFilePath, undefined, 'resolvedFilePath must NOT be set on extraction write failure');
      assert.strictEqual(result.zipFilePath, zipPath);
    } finally {
      fs.promises.writeFile = originalWriteFile;
    }
  });

  test('returns failure and undefined resolvedFilePath when zip contains no supported image', async () => {
    const picDir = path.join(tempDir, 'CommonPictures', 'NoImageZip');
    const extDir = path.join(picDir, 'Ext');
    const subPicDir = path.join(extDir, 'Picture');
    await fs.promises.mkdir(subPicDir, { recursive: true });

    const metadataXml = path.join(tempDir, 'CommonPictures', 'NoImageZip.xml');
    await fs.promises.writeFile(metadataXml, '<CommonPicture><Name>NoImageZip</Name></CommonPicture>', 'utf8');

    const pictureXml = path.join(extDir, 'Picture.xml');
    await fs.promises.writeFile(pictureXml, '<ExtPicture><Picture><xr:Abs>Picture.zip</xr:Abs></Picture></ExtPicture>', 'utf8');

    const zipBuf = createZipBuffer([{ name: 'readme.txt', content: 'no image here' }]);
    const zipPath = path.join(subPicDir, 'Picture.zip');
    await fs.promises.writeFile(zipPath, zipBuf);

    const result = await resolveCommonPicture(metadataXml);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.resolvedFilePath, undefined, 'resolvedFilePath must not point to zip file');
    assert.strictEqual(result.zipFilePath, zipPath);
  });

  test('returns graceful failure for non-existent path', async () => {
    const result = await resolveCommonPicture(path.join(tempDir, 'nonexistent.xml'));
    assert.strictEqual(result.success, false);
    assert.ok(result.error);
  });
});

