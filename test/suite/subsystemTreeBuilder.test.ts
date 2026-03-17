import * as assert from 'assert';
import { TreeNode, MetadataType } from '../../src/models/treeNode';
import { buildSubsystemTree } from '../../src/parsers/subsystemTreeBuilder';
import { Logger } from '../../src/utils/logger';

suite('subsystemTreeBuilder', () => {
  test('buildSubsystemTree assigns path-based id and only roots to rootParent', () => {
    const rootParent: TreeNode = {
      id: 'Subsystems',
      name: 'Subsystems',
      type: MetadataType.Subsystem,
      properties: { type: 'Subsystems' },
      children: [],
    };
    const a: TreeNode = {
      id: 'x',
      name: 'A',
      type: MetadataType.Subsystem,
      properties: {},
      children: [],
    };
    const b: TreeNode = {
      id: 'y',
      name: 'B',
      type: MetadataType.Subsystem,
      properties: { parentSubsystemRef: 'A' },
      children: [],
    };
    buildSubsystemTree([a, b], rootParent);

    assert.strictEqual(a.id, 'Subsystems.A');
    assert.strictEqual(b.id, 'Subsystems.A.B');
    assert.strictEqual(rootParent.children?.length, 1);
    assert.strictEqual(rootParent.children?.[0], a);
    assert.strictEqual(a.children?.length, 1);
    assert.strictEqual(a.children?.[0], b);
    assert.strictEqual(b.parent, a);
    assert.strictEqual(a.parent, rootParent);
  });

  test('buildSubsystemTree disambiguates duplicate parent names by filePath ref', () => {
    const rootParent: TreeNode = {
      id: 'Subsystems',
      name: 'Subsystems',
      type: MetadataType.Subsystem,
      properties: {},
      children: [],
    };

    const parent1: TreeNode = {
      id: 'p1',
      name: 'P',
      type: MetadataType.Subsystem,
      properties: {},
      children: [],
      filePath: 'C:\\cfg\\Subsystems\\P.xml',
    };
    const parent2: TreeNode = {
      id: 'p2',
      name: 'P',
      type: MetadataType.Subsystem,
      properties: {},
      children: [],
      filePath: 'C:\\cfg\\Subsystems\\Other\\P.xml',
    };
    const child: TreeNode = {
      id: 'c',
      name: 'Child',
      type: MetadataType.Subsystem,
      properties: { parentSubsystemRef: { filePath: parent2.filePath } },
      children: [],
      filePath: 'C:\\cfg\\Subsystems\\Other\\P\\Subsystems\\Child.xml',
    };

    buildSubsystemTree([parent1, parent2, child], rootParent);

    assert.strictEqual(child.parent, parent2);
    assert.ok((parent2.children ?? []).includes(child));
    assert.ok(!(parent1.children ?? []).includes(child));
  });

  test('buildSubsystemTree preserves non-subsystem children on subsystem nodes', () => {
    const rootParent: TreeNode = {
      id: 'Subsystems',
      name: 'Subsystems',
      type: MetadataType.Subsystem,
      properties: {},
      children: [],
    };
    const parent: TreeNode = {
      id: 'p',
      name: 'Parent',
      type: MetadataType.Subsystem,
      properties: {},
      children: [
        {
          id: 'Forms',
          name: 'Forms',
          type: MetadataType.Form,
          properties: {},
          children: [],
        },
      ],
    };
    const child: TreeNode = {
      id: 'c',
      name: 'Child',
      type: MetadataType.Subsystem,
      properties: { parentSubsystemRef: 'Parent' },
      children: [],
    };

    buildSubsystemTree([parent, child], rootParent);

    const children = parent.children ?? [];
    assert.ok(children.some((c) => c.type === MetadataType.Form), 'expected non-subsystem child to be preserved');
    assert.ok(children.some((c) => c.type === MetadataType.Subsystem && c.name === 'Child'));
  });

  test('buildSubsystemTree breaks cycles and keeps roots non-empty (logs warning)', () => {
    const rootParent: TreeNode = {
      id: 'Subsystems',
      name: 'Subsystems',
      type: MetadataType.Subsystem,
      properties: {},
      children: [],
    };
    const a: TreeNode = {
      id: 'a',
      name: 'A',
      type: MetadataType.Subsystem,
      properties: { parentSubsystemRef: 'B' },
      children: [],
    };
    const b: TreeNode = {
      id: 'b',
      name: 'B',
      type: MetadataType.Subsystem,
      properties: { parentSubsystemRef: 'A' },
      children: [],
    };

    let warnCount = 0;
    const origWarn = Logger.warn;
    try {
      Logger.warn = ((message: string, ..._args: unknown[]) => {
        if (message.toLowerCase().includes('cycle')) warnCount += 1;
      }) as unknown as typeof Logger.warn;

      buildSubsystemTree([a, b], rootParent);

      assert.ok((rootParent.children ?? []).length > 0, 'roots must be non-empty');
      assert.ok(warnCount > 0, 'expected cycle warning');
    } finally {
      Logger.warn = origWarn;
    }
  });

  test('buildSubsystemTree with no parentRef yields single root', () => {
    const rootParent: TreeNode = {
      id: 'Subsystems',
      name: 'Subsystems',
      type: MetadataType.Subsystem,
      properties: {},
      children: [],
    };
    const a: TreeNode = {
      id: 'x',
      name: 'Only',
      type: MetadataType.Subsystem,
      properties: {},
      children: [],
    };
    buildSubsystemTree([a], rootParent);

    assert.strictEqual(a.id, 'Subsystems.Only');
    assert.strictEqual(rootParent.children?.length, 1);
    assert.strictEqual(rootParent.children?.[0], a);
  });

  test('buildSubsystemTree orders subsystem children by childSubsystemNames (ChildObjects order)', () => {
    const rootParent: TreeNode = {
      id: 'Subsystems',
      name: 'Subsystems',
      type: MetadataType.Subsystem,
      properties: {},
      children: [],
    };
    const parent: TreeNode = {
      id: 'p',
      name: 'Parent',
      type: MetadataType.Subsystem,
      properties: {
        childSubsystemNames: ['Third', 'First', 'Second'],
      },
      children: [],
    };
    const first: TreeNode = {
      id: 'f',
      name: 'First',
      type: MetadataType.Subsystem,
      properties: { parentSubsystemRef: 'Parent' },
      children: [],
    };
    const second: TreeNode = {
      id: 's',
      name: 'Second',
      type: MetadataType.Subsystem,
      properties: { parentSubsystemRef: 'Parent' },
      children: [],
    };
    const third: TreeNode = {
      id: 't',
      name: 'Third',
      type: MetadataType.Subsystem,
      properties: { parentSubsystemRef: 'Parent' },
      children: [],
    };
    buildSubsystemTree([parent, first, second, third], rootParent);

    const subs = (parent.children ?? []).filter((c) => c.type === MetadataType.Subsystem);
    assert.strictEqual(subs.length, 3);
    assert.strictEqual(subs[0].name, 'Third');
    assert.strictEqual(subs[1].name, 'First');
    assert.strictEqual(subs[2].name, 'Second');
  });
});
