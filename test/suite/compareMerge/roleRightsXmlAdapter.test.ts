import * as assert from 'assert';
import { createHash } from 'crypto';
import * as path from 'path';

import { CompareSession } from '../../../src/compareMerge/domain/compareSession';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import { roleRightsXmlAdapter } from '../../../src/compareMerge/adapters/roleRightsXmlAdapter';
import type { AdapterCompareInput } from '../../../src/compareMerge/adapters/mergeAdapter';
import { applyXmlPatchBatch } from '../../../src/compareMerge/xml/xmlPatch';
import { applySelectedXmlPatches } from '../../../src/compareMerge/merge/semanticXmlMerge';
import { elementChildren, parseXmlDocument, textContent, type XmlElement } from '../../../src/compareMerge/xml/xmlDom';
import { projectRoleRightsPair } from '../../../src/compareMerge/adapters/roleRightsEffectiveProjection';

suite('Role Rights XML adapter', () => {
  test('compares effective 2.19+ permissions instead of deleting a target right omitted under the incoming default', async () => {
    const target = rightsXmlWithPolicy({ read: 'true', setForNewObjects: 'false' });
    const incoming = rightsXmlWithPolicy({ read: undefined, setForNewObjects: 'true' });
    const compared = await roleRightsXmlAdapter.compare(makeInput(target, incoming));
    const candidates = await Promise.all([...compared.candidateFactories.values()].map((factory) => factory()));
    const rightCandidates = candidates.flatMap((result) => result.ok && result.candidate.xmlPatch
      ? [{ kind: result.candidate.xmlPatch.kind, target: result.candidate.xmlPatch.target, replacementXml: result.candidate.xmlPatch.replacementXml }]
      : []);

    assert.ok(
      !rightCandidates.some((candidate) => candidate.kind === 'deleteNode'
        && /right/iu.test(candidate.target.displayPath)
        && /Catalog\.Products/iu.test(candidate.target.displayPath)),
      `The incoming omission means Read=true, so it must not create a delete candidate: ${JSON.stringify(rightCandidates)}`,
    );
    assert.ok(
      collectNodes(compared.nodes).some((node) => node.label === 'setForNewObjects'),
      'the changed root policy remains visible as its own selectable decision',
    );
    const policy = collectNodes(compared.nodes).find((node) => node.label === 'setForNewObjects');
    assert.strictEqual(policy?.mergeable, false, 'root policy is visible but cannot be copied with a selected right');
  });

  test('normalizes a selected effective right under target policy and keeps the raw source witness', async () => {
    const target = rightsXmlWithPolicy({ read: 'false', setForNewObjects: 'false' });
    const incoming = rightsXmlWithPolicy({ read: undefined, setForNewObjects: 'true' });
    const compared = await roleRightsXmlAdapter.compare(makeInput(target, incoming));
    const rightNode = collectNodes(compared.nodes).find((node) => node.payloadRef?.includes('rights-object%3Dcatalog.products')
      && node.payloadRef.includes('rights-right%3Dread'));
    assert.ok(rightNode, 'effective Read=true differs from the target Read=false');
    assert.strictEqual(rightNode!.mergeable, true);
    const candidateResult = await compared.candidateFactories.get(rightNode!.id)!();
    assert.strictEqual(candidateResult.ok, true);
    if (!candidateResult.ok) {return;}
    const patch = candidateResult.candidate.xmlPatch;
    assert.ok(patch);
    const rawSourceHash = createHash('sha256').update(Buffer.from(incoming, 'utf8')).digest('hex');
    assert.ok(patch!.sourceWitnesses?.some((witness) =>
      witness.sourceId === 'right-source'
        && witness.relativePath === 'Roles/Sales/Ext/Rights.xml'
        && witness.expectedHash === rawSourceHash),
    'the physical source hash is attached even though compare used a normalized logical view');

    const merged = parseXmlDocument(applyXmlPatchBatch(target, [patch!])).root;
    assert.strictEqual(rightValue(merged, 'Catalog.Products', 'Read'), 'true');
    assert.strictEqual(textContent(elementChildren(merged).find((element) => element.localName === 'setForNewObjects')!).trim(), 'false',
      'a selected right is encoded against the existing target policy');
  });

  test('keeps a policy blocker visible when both sides omit rights under different defaults', async () => {
    const target = rightsXmlWithPolicy({ read: undefined, setForNewObjects: 'false' });
    const incoming = rightsXmlWithPolicy({ read: undefined, setForNewObjects: 'true' });
    const compared = await roleRightsXmlAdapter.compare(makeInput(target, incoming));
    const nodes = collectNodes(compared.nodes);

    assert.strictEqual(nodes.filter((node) => node.label === 'setForNewObjects').length, 1);
    assert.strictEqual(nodes.find((node) => node.label === 'setForNewObjects')?.mergeable, false);
    assert.strictEqual([...compared.candidateFactories.keys()].some((id) => id.includes('rights-right%3Dread')), false,
      'an absent right has no per-right candidate, so the changed root policy carries the read-only decision');
  });

  test('blocks an omitted nested right without guessing an Attribute default', async () => {
    const target = nestedRightsXml(true);
    const incoming = nestedRightsXml(false);
    const compared = await roleRightsXmlAdapter.compare(makeInput(target, incoming));
    const nodes = collectNodes(compared.nodes);
    const rightNode = nodes.find((node) => node.payloadRef?.includes('rights-object%3Dcatalog.products.attribute.code')
      && node.payloadRef.includes('rights-right%3Dedit'));

    assert.ok(rightNode, `the nested right remains visible: ${JSON.stringify(nodes.map((node) => ({ label: node.label, payloadRef: node.payloadRef, state: node.mergeState })))}`);
    assert.strictEqual(rightNode!.mergeable, false);
    assert.match(rightNode!.mergeState?.reason ?? '', /нельзя подтвердить значение пропуска/u);
  });

  test('preserves a changed source RLS restriction instead of mirroring the target right', () => {
    const target = rightsXmlWithRestriction('TargetCondition');
    const source = rightsXmlWithRestriction('IncomingCondition');
    const projected = projectRoleRightsPair({ targetXml: target, sourceXml: source });

    assert.match(projected.comparisonSourceXml, /IncomingCondition/u);
    assert.doesNotMatch(projected.comparisonSourceXml, /TargetCondition/u);
    assert.ok(projected.issues.some((issue) => issue.scope === 'right'
      && issue.objectQualifiedName === 'Catalog.Products'
      && issue.rightName === 'Read'));
  });

  test('does not infer omitted-right defaults before format 2.19', async () => {
    const target = rightsXmlWithPolicy({ read: 'true', setForNewObjects: 'true' }).replace('version="2.20"', 'version="2.18"');
    const incoming = rightsXmlWithPolicy({ read: undefined, setForNewObjects: 'true' }).replace('version="2.20"', 'version="2.18"');
    const compared = await roleRightsXmlAdapter.compare(makeInput(target, incoming));
    const rightNode = collectNodes(compared.nodes).find((node) => node.payloadRef?.includes('rights-object%3Dcatalog.products')
      && node.payloadRef.includes('rights-right%3Dread'));

    assert.ok(rightNode, 'the explicit-versus-omitted difference is retained');
    assert.strictEqual(rightNode!.mergeable, false);
  });

  test('blocks a whole-object ancestor containing an unsafe right without blocking a similarly named sibling object', async () => {
    const target = `<Rights xmlns="http://v8.1c.ru/8.2/roles" version="2.20">` +
      '<setForNewObjects>false</setForNewObjects><setForAttributesByDefault>false</setForAttributesByDefault>' +
      '<independentRightsOfChildObjects>false</independentRightsOfChildObjects>' +
      '<object><name>Catalog.ProductsExtra</name><right><name>Read</name><value>false</value></right></object></Rights>';
    const source = `<Rights xmlns="http://v8.1c.ru/8.2/roles" version="2.20">` +
      '<setForNewObjects>false</setForNewObjects><setForAttributesByDefault>false</setForAttributesByDefault>' +
      '<independentRightsOfChildObjects>false</independentRightsOfChildObjects>' +
      '<object><name>Catalog.Products</name><right><name>Read</name><value>true</value>' +
      '<restrictionByCondition><condition>IncomingCondition</condition></restrictionByCondition></right></object>' +
      '<object><name>Catalog.ProductsExtra</name><right><name>Read</name><value>true</value></right></object></Rights>';

    const compared = await roleRightsXmlAdapter.compare(makeInput(target, source));
    const nodes = collectNodes(compared.nodes);
    const wholeObject = nodes.find((node) => node.kind === 'roleRightsObject'
      && node.payloadRef?.includes('rights-object%3Dcatalog.products]'));
    const independentRight = nodes.find((node) => node.payloadRef?.includes('rights-object%3Dcatalog.productsextra')
      && node.payloadRef.includes('rights-right%3Dread'));

    assert.ok(wholeObject, `the whole-object candidate remains visible: ${JSON.stringify(nodes.map((node) => ({label: node.label, payloadRef: node.payloadRef, mergeable: node.mergeable})))}`);
    assert.strictEqual(wholeObject!.mergeable, false, 'the object insertion contains a right whose RLS cannot be translated');
    assert.strictEqual(compared.candidateFactories.has(wholeObject!.id), false, 'the unsafe ancestor candidate is removed');
    assert.ok(independentRight, 'the similarly named independent object right remains visible');
    assert.strictEqual(independentRight!.mergeable, true, 'exact object identity must not confuse Products with ProductsExtra');
    assert.strictEqual(compared.candidateFactories.has(independentRight!.id), true);
  });

  test('captures the physical target descriptor witness for each referenced Rights object', async () => {
    const target = rightsXmlWithPolicy({ read: 'false', setForNewObjects: 'false' });
    const source = rightsXmlWithPolicy({ read: 'true', setForNewObjects: 'false' });
    const input = makeInput(target, source);
    const descriptorPath = path.join('left', 'Catalogs', 'Products.xml');
    const descriptorContent = '<MetaDataObject/>';
    const descriptorHash = createHash('sha256').update(Buffer.from(descriptorContent, 'utf8')).digest('hex');
    input.leftInventory.objects = [{
      objectId: 'left-catalog-products',
      qualifiedName: 'Catalog.Products',
      metadataType: 'Catalog',
      descriptorPath,
      containerPath: path.join('left', 'Catalogs', 'Products'),
    }];
    input.leftInventory.artifactsByObjectId = new Map([['left-catalog-products', [{
      artifactId: 'left-catalog-products:descriptor',
      ownerObjectId: 'left-catalog-products',
      kind: 'metadataXml',
      relativePath: path.join('Catalogs', 'Products.xml'),
      filePath: descriptorPath,
      contentHash: `sha256:${descriptorHash}`,
      mergeMode: 'xmlPatch',
    }]]]);
    input.semanticValidationContext = { availableMetadataReferences: ['Catalog.Products'] };

    const compared = await roleRightsXmlAdapter.compare(input);
    const rightNode = collectNodes(compared.nodes).find((node) => node.payloadRef?.includes('rights-right%3Dread'));
    assert.ok(rightNode, 'the selected Read change is available');
    const result = await compared.candidateFactories.get(rightNode!.id)!();
    assert.strictEqual(result.ok, true);
    if (!result.ok) {return;}
    assert.ok(result.candidate.xmlPatch?.sourceWitnesses?.some((witness) =>
      witness.sourceId === 'left-source'
        && witness.relativePath === 'Catalogs/Products.xml'
        && witness.expectedHash === descriptorHash),
    'the previewed right depends on the exact target descriptor bytes used to validate the Rights reference');
  });

  test('selects a single right value while retaining target-only objects and foreign namespace content', async () => {
    const left = rightsXml({ read: 'true', update: 'false', foreign: 'keep target', otherRead: 'false' }, true);
    const right = rightsXml({ read: 'false', update: 'true', foreign: 'incoming foreign', otherRead: 'true' }, false);
    const input = makeInput(left, right);
    const compared = await roleRightsXmlAdapter.compare(input);
    const candidateNode = collectNodes(compared.nodes).find((node) =>
      node.kind === 'xmlProperty' && node.leftValue === 'true' && node.rightValue === 'false'
    );
    assert.ok(candidateNode, 'the changed Read value should be independently selectable');
    const changedValues = collectNodes(compared.nodes).filter((node) => node.kind === 'xmlProperty' &&
      ((node.leftValue === 'true' && node.rightValue === 'false') || (node.leftValue === 'false' && node.rightValue === 'true')));
    assert.strictEqual(changedValues.length, 3, 'right names must resolve within their own object scope');

    const candidateResult = await compared.candidateFactories.get(candidateNode!.id)!();
    assert.strictEqual(candidateResult.ok, true);
    if (!candidateResult.ok) {return;}
    const patch = candidateResult.candidate.xmlPatch;
    assert.ok(patch);
    const semanticallyApplied = applySelectedXmlPatches(left, [patch!]);
    assert.strictEqual(semanticallyApplied.ok, true, JSON.stringify(semanticallyApplied));
    const merged = applyXmlPatchBatch(left, [patch!]);
    const root = parseXmlDocument(merged).root;
    const objectNames = elementChildren(root).filter((element) => element.localName === 'object')
      .map((element) => textContent(elementChildren(element).find((child) => child.localName === 'name')!).trim());
    assert.deepStrictEqual(objectNames, ['Catalog.Products', 'Catalog.TargetOnly', 'Catalog.LocalOnly']);
    assert.strictEqual(rightValue(root, 'Catalog.Products', 'Read'), 'false');
    assert.strictEqual(rightValue(root, 'Catalog.Products', 'Update'), 'false', 'unselected source edits must not overwrite target values');
    assert.strictEqual(rightValue(root, 'Catalog.TargetOnly', 'Read'), 'false', 'same-named rights in another object must remain independent');
    assert.strictEqual(textContent(findElement(root, 'vendor:policy')).trim(), 'keep target');

    const foreignNode = collectNodes(compared.nodes).find((node) => node.label === 'vendor:policy');
    assert.ok(foreignNode, 'the changed foreign element should remain visible for review');
    assert.strictEqual(foreignNode!.mergeable, false);
    assert.strictEqual(compared.candidateFactories.has(foreignNode!.id), false);
  });
});

