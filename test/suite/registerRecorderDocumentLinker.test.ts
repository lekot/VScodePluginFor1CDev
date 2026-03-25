import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  appendRegisterReferenceToRecorderDocument,
  removeRegisterReferenceFromRecorderDocument,
} from '../../src/services/registerRecorderDocumentLinker';
import { SMOKE_EMPTY_CONF_RECORDER_DOCUMENT } from '../helpers/smokeIbcmdConstants';
import { createTempDir, cleanupTempDir } from '../helpers/testHelpers';

suite('registerRecorderDocumentLinker', () => {
  let tmpDir: string;

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-rrd-');
    const documentsDir = path.join(tmpDir, 'Documents');
    await fs.promises.mkdir(documentsDir, { recursive: true });
    const docPath = path.join(documentsDir, 'ДокументТестРаботает.xml');
    await fs.promises.writeFile(
      docPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="2.20">
<Document uuid="6736af77-cdfd-4fc3-92a4-9a9a35fe2a08">
<Properties><Name>ДокументТестРаботает</Name></Properties>
<ChildObjects/>
<RegisterRecords/>
</Document>
</MetaDataObject>
`,
      'utf-8'
    );
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  test('is no-op when recorder document name is missing', async () => {
    const p = path.join(tmpDir, 'Documents', 'ДокументТестРаботает.xml');
    const before = await fs.promises.readFile(p, 'utf-8');
    await appendRegisterReferenceToRecorderDocument(tmpDir, 'AccumulationRegister', 'Orphan', undefined);
    await appendRegisterReferenceToRecorderDocument(tmpDir, 'AccumulationRegister', 'Orphan', '  ');
    assert.strictEqual(await fs.promises.readFile(p, 'utf-8'), before);
  });

  test('is no-op when recorder document file is missing', async () => {
    await appendRegisterReferenceToRecorderDocument(
      tmpDir,
      'AccumulationRegister',
      'X',
      'NoSuchDocument'
    );
  });

  test('skips append when ref is already present', async () => {
    await appendRegisterReferenceToRecorderDocument(
      tmpDir,
      'AccumulationRegister',
      'Matrix_TestReg',
      SMOKE_EMPTY_CONF_RECORDER_DOCUMENT
    );
    const mid = await fs.promises.readFile(
      path.join(tmpDir, 'Documents', 'ДокументТестРаботает.xml'),
      'utf-8'
    );
    await appendRegisterReferenceToRecorderDocument(
      tmpDir,
      'AccumulationRegister',
      'Matrix_TestReg',
      SMOKE_EMPTY_CONF_RECORDER_DOCUMENT
    );
    assert.strictEqual(
      await fs.promises.readFile(path.join(tmpDir, 'Documents', 'ДокументТестРаботает.xml'), 'utf-8'),
      mid
    );
  });

  test('remove is no-op when ref is absent', async () => {
    const p = path.join(tmpDir, 'Documents', 'ДокументТестРаботает.xml');
    const before = await fs.promises.readFile(p, 'utf-8');
    await removeRegisterReferenceFromRecorderDocument(
      tmpDir,
      'InformationRegister',
      'NotThere',
      SMOKE_EMPTY_CONF_RECORDER_DOCUMENT
    );
    assert.strictEqual(await fs.promises.readFile(p, 'utf-8'), before);
  });

  test('uses IBCMD_RECORDER_DOCUMENT when recorder name arg omitted', async () => {
    const prev = process.env.IBCMD_RECORDER_DOCUMENT;
    try {
      process.env.IBCMD_RECORDER_DOCUMENT = SMOKE_EMPTY_CONF_RECORDER_DOCUMENT;
      await appendRegisterReferenceToRecorderDocument(tmpDir, 'InformationRegister', 'EnvLinkedReg');
      const xml = await fs.promises.readFile(
        path.join(tmpDir, 'Documents', 'ДокументТестРаботает.xml'),
        'utf-8'
      );
      assert.ok(xml.includes('InformationRegister.EnvLinkedReg'));
    } finally {
      if (prev === undefined) {
        delete process.env.IBCMD_RECORDER_DOCUMENT;
      } else {
        process.env.IBCMD_RECORDER_DOCUMENT = prev;
      }
    }
  });

  test('append then remove clears RegisterRecords to self-closing', async () => {
    await appendRegisterReferenceToRecorderDocument(
      tmpDir,
      'AccumulationRegister',
      'Matrix_TestReg',
      SMOKE_EMPTY_CONF_RECORDER_DOCUMENT
    );
    let xml = await fs.promises.readFile(
      path.join(tmpDir, 'Documents', 'ДокументТестРаботает.xml'),
      'utf-8'
    );
    assert.ok(xml.includes('AccumulationRegister.Matrix_TestReg'));
    await removeRegisterReferenceFromRecorderDocument(
      tmpDir,
      'AccumulationRegister',
      'Matrix_TestReg',
      SMOKE_EMPTY_CONF_RECORDER_DOCUMENT
    );
    xml = await fs.promises.readFile(
      path.join(tmpDir, 'Documents', 'ДокументТестРаботает.xml'),
      'utf-8'
    );
    assert.ok(!xml.includes('Matrix_TestReg'));
    assert.ok(xml.includes('<RegisterRecords/>'));
  });

  test('inserts before closing RegisterRecords when block is non-empty', async () => {
    const d = await createTempDir('1cviewer-rrd-closing-');
    try {
      const documentsDir = path.join(d, 'Documents');
      await fs.promises.mkdir(documentsDir, { recursive: true });
      const docPath = path.join(documentsDir, 'RecDoc.xml');
      await fs.promises.writeFile(
        docPath,
        `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="2.20">
<Document uuid="11111111-1111-1111-1111-111111111111">
<Properties><Name>RecDoc</Name></Properties>
<ChildObjects/>
<RegisterRecords>
\t\t\t<xr:Item xsi:type="xr:MDObjectRef">InformationRegister.Existing</xr:Item>
\t\t</RegisterRecords>
</Document>
</MetaDataObject>
`,
        'utf-8'
      );
      await appendRegisterReferenceToRecorderDocument(d, 'AccumulationRegister', 'Extra', 'RecDoc');
      const xml = await fs.promises.readFile(docPath, 'utf-8');
      assert.ok(xml.includes('InformationRegister.Existing'));
      assert.ok(xml.includes('AccumulationRegister.Extra'));
    } finally {
      await cleanupTempDir(d);
    }
  });

  test('append is no-op when RegisterRecords section is absent', async () => {
    const d = await createTempDir('1cviewer-rrd-none-');
    try {
      const documentsDir = path.join(d, 'Documents');
      await fs.promises.mkdir(documentsDir, { recursive: true });
      const docPath = path.join(documentsDir, 'Bare.xml');
      const body = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">
<Document uuid="22222222-2222-2222-2222-222222222222">
<Properties><Name>Bare</Name></Properties>
<ChildObjects/>
</Document>
</MetaDataObject>
`;
      await fs.promises.writeFile(docPath, body, 'utf-8');
      await appendRegisterReferenceToRecorderDocument(d, 'AccumulationRegister', 'Orphan', 'Bare');
      assert.strictEqual(await fs.promises.readFile(docPath, 'utf-8'), body);
    } finally {
      await cleanupTempDir(d);
    }
  });
});
