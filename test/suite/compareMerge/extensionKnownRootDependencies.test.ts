import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';

import { buildConfigurationCompare, type ConfigurationCompareInput, type ConfigurationCompareResult } from '../../../src/compareMerge/configurationCompareService';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import { scanExtensionXmlDependencies } from '../../../src/compareMerge/extensions/extensionDependencyScanner';
import { scanKnownRootPropertyReferences } from '../../../src/compareMerge/extensions/extensionKnownRootPropertyReferences';
import { XmlParser } from '../../../src/parsers/xmlParser';
import {
  createExtensionCompareTempRoot,
  writeDesignerConfiguration,
  type ExtensionCompareConfigurationFixture,
  type ExtensionCompareObjectFixture,
} from '../../helpers/extensionCompareFixtures';

const UUID = {
  target: '11111111-1111-4111-8111-111111111111',
  source: '22222222-2222-4222-8222-222222222222',
  register: '33333333-3333-4333-8333-333333333333',
  recorder: '44444444-4444-4444-8444-444444444444',
  accountingRegister: '55555555-5555-4555-8555-555555555555',
  calculationRegister: '66666666-6666-4666-8666-666666666666',
  accountsChart: '77777777-7777-4777-8777-777777777777',
  calculationChart: '88888888-8888-4888-8888-888888888888',
  targetAccountsChart: '99999999-9999-4999-8999-999999999999',
  targetCalculationChart: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
} as const;

