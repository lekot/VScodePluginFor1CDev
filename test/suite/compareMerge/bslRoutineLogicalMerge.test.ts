import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { buildConfigurationCompare } from '../../../src/compareMerge/configurationCompareService';
import { indexBslModuleSource, type BslModuleIdentity } from '../../../src/compareMerge/bsl/bslModuleIndexer';
import { createBslRoutineLogicalMergePlan } from '../../../src/compareMerge/bsl/bslRoutineLogicalMerge';
import { createMergeMutationTestRuntime } from './mergeMutationTestSupport';

suite('BslRoutineLogicalMerge', () => {
  test('plans safe inserted supported block between unchanged anchors as auto', () => {
    const plan = planFor({
      base: [
        'Procedure Run()',
        '  If A Then',
        '    A = 1;',
        '  EndIf;',
        '  If B Then',
        '    B = 1;',
        '  EndIf;',
        'EndProcedure',
      ],
      incoming: [
        'Procedure Run()',
        '  If A Then',
        '    A = 1;',
        '  EndIf;',
        '  Try',
        '    C = 1;',
        '  Except',
        '    C = 0;',
        '  EndTry;',
        '  If B Then',
        '    B = 1;',
        '  EndIf;',
        'EndProcedure',
      ],
    });

    assert.strictEqual(plan.status, 'auto');
    assert.strictEqual(plan.operations.length, 1);
    assert.strictEqual(plan.operations[0].kind, 'insertBlock');
    assert.strictEqual(plan.operations[0].sourceText.includes('Try'), true);
    assert.strictEqual(plan.operations[0].startAnchor.kind, 'node');
    assert.strictEqual(plan.operations[0].endAnchor.kind, 'node');
  });

  test('uses sentinels for insertion at routine start and end', () => {
    const start = planFor({
      base: [
        'Procedure Run()',
        '  If A Then',
        '    A = 1;',
        '  EndIf;',
        'EndProcedure',
      ],
      incoming: [
        'Procedure Run()',
        '  Try',
        '    Before = 1;',
        '  Except',
        '    Before = 0;',
        '  EndTry;',
        '  If A Then',
        '    A = 1;',
        '  EndIf;',
        'EndProcedure',
      ],
    });
    const end = planFor({
      base: [
        'Procedure Run()',
        '  If A Then',
        '    A = 1;',
        '  EndIf;',
        'EndProcedure',
      ],
      incoming: [
        'Procedure Run()',
        '  If A Then',
        '    A = 1;',
        '  EndIf;',
        '  Try',
        '    After = 1;',
        '  Except',
        '    After = 0;',
        '  EndTry;',
        'EndProcedure',
      ],
    });

    assert.strictEqual(start.status, 'auto');
    assert.strictEqual(start.operations[0].startAnchor.kind, 'sentinel');
    assert.strictEqual(start.operations[0].startAnchor.sentinel, 'section-start');
    assert.strictEqual(end.status, 'auto');
    assert.strictEqual(end.operations[0].endAnchor.kind, 'sentinel');
    assert.strictEqual(end.operations[0].endAnchor.sentinel, 'section-end');
  });

  test('keeps changed existing statement manual', () => {
    const plan = planFor({
      base: ['Procedure Run()', '  A = 1;', 'EndProcedure'],
      incoming: ['Procedure Run()', '  A = 2;', 'EndProcedure'],
    });

    assert.strictEqual(plan.status, 'manual');
    assert.deepStrictEqual(
      plan.diagnostics.map((diagnostic) => diagnostic.reason),
      ['changed-existing-node']
    );
  });

  test('keeps changed existing block header and body manual', () => {
    const header = planFor({
      base: [
        'Procedure Run()',
        '  If A Then',
        '    Value = 1;',
        '  EndIf;',
        'EndProcedure',
      ],
      incoming: [
        'Procedure Run()',
        '  If B Then',
        '    Value = 1;',
        '  EndIf;',
        'EndProcedure',
      ],
    });
    const body = planFor({
      base: [
        'Procedure Run()',
        '  If A Then',
        '    Value = 1;',
        '  EndIf;',
        'EndProcedure',
      ],
      incoming: [
        'Procedure Run()',
        '  If A Then',
        '    Value = 2;',
        '  EndIf;',
        'EndProcedure',
      ],
    });

    assert.strictEqual(header.status, 'manual');
    assert.strictEqual(body.status, 'manual');
  });

  test('keeps ambiguous duplicate anchors manual', () => {
    const plan = planFor({
      base: [
        'Procedure Run()',
        '  If A Then',
        '    Value = 1;',
        '  EndIf;',
        '  If A Then',
        '    Value = 1;',
        '  EndIf;',
        'EndProcedure',
      ],
      incoming: [
        'Procedure Run()',
        '  If A Then',
        '    Value = 1;',
        '  EndIf;',
        '  Try',
        '    NewValue = 1;',
        '  Except',
        '    NewValue = 0;',
        '  EndTry;',
        '  If A Then',
        '    Value = 1;',
        '  EndIf;',
        'EndProcedure',
      ],
    });

    assert.strictEqual(plan.status, 'manual');
    assert.deepStrictEqual(
      plan.diagnostics.map((diagnostic) => diagnostic.reason),
      ['ambiguous-anchor']
    );
  });

  test('keeps statement group beside insertion manual', () => {
    const plan = planFor({
      base: ['Procedure Run()', '  A = 1;', 'EndProcedure'],
      incoming: [
        'Procedure Run()',
        '  A = 1;',
        '  Try',
        '    B = 1;',
        '  Except',
        '    B = 0;',
        '  EndTry;',
        'EndProcedure',
      ],
    });

    assert.strictEqual(plan.status, 'manual');
    assert.deepStrictEqual(
      plan.diagnostics.map((diagnostic) => diagnostic.reason),
      ['statement-group-anchor']
    );
  });

  test('allows unrelated target change outside anchored interval', () => {
    const plan = planFor({
      base: [
        'Procedure Run()',
        '  If A Then',
        '    A = 1;',
        '  EndIf;',
        '  If B Then',
        '    B = 1;',
        '  EndIf;',
        '  If C Then',
        '    C = 1;',
        '  EndIf;',
        'EndProcedure',
      ],
      current: [
        'Procedure Run()',
        '  If A Then',
        '    A = 1;',
        '  EndIf;',
        '  If B Then',
        '    B = 1;',
        '  EndIf;',
        '  If C Then',
        '    C = 2;',
        '  EndIf;',
        'EndProcedure',
      ],
      incoming: [
        'Procedure Run()',
        '  If A Then',
        '    A = 1;',
        '  EndIf;',
        '  Try',
        '    NewValue = 1;',
        '  Except',
        '    NewValue = 0;',
        '  EndTry;',
        '  If B Then',
        '    B = 1;',
        '  EndIf;',
        '  If C Then',
        '    C = 1;',
        '  EndIf;',
        'EndProcedure',
      ],
    });

    assert.strictEqual(plan.status, 'auto');
    assert.strictEqual(plan.operations.length, 1);
  });

  test('executes a healthy routine insertion against the original target when module globals also differ', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bsl-logical-module-content-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const targetModulePath = path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const sourceModulePath = path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const targetSource = ['ModuleGlobal = "target";', '', logicalBaseRoutine()].join('\n');
    const incomingSource = [
      'ModuleGlobal = "incoming";',
      '',
      logicalIncomingRoutine(),
      '',
      '#Если Сервер Тогда',
      'Procedure GuardedAddition()',
      '  Value = 41;',
      'EndProcedure',
      '#КонецЕсли',
      '',
      'Procedure HealthyAddition()',
      '  Value = 42;',
      'EndProcedure',
    ].join('\n');
    let workspace: Awaited<ReturnType<typeof buildConfigurationCompare>>['workspace'] | undefined;
    let runtime: Awaited<ReturnType<typeof createMergeMutationTestRuntime>> | undefined;

    try {
      await writeCatalogFixture(leftRoot);
      await writeCatalogFixture(rightRoot);
      await fs.mkdir(path.dirname(targetModulePath), { recursive: true });
      await fs.mkdir(path.dirname(sourceModulePath), { recursive: true });
      await fs.writeFile(targetModulePath, targetSource, 'utf8');
      await fs.writeFile(sourceModulePath, incomingSource, 'utf8');
      runtime = await createMergeMutationTestRuntime(leftRoot);

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
        mutationEngine: runtime.engine,
        configurationId: runtime.configurationId,
      });
      workspace = result.workspace;

      const moduleContent = findNode(workspace.payload.root, 'bsl:module-content:Catalog.Products.Object');
      const routineId = 'bsl:routine:Catalog.Products.Object:run';
      const guardedId = 'bsl:routine:Catalog.Products.Object:guardedaddition';
      const guardedRoutine = findNode(workspace.payload.root, guardedId);
      assert.ok(moduleContent, 'different module globals must stay visible as a module-content conflict');
      assert.strictEqual(moduleContent.mergeable, false);
      assert.strictEqual(moduleContent.conflict?.blocking, true);
      assert.ok(workspace.listMergeableNodeIds().includes(routineId));
      assert.ok(workspace.listMergeableNodeIds().includes('bsl:routine:Catalog.Products.Object:healthyaddition'));
      assert.ok(guardedRoutine, 'guarded routine remains visible for manual review');
      assert.strictEqual(guardedRoutine.mergeable, false);
      assert.match(guardedRoutine.conflict?.message ?? '', /условн/i);
      assert.ok(!workspace.listMergeableNodeIds().includes(guardedId));

      const guardedPreview = await workspace.createPreviewForNodeIds([guardedId]);
      assert.strictEqual(guardedPreview.ok, false);

      const preview = await workspace.createPreviewForNodeIds([routineId]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      const approval = workspace.approvePreview(preview.preview.previewId);
      assert.strictEqual(approval.ok, true, JSON.stringify(approval));
      const execution = await workspace.executeApprovedPreview(preview.preview.previewId);

      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      const mergedTarget = await fs.readFile(targetModulePath, 'utf8');
      assert.ok(mergedTarget.includes('ModuleGlobal = "target";'));
      assert.ok(!mergedTarget.includes('ModuleGlobal = "incoming";'));
      assert.ok(mergedTarget.includes('A = 1;'));
      assert.ok(mergedTarget.includes('B = 1;'));
      assert.ok(mergedTarget.includes('C = 1;'));
    } finally {
      workspace?.dispose();
      await runtime?.coordinator.dispose();
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('keeps current routine identity mismatch manual', () => {
    const plan = planFor({
      base: [
        'Procedure Run()',
        '  If A Then',
        '    A = 1;',
        '  EndIf;',
        'EndProcedure',
      ],
      current: [
        'Procedure Other()',
        '  If A Then',
        '    A = 1;',
        '  EndIf;',
        'EndProcedure',
      ],
      incoming: [
        'Procedure Run()',
        '  Try',
        '    Before = 1;',
        '  Except',
        '    Before = 0;',
        '  EndTry;',
        '  If A Then',
        '    A = 1;',
        '  EndIf;',
        'EndProcedure',
      ],
    });

    assert.strictEqual(plan.status, 'manual');
    assert.deepStrictEqual(
      plan.diagnostics.map((diagnostic) => diagnostic.reason),
      ['routine-identity-changed']
    );
  });

  test('keeps routine signature export and directive mismatches manual', () => {
    const cases: PlanFixture[] = [
      {
        base: ['Procedure Run()', '  If A Then', '    A = 1;', '  EndIf;', 'EndProcedure'],
        incoming: [
          'Procedure Run(Value)',
          '  Try',
          '    Before = 1;',
          '  Except',
          '    Before = 0;',
          '  EndTry;',
          '  If A Then',
          '    A = 1;',
          '  EndIf;',
          'EndProcedure',
        ],
      },
      {
        base: ['Procedure Run()', '  If A Then', '    A = 1;', '  EndIf;', 'EndProcedure'],
        incoming: [
          'Procedure Run() Export',
          '  Try',
          '    Before = 1;',
          '  Except',
          '    Before = 0;',
          '  EndTry;',
          '  If A Then',
          '    A = 1;',
          '  EndIf;',
          'EndProcedure',
        ],
      },
      {
        base: ['Procedure Run()', '  If A Then', '    A = 1;', '  EndIf;', 'EndProcedure'],
        incoming: [
          '&AtClient',
          'Procedure Run()',
          '  Try',
          '    Before = 1;',
          '  Except',
          '    Before = 0;',
          '  EndTry;',
          '  If A Then',
          '    A = 1;',
          '  EndIf;',
          'EndProcedure',
        ],
      },
      {
        base: ['Procedure Run()', '  If A Then', '    A = 1;', '  EndIf;', 'EndProcedure'],
        current: [
          '&AtClient',
          'Procedure Run()',
          '  If A Then',
          '    A = 1;',
          '  EndIf;',
          'EndProcedure',
        ],
        incoming: [
          'Procedure Run()',
          '  Try',
          '    Before = 1;',
          '  Except',
          '    Before = 0;',
          '  EndTry;',
          '  If A Then',
          '    A = 1;',
          '  EndIf;',
          'EndProcedure',
        ],
      },
    ];

    for (const fixture of cases) {
      const plan = planFor(fixture);

      assert.strictEqual(plan.status, 'manual');
      assert.deepStrictEqual(
        plan.diagnostics.map((diagnostic) => diagnostic.reason),
        ['routine-identity-changed']
      );
      assert.deepStrictEqual(plan.operations, []);
    }
  });
});

interface PlanFixture {
  base: string[];
  current?: string[];
  incoming: string[];
}

function planFor(fixture: PlanFixture) {
  const base = snapshot(fixture.base);
  const current = snapshot(fixture.current ?? fixture.base);
  const incoming = snapshot(fixture.incoming);
  return createBslRoutineLogicalMergePlan({
    moduleId: 'Catalog.Products.Object',
    base,
    current,
    incoming,
  });
}

function snapshot(lines: string[]) {
  const source = lines.join('\n');
  const module = indexBslModuleSource({
    identity: makeIdentity(),
    source,
  });
  return {
    source,
    routine: module.routines[0],
  };
}

async function writeCatalogFixture(root: string): Promise<void> {
  const descriptor = path.join(root, 'Catalogs', 'Products.xml');
  await fs.mkdir(path.dirname(descriptor), { recursive: true });
  await fs.writeFile(
    descriptor,
    '<MetaDataObject><Catalog uuid="catalog-products"><Properties><Name>Products</Name></Properties></Catalog></MetaDataObject>',
    'utf8'
  );
}

function logicalBaseRoutine(): string {
  return [
    'Procedure Run()',
    '  If A Then',
    '    A = 1;',
    '  EndIf;',
    '  If B Then',
    '    B = 1;',
    '  EndIf;',
    'EndProcedure',
  ].join('\n');
}

function logicalIncomingRoutine(): string {
  return [
    'Procedure Run()',
    '  If A Then',
    '    A = 1;',
    '  EndIf;',
    '  Try',
    '    C = 1;',
    '  Except',
    '    C = 0;',
    '  EndTry;',
    '  If B Then',
    '    B = 1;',
    '  EndIf;',
    'EndProcedure',
  ].join('\n');
}

function findNode<T extends { id: string; children: T[] }>(root: T, id: string): T | undefined {
  if (root.id === id) {
    return root;
  }
  for (const child of root.children) {
    const found = findNode(child, id);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function makeIdentity(): BslModuleIdentity {
  return {
    sourceId: 'merge',
    side: 'left',
    filePath: path.join('root', 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl'),
    configRoot: 'root',
    metadataType: 'Catalog',
    objectName: 'Products',
    moduleKind: 'Object',
    moduleId: 'Catalog.Products.Object',
    displayName: 'Catalog.Products.Object',
  };
}
