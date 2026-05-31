import * as assert from 'assert';
import * as path from 'path';

import { CompareSession } from '../../../src/compareMerge/domain/compareSession';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import { predefinedXmlAdapter } from '../../../src/compareMerge/adapters/predefinedXmlAdapter';
import type { AdapterCompareInput } from '../../../src/compareMerge/adapters/mergeAdapter';
import { applyXmlPatch } from '../../../src/compareMerge/xml/xmlPatch';

suite('Predefined XML merge adapter', () => {
  test('matches predefined items by id then name and diffs item properties', async () => {
    const result = await predefinedXmlAdapter.compare(
      makeInput({
        left: [
          '<PredefinedData>',
          '  <Item id="main">',
          '    <Name>Main</Name>',
          '    <Presentation>Old main</Presentation>',
          '  </Item>',
          '  <Item>',
          '    <Name>ByName</Name>',
          '    <Presentation>Old named</Presentation>',
          '  </Item>',
          '</PredefinedData>',
        ].join('\n'),
        right: [
          '<PredefinedData>',
          '  <Item id="main">',
          '    <Name>MainRenamed</Name>',
          '    <Presentation>New main</Presentation>',
          '  </Item>',
          '  <Item>',
          '    <Name>ByName</Name>',
          '    <Presentation>New named</Presentation>',
          '  </Item>',
          '</PredefinedData>',
        ].join('\n'),
      })
    );

    const main = requireNodeByLabel(result.nodes, 'MainRenamed');
    const mainPresentation = requireNodeByLabel(main.children, 'Presentation');
    const byName = requireNodeByLabel(result.nodes, 'ByName');
    const byNamePresentation = requireNodeByLabel(byName.children, 'Presentation');

    assert.strictEqual(main.kind, 'predefinedItem');
    assert.strictEqual(mainPresentation.leftValue, 'Old main');
    assert.strictEqual(mainPresentation.rightValue, 'New main');
    assert.strictEqual(byNamePresentation.leftValue, 'Old named');
    assert.strictEqual(byNamePresentation.rightValue, 'New named');
    assert.strictEqual(mainPresentation.mergeable, true);
    assert.strictEqual(byNamePresentation.mergeable, true);
    assert.ok(result.candidateFactories.has(mainPresentation.id));
    assert.ok(result.candidateFactories.has(byNamePresentation.id));
  });

  test('builds executable left-only predefined item subtree candidate', async () => {
    const left = [
      '<PredefinedData>',
      '  <Item id="old">',
      '    <Name>OldItem</Name>',
      '    <Presentation>Removed</Presentation>',
      '  </Item>',
      '</PredefinedData>',
    ].join('\n');
    const result = await predefinedXmlAdapter.compare(
      makeInput({
        left,
        right: '<PredefinedData></PredefinedData>',
      })
    );

    const item = requireNodeByLabel(result.nodes, 'OldItem');

    assert.strictEqual(item.kind, 'predefinedItem');
    assert.strictEqual(item.status, 'leftOnly');
    assert.strictEqual(item.mergeable, true);
    assert.strictEqual(item.destructive, true);
    assert.ok(result.candidateFactories.has(item.id));

    const candidateResult = await result.candidateFactories.get(item.id)!();
    assert.strictEqual(candidateResult.ok, true);
    const applied = applyXmlPatch(left, candidateResult.candidate.xmlPatch!);
    assert.doesNotMatch(applied, /<Item id="old">/);
  });
});

function makeInput(snapshots: { left: string; right: string }): AdapterCompareInput {
  return {
    strategy: 'full',
    leftInventory: { rootPath: 'left', objects: [], artifactsByObjectId: new Map() },
    rightInventory: { rootPath: 'right', objects: [], artifactsByObjectId: new Map() },
    match: {
      left: metadataObject('left-object', path.join('left', 'Catalogs', 'Products.xml'), 'left'),
      right: metadataObject('right-object', path.join('right', 'Catalogs', 'Products.xml'), 'right'),
    },
    session: makeSession(),
    snapshots,
  };
}

function metadataObject(objectId: string, descriptorPath: string, containerPath: string) {
  return {
    objectId,
    qualifiedName: 'Catalog.Products',
    metadataType: 'Catalog',
    descriptorPath,
    containerPath,
  };
}

function makeSession(): CompareSession {
  const session = CompareSession.create({
    sessionId: 'session-1',
    createdAt: '2026-05-30T10:00:00.000Z',
    sources: [
      {
        sourceId: 'left-source',
        side: 'left',
        kind: 'workspace',
        displayName: 'Left',
        rootUri: 'file:///left',
        writable: true,
      },
      {
        sourceId: 'right-source',
        side: 'right',
        kind: 'file',
        displayName: 'Right',
        rootUri: 'file:///right',
        writable: false,
      },
    ],
  });
  session.registerSnapshot(snapshot('left-source', 'left'));
  session.registerSnapshot(snapshot('right-source', 'right'));
  return session;
}

function snapshot(sourceId: string, side: 'left' | 'right') {
  return {
    snapshotId: `snapshot-${side}`,
    sourceId,
    snapshotRoot: `file:///${side}`,
    origin: `file:///${side}`,
    createdAt: '2026-05-30T10:00:00.000Z',
    retentionUntil: '2026-05-30T12:00:00.000Z',
    sourceRevision: side,
    readOnly: side === 'right',
    cleanupPolicy: 'manual' as const,
    contentHash: side,
  };
}

function requireNodeByLabel(nodes: readonly CompareTreeNode[], label: string): CompareTreeNode {
  const found = collectNodes(nodes, (node) => node.label === label);
  assert.strictEqual(found.length, 1, `Expected exactly one node with label ${label}.`);
  return found[0]!;
}

function collectNodes(
  nodes: readonly CompareTreeNode[],
  predicate: (node: CompareTreeNode) => boolean
): CompareTreeNode[] {
  const found: CompareTreeNode[] = [];
  for (const node of nodes) {
    visit(node, predicate, found);
  }
  return found;
}

function visit(
  node: CompareTreeNode,
  predicate: (node: CompareTreeNode) => boolean,
  found: CompareTreeNode[]
): void {
  if (predicate(node)) {
    found.push(node);
  }
  for (const child of node.children) {
    visit(child, predicate, found);
  }
}
