import * as assert from 'assert';
import * as path from 'path';

import { indexBslModuleSource, type BslModuleIdentity } from '../../../src/compareMerge/bsl/bslModuleIndexer';
import { createBslRoutineLogicalMergePlan } from '../../../src/compareMerge/bsl/bslRoutineLogicalMerge';
import { validateBslRoutineLogicalMergePlan } from '../../../src/compareMerge/bsl/bslRoutineMergeExecutorGuard';
import type { BslRoutineLogicalMergePlan } from '../../../src/compareMerge/bsl/bslRoutineMergePlanTypes';

suite('BslRoutineMergeExecutorGuard', () => {
  test('does not block on full base body hash mismatch when anchors and interval are unchanged', () => {
    const plan = createPlan();
    const current = snapshot([
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
    ]);

    const result = validateBslRoutineLogicalMergePlan(plan, {
      moduleId: 'Catalog.Products.Object',
      current,
    });

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.diagnostics, []);
  });

  test('blocks target race inside anchored interval', () => {
    const plan = createPlan();
    const current = snapshot([
      'Procedure Run()',
      '  If A Then',
      '    A = 1;',
      '  EndIf;',
      '  // concurrent edit',
      '  If B Then',
      '    B = 1;',
      '  EndIf;',
      '  If C Then',
      '    C = 1;',
      '  EndIf;',
      'EndProcedure',
    ]);

    const result = validateBslRoutineLogicalMergePlan(plan, {
      moduleId: 'Catalog.Products.Object',
      current,
    });

    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(
      result.diagnostics.map((diagnostic) => diagnostic.reason),
      ['interval-material-changed']
    );
  });

  test('blocks current-side duplicate node anchor even when planned path still matches', () => {
    const plan = createPlan();
    const current = snapshot([
      'Procedure Run()',
      '  If A Then',
      '    A = 1;',
      '  EndIf;',
      '  If B Then',
      '    B = 1;',
      '  EndIf;',
      '  If B Then',
      '    B = 1;',
      '  EndIf;',
      '  If C Then',
      '    C = 1;',
      '  EndIf;',
      'EndProcedure',
    ]);

    const result = validateBslRoutineLogicalMergePlan(plan, {
      moduleId: 'Catalog.Products.Object',
      current,
    });

    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(
      result.diagnostics.map((diagnostic) => diagnostic.reason),
      ['ambiguous-anchor']
    );
  });

  test('blocks operation source text tampering while anchors remain valid', () => {
    const plan = createPlan();
    const operation = plan.operations[0];
    const tamperedPlan: BslRoutineLogicalMergePlan = {
      ...plan,
      operations: [
        {
          ...operation,
          sourceText: operation.sourceText.replace('NewValue = 1;', 'NewValue = 2;'),
        },
      ],
    };
    const current = snapshot([
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
    ]);

    const result = validateBslRoutineLogicalMergePlan(tamperedPlan, {
      moduleId: 'Catalog.Products.Object',
      current,
    });

    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(
      result.diagnostics.map((diagnostic) => diagnostic.reason),
      ['operation-source-text-changed']
    );
  });

  test('captures EOL style in plan metadata for later executor preservation', () => {
    const base = snapshot(
      [
        'Procedure Run()',
        '  If A Then',
        '    A = 1;',
        '  EndIf;',
        '  If B Then',
        '    B = 1;',
        '  EndIf;',
        'EndProcedure',
      ],
      '\r\n'
    );
    const incoming = snapshot(
      [
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
      '\r\n'
    );

    const plan = createBslRoutineLogicalMergePlan({
      moduleId: 'Catalog.Products.Object',
      base,
      current: base,
      incoming,
    });

    assert.strictEqual(plan.eol, '\r\n');
    assert.strictEqual(plan.operations[0].eol, '\r\n');
  });

  test('blocks operation provenance mismatch', () => {
    const plan = createPlan();
    const current = snapshot([
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
    ]);
    const cases: BslRoutineLogicalMergePlan[] = [
      {
        ...plan,
        operations: [{ ...plan.operations[0], moduleId: 'Document.Order.Object' }],
      },
      {
        ...plan,
        operations: [
          {
            ...plan.operations[0],
            routine: { ...plan.operations[0].routine, normalizedName: 'other' },
          },
        ],
      },
      {
        ...plan,
        operations: [{ ...plan.operations[0], eol: '\r\n' }],
      },
    ];

    for (const mismatchedPlan of cases) {
      const result = validateBslRoutineLogicalMergePlan(mismatchedPlan, {
        moduleId: 'Catalog.Products.Object',
        current,
      });

      assert.strictEqual(result.ok, false);
      assert.deepStrictEqual(
        result.diagnostics.map((diagnostic) => diagnostic.reason),
        ['operation-provenance-changed']
      );
    }
  });

  test('blocks manual plan with diagnostics and empty operations', () => {
    const plan: BslRoutineLogicalMergePlan = {
      ...createPlan(),
      status: 'manual',
      operations: [],
      diagnostics: [
        {
          reason: 'no-logical-insertion',
          message: 'No executable logical insertion was planned.',
        },
      ],
    };
    const current = snapshot([
      'Procedure Run()',
      '  If A Then',
      '    A = 1;',
      '  EndIf;',
      'EndProcedure',
    ]);

    const result = validateBslRoutineLogicalMergePlan(plan, {
      moduleId: 'Catalog.Products.Object',
      current,
    });

    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(
      result.diagnostics.map((diagnostic) => diagnostic.reason),
      ['plan-not-executable', 'no-logical-insertion']
    );
  });

  test('blocks operation section tampering while anchors remain valid', () => {
    const basePlan = createPlan();
    const plan: BslRoutineLogicalMergePlan = {
      ...basePlan,
      operations: [
        {
          ...basePlan.operations[0],
          sectionId: 'routine/body/if[0]/then[0]',
          parentPath: 'routine/body/if[0]',
        },
      ],
    };
    const current = snapshot([
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
    ]);

    const result = validateBslRoutineLogicalMergePlan(plan, {
      moduleId: 'Catalog.Products.Object',
      current,
    });

    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(
      result.diagnostics.map((diagnostic) => diagnostic.reason),
      ['operation-anchor-mismatch']
    );
  });

  test('blocks corrupted sentinel anchor kind', () => {
    const plan: BslRoutineLogicalMergePlan = {
      ...createPlan(),
      operations: [
        {
          ...createPlan().operations[0],
          startAnchor: {
            kind: 'sentinel',
            parentPath: 'routine',
            sectionId: 'routine/body',
            sentinel: 'invalid-sentinel',
          } as unknown as BslRoutineLogicalMergePlan['operations'][number]['startAnchor'],
        },
      ],
    };
    const current = snapshot([
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
    ]);

    const result = validateBslRoutineLogicalMergePlan(plan, {
      moduleId: 'Catalog.Products.Object',
      current,
    });

    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(
      result.diagnostics.map((diagnostic) => diagnostic.reason),
      ['invalid-anchor']
    );
  });

  test('blocks corrupted sentinel anchor roles for interval operation', () => {
    const basePlan = createPlan();
    const cases: BslRoutineLogicalMergePlan[] = [
      {
        ...basePlan,
        operations: [
          {
            ...basePlan.operations[0],
            startAnchor: {
              kind: 'sentinel',
              parentPath: 'routine',
              sectionId: 'routine/body',
              sentinel: 'section-end',
            },
          },
        ],
      },
      {
        ...basePlan,
        operations: [
          {
            ...basePlan.operations[0],
            endAnchor: {
              kind: 'sentinel',
              parentPath: 'routine',
              sectionId: 'routine/body',
              sentinel: 'section-start',
            },
          },
        ],
      },
    ];
    const current = snapshot([
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
    ]);

    for (const plan of cases) {
      const result = validateBslRoutineLogicalMergePlan(plan, {
        moduleId: 'Catalog.Products.Object',
        current,
      });

      assert.strictEqual(result.ok, false);
      assert.deepStrictEqual(
        result.diagnostics.map((diagnostic) => diagnostic.reason),
        ['invalid-anchor']
      );
    }
  });
});

function createPlan() {
  const base = snapshot([
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
  ]);
  const incoming = snapshot([
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
  ]);

  return createBslRoutineLogicalMergePlan({
    moduleId: 'Catalog.Products.Object',
    base,
    current: base,
    incoming,
  });
}

function snapshot(lines: string[], eol = '\n') {
  const source = lines.join(eol);
  const module = indexBslModuleSource({
    identity: makeIdentity(),
    source,
  });
  return {
    source,
    routine: module.routines[0],
  };
}

function makeIdentity(): BslModuleIdentity {
  return {
    sourceId: 'guard',
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
