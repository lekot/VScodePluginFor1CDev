import * as assert from 'assert';
import * as path from 'path';

import { indexBslModuleSource, type BslModuleIdentity } from '../../../src/compareMerge/bsl/bslModuleIndexer';
import { createBslRoutineLogicalMergePlan } from '../../../src/compareMerge/bsl/bslRoutineLogicalMerge';

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
