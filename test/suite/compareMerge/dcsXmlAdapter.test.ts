import * as assert from 'assert';
import * as path from 'path';

import { CompareSession } from '../../../src/compareMerge/domain/compareSession';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import { dcsXmlAdapter } from '../../../src/compareMerge/adapters/dcsXmlAdapter';
import type { AdapterCompareInput } from '../../../src/compareMerge/adapters/mergeAdapter';
import { applyXmlPatchBatch } from '../../../src/compareMerge/xml/xmlPatch';
import { applySelectedXmlPatches } from '../../../src/compareMerge/merge/semanticXmlMerge';
import { elementChildren, parseXmlDocument, textContent, type XmlElement } from '../../../src/compareMerge/xml/xmlDom';

suite('DCS XML adapter', () => {
  test('selects an escaped calculated expression and preserves target-only fields and settings', async () => {
    const left = dcsXml('SELECT 1', 'Target & expression', true);
    const right = dcsXml('SELECT 2', 'Gross & Net', false);
    const input = makeInput(left, right);
    const compared = await dcsXmlAdapter.compare(input);
    const expression = collectNodes(compared.nodes).find((node) =>
      node.kind === 'xmlProperty' && node.leftValue === 'Target & expression' && node.rightValue === 'Gross & Net'
    );
    assert.ok(expression, 'the calculated-field expression should be independently selectable');
    const changedValues = collectNodes(compared.nodes).filter((node) => node.kind === 'xmlProperty' &&
      ((node.leftValue === 'SELECT 1' && node.rightValue === 'SELECT 2') ||
        (node.leftValue === 'Target & expression' && node.rightValue === 'Gross & Net')));
    assert.strictEqual(changedValues.length, 2, 'query and expression values should remain separately selectable');

    const candidateResult = await compared.candidateFactories.get(expression!.id)!();
    assert.strictEqual(candidateResult.ok, true);
    if (!candidateResult.ok) {return;}
    const patch = candidateResult.candidate.xmlPatch;
    assert.ok(patch);
    const semanticallyApplied = applySelectedXmlPatches(left, [patch!]);
    assert.strictEqual(semanticallyApplied.ok, true, JSON.stringify(semanticallyApplied));
    const merged = applyXmlPatchBatch(left, [patch!]);
    const root = parseXmlDocument(merged).root;
    assert.strictEqual(textContent(findDescendant(root, 'expression')).trim(), 'Gross & Net');
    assert.strictEqual(textContent(findDescendant(root, 'query')).trim(), 'SELECT 1', 'unselected source query edits must leave target content unchanged');
    assert.ok(merged.includes('Gross &amp; Net'), 'selected text must be XML-escaped in the serialized output');
    assert.ok(elementChildren(findDescendant(root, 'dataSet')).filter((element) => element.localName === 'field')
      .some((field) => textContent(elementChildren(field).find((child) => child.localName === 'dataPath')!).trim() === 'TargetOnly'));
    assert.strictEqual(textContent(findDescendant(root, 'name', 'Default')).trim(), 'Default', 'the target settings variant must remain intact');
  });

  test('keeps foreign same-local-name DCS values read-only', async () => {
    const namespace = 'http://v8.1c.ru/8.1/data-composition-system/schema';
    const left = dcsXml('SELECT 1', 'Value', false).replace('<d:query>SELECT 1</d:query>',
      '<d:query>SELECT 1</d:query><foreign:query>target</foreign:query>')
      .replace(`xmlns:d="${namespace}"`, `xmlns:d="${namespace}" xmlns:foreign="urn:foreign"`);
    const right = dcsXml('SELECT 1', 'Value', false).replace('<d:query>SELECT 1</d:query>',
      '<d:query>SELECT 1</d:query><foreign:query>source</foreign:query>')
      .replace(`xmlns:d="${namespace}"`, `xmlns:d="${namespace}" xmlns:foreign="urn:foreign"`);
    const compared = await dcsXmlAdapter.compare(makeInput(left, right));
    const foreign = collectNodes(compared.nodes).find((node) => node.label === 'foreign:query');
    assert.ok(foreign, 'the foreign element should remain visible');
    assert.strictEqual(foreign!.mergeable, false);
    assert.strictEqual(compared.candidateFactories.has(foreign!.id), false);
  });

  test('matches data-set links by the full tuple when endpoints are shared', async () => {
    const left = withLinks(dcsXml('SELECT 1', 'Value', false), false);
    const right = withLinks(dcsXml('SELECT 1', 'Value', false), true);
    const compared = await dcsXmlAdapter.compare(makeInput(left, right));
    const changed = collectNodes(compared.nodes).find((node) =>
      node.kind === 'xmlProperty' && node.leftValue === 'false' && node.rightValue === 'true'
    );
    assert.ok(changed, 'the changed link property should be selectable despite a shared dataset pair');
    const candidateResult = await compared.candidateFactories.get(changed!.id)!();
    assert.strictEqual(candidateResult.ok, true);
    if (!candidateResult.ok) {return;}
    const patch = candidateResult.candidate.xmlPatch;
    assert.ok(patch);
    assert.match(decodeURIComponent(patch!.target.pointer), /dcs-link=\["Query","Query2","Amount","Total","P1"\]/u);
    const merged = applyXmlPatchBatch(left, [patch!]);
    const root = parseXmlDocument(merged).root;
    const links = elementChildren(root).filter((element) => element.localName === 'dataSetLink');
    assert.deepStrictEqual(links.map((link) => textContent(elementChildren(link).find((child) => child.localName === 'parameterListAllowed')!).trim()), ['true', 'false']);
  });
});

