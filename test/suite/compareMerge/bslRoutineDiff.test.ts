import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';

import {
  indexBslModuleFile,
  indexBslModuleSource,
  type BslModuleIdentity,
} from '../../../src/compareMerge/bsl/bslModuleIndexer';
import { diffBslModules } from '../../../src/compareMerge/bsl/bslRoutineDiff';

suite('BslRoutineDiff', () => {
  test('reports changed routine by name and body hash', () => {
    const left = moduleFromSource(
      'left',
      'left',
      ['Procedure Save()', '  Value = 1;', 'EndProcedure'].join('\n')
    );
    const right = moduleFromSource(
      'right',
      'right',
      ['Procedure Save()', '  Value = 2;', 'EndProcedure'].join('\n')
    );

    const result = diffBslModules({ left, right });

    assert.strictEqual(result.canAutoMatch, true);
    assert.deepStrictEqual(result.summary, {
      added: 0,
      changed: 1,
      deleted: 0,
      reordered: 0,
      unchanged: 0,
    });
    assert.deepStrictEqual(
      result.routines.map((routine) => [routine.name, routine.status]),
      [['Save', 'changed']]
    );
  });

  test('reports added and deleted routines while matching unchanged routines by name', () => {
    const left = moduleFromSource(
      'left',
      'left',
      [
        'Procedure BeforeOnly()',
        'EndProcedure',
        '',
        'Procedure Shared()',
        '  Value = 1;',
        'EndProcedure',
      ].join('\n')
    );
    const right = moduleFromSource(
      'right',
      'right',
      [
        'Procedure Shared()',
        '  Value = 1;',
        'EndProcedure',
        '',
        'Procedure AfterOnly()',
        'EndProcedure',
      ].join('\n')
    );

    const result = diffBslModules({ left, right });

    assert.strictEqual(result.canAutoMatch, true);
    assert.deepStrictEqual(result.summary, {
      added: 1,
      changed: 0,
      deleted: 1,
      reordered: 0,
      unchanged: 1,
    });
    assert.deepStrictEqual(
      result.routines.map((routine) => [routine.name, routine.status]),
      [
        ['BeforeOnly', 'deleted'],
        ['Shared', 'unchanged'],
        ['AfterOnly', 'added'],
      ]
    );
  });

  test('reports reordered routines without false changed status', () => {
    const left = moduleFromSource(
      'left',
      'left',
      [
        'Procedure First()',
        '  Value = 1;',
        'EndProcedure',
        '',
        'Procedure Second()',
        '  Value = 2;',
        'EndProcedure',
      ].join('\n')
    );
    const right = moduleFromSource(
      'right',
      'right',
      [
        'Procedure Second()',
        '  Value = 2;',
        'EndProcedure',
        '',
        'Procedure First()',
        '  Value = 1;',
        'EndProcedure',
      ].join('\n')
    );

    const result = diffBslModules({ left, right });

    assert.strictEqual(result.canAutoMatch, true);
    assert.deepStrictEqual(result.summary, {
      added: 0,
      changed: 0,
      deleted: 0,
      reordered: 2,
      unchanged: 0,
    });
    assert.deepStrictEqual(
      result.routines.map((routine) => [routine.name, routine.status]),
      [
        ['First', 'reordered'],
        ['Second', 'reordered'],
      ]
    );
  });

  test('reports reordered routines when added routines are also present', () => {
    const left = moduleFromSource(
      'left',
      'left',
      [
        'Procedure First()',
        '  Value = 1;',
        'EndProcedure',
        '',
        'Procedure Second()',
        '  Value = 2;',
        'EndProcedure',
      ].join('\n')
    );
    const right = moduleFromSource(
      'right',
      'right',
      [
        'Procedure Second()',
        '  Value = 2;',
        'EndProcedure',
        '',
        'Procedure First()',
        '  Value = 1;',
        'EndProcedure',
        '',
        'Procedure Third()',
        '  Value = 3;',
        'EndProcedure',
      ].join('\n')
    );

    const result = diffBslModules({ left, right });

    assert.strictEqual(result.canAutoMatch, true);
    assert.deepStrictEqual(result.summary, {
      added: 1,
      changed: 0,
      deleted: 0,
      reordered: 2,
      unchanged: 0,
    });
    assert.deepStrictEqual(
      result.routines.map((routine) => [routine.name, routine.status]),
      [
        ['First', 'reordered'],
        ['Second', 'reordered'],
        ['Third', 'added'],
      ]
    );
  });

  test('blocks auto match when routine names are duplicated', () => {
    const left = moduleFromSource(
      'left',
      'left',
      ['Procedure Save()', 'EndProcedure', '', 'Function save()', 'EndFunction'].join('\n')
    );
    const right = moduleFromSource(
      'right',
      'right',
      ['Procedure Save()', 'EndProcedure'].join('\n')
    );

    const result = diffBslModules({ left, right });

    assert.strictEqual(result.canAutoMatch, false);
    assert.deepStrictEqual(result.routines, []);
    assert.deepStrictEqual(
      result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.blocking]),
      [['BSL_MODULE_DUPLICATE_ROUTINE', true]]
    );
  });

  test('indexes supported Catalog and Document object and manager modules', async () => {
    const root = tempRoot();
    const cases = [
      [
        path.join(root, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl'),
        'Catalog.Products.Object',
      ],
      [
        path.join(root, 'Catalogs', 'Products', 'Ext', 'ManagerModule.bsl'),
        'Catalog.Products.Manager',
      ],
      [path.join(root, 'Documents', 'Order', 'Ext', 'ObjectModule.bsl'), 'Document.Order.Object'],
      [path.join(root, 'Documents', 'Order', 'Ext', 'ManagerModule.bsl'), 'Document.Order.Manager'],
    ];

    for (const [filePath, moduleId] of cases) {
      const result = await indexBslModuleFile({
        sourceId: 'left-source',
        side: 'left',
        filePath,
        configRoots: [root],
        source: '',
      });

      assert.deepStrictEqual(result.diagnostics, []);
      assert.strictEqual(result.modules.length, 1);
      assert.strictEqual(result.modules[0].identity.moduleId, moduleId);
    }
  });

  test('indexes supported CommonModule identity', async () => {
    const root = tempRoot();
    const result = await indexBslModuleFile({
      sourceId: 'left-source',
      side: 'left',
      filePath: path.join(root, 'CommonModules', 'ServerApi', 'Ext', 'Module.bsl'),
      configRoots: [root],
      source: '',
    });

    assert.deepStrictEqual(result.diagnostics, []);
    assert.strictEqual(result.modules[0].identity.moduleId, 'CommonModule.ServerApi');
    assert.strictEqual(result.modules[0].identity.moduleKind, 'CommonModule');
  });

  test('indexes extension module identity with extension context', async () => {
    const root = tempRoot();
    const result = await indexBslModuleFile({
      sourceId: 'left-source',
      side: 'left',
      filePath: path.join(
        root,
        'ConfigurationExtensions',
        'SalesPatch',
        'Catalogs',
        'Products',
        'Ext',
        'ObjectModule.bsl'
      ),
      configRoots: [root],
      source: '',
    });

    assert.deepStrictEqual(result.diagnostics, []);
    assert.strictEqual(result.modules[0].identity.extensionName, 'SalesPatch');
    assert.strictEqual(
      result.modules[0].identity.moduleId,
      'Extension.SalesPatch.Catalog.Products.Object'
    );
    assert.strictEqual(
      result.modules[0].identity.displayName,
      'Extension.SalesPatch.Catalog.Products.Object'
    );
  });

  test('indexes extension module identity when extension root is also configured', async () => {
    const root = tempRoot();
    const extensionRoot = path.join(root, 'ConfigurationExtensions', 'SalesPatch');
    const result = await indexBslModuleFile({
      sourceId: 'left-source',
      side: 'left',
      filePath: path.join(extensionRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl'),
      configRoots: [root, extensionRoot],
      source: '',
    });

    assert.deepStrictEqual(result.diagnostics, []);
    assert.strictEqual(result.modules[0].identity.configRoot, extensionRoot);
    assert.strictEqual(result.modules[0].identity.extensionName, 'SalesPatch');
    assert.strictEqual(
      result.modules[0].identity.moduleId,
      'Extension.SalesPatch.Catalog.Products.Object'
    );
  });

  test('blocks auto match between base and extension modules', async () => {
    const root = tempRoot();
    const base = await indexBslModuleFile({
      sourceId: 'left-source',
      side: 'left',
      filePath: path.join(root, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl'),
      configRoots: [root],
      source: ['Procedure Save()', 'EndProcedure'].join('\n'),
    });
    const extension = await indexBslModuleFile({
      sourceId: 'right-source',
      side: 'right',
      filePath: path.join(
        root,
        'ConfigurationExtensions',
        'SalesPatch',
        'Catalogs',
        'Products',
        'Ext',
        'ObjectModule.bsl'
      ),
      configRoots: [root],
      source: ['Procedure Save()', 'EndProcedure'].join('\n'),
    });

    const result = diffBslModules({ left: base.modules[0], right: extension.modules[0] });

    assert.strictEqual(result.canAutoMatch, false);
    assert.deepStrictEqual(
      result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.blocking]),
      [['BSL_MODULE_IDENTITY_MISMATCH', true]]
    );
  });

  test('indexes supported form module identity', async () => {
    const root = tempRoot();
    const result = await indexBslModuleFile({
      sourceId: 'left-source',
      side: 'left',
      filePath: path.join(
        root,
        'Catalogs',
        'Products',
        'Forms',
        'ItemForm',
        'Ext',
        'Form',
        'Module.bsl'
      ),
      configRoots: [root],
      source: '',
    });

    assert.deepStrictEqual(result.diagnostics, []);
    assert.strictEqual(
      result.modules[0].identity.moduleId,
      'Catalog.Products.Form.ItemForm.FormModule'
    );
    assert.strictEqual(result.modules[0].identity.formName, 'ItemForm');
  });

  test('indexes common form module identity', async () => {
    const root = tempRoot();
    const result = await indexBslModuleFile({
      sourceId: 'left-source',
      side: 'left',
      filePath: path.join(root, 'CommonForms', 'CustomerPicker', 'Ext', 'Form', 'Module.bsl'),
      configRoots: [root],
      source: '',
    });

    assert.deepStrictEqual(result.diagnostics, []);
    assert.strictEqual(result.modules[0].identity.moduleId, 'CommonForm.CustomerPicker.FormModule');
    assert.strictEqual(result.modules[0].identity.moduleKind, 'Form');
    assert.strictEqual(result.modules[0].identity.formName, 'CustomerPicker');
  });

  test('indexes supported command module identity', async () => {
    const root = tempRoot();
    const result = await indexBslModuleFile({
      sourceId: 'left-source',
      side: 'left',
      filePath: path.join(
        root,
        'Documents',
        'Order',
        'Commands',
        'PostOrder',
        'Ext',
        'CommandModule.bsl'
      ),
      configRoots: [root],
      source: '',
    });

    assert.deepStrictEqual(result.diagnostics, []);
    assert.strictEqual(
      result.modules[0].identity.moduleId,
      'Document.Order.Command.PostOrder.CommandModule'
    );
    assert.strictEqual(result.modules[0].identity.commandName, 'PostOrder');
  });

  test('indexes common command module identity', async () => {
    const root = tempRoot();
    const result = await indexBslModuleFile({
      sourceId: 'left-source',
      side: 'left',
      filePath: path.join(root, 'CommonCommands', 'OpenDashboard', 'Ext', 'CommandModule.bsl'),
      configRoots: [root],
      source: '',
    });

    assert.deepStrictEqual(result.diagnostics, []);
    assert.strictEqual(
      result.modules[0].identity.moduleId,
      'CommonCommand.OpenDashboard.CommandModule'
    );
    assert.strictEqual(result.modules[0].identity.moduleKind, 'Command');
    assert.strictEqual(result.modules[0].identity.commandName, 'OpenDashboard');
  });

  test('uses known metadata folder type names in module identity', async () => {
    const root = tempRoot();
    const result = await indexBslModuleFile({
      sourceId: 'left-source',
      side: 'left',
      filePath: path.join(
        root,
        'FilterCriteria',
        'ByPartner',
        'Forms',
        'Main',
        'Ext',
        'Form',
        'Module.bsl'
      ),
      configRoots: [root],
      source: '',
    });

    assert.deepStrictEqual(result.diagnostics, []);
    assert.strictEqual(
      result.modules[0].identity.moduleId,
      'FilterCriterion.ByPartner.Form.Main.FormModule'
    );
  });

  test('returns blocking unsupported diagnostic for unsupported module kind', async () => {
    const root = tempRoot();
    const result = await indexBslModuleFile({
      sourceId: 'left-source',
      side: 'left',
      filePath: path.join(root, 'Constants', 'ExchangeRate', 'Ext', 'ValueManagerModule.bsl'),
      configRoots: [root],
      source: '',
    });

    assert.deepStrictEqual(result.modules, []);
    assert.deepStrictEqual(
      result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.blocking]),
      [['BSL_MODULE_UNSUPPORTED_KIND', true]]
    );
  });
});

function moduleFromSource(sourceId: string, side: 'left' | 'right', source: string) {
  return indexBslModuleSource({
    identity: makeIdentity(sourceId, side),
    source,
  });
}

function makeIdentity(sourceId: string, side: 'left' | 'right'): BslModuleIdentity {
  return {
    sourceId,
    side,
    filePath: path.join(tempRoot(), side, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl'),
    configRoot: tempRoot(),
    metadataType: 'Catalog',
    objectName: 'Products',
    moduleKind: 'Object',
    moduleId: 'Catalog.Products.Object',
    displayName: 'Catalog.Products.Object',
  };
}

function tempRoot(): string {
  return path.join(os.tmpdir(), 'bsl-routine-diff-root');
}