function rightsXml(values: { read: string; update: string; foreign: string; otherRead: string }, includeTargetOnly: boolean): string {
  const objects = '<object><name>Catalog.Products</name>' +
    `<right><name>Read</name><value>${values.read}</value></right>` +
    `<right><name>Update</name><value>${values.update}</value></right></object>` +
    `<object><name>Catalog.TargetOnly</name><right><name>Read</name><value>${values.otherRead}</value></right></object>` +
    (includeTargetOnly ? '<object><name>Catalog.LocalOnly</name><right><name>Read</name><value>true</value></right></object>' : '');
  return `<Rights xmlns="http://v8.1c.ru/8.2/roles" xmlns:vendor="urn:vendor" version="2.20">` +
    '<setForNewObjects>false</setForNewObjects><setForAttributesByDefault>false</setForAttributesByDefault>' +
    '<independentRightsOfChildObjects>false</independentRightsOfChildObjects>' + objects +
    `<vendor:policy>${values.foreign}</vendor:policy></Rights>`;
}

function rightsXmlWithPolicy(values: { read?: string; setForNewObjects: 'true' | 'false' }): string {
  const readRight = values.read === undefined
    ? ''
    : `<right><name>Read</name><value>${values.read}</value></right>`;
  return `<Rights xmlns="http://v8.1c.ru/8.2/roles" version="2.20">` +
    `<setForNewObjects>${values.setForNewObjects}</setForNewObjects>` +
    '<setForAttributesByDefault>true</setForAttributesByDefault><independentRightsOfChildObjects>false</independentRightsOfChildObjects>' +
    `<object><name>Catalog.Products</name>${readRight}</object></Rights>`;
}