function dcsXml(query: string, expression: string, includeTargetOnly: boolean): string {
  return `<d:DataCompositionSchema xmlns:d="http://v8.1c.ru/8.1/data-composition-system/schema" ` +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:dcsset="http://v8.1c.ru/8.1/data-composition-system/settings">' +
    '<d:dataSource><d:name>Source</d:name><d:dataSourceType>Local</d:dataSourceType></d:dataSource>' +
    `<d:dataSet xsi:type="d:DataSetQuery"><d:name>Query</d:name><d:dataSource>Source</d:dataSource><d:query>${query}</d:query>` +
    '<d:field><d:dataPath>Amount</d:dataPath></d:field>' +
    (includeTargetOnly ? '<d:field><d:dataPath>TargetOnly</d:dataPath></d:field>' : '') +
    '</d:dataSet><d:calculatedField><d:dataPath>Display</d:dataPath><d:expression>' + escapeXml(expression) + '</d:expression></d:calculatedField>' +
    '<d:settingsVariant><dcsset:name>Default</dcsset:name><d:settings/></d:settingsVariant>' +
    '</d:DataCompositionSchema>';
}

function withLinks(xml: string, changeFirst: boolean): string {
  const additions = '<d:dataSet xsi:type="d:DataSetQuery"><d:name>Query2</d:name><d:dataSource>Source</d:dataSource><d:query>SELECT 2</d:query></d:dataSet>' +
    '<d:dataSetLink><d:sourceDataSet>Query</d:sourceDataSet><d:destinationDataSet>Query2</d:destinationDataSet><d:sourceExpression>Amount</d:sourceExpression><d:destinationExpression>Total</d:destinationExpression><d:parameter>P1</d:parameter><d:parameterListAllowed>' + (changeFirst ? 'true' : 'false') + '</d:parameterListAllowed></d:dataSetLink>' +
    '<d:dataSetLink><d:sourceDataSet>Query</d:sourceDataSet><d:destinationDataSet>Query2</d:destinationDataSet><d:sourceExpression>Discount</d:sourceExpression><d:destinationExpression>DiscountTotal</d:destinationExpression><d:parameter>P2</d:parameter><d:parameterListAllowed>false</d:parameterListAllowed></d:dataSetLink>';
  return xml.replace('<d:calculatedField>', additions + '<d:calculatedField>');
}

function makeInput(left: string, right: string): AdapterCompareInput {
  const leftPath = path.join('left', 'Reports', 'Sales', 'Ext', 'Template.xml');
  const rightPath = path.join('right', 'Reports', 'Sales', 'Ext', 'Template.xml');
  return {
    strategy: 'full',
    leftInventory: { rootPath: 'left', objects: [], artifactsByObjectId: new Map() },
    rightInventory: { rootPath: 'right', objects: [], artifactsByObjectId: new Map() },
    match: {
      left: metadataObject('left-report', path.join('left', 'Reports', 'Sales.xml'), path.join('left', 'Reports', 'Sales')),
      right: metadataObject('right-report', path.join('right', 'Reports', 'Sales.xml'), path.join('right', 'Reports', 'Sales')),
    },
    artifactPaths: { left: leftPath, right: rightPath },
    semanticValidationContext: { ownerDescriptorVersions: { target: '2.20', incoming: '2.20' } },
    session: makeSession(),
    snapshots: { left, right },
  };
}

function metadataObject(objectId: string, descriptorPath: string, containerPath: string) {
  return { objectId, qualifiedName: 'Report.Sales', metadataType: 'Report', descriptorPath, containerPath };
}

function makeSession(): CompareSession {
  const session = CompareSession.create({
    sessionId: 'dcs-adapter',
    createdAt: '2026-06-01T10:00:00.000Z',
    sources: [
      { sourceId: 'left-source', side: 'left', kind: 'workspace', displayName: 'Left', rootUri: 'file:///left', writable: true },
      { sourceId: 'right-source', side: 'right', kind: 'file', displayName: 'Right', rootUri: 'file:///right', writable: false },
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
    createdAt: '2026-06-01T10:00:00.000Z',
    retentionUntil: '2026-06-01T12:00:00.000Z',
    sourceRevision: side,
    readOnly: side === 'right',
    cleanupPolicy: 'manual' as const,
    contentHash: side,
  };
}

function collectNodes(nodes: readonly CompareTreeNode[]): CompareTreeNode[] {
  return nodes.flatMap((node) => [node, ...collectNodes(node.children)]);
}

function findDescendant(root: XmlElement, localName: string, value?: string): XmlElement {
  const pending = [root];
  while (pending.length > 0) {
    const element = pending.pop()!;
    if (element.localName === localName && (value === undefined || textContent(element).trim() === value)) {return element;}
    pending.push(...elementChildren(element));
  }
  assert.fail(`Expected descendant ${localName}${value ? `=${value}` : ''}.`);
}

function escapeXml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}
