import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { MAX_MXL_PREVIEW_FILE_SIZE_BYTES, MxlLoaderService } from '../../src/mxlPreview/mxlLoaderService';

suite('MxlLoaderService', () => {
  test('detects .mxl format and reads file content', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mxl-loader-'));
    const filePath = path.join(dir, 'sample.mxl');
    const xml = '<TableDocument><Row><Cell>ok</Cell></Row></TableDocument>';
    await fs.writeFile(filePath, xml, 'utf8');

    try {
      const service = new MxlLoaderService();
      const result = await service.loadFromUri({ fsPath: filePath } as any);

      assert.strictEqual(result.sourceFormat, 'mxl');
      assert.strictEqual(result.rawXml, xml);
      assert.strictEqual(result.model.tables.length, 1);
      assert.strictEqual(result.model.tables[0].cells[0].text, 'ok');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('detects .xml and unknown formats by extension', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mxl-loader-'));
    const xmlPath = path.join(dir, 'sample.xml');
    const txtPath = path.join(dir, 'sample.txt');
    const xml = '<TableDocument><Row><Cell>x</Cell></Row></TableDocument>';
    await fs.writeFile(xmlPath, xml, 'utf8');
    await fs.writeFile(txtPath, xml, 'utf8');

    try {
      const service = new MxlLoaderService();
      const xmlResult = await service.loadFromUri({ fsPath: xmlPath } as any);
      const txtResult = await service.loadFromUri({ fsPath: txtPath } as any);

      assert.strictEqual(xmlResult.sourceFormat, 'xml');
      assert.strictEqual(txtResult.sourceFormat, 'unknown');
      assert.strictEqual(xmlResult.model.tables.length, 1);
      assert.strictEqual(txtResult.model.tables.length, 1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('decodes UTF-16LE BOM file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mxl-loader-'));
    const filePath = path.join(dir, 'sample.mxl');
    const xml = '<TableDocument><Row><Cell>ok</Cell></Row></TableDocument>';
    const payload = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
    await fs.writeFile(filePath, payload);

    try {
      const service = new MxlLoaderService();
      const result = await service.loadFromUri({ fsPath: filePath } as any);

      assert.strictEqual(result.model.tables.length, 1);
      assert.strictEqual(result.model.tables[0].cells[0].text, 'ok');
      assert.strictEqual(result.model.diagnostics.some((diag) => diag.level === 'error'), false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('decodes UTF-16BE BOM file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mxl-loader-'));
    const filePath = path.join(dir, 'sample.mxl');
    const xml = '<TableDocument><Row><Cell>be</Cell></Row></TableDocument>';
    const le = Buffer.from(xml, 'utf16le');
    const be = Buffer.alloc(le.length);
    for (let i = 0; i + 1 < le.length; i += 2) {
      be[i] = le[i + 1];
      be[i + 1] = le[i];
    }
    await fs.writeFile(filePath, Buffer.concat([Buffer.from([0xfe, 0xff]), be]));

    try {
      const service = new MxlLoaderService();
      const result = await service.loadFromUri({ fsPath: filePath } as any);

      assert.strictEqual(result.model.tables.length, 1);
      assert.strictEqual(result.model.tables[0].cells[0].text, 'be');
      assert.strictEqual(result.model.diagnostics.some((diag) => diag.level === 'error'), false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('reports encoding diagnostic on suspicious decode', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mxl-loader-'));
    const filePath = path.join(dir, 'sample.mxl');
    await fs.writeFile(filePath, Buffer.from([0xff, 0xfe, 0x00]));

    try {
      const service = new MxlLoaderService();
      const result = await service.loadFromUri({ fsPath: filePath } as any);

      assert.ok(
        result.model.diagnostics.some(
          (diag) =>
            diag.code === 'MXL_XML_PARSE_ERROR' ||
            diag.code === 'MXL_ENCODING_DECODE_ERROR' ||
            diag.code === 'MXL_EMPTY_INPUT'
        )
      );
      assert.ok(result.model.diagnostics.some((diag) => diag.level === 'error'));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('returns diagnostic model when file size exceeds preview limit', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mxl-loader-'));
    const filePath = path.join(dir, 'big.mxl');
    const payload = Buffer.alloc(MAX_MXL_PREVIEW_FILE_SIZE_BYTES + 1, 0x20);
    await fs.writeFile(filePath, payload);

    try {
      const service = new MxlLoaderService();
      const result = await service.loadFromUri({ fsPath: filePath } as any);

      assert.strictEqual(result.rawXml, '');
      assert.strictEqual(result.model.tables.length, 0);
      assert.ok(result.model.diagnostics.some((diag) => diag.code === 'MXL_FILE_SIZE_LIMIT_EXCEEDED'));
      assert.ok(result.model.diagnostics.some((diag) => diag.level === 'error'));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
