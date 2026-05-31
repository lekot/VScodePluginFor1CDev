import * as assert from 'assert';
import * as path from 'path';

import { CompareSession } from '../../../src/compareMerge/domain/compareSession';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import { metadataXmlAdapter } from '../../../src/compareMerge/adapters/xmlMetadataAdapter';
import type { AdapterCompareInput } from '../../../src/compareMerge/adapters/mergeAdapter';
import { buildCompareTreeProjection } from '../../../src/compareMerge/projection/compareTreeProjection';
import { applyXmlPatch } from '../../../src/compareMerge/xml/xmlPatch';

suite('Metadata XML merge adapter', () => {
  test('builds mergeable descriptor property diff and projection keeps adapter nodes', async () => {
    const result = await metadataXmlAdapter.compare(
      makeInput({
        left: [
          '<MetaDataObject>',
          '  <Properties>',
          '    <Name>Products</Name>',
          '    <Synonym>Old goods</Synonym>',
          '  </Properties>',
          '</MetaDataObject>',
        ].join('\n'),
        right: [
          '<MetaDataObject>',
          '  <Properties>',
          '    <Name>Products</Name>',
          '    <Synonym>New goods</Synonym>',
          '  </Properties>',
          '</MetaDataObject>',
        ].join('\n'),
      })
    );

    const synonym = requireNodeByLabel(result.nodes, 'Synonym');

    assert.strictEqual(synonym.kind, 'xmlProperty');
    assert.strictEqual(synonym.status, 'changed');
    assert.strictEqual(synonym.leftValue, 'Old goods');
    assert.strictEqual(synonym.rightValue, 'New goods');
    assert.strictEqual(synonym.mergeable, true);
    assert.ok(synonym.payloadRef);
    assert.ok(result.candidateFactories.has(synonym.id));
    const candidateResult = await result.candidateFactories.get(synonym.id)!();
    assert.strictEqual(candidateResult.ok, true);
    assert.strictEqual((candidateResult.candidate as { xmlPatch?: { kind: string } }).xmlPatch?.kind, 'replaceNode');

    const projection = buildCompareTreeProjection({ adapterResults: [result] });
    assert.ok(requireNodeByLabel(projection.root.children, 'Synonym'));
  });

  test('filters left-only and right-only XML properties by join strategy', async () => {
    const leftOnly = await metadataXmlAdapter.compare(
      makeInput(
        {
          left: [
            '<MetaDataObject>',
            '  <Properties>',
            '    <Name>Products</Name>',
            '    <LocalOnly>1</LocalOnly>',
            '  </Properties>',
            '</MetaDataObject>',
          ].join('\n'),
          right: [
            '<MetaDataObject>',
            '  <Properties>',
            '    <Name>Products</Name>',
            '    <RightOnly>1</RightOnly>',
            '  </Properties>',
            '</MetaDataObject>',
          ].join('\n'),
        },
        'left'
      )
    );
    const rightOnly = await metadataXmlAdapter.compare(
      makeInput(
        {
          left: [
            '<MetaDataObject>',
            '  <Properties>',
            '    <Name>Products</Name>',
            '    <LocalOnly>1</LocalOnly>',
            '  </Properties>',
            '</MetaDataObject>',
          ].join('\n'),
          right: [
            '<MetaDataObject>',
            '  <Properties>',
            '    <Name>Products</Name>',
            '    <RightOnly>1</RightOnly>',
            '  </Properties>',
            '</MetaDataObject>',
          ].join('\n'),
        },
        'right'
      )
    );

    assert.ok(requireNodeByLabel(leftOnly.nodes, 'LocalOnly'));
    assert.strictEqual(findNodeByLabel(leftOnly.nodes, 'RightOnly'), undefined);
    assert.ok(requireNodeByLabel(rightOnly.nodes, 'RightOnly'));
    assert.strictEqual(findNodeByLabel(rightOnly.nodes, 'LocalOnly'), undefined);
  });

  test('builds executable right-only XML subtree candidate for missing parent', async () => {
    const left = [
      '<MetaDataObject>',
      '  <Properties>',
      '    <Name>Products</Name>',
      '  </Properties>',
      '</MetaDataObject>',
    ].join('\n');
    const result = await metadataXmlAdapter.compare(
      makeInput({
        left,
        right: [
          '<MetaDataObject>',
          '  <Properties>',
          '    <Name>Products</Name>',
          '  </Properties>',
          '  <Item id="new">',
          '    <Name>NewItem</Name>',
          '    <Presentation>Created</Presentation>',
          '  </Item>',
          '</MetaDataObject>',
        ].join('\n'),
      })
    );

    const item = requireNodeByLabel(result.nodes, 'NewItem');

    assert.strictEqual(item.status, 'rightOnly');
    assert.strictEqual(item.mergeable, true);
    assert.ok(result.candidateFactories.has(item.id));
    assert.strictEqual(findNodeByLabel(item.children, 'Presentation'), undefined);

    const candidateResult = await result.candidateFactories.get(item.id)!();
    assert.strictEqual(candidateResult.ok, true);
    const patch = candidateResult.candidate.xmlPatch!;
    assert.strictEqual(patch.kind, 'insertNode');
    assert.match(patch.target.pointer, /\/Item\[id=new\]$/);
    const applied = applyXmlPatch(left, patch);
    assert.match(applied, /<Item id="new"><Name>NewItem<\/Name><Presentation>Created<\/Presentation><\/Item>/);
  });

  test('builds executable left-only XML subtree candidate that deletes parent element', async () => {
    const left = [
      '<MetaDataObject>',
      '  <Item id="old">',
      '    <Name>OldItem</Name>',
      '    <Presentation>Removed</Presentation>',
      '  </Item>',
      '</MetaDataObject>',
    ].join('\n');
    const result = await metadataXmlAdapter.compare(
      makeInput({
        left,
        right: '<MetaDataObject></MetaDataObject>',
      })
    );

    const item = requireNodeByLabel(result.nodes, 'OldItem');

    assert.strictEqual(item.status, 'leftOnly');
    assert.strictEqual(item.mergeable, true);
    assert.strictEqual(item.destructive, true);
    assert.ok(result.candidateFactories.has(item.id));
    assert.strictEqual(findNodeByLabel(item.children, 'Presentation'), undefined);

    const candidateResult = await result.candidateFactories.get(item.id)!();
    assert.strictEqual(candidateResult.ok, true);
    const patch = candidateResult.candidate.xmlPatch!;
    assert.strictEqual(patch.kind, 'deleteNode');
    assert.match(patch.target.pointer, /\/Item\[id=old\]$/);
    const applied = applyXmlPatch(left, patch);
    assert.doesNotMatch(applied, /<Item id="old">/);
  });

  test('builds executable XML attribute patch candidate', async () => {
    const left = '<MetaDataObject><Item id="same" role="old"><Name>Same</Name></Item></MetaDataObject>';
    const result = await metadataXmlAdapter.compare(
      makeInput({
        left,
        right: '<MetaDataObject><Item id="same" role="new"><Name>Same</Name></Item></MetaDataObject>',
      })
    );

    const role = requireNodeByLabel(result.nodes, '@role');

    assert.strictEqual(role.status, 'changed');
    assert.strictEqual(role.mergeable, true);
    assert.ok(result.candidateFactories.has(role.id));

    const candidateResult = await result.candidateFactories.get(role.id)!();
    assert.strictEqual(candidateResult.ok, true);
    const patch = candidateResult.candidate.xmlPatch!;
    assert.strictEqual(patch.kind, 'replaceNode');
    assert.match(patch.target.pointer, /\/Item\[id=same\]\/@role$/);
    const applied = applyXmlPatch(left, patch);
    assert.match(applied, /<Item id="same" role="new">/);
  });

  test('builds executable XML patch for namespaced 1C elements', async () => {
    const left = [
      '<v8:MetaDataObject xmlns:v8="http://v8.1c.ru/8.3/MDClasses">',
      '  <v8:Properties>',
      '    <v8:Name>Products</v8:Name>',
      '    <v8:Synonym>Old goods</v8:Synonym>',
      '  </v8:Properties>',
      '</v8:MetaDataObject>',
    ].join('\n');
    const result = await metadataXmlAdapter.compare(
      makeInput({
        left,
        right: [
          '<v8:MetaDataObject xmlns:v8="http://v8.1c.ru/8.3/MDClasses">',
          '  <v8:Properties>',
          '    <v8:Name>Products</v8:Name>',
          '    <v8:Synonym>New goods</v8:Synonym>',
          '  </v8:Properties>',
          '</v8:MetaDataObject>',
        ].join('\n'),
      })
    );

    const synonym = requireNodeByLabel(result.nodes, 'v8:Synonym');
    const candidateResult = await result.candidateFactories.get(synonym.id)!();

    assert.strictEqual(candidateResult.ok, true);
    const patch = candidateResult.candidate.xmlPatch!;
    assert.doesNotMatch(patch.target.pointer, /v8:/);
    const applied = applyXmlPatch(left, patch);
    assert.match(applied, /<v8:Synonym>New goods<\/v8:Synonym>/);
  });
});