suite('Extension known root property dependencies (#336)', () => {
  test('reads only the supported direct root property references', () => {
    const result = scanExtensionXmlDependencies([
      {
        relativePath: 'AccountingRegisters/Ext_Accounting.xml',
        content: Buffer.from('<MetaDataObject><AccountingRegister><Properties><Name>ChartOfAccounts.NameNoise</Name><Comment>ChartOfAccounts.CommentNoise</Comment><ChartOfAccounts>ChartOfAccounts.Plan</ChartOfAccounts></Properties></AccountingRegister></MetaDataObject>'),
      },
      {
        relativePath: 'CalculationRegisters/Ext_Calculation.xml',
        content: Buffer.from('<MetaDataObject><CalculationRegister><Properties><ChartOfCalculationTypes>ChartOfCalculationTypes.Accruals</ChartOfCalculationTypes></Properties></CalculationRegister></MetaDataObject>'),
      },
      {
        relativePath: 'ChartsOfAccounts/Ext_Accounts.xml',
        content: Buffer.from('<MetaDataObject><ChartOfAccounts><Properties><ExtDimensionTypes>ChartOfCharacteristicTypes.Subconto</ExtDimensionTypes></Properties></ChartOfAccounts></MetaDataObject>'),
      },
      {
        relativePath: 'AccountingRegisters/Noise.xml',
        content: Buffer.from('<MetaDataObject><AccountingRegister><Properties><Comment><ChartOfAccounts>ChartOfAccounts.NestedNoise</ChartOfAccounts></Comment><Name>ChartOfAccounts.NameOnly</Name></Properties></AccountingRegister></MetaDataObject>'),
      },
    ]);

    assert.deepStrictEqual(result.errors, []);
    assert.deepStrictEqual(result.references, [
      { artifactPath: 'AccountingRegisters/Ext_Accounting.xml', qualifiedName: 'ChartOfAccounts.Plan', metadataType: 'ChartOfAccounts', objectName: 'Plan', requiresCfeDeclaration: true },
      { artifactPath: 'CalculationRegisters/Ext_Calculation.xml', qualifiedName: 'ChartOfCalculationTypes.Accruals', metadataType: 'ChartOfCalculationTypes', objectName: 'Accruals', requiresCfeDeclaration: true },
      { artifactPath: 'ChartsOfAccounts/Ext_Accounts.xml', qualifiedName: 'ChartOfCharacteristicTypes.Subconto', metadataType: 'ChartOfCharacteristicTypes', objectName: 'Subconto', requiresCfeDeclaration: true },
    ]);
  });

  test('preserves the CFE declaration marker when raw and typed discovery paths deduplicate', () => {
    const result = scanExtensionXmlDependencies([
      {
        relativePath: 'AccountingRegisters/Ext_Accounting.xml',
        content: Buffer.from('<MetaDataObject xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><AccountingRegister><Properties><ChartOfAccounts>ChartOfAccounts.Plan</ChartOfAccounts><OtherReference><xr:Item xsi:type="xr:MDObjectRef">ChartOfAccounts.Plan</xr:Item></OtherReference></Properties></AccountingRegister></MetaDataObject>'),
      },
      {
        relativePath: 'Documents/Ext_Recorder.xml',
        content: Buffer.from('<MetaDataObject xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Document><Properties><OtherReference><xr:Item xsi:type="xr:MDObjectRef">ChartOfAccounts.Plan</xr:Item></OtherReference></Properties></Document></MetaDataObject>'),
      },
    ]);

    assert.deepStrictEqual(result.errors, []);
    assert.deepStrictEqual(result.references, [
      { artifactPath: 'AccountingRegisters/Ext_Accounting.xml', qualifiedName: 'ChartOfAccounts.Plan', metadataType: 'ChartOfAccounts', objectName: 'Plan', requiresCfeDeclaration: true },
      { artifactPath: 'Documents/Ext_Recorder.xml', qualifiedName: 'ChartOfAccounts.Plan', metadataType: 'ChartOfAccounts', objectName: 'Plan' },
    ]);
  });

  test('fails closed for malformed, duplicate, and explicitly empty required raw reference fields', () => {
    const malformed = scanExtensionXmlDependencies([{
      relativePath: 'AccountingRegisters/Malformed.xml',
      content: Buffer.from('<MetaDataObject><AccountingRegister><Properties><ChartOfAccounts>ChartOfAccounts.Plan</ChartOfAccounts>'),
    }]);
    assert.strictEqual(malformed.errors.length, 1);
    assert.strictEqual(malformed.errors[0]?.artifactPath, 'AccountingRegisters/Malformed.xml');
    assert.match(malformed.errors[0]?.message ?? '', /XML нельзя проверить/u);

    const duplicate = scanKnownRootXml(
      '<MetaDataObject><AccountingRegister><Properties><ChartOfAccounts>ChartOfAccounts.First</ChartOfAccounts><ChartOfAccounts>ChartOfAccounts.Second</ChartOfAccounts></Properties></AccountingRegister></MetaDataObject>',
      'AccountingRegisters/Duplicate.xml',
    );
    assert.deepStrictEqual(duplicate.references, []);
    assert.strictEqual(duplicate.errors.length, 1);
    assert.match(duplicate.errors[0]?.message ?? '', /должен встречаться ровно один раз/u);

    const emptyRequired = scanKnownRootXml(
      '<MetaDataObject><AccountingRegister><Properties><ChartOfAccounts/></Properties></AccountingRegister></MetaDataObject>',
      'AccountingRegisters/EmptyRequired.xml',
    );
    assert.deepStrictEqual(emptyRequired.references, []);
    assert.strictEqual(emptyRequired.errors.length, 1);
    assert.match(emptyRequired.errors[0]?.message ?? '', /не может быть пустым/u);
  });

  test('allows optional empty or absent fields and an adopted register with an absent inherited field', () => {
    const optionalEmpty = scanKnownRootXml(
      '<MetaDataObject><ChartOfAccounts><Properties><ExtDimensionTypes/></Properties></ChartOfAccounts></MetaDataObject>',
      'ChartsOfAccounts/EmptyOptional.xml',
    );
    const optionalAbsent = scanKnownRootXml(
      '<MetaDataObject><ChartOfAccounts><Properties><Name>Accounts</Name></Properties></ChartOfAccounts></MetaDataObject>',
      'ChartsOfAccounts/AbsentOptional.xml',
    );
    const adoptedAbsent = scanKnownRootXml(
      '<MetaDataObject><AccountingRegister><Properties><ObjectBelonging>Adopted</ObjectBelonging><Name>Ext_Register</Name></Properties></AccountingRegister></MetaDataObject>',
      'AccountingRegisters/AdoptedAbsent.xml',
    );

    for (const result of [optionalEmpty, optionalAbsent, adoptedAbsent]) {
      assert.deepStrictEqual(result.references, []);
      assert.deepStrictEqual(result.errors, []);
    }
  });

  test('ignores raw-looking root names in nested elements, Comment, and Name', () => {
    const result = scanKnownRootXml(
      '<MetaDataObject><AccountingRegister><Properties><Name>ChartOfAccounts.NameNoise</Name><Comment>ChartOfAccounts.CommentNoise</Comment><Other><ChartOfAccounts>ChartOfAccounts.NestedNoise</ChartOfAccounts></Other></Properties></AccountingRegister></MetaDataObject>',
      'AccountingRegisters/Noise.xml',
    );

    assert.deepStrictEqual(result.references, []);
    assert.deepStrictEqual(result.errors, []);
  });

  test('blocks a missing ChartOfAccounts reference stored as direct root property text', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cf');
      const source = path.join(tempRoot, 'source-cfe');
      const register: ExtensionCompareObjectFixture = {
        type: 'AccountingRegister',
        name: 'Ext_Register',
        uuid: UUID.register,
        belonging: 'Own',
        propertiesXml: '<ChartOfAccounts>ChartOfAccounts.MissingPlan</ChartOfAccounts>',
      };
      const recorder: ExtensionCompareObjectFixture = {
        type: 'Document',
        name: 'Ext_Recorder',
        uuid: UUID.recorder,
        belonging: 'Own',
        propertiesXml: '<RegisterRecords xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><xr:Item xsi:type="xr:MDObjectRef">AccountingRegister.Ext_Register</xr:Item></RegisterRecords>',
      };
      await writeDesignerConfiguration(target, { uuid: UUID.target });
      await writeDesignerConfiguration(source, {
        uuid: UUID.source,
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [register, recorder],
      });

      const compare = await openCompare(tempRoot, target, source);
      try {
        const registerId = nodeIdForLabel(compare.result.projection.root, 'AccountingRegister.Ext_Register');
        const recorderId = nodeIdForLabel(compare.result.projection.root, 'Document.Ext_Recorder');
        const created = await compare.result.workspace.createPreviewForNodeIds([registerId, recorderId]);

        assert.strictEqual(created.ok, false, `missing raw ChartOfAccounts dependency must block preview: ${JSON.stringify(created)}`);
        const diagnostic = created.diagnostics.find((item) => item.blocking);
        assert.ok(diagnostic);
        assert.ok(diagnostic.suggestedAction?.includes('ChartOfAccounts.MissingPlan'), JSON.stringify(diagnostic));
      } finally {
        compare.dispose();
      }
    });
  });

  test('blocks an own CFE register when its raw chart dependency exists only in the proven base', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cfe');
      await writeDesignerConfiguration(base, {
        objects: [
          { type: 'ChartOfAccounts', name: 'Plan', uuid: UUID.accountsChart },
          { type: 'ChartOfCalculationTypes', name: 'Accruals', uuid: UUID.calculationChart },
        ],
      });
      await writeDesignerConfiguration(target, {
        uuid: UUID.target,
        purpose: 'Customization',
        namePrefix: 'Ext_',
      });
      await writeDesignerConfiguration(source, {
        uuid: UUID.source,
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [
          {
            type: 'AccountingRegister',
            name: 'Ext_Accounting',
            uuid: UUID.accountingRegister,
            belonging: 'Own',
            propertiesXml: '<ChartOfAccounts>ChartOfAccounts.Plan</ChartOfAccounts>',
          },
          {
            type: 'CalculationRegister',
            name: 'Ext_Calculation',
            uuid: UUID.calculationRegister,
            belonging: 'Own',
            propertiesXml: '<ChartOfCalculationTypes>ChartOfCalculationTypes.Accruals</ChartOfCalculationTypes>',
          },
          {
            type: 'Document',
            name: 'Ext_Recorder',
            uuid: UUID.recorder,
            belonging: 'Own',
            propertiesXml: '<RegisterRecords xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><xr:Item xsi:type="xr:MDObjectRef">AccountingRegister.Ext_Accounting</xr:Item><xr:Item xsi:type="xr:MDObjectRef">CalculationRegister.Ext_Calculation</xr:Item></RegisterRecords>',
          },
        ],
      });

      const compare = await openCompare(tempRoot, target, source, {
        extensionBaseRoots: { left: base, right: base },
      });
      try {
        const selectedIds = [
          nodeIdForLabel(compare.result.projection.root, 'AccountingRegister.Ext_Accounting'),
          nodeIdForLabel(compare.result.projection.root, 'CalculationRegister.Ext_Calculation'),
          nodeIdForLabel(compare.result.projection.root, 'Document.Ext_Recorder'),
        ];
        const created = await compare.result.workspace.createPreviewForNodeIds(selectedIds);

        assert.strictEqual(created.ok, false, `an own CFE output must declare its raw chart dependency locally: ${JSON.stringify(created)}`);
        const diagnostic = created.diagnostics.find((item) => item.blocking);
        assert.ok(diagnostic);
        assert.match(diagnostic.suggestedAction ?? '', /CFE|заимств|выбран|borrow|select/iu, JSON.stringify(diagnostic));
        assert.match(diagnostic.suggestedAction ?? '', /выбер|заимств|borrow|select/iu, JSON.stringify(diagnostic));
      } finally {
        compare.dispose();
      }
    });
  });

  test('allows own CFE registers when both raw chart dependencies are adopted in the target', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cfe');
      await writeDesignerConfiguration(base, {
        objects: [
          { type: 'ChartOfAccounts', name: 'Plan', uuid: UUID.accountsChart },
          { type: 'ChartOfCalculationTypes', name: 'Accruals', uuid: UUID.calculationChart },
        ],
      });
      await writeDesignerConfiguration(target, {
        uuid: UUID.target,
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [
          { type: 'ChartOfAccounts', name: 'Plan', uuid: UUID.targetAccountsChart, belonging: 'Adopted', anchorUuid: UUID.accountsChart },
          { type: 'ChartOfCalculationTypes', name: 'Accruals', uuid: UUID.targetCalculationChart, belonging: 'Adopted', anchorUuid: UUID.calculationChart },
        ],
      });
      await writeDesignerConfiguration(source, {
        uuid: UUID.source,
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [
          {
            type: 'AccountingRegister',
            name: 'Ext_Accounting',
            uuid: UUID.accountingRegister,
            belonging: 'Own',
            propertiesXml: '<ChartOfAccounts>ChartOfAccounts.Plan</ChartOfAccounts>',
          },
          {
            type: 'CalculationRegister',
            name: 'Ext_Calculation',
            uuid: UUID.calculationRegister,
            belonging: 'Own',
            propertiesXml: '<ChartOfCalculationTypes>ChartOfCalculationTypes.Accruals</ChartOfCalculationTypes>',
          },
          {
            type: 'Document',
            name: 'Ext_Recorder',
            uuid: UUID.recorder,
            belonging: 'Own',
            propertiesXml: '<RegisterRecords xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><xr:Item xsi:type="xr:MDObjectRef">AccountingRegister.Ext_Accounting</xr:Item><xr:Item xsi:type="xr:MDObjectRef">CalculationRegister.Ext_Calculation</xr:Item></RegisterRecords>',
          },
        ],
      });

      const compare = await openCompare(tempRoot, target, source, {
        extensionBaseRoots: { left: base, right: base },
      });
      try {
        const selectedIds = [
          nodeIdForLabel(compare.result.projection.root, 'AccountingRegister.Ext_Accounting'),
          nodeIdForLabel(compare.result.projection.root, 'CalculationRegister.Ext_Calculation'),
          nodeIdForLabel(compare.result.projection.root, 'Document.Ext_Recorder'),
        ];
        const created = await compare.result.workspace.createPreviewForNodeIds(selectedIds);
        assert.strictEqual(created.ok, true, created.ok ? '' : JSON.stringify(created.diagnostics));
      } finally {
        compare.dispose();
      }
    });
  });
});

