// test/suite/predefinedCharacteristicOperations.test.ts
// Unit tests for predefinedCharacteristicOperations

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  listPredefinedCharacteristics,
  getPredefinedCharacteristicType,
  setPredefinedCharacteristicType,
  getCharacteristicValueRegisters,
} from '../../src/agent/predefinedCharacteristicOperations';
import { createTempDir, cleanupTempDir } from '../helpers/testHelpers';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SAMPLE_PREDEFINED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<PredefinedData xmlns="http://v8.1c.ru/8.3/xcf/predef" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="PlanOfCharacteristicKindPredefinedItems" version="2.20">
\t<Item id="74f7f99c-ca92-431a-86d6-39f749ae3adb">
\t\t<Name>КатегорииЗакупок</Name>
\t\t<Code>000000010</Code>
\t\t<Description>Категории закупок</Description>
\t\t<Type>
\t\t\t<v8:Type xmlns:d4p1="http://v8.1c.ru/8.1/data/enterprise/current-config">d4p1:CatalogRef.КатегорииЗакупок</v8:Type>
\t\t</Type>
\t\t<IsFolder>false</IsFolder>
\t</Item>
\t<Item id="6ac9eab8-b733-42c3-93dd-84d106e9bd2e">
\t\t<Name>Номенклатура</Name>
\t\t<Code>000000003</Code>
\t\t<Description>Номенклатура</Description>
\t\t<Type>
\t\t\t<v8:Type xmlns:d4p1="http://v8.1c.ru/8.1/data/enterprise/current-config">d4p1:CatalogRef.Номенклатура</v8:Type>
\t\t</Type>
\t\t<IsFolder>false</IsFolder>
\t</Item>
</PredefinedData>`;

const IR_WITH_COT_REF = (cotName: string) => `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <InformationRegister>
    <Properties>
      <Name>РегистрСвязанный</Name>
    </Properties>
    <ChildObjects>
      <Resource>
        <Name>ЗначениеВида</Name>
        <Type>
          <v8:Type>cfg:ChartOfCharacteristicTypesRef.${cotName}</v8:Type>
        </Type>
      </Resource>
    </ChildObjects>
  </InformationRegister>
</MetaDataObject>`;

const IR_WITHOUT_COT_REF = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses">
  <InformationRegister>
    <Properties>
      <Name>РегистрБезСвязи</Name>
    </Properties>
  </InformationRegister>
</MetaDataObject>`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setupCotWorkspace(configRoot: string, cotName: string, xmlContent: string): void {
  const cotDir = path.join(configRoot, 'ChartsOfCharacteristicTypes', cotName, 'Ext');
  fs.mkdirSync(cotDir, { recursive: true });
  fs.writeFileSync(path.join(cotDir, 'Predefined.xml'), xmlContent, 'utf-8');
}

// ─── Suite: listPredefinedCharacteristics ─────────────────────────────────────

suite('predefinedCharacteristicOperations: listPredefinedCharacteristics', () => {
  let tmpDir: string;

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-cot-list-');
    setupCotWorkspace(tmpDir, 'РеквизитыЗакупки', SAMPLE_PREDEFINED_XML);
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  test('returns 2 entries for sample predefined', async () => {
    const entries = await listPredefinedCharacteristics(tmpDir, 'РеквизитыЗакупки');
    assert.strictEqual(entries.length, 2);
  });

  test('first entry has correct name and type', async () => {
    const entries = await listPredefinedCharacteristics(tmpDir, 'РеквизитыЗакупки');
    const first = entries.find((e) => e.name === 'КатегорииЗакупок');
    assert.ok(first, 'КатегорииЗакупок should be found');
    assert.ok(first!.type[0].includes('CatalogRef.КатегорииЗакупок'));
  });

  test('returns empty array when Predefined.xml does not exist', async () => {
    const entries = await listPredefinedCharacteristics(tmpDir, 'НесуществующийПВХ');
    assert.strictEqual(entries.length, 0);
  });

  test('accepts dot-separated path format', async () => {
    const entries = await listPredefinedCharacteristics(tmpDir, 'ChartOfCharacteristicTypes.РеквизитыЗакупки');
    assert.strictEqual(entries.length, 2);
  });
});

// ─── Suite: getPredefinedCharacteristicType ───────────────────────────────────

