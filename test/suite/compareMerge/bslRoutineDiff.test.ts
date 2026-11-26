import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';

import { METADATA_STANDARD_MODULE_DESCRIPTORS } from '../../../src/constants/metadataModuleDescriptors';
import { METADATA_TYPE_DESCRIPTORS } from '../../../src/constants/metadataTypeDescriptors';
import {
  indexBslModuleFile,
  indexBslModuleSource,
  type BslModuleIdentity,
  type BslModuleIndexEntry,
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

  test('reports meaningful source changes outside routines without blocking routine matching', () => {
    const routine = ['Procedure Save()', '  Value = 1;', 'EndProcedure'];
    const left = moduleFromSource('left', 'left', [
      '#If Server Then',
      '// module preamble',
      'ModuleValue = 1;',
      'InitializeModule(1);',
      ...routine,
    ].join('\n'));
    const right = moduleFromSource('right', 'right', [
      '#If Client Then',
      '// changed module preamble',
      'ModuleValue = 2;',
      'InitializeModule(2);',
      ...routine,
    ].join('\n'));

    const result = diffBslModules({ left, right });
    const contentChange = readNonRoutineChange(result);

    assert.strictEqual(result.canAutoMatch, true);
    assert.deepStrictEqual(result.routines.map((item) => item.status), ['unchanged']);
    assert.deepStrictEqual(result.diagnostics, []);
    assert.ok(contentChange, 'outside-source changes must be reported separately');
    assert.match(contentChange.message, /вне процедур/i);
    assert.match(contentChange.message, /ручн/i);
  });

  test('reports changes in empty modules and preserves multiline literal whitespace', () => {
    const left = moduleFromSource('left', 'left', ['Text = "first line', '|continuation  ', '|";'].join('\n'));
    const right = moduleFromSource('right', 'right', ['Text = "first line', '|continuation ', '|";'].join('\n'));

    const result = diffBslModules({ left, right });

    assert.strictEqual(left.routines.length, 0);
    assert.strictEqual(right.routines.length, 0);
    assert.strictEqual(result.canAutoMatch, true);
    assert.deepStrictEqual(result.diagnostics, []);
    assert.ok(readNonRoutineChange(result), 'empty modules still compare their full source');
  });

  test('ignores routine insertion, attached directives, line shifts, and line-ending changes outside the diff', () => {
    const left = moduleFromSource('left', 'left', [
      'ModuleValue = 1;',
      '',
      '&AtClient',
      'Procedure Existing()',
      '  Value = 1;',
      'EndProcedure',
    ].join('\n'));
    const right = moduleFromSource('right', 'right', [
      'ModuleValue = 1;',
      '',
      '&AtServer',
      'Procedure Added()',
      '  Value = 2;',
      'EndProcedure',
      '',
      '&AtClient',
      'Procedure Existing()',
      '  Value = 1;',
      'EndProcedure',
    ].join('\r\n'));

    const result = diffBslModules({ left, right });

    assert.strictEqual(result.summary.added, 1);
    assert.strictEqual(result.summary.unchanged, 1);
    assert.strictEqual(readNonRoutineChange(result), undefined);
  });

  test('folds outside text across a newly added routine and still detects changed initialization', () => {
    const left = moduleFromSource('left', 'left', [
      'ModuleValue = 1;',
      'InitializeModule(1);',
    ].join('\n'));
    const right = moduleFromSource('right', 'right', [
      'ModuleValue = 1;',
      'Procedure Added()',
      '  Value = 2;',
      'EndProcedure',
      'InitializeModule(1);',
    ].join('\n'));
    const changedInitialization = moduleFromSource('right', 'right', [
      'ModuleValue = 1;',
      'Procedure Added()',
      '  Value = 2;',
      'EndProcedure',
      'InitializeModule(3);',
    ].join('\n'));

    assert.strictEqual(readNonRoutineChange(diffBslModules({ left, right })), undefined);
    assert.ok(readNonRoutineChange(diffBslModules({ left, right: changedInitialization })));
  });

  test('detects preprocessor regions and comments moved across unchanged routine anchors', () => {
    const routineA = ['Procedure A()', '  Value = 1;', 'EndProcedure'];
    const routineB = ['Procedure B()', '  Value = 2;', 'EndProcedure'];
    const movedIf = diffBslModules({
      left: moduleFromSource('left', 'left', [
        '#If Server Then',
        ...routineA,
        '#EndIf',
        ...routineB,
      ].join('\n')),
      right: moduleFromSource('right', 'right', [
        ...routineA,
        '#If Server Then',
        ...routineB,
        '#EndIf',
      ].join('\n')),
    });
    const movedComments = diffBslModules({
      left: moduleFromSource('left', 'left', [
        'ModuleValue = 1;',
        '// comment before A',
        ...routineA,
        '// comment between routines',
        ...routineB,
        'InitializeModule();',
      ].join('\n')),
      right: moduleFromSource('right', 'right', [
        'ModuleValue = 1;',
        ...routineA,
        '// comment before A',
        '// comment between routines',
        ...routineB,
        'InitializeModule();',
      ].join('\n')),
    });

    assert.deepStrictEqual(movedIf.routines.map((item) => item.status), ['unchanged', 'unchanged']);
    assert.ok(readNonRoutineChange(movedIf), 'moving #If/#EndIf changes the routine compile context');
    assert.ok(readNonRoutineChange(movedComments), 'moving a comment across routines changes its anchored region');
  });

  test('detects Russian #Иначе branches and keeps pure routine reorder with prefix and suffix source equal', () => {
    const routineA = ['Procedure A()', '  Value = 1;', 'EndProcedure'];
    const routineB = ['Procedure B()', '  Value = 2;', 'EndProcedure'];
    const movedElse = diffBslModules({
      left: moduleFromSource('left', 'left', [
        '#Если Клиент Тогда',
        ...routineA,
        '#Иначе',
        ...routineB,
        '#КонецЕсли',
      ].join('\n')),
      right: moduleFromSource('right', 'right', [
        '#Если Клиент Тогда',
        ...routineB,
        '#Иначе',
        ...routineA,
        '#КонецЕсли',
      ].join('\n')),
    });
    const reordered = diffBslModules({
      left: moduleFromSource('left', 'left', [
        'ModuleValue = 1;',
        ...routineA,
        ...routineB,
        'InitializeModule();',
      ].join('\n')),
      right: moduleFromSource('right', 'right', [
        'ModuleValue = 1;',
        ...routineB,
        ...routineA,
        'InitializeModule();',
      ].join('\n')),
    });

    assert.ok(readNonRoutineChange(movedElse), 'moving a Russian #Иначе branch changes conditional context');
    assert.strictEqual(readNonRoutineChange(reordered), undefined);
  });

  test('blocks only an added routine whose preprocessor context cannot be preserved by insertion', () => {
    const routine = ['Procedure Keep()', '  Value = 1;', 'EndProcedure'];
    const left = moduleFromSource('left', 'left', ['ModuleValue = 1;', ...routine].join('\n'));
    const right = moduleFromSource('right', 'right', [
      'ModuleValue = 1;',
      '#If Server Then',
      'Procedure Guarded()',
      '  Value = 2;',
      'EndProcedure',
      '#EndIf',
      ...routine,
    ].join('\n'));

    const result = diffBslModules({ left, right });
    const guarded = result.routines.find((item) => item.normalizedName === 'guarded');

    assert.strictEqual(result.canAutoMatch, true);
    assert.strictEqual(result.routines.find((item) => item.normalizedName === 'keep')?.status, 'unchanged');
    assert.ok(readNonRoutineChange(result));
    assert.match(readRoutineMergeBlockReason(guarded) ?? '', /условн/i);
  });

  test('fails closed for dangling conditional directives when adding a routine', () => {
    const base = moduleFromSource('left', 'left', [
      'Procedure Keep()',
      '  Value = 1;',
      'EndProcedure',
    ].join('\n'));
    const candidates = [
      [
        '#If Server Then',
        'Procedure Guarded()',
        '  Value = 2;',
        'EndProcedure',
      ],
      [
        '#Else',
        'Procedure Guarded()',
        '  Value = 2;',
        'EndProcedure',
        '#EndIf',
      ],
    ];

    for (const lines of candidates) {
      const right = moduleFromSource('right', 'right', lines.join('\n'));
      const result = diffBslModules({ left: base, right });
      const guarded = result.routines.find((item) => item.normalizedName === 'guarded');

      assert.strictEqual(result.canAutoMatch, true);
      assert.match(readRoutineMergeBlockReason(guarded) ?? '', /условн/i);
    }
  });

  test('recognizes #ElsIf as a distinct branch and fails closed for a dangling branch', () => {
    const routine = ['Procedure Keep()', '  Value = 1;', 'EndProcedure'];
    const ifContext = moduleFromSource('left', 'left', [
      '#If Server Then',
      ...routine,
      '#EndIf',
    ].join('\n'));
    const elsifContext = moduleFromSource('right', 'right', [
      '#If Server Then',
      '#ElsIf Client Then',
      ...routine,
      '#EndIf',
    ].join('\n'));
    const guardedRight = moduleFromSource('right', 'right', [
      '#ElsIf Client Then',
      'Procedure Guarded()',
      '  Value = 2;',
      'EndProcedure',
      '#EndIf',
      ...routine,
    ].join('\n'));
    const guardedResult = diffBslModules({
      left: moduleFromSource('left', 'left', routine.join('\n')),
      right: guardedRight,
    });
    const guarded = guardedResult.routines.find((item) => item.normalizedName === 'guarded');

    assert.notStrictEqual(
      ifContext.routineConditionalContextFingerprints?.[0],
      elsifContext.routineConditionalContextFingerprints?.[0]
    );
    assert.match(readRoutineMergeBlockReason(guarded) ?? '', /условн/i);
  });

  test('keeps body comments and attached routine directives in routine semantics', () => {
    const left = moduleFromSource('left', 'left', [
      '&AtClient',
      'Procedure Save()',
      '  // original comment',
      '  Value = 1;',
      'EndProcedure',
    ].join('\n'));
    const bodyCommentChanged = moduleFromSource('right', 'right', [
      '&AtClient',
      'Procedure Save()',
      '  // changed comment',
      '  Value = 1;',
      'EndProcedure',
    ].join('\n'));
    const directiveChanged = moduleFromSource('right', 'right', [
      '&AtServer',
      'Procedure Save()',
      '  // original comment',
      '  Value = 1;',
      'EndProcedure',
    ].join('\n'));

    assert.strictEqual(diffBslModules({ left, right: bodyCommentChanged }).routines[0]?.status, 'changed');
    assert.strictEqual(diffBslModules({ left, right: directiveChanged }).routines[0]?.status, 'changed');
    assert.strictEqual(readNonRoutineChange(diffBslModules({ left, right: directiveChanged })), undefined);
  });

  test('keeps ordered routine indices without scanning the right array per routine', () => {
    const routines = Array.from({ length: 400 }, (_, index) => [
      `Procedure Routine${index}()`,
      `  Value = ${index};`,
      'EndProcedure',
    ].join('\n'));
    const denseModule = [
      'ModuleGlobal = 1;',
      ...routines.flatMap((routine, index) => [routine, `// gap ${index}`]),
      'InitializeModule();',
    ].join('\n');
    const left = moduleFromSource('left', 'left', denseModule);
    const right = moduleFromSource('right', 'right', denseModule);
    for (const entry of [left, right]) {
      Object.defineProperty(entry.routines, 'indexOf', {
        value: () => {
          throw new Error('Routine diff must not scan routine arrays with indexOf.');
        },
      });
      Object.defineProperty(entry.routines, 'findIndex', {
        value: () => {
          throw new Error('Routine diff must not rescan routine arrays with findIndex.');
        },
      });
    }

    const result = diffBslModules({ left, right });

    assert.strictEqual(result.routines.length, 400);
    assert.strictEqual(readNonRoutineChange(result), undefined);
    assert.deepStrictEqual(
      result.routines.map((routine) => [routine.status, routine.leftIndex, routine.rightIndex]),
      routines.map((_, index) => ['unchanged', index, index])
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

  test('blocks a diff when one side defers analysis instead of emitting fake routine deletions', () => {
    const left = moduleFromSource(
      'left-source',
      'left',
      ['Procedure Keep()', '  Value = 1;', 'EndProcedure'].join('\n'),
    );
    const right = deferredModule(moduleFromSource(
      'right-source',
      'right',
      ['Procedure Keep()', '  Value = 1;', 'EndProcedure'].join('\n'),
    ));

    const result = diffBslModules({ left, right });

    assert.strictEqual(result.canAutoMatch, false);
    assert.deepStrictEqual(result.routines, []);
    assert.deepStrictEqual(result.summary, {
      added: 0,
      changed: 0,
      deleted: 0,
      reordered: 0,
      unchanged: 0,
    });
    assert.deepStrictEqual(result.diagnostics.map((diagnostic) => ({
      severity: diagnostic.severity,
      code: diagnostic.code,
      blocking: diagnostic.blocking,
      sourceId: diagnostic.sourceId,
      side: diagnostic.side,
      filePath: diagnostic.filePath,
      moduleId: diagnostic.moduleId,
    })), [{
      severity: 'error',
      code: 'BSL_MODULE_ANALYSIS_REQUIRED',
      blocking: true,
      sourceId: 'right-source',
      side: 'right',
      filePath: right.identity.filePath,
      moduleId: right.identity.moduleId,
    }]);
  });

  test('emits one blocking analysis-required diagnostic for each deferred input', () => {
    const left = deferredModule(moduleFromSource('left-source', 'left', ''));
    const right = deferredModule(moduleFromSource('right-source', 'right', ''));

    const result = diffBslModules({ left, right });

    assert.strictEqual(result.canAutoMatch, false);
    assert.deepStrictEqual(result.routines, []);
    assert.deepStrictEqual(result.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      blocking: diagnostic.blocking,
      sourceId: diagnostic.sourceId,
      side: diagnostic.side,
      filePath: diagnostic.filePath,
      moduleId: diagnostic.moduleId,
    })), [left, right].map((entry) => ({
      code: 'BSL_MODULE_ANALYSIS_REQUIRED',
      blocking: true,
      sourceId: entry.identity.sourceId,
      side: entry.identity.side,
      filePath: entry.identity.filePath,
      moduleId: entry.identity.moduleId,
    })));
  });

  test('indexes supported object and manager modules including CalculationRegister manager', async () => {
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
      [
        path.join(root, 'CalculationRegisters', 'Payroll', 'Ext', 'ManagerModule.bsl'),
        'CalculationRegister.Payroll.Manager',
      ],
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

  test('indexes every canonical non-Configuration standard module with its owner identity', async () => {
    const root = tempRoot();
    const owners = new Map(METADATA_TYPE_DESCRIPTORS.map((descriptor) => [descriptor.type, descriptor.designerFolder]));
    const source = ['Procedure Run()', '  Value = 1;', 'EndProcedure'].join('\n');
    const descriptors = METADATA_STANDARD_MODULE_DESCRIPTORS.filter(
      (descriptor) => descriptor.metadataType !== 'Configuration'
    );

    for (const [index, descriptor] of descriptors.entries()) {
      const ownerFolder = owners.get(descriptor.metadataType);
      assert.ok(ownerFolder, `${descriptor.metadataType} needs a canonical owner folder`);
      if (!ownerFolder) { continue; }
      const objectName = `RegistryOwner${index}`;
      const filePath = path.join(root, ownerFolder, objectName, 'Ext', descriptor.fileName);
      const result = await indexBslModuleFile({
        sourceId: 'left-source',
        side: 'left',
        filePath,
        configRoots: [root],
        source,
      });

      assert.deepStrictEqual(result.diagnostics, [], `${descriptor.metadataType}.${descriptor.kind}`);
      assert.strictEqual(result.modules.length, 1, `${descriptor.metadataType}.${descriptor.kind}`);
      const entry = result.modules[0]!;
      const idSuffix = descriptor.kind === 'ObjectModule'
        ? '.Object'
        : descriptor.kind === 'ManagerModule'
          ? '.Manager'
          : descriptor.kind === 'RecordSetModule'
            ? '.RecordSet'
            : descriptor.kind === 'ValueManagerModule'
              ? '.ValueManager'
              : '';
      const expectedId = descriptor.kind === 'CommonModule'
        ? `CommonModule.${objectName}`
        : `${descriptor.metadataType}.${objectName}${idSuffix}`;
      const expectedKind = descriptor.kind === 'CommonModule'
        ? 'CommonModule'
        : descriptor.kind.slice(0, -'Module'.length);

      assert.strictEqual(entry.identity.moduleId, expectedId, `${descriptor.metadataType}.${descriptor.kind}`);
      assert.strictEqual(entry.identity.moduleKind, expectedKind, `${descriptor.metadataType}.${descriptor.kind}`);
      assert.strictEqual(entry.routines.length, 1, `${descriptor.metadataType}.${descriptor.kind} must be deeply parsed`);
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

  test('indexes Constant ValueManagerModule with a parsed routine', async () => {
    const root = tempRoot();
    const result = await indexBslModuleFile({
      sourceId: 'left-source',
      side: 'left',
      filePath: path.join(root, 'Constants', 'ExchangeRate', 'Ext', 'ValueManagerModule.bsl'),
      configRoots: [root],
      source: ['Procedure Recalculate()', '  Value = 1;', 'EndProcedure'].join('\n'),
    });

    assert.deepStrictEqual(result.diagnostics, []);
    assert.strictEqual(result.modules[0]?.identity.moduleId, 'Constant.ExchangeRate.ValueManager');
    assert.strictEqual(result.modules[0]?.identity.moduleKind, 'ValueManager');
    assert.strictEqual(result.modules[0]?.routines.length, 1);
  });

  test('indexes CalculationRegister RecordSetModule with a parsed routine', async () => {
    const root = tempRoot();
    const result = await indexBslModuleFile({
      sourceId: 'left-source',
      side: 'left',
      filePath: path.join(
        root,
        'CalculationRegisters',
        'Payroll',
        'Ext',
        'RecordSetModule.bsl'
      ),
      configRoots: [root],
      source: ['Procedure Recalculate()', '  Value = 1;', 'EndProcedure'].join('\n'),
    });

    assert.deepStrictEqual(result.diagnostics, []);
    assert.strictEqual(result.modules[0]?.identity.moduleId, 'CalculationRegister.Payroll.RecordSet');
    assert.strictEqual(result.modules[0]?.identity.moduleKind, 'RecordSet');
    assert.strictEqual(result.modules[0]?.routines.length, 1);
  });

  test('keeps non-BSL Rights paths outside procedural diff', async () => {
    const root = tempRoot();
    const result = await indexBslModuleFile({
      sourceId: 'left-source',
      side: 'left',
      filePath: path.join(root, 'Roles', 'Approver', 'Ext', 'Rights.xml'),
      configRoots: [root],
      source: '<Rights />',
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

function deferredModule(entry: BslModuleIndexEntry): BslModuleIndexEntry {
  return {
    ...entry,
    routines: [],
    analysisState: 'deferred',
  } as unknown as BslModuleIndexEntry;
}

function readNonRoutineChange(result: unknown): { message: string } | undefined {
  return (result as { nonRoutineChange?: { message: string } }).nonRoutineChange;
}

function readRoutineMergeBlockReason(item: unknown): string | undefined {
  return (item as { mergeBlockReason?: string } | undefined)?.mergeBlockReason;
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