async function openCompare(
  tempRoot: string,
  leftRootPath: string,
  rightRootPath: string,
  options: Pick<ConfigurationCompareInput, 'extensionBaseRoots'> = {},
): Promise<{ result: ConfigurationCompareResult; dispose(): void }> {
  const result = await buildConfigurationCompare({
    leftRootPath,
    rightRootPath,
    backupRootPath: path.join(tempRoot, 'backups'),
    extensionBaseRoots: options.extensionBaseRoots,
  });
  return { result, dispose: () => result.workspace.dispose() };
}

async function withTempRoot<T>(callback: (tempRoot: string) => Promise<T>): Promise<T> {
  const tempRoot = await createExtensionCompareTempRoot('issue336-root-property-dependencies-');
  try {
    return await callback(tempRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function nodeIdForLabel(root: CompareTreeNode, label: string): string {
  const matches = collectNodes(root).filter((node) => node.label === label);
  assert.strictEqual(matches.length, 1, `Expected one row ${label}, got ${matches.length}`);
  return matches[0]!.id;
}

function collectNodes(root: CompareTreeNode): CompareTreeNode[] {
  return [root, ...root.children.flatMap(collectNodes)];
}

function scanKnownRootXml(xml: string, artifactPath: string) {
  return scanKnownRootPropertyReferences(XmlParser.parseString(xml), artifactPath);
}