function nestedRightsXml(includeRight: boolean): string {
  const right = includeRight ? '<right><name>Edit</name><value>false</value></right>' : '';
  return `<Rights xmlns="http://v8.1c.ru/8.2/roles" version="2.20">` +
    '<setForNewObjects>false</setForNewObjects><setForAttributesByDefault>false</setForAttributesByDefault>' +
    '<independentRightsOfChildObjects>false</independentRightsOfChildObjects>' +
    `<object><name>Catalog.Products.Attribute.Code</name>${right}</object></Rights>`;
}

function rightsXmlWithRestriction(condition: string): string {
  return `<Rights xmlns="http://v8.1c.ru/8.2/roles" version="2.20">` +
    '<setForNewObjects>false</setForNewObjects><setForAttributesByDefault>false</setForAttributesByDefault>' +
    '<independentRightsOfChildObjects>false</independentRightsOfChildObjects>' +
    `<object><name>Catalog.Products</name><right><name>Read</name><value>true</value>` +
    `<restrictionByCondition><condition>${condition}</condition></restrictionByCondition></right></object></Rights>`;
}

function makeInput(left: string, right: string): AdapterCompareInput {
  const leftPath = path.join('left', 'Roles', 'Sales', 'Ext', 'Rights.xml');
  const rightPath = path.join('right', 'Roles', 'Sales', 'Ext', 'Rights.xml');
  return {
    strategy: 'full',
    leftInventory: { rootPath: 'left', objects: [], artifactsByObjectId: new Map() },
    rightInventory: { rootPath: 'right', objects: [], artifactsByObjectId: new Map() },
    match: {
      left: metadataObject('left-role', path.join('left', 'Roles', 'Sales.xml'), path.join('left', 'Roles', 'Sales')),
      right: metadataObject('right-role', path.join('right', 'Roles', 'Sales.xml'), path.join('right', 'Roles', 'Sales')),
    },
    artifactPaths: { left: leftPath, right: rightPath },
    semanticValidationContext: { availableMetadataReferences: ['Catalog.Products', 'Catalog.TargetOnly', 'Catalog.LocalOnly'] },
    session: makeSession(),
    snapshots: { left, right },
  };
}

function metadataObject(objectId: string, descriptorPath: string, containerPath: string) {
  return { objectId, qualifiedName: 'Role.Sales', metadataType: 'Role', descriptorPath, containerPath };
}

function makeSession(): CompareSession {
  const session = CompareSession.create({
    sessionId: 'role-rights-adapter',
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

function rightValue(root: XmlElement, objectName: string, rightName: string): string | undefined {
  const object = elementChildren(root).find((element) => element.localName === 'object' &&
    textContent(elementChildren(element).find((child) => child.localName === 'name')!).trim() === objectName);
  const right = elementChildren(object!).find((element) => element.localName === 'right' &&
    textContent(elementChildren(element).find((child) => child.localName === 'name')!).trim() === rightName);
  const value = elementChildren(right!).find((element) => element.localName === 'value');
  return value ? textContent(value).trim() : undefined;
}

function findElement(root: XmlElement, qualifiedName: string): XmlElement {
  const found = elementChildren(root).find((element) => element.name === qualifiedName);
  assert.ok(found, `Expected XML element ${qualifiedName}.`);
  return found!;
}