function makeInput(
  snapshots: { left: string; right: string },
  strategy: AdapterCompareInput['strategy'] = 'full'
): AdapterCompareInput {
  const leftPath = path.join('left', 'Catalogs', 'Products.xml');
  const rightPath = path.join('right', 'Catalogs', 'Products.xml');

  return {
    strategy,
    leftInventory: { rootPath: 'left', objects: [], artifactsByObjectId: new Map() },
    rightInventory: { rootPath: 'right', objects: [], artifactsByObjectId: new Map() },
    match: {
      left: metadataObject('left-object', leftPath, path.join('left', 'Catalogs', 'Products')),
      right: metadataObject('right-object', rightPath, path.join('right', 'Catalogs', 'Products')),
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
    uuid: 'catalog-products',
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
  const found = findNodesByLabel(nodes, label);
  assert.strictEqual(found.length, 1, `Expected exactly one node with label ${label}.`);
  return found[0]!;
}

function findNodeByLabel(nodes: readonly CompareTreeNode[], label: string): CompareTreeNode | undefined {
  return findNodesByLabel(nodes, label)[0];
}

function findNodesByLabel(nodes: readonly CompareTreeNode[], label: string): CompareTreeNode[] {
  const found = collectNodes(nodes, (node) => node.label === label);
  return found;
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
