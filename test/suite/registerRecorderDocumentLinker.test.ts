import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  appendRegisterReferenceToRecorderDocument,
  removeRegisterReferenceFromRecorderDocument,
} from '../../src/services/registerRecorderDocumentLinker';
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

  test('append then remove clears RegisterRecords to self-closing', async () => {
    await appendRegisterReferenceToRecorderDocument(
      tmpDir,
      'AccumulationRegister',
      'Matrix_TestReg'
    );
    let xml = await fs.promises.readFile(
      path.join(tmpDir, 'Documents', 'ДокументТестРаботает.xml'),
      'utf-8'
    );
    assert.ok(xml.includes('AccumulationRegister.Matrix_TestReg'));
    await removeRegisterReferenceFromRecorderDocument(
      tmpDir,
      'AccumulationRegister',
      'Matrix_TestReg'
    );
    xml = await fs.promises.readFile(
      path.join(tmpDir, 'Documents', 'ДокументТестРаботает.xml'),
      'utf-8'
    );
    assert.ok(!xml.includes('Matrix_TestReg'));
    assert.ok(xml.includes('<RegisterRecords/>'));
  });
});
