import * as assert from 'assert';
import * as path from 'path';

import { CompareSession } from '../../../src/compareMerge/domain/compareSession';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import { formXmlAdapter } from '../../../src/compareMerge/adapters/formXmlAdapter';
import type { AdapterCompareInput } from '../../../src/compareMerge/adapters/mergeAdapter';
import { applyXmlPatch } from '../../../src/compareMerge/xml/xmlPatch';

suite('Form XML merge adapter', () => {
  test('groups form item property diffs under known form sections', async () => {
    const result = await formXmlAdapter.compare(
      makeInput({
        left: [
          '<Form>',
          '  <ChildItems>',
          '    <Item>',
          '      <Name>ItemsTable</Name>',
          '      <Title>Old title</Title>',
          '    </Item>',
          '  </ChildItems>',
          '</Form>',
        ].join('\n'),
        right: [
          '<Form>',
          '  <ChildItems>',
          '    <Item>',
          '      <Name>ItemsTable</Name>',
          '      <Title>New title</Title>',
          '    </Item>',
          '  </ChildItems>',
          '</Form>',
        ].join('\n'),
      })
    );

    const group = requireNodeByLabel(result.nodes, 'ChildItems');
    const item = requireNodeByLabel(group.children, 'ItemsTable');
    const title = requireNodeByLabel(item.children, 'Title');

    assert.strictEqual(group.kind, 'formGroup');
    assert.strictEqual(item.kind, 'formItem');
    assert.strictEqual(title.kind, 'xmlProperty');
    assert.strictEqual(title.status, 'changed');
    assert.strictEqual(title.leftValue, 'Old title');
    assert.strictEqual(title.rightValue, 'New title');
    assert.strictEqual(title.mergeable, true);
    assert.ok(result.candidateFactories.has(title.id));
  });

  test('builds executable right-only form item subtree candidate', async () => {
    const left = '<Form><ChildItems></ChildItems></Form>';
    const result = await formXmlAdapter.compare(
      makeInput({
        left,
        right: [
          '<Form>',
          '  <ChildItems>',
          '    <Item id="new">',
          '      <Name>NewItem</Name>',
          '      <Title>Created</Title>',
          '    </Item>',
          '  </ChildItems>',
          '</Form>',
        ].join('\n'),
      })
    );

    const item = requireNodeByLabel(result.nodes, 'NewItem');

    assert.strictEqual(item.kind, 'formItem');
    assert.strictEqual(item.status, 'rightOnly');
    assert.strictEqual(item.mergeable, true);
    assert.ok(result.candidateFactories.has(item.id));

    const candidateResult = await result.candidateFactories.get(item.id)!();
    assert.strictEqual(candidateResult.ok, true);
    const applied = applyXmlPatch(left, candidateResult.candidate.xmlPatch!);
    assert.match(applied, /<Item id="new"><Name>NewItem<\/Name><Title>Created<\/Title><\/Item>/);
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