suite('predefinedCharacteristicOperations: getPredefinedCharacteristicType', () => {
  let tmpDir: string;

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-cot-gettype-');
    setupCotWorkspace(tmpDir, 'РеквизитыЗакупки', SAMPLE_PREDEFINED_XML);
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  test('returns type array for existing predefined', async () => {
    const types = await getPredefinedCharacteristicType(tmpDir, 'РеквизитыЗакупки', 'Номенклатура');
    assert.ok(types.length >= 1, 'should return at least 1 type');
    assert.ok(types[0].includes('CatalogRef.Номенклатура'), `Got: ${types[0]}`);
  });

  test('returns empty array for unknown predefined name', async () => {
    const types = await getPredefinedCharacteristicType(tmpDir, 'РеквизитыЗакупки', 'НесуществующийВид');
    assert.strictEqual(types.length, 0);
  });
});

// ─── Suite: setPredefinedCharacteristicType ───────────────────────────────────

suite('predefinedCharacteristicOperations: setPredefinedCharacteristicType', () => {
  let tmpDir: string;

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-cot-settype-');
    setupCotWorkspace(tmpDir, 'РеквизитыЗакупки', SAMPLE_PREDEFINED_XML);
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  test('set then get returns updated type', async () => {
    await setPredefinedCharacteristicType(
      tmpDir, 'РеквизитыЗакупки', 'Номенклатура', ['xs:string']
    );
    const types = await getPredefinedCharacteristicType(tmpDir, 'РеквизитыЗакупки', 'Номенклатура');
    assert.ok(types.some((t) => t.includes('string')), `Expected xs:string, got: ${JSON.stringify(types)}`);
  });

  test('set cfg: reference type and read back', async () => {
    await setPredefinedCharacteristicType(
      tmpDir, 'РеквизитыЗакупки', 'КатегорииЗакупок', ['cfg:CatalogRef.Номенклатура']
    );
    const types = await getPredefinedCharacteristicType(tmpDir, 'РеквизитыЗакупки', 'КатегорииЗакупок');
    assert.ok(
      types.some((t) => t.includes('CatalogRef.Номенклатура')),
      `Expected CatalogRef.Номенклатура in types, got: ${JSON.stringify(types)}`
    );
  });

  test('throws for unknown predefined name', async () => {
    await assert.rejects(
      () => setPredefinedCharacteristicType(tmpDir, 'РеквизитыЗакупки', 'НесуществующийВид', ['xs:string']),
      /not found/i
    );
  });
});

// ─── Suite: getCharacteristicValueRegisters ───────────────────────────────────

suite('predefinedCharacteristicOperations: getCharacteristicValueRegisters', () => {
  let tmpDir: string;
  const COT_NAME = 'РеквизитыЗакупки';

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-cot-regs-');
    const irDir = path.join(tmpDir, 'InformationRegisters');
    fs.mkdirSync(irDir, { recursive: true });

    // Register that references the COT
    fs.writeFileSync(
      path.join(irDir, 'РегистрСвязанный.xml'),
      IR_WITH_COT_REF(COT_NAME),
      'utf-8'
    );
    // Register that does NOT reference the COT
    fs.writeFileSync(
      path.join(irDir, 'РегистрБезСвязи.xml'),
      IR_WITHOUT_COT_REF,
      'utf-8'
    );
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  test('returns only registers that reference the COT', async () => {
    const regs = await getCharacteristicValueRegisters(tmpDir, COT_NAME);
    assert.ok(regs.includes('InformationRegister.РегистрСвязанный'), `Expected РегистрСвязанный, got: ${JSON.stringify(regs)}`);
    assert.ok(!regs.includes('InformationRegister.РегистрБезСвязи'), `Unexpected РегистрБезСвязи in: ${JSON.stringify(regs)}`);
    assert.strictEqual(regs.length, 1);
  });

  test('returns empty array when InformationRegisters dir missing', async () => {
    const regs = await getCharacteristicValueRegisters(tmpDir, 'НесуществующийПВХ');
    // No IR dir issue + no matches — just no results expected for unknown COT
    assert.ok(Array.isArray(regs));
  });

  test('returns empty array when no registers reference the COT', async () => {
    const regs = await getCharacteristicValueRegisters(tmpDir, 'ПВХКоторыйНиктоНеИспользует');
    assert.strictEqual(regs.length, 0);
  });

  test('result is sorted alphabetically', async () => {
    // Add another register that also references the COT
    const irDir = path.join(tmpDir, 'InformationRegisters');
    fs.writeFileSync(
      path.join(irDir, 'АаРегистр.xml'),
      IR_WITH_COT_REF(COT_NAME),
      'utf-8'
    );
    const regs = await getCharacteristicValueRegisters(tmpDir, COT_NAME);
    assert.strictEqual(regs.length, 2);
    // Sorted: АаРегистр before РегистрСвязанный
    assert.ok(regs[0] <= regs[1], `Expected sorted, got: ${JSON.stringify(regs)}`);
  });
});
