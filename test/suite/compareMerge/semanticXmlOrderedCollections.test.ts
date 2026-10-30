import * as assert from 'assert';
import * as path from 'path';

import { CompareSession } from '../../../src/compareMerge/domain/compareSession';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import { formXmlAdapter } from '../../../src/compareMerge/adapters/formXmlAdapter';
import type { AdapterCompareInput, AdapterCompareResult } from '../../../src/compareMerge/adapters/mergeAdapter';
import { metadataXmlAdapter } from '../../../src/compareMerge/adapters/xmlMetadataAdapter';
import { applySelectedXmlPatches } from '../../../src/compareMerge/merge/semanticXmlMerge';
import { buildXmlAddress, elementChildren, parseXmlDocument } from '../../../src/compareMerge/xml/xmlDom';
import { applyXmlPatch, hashXmlText } from '../../../src/compareMerge/xml/xmlPatch';
import type { MergeCandidate, XmlPatchPayload } from '../../../src/compareMerge/merge/mergePreview';

const MDCLASSES = 'http://v8.1c.ru/8.3/MDClasses';
const LOGFORM = 'http://v8.1c.ru/8.3/xcf/logform';

type OrderScope =
  | { kind: 'metadataChildObjects'; elementKind: string }
  | { kind: 'formSection'; section: 'Attributes' | 'Commands' | 'Parameters' };

suite('Scoped Designer XML order profiles', () => {
  test('projects moves for each accepted metadata owner-kind family', async () => {
    const cases: { ownerChain: string[]; childKind: string }[] = [
      { ownerChain: ['Catalog'], childKind: 'Attribute' },
      { ownerChain: ['Catalog'], childKind: 'TabularSection' },
      { ownerChain: ['AccumulationRegister'], childKind: 'Dimension' },
      { ownerChain: ['AccumulationRegister'], childKind: 'Resource' },
      { ownerChain: ['AccumulationRegister'], childKind: 'Attribute' },
      { ownerChain: ['Task'], childKind: 'AddressingAttribute' },
      { ownerChain: ['ChartOfAccounts'], childKind: 'AccountingFlag' },
      { ownerChain: ['ChartOfAccounts'], childKind: 'ExtDimensionAccountingFlag' },
      { ownerChain: ['HTTPService'], childKind: 'URLTemplate' },
      { ownerChain: ['HTTPService', 'URLTemplate'], childKind: 'Method' },
      { ownerChain: ['WebService'], childKind: 'Operation' },
      { ownerChain: ['WebService', 'Operation'], childKind: 'Parameter' },
      { ownerChain: ['Catalog', 'TabularSection'], childKind: 'Attribute' },
    ];

    for (const entry of cases) {
      const compared = await metadataXmlAdapter.compare(makeInput(
        metadataOwnerXml(entry.ownerChain, entry.childKind, ['First', 'Second']),
        metadataOwnerXml(entry.ownerChain, entry.childKind, ['Second', 'First']),
        'metadataXml',
        entry.ownerChain[0],
      ));
      const candidates = await resolveCandidates(compared);
      const moves = candidates.filter((candidate) => candidate.kind === 'xmlNodeMove');
      assert.ok(moves.length > 0,
        `${entry.ownerChain.join('/')} → ${entry.childKind} should expose a same-parent move; ` +
        `nodes=${describeNodes(compared.nodes).join(' | ')}`);
      assert.ok(moves.every((candidate) => candidate.xmlPatch?.kind === 'moveNode'));
      assert.ok(moves.every((candidate) => {
        const scope = orderScope(candidate.xmlPatch);
        return scope?.kind === 'metadataChildObjects' && scope.elementKind === entry.childKind;
      }));
    }
  });

  test('orders direct Form Attributes, Commands, and Parameters independently', async () => {
    const left = formXml(['First', 'Second'], ['First', 'Second'], ['First', 'Second']);
    const right = formXml(['Second', 'First'], ['Second', 'First'], ['Second', 'First']);
    const input = makeInput(left, right, 'formXml', 'Catalog');
    (input as AdapterCompareInput & { allowFormSectionOrder?: boolean }).allowFormSectionOrder = true;

    const compared = await formXmlAdapter.compare(input);
    const candidates = await resolveCandidates(compared);
    const moves = candidates.filter((candidate) => candidate.kind === 'xmlNodeMove');
    assert.strictEqual(moves.length, 3, 'one selected move should be available for each direct section');
    assert.deepStrictEqual(moves.map((candidate) => orderScope(candidate.xmlPatch)?.kind), ['formSection', 'formSection', 'formSection']);
    assert.deepStrictEqual(moves.map((candidate) => formSectionScope(candidate.xmlPatch)).sort(),
      ['Attributes', 'Commands', 'Parameters']);

    const applied = applySelectedXmlPatches(left, moves.map((candidate) => candidate.xmlPatch!));
    assert.strictEqual(applied.ok, true, applied.ok ? undefined : applied.message);
    if (!applied.ok) {return;}
    const root = parseXmlDocument(applied.source).root;
    for (const sectionName of ['Attributes', 'Commands', 'Parameters']) {
      const section = elementChildren(root).find((element) => element.localName === sectionName)!;
      assert.deepStrictEqual(elementChildren(section).map((element) => element.attributes.find((attribute) => attribute.localName === 'name')?.value), ['Second', 'First']);
    }
  });

  test('keeps Attributes ahead of every TabularSection for Attribute-only and combined selections', async () => {
    const left = mixedMetadataOrder(['First', 'TargetOnly', 'Second'], ['One', 'Two']);
    const right = mixedMetadataOrder(['Second', 'New', 'First'], ['Two', 'One']);
    const compared = await metadataXmlAdapter.compare(makeInput(left, right, 'metadataXml', 'Catalog'));
    const candidates = await resolveCandidates(compared);
    const attributeChanges = candidates.filter((candidate) => {
      const patch = candidate.xmlPatch;
      const scope = orderScope(patch);
      return (patch?.kind === 'moveNode' || patch?.kind === 'insertNode') &&
        scope?.kind === 'metadataChildObjects' && scope.elementKind === 'Attribute';
    });
    assert.ok(attributeChanges.length >= 2,
      'the selected Attribute move and new Attribute insertion need individual candidates; ' +
      `candidates=${candidates.map((candidate) => `${candidate.kind}:${candidate.nodeId}:${JSON.stringify(orderScope(candidate.xmlPatch))}`).join(' | ')}; ` +
      `nodes=${describeNodes(compared.nodes).join(' | ')}; diagnostics=${JSON.stringify(compared.diagnostics)}`);
    assert.ok(attributeChanges.every((candidate) => {
      const scope = orderScope(candidate.xmlPatch);
      return scope?.kind === 'metadataChildObjects' && scope.elementKind === 'Attribute';
    }));

    for (const combined of [false, true]) {
      const selected = combined
        ? attributeChanges.concat(candidates.filter((candidate) => {
          const scope = orderScope(candidate.xmlPatch);
          return scope?.kind === 'metadataChildObjects' && scope.elementKind === 'TabularSection';
        }))
        : attributeChanges;
      for (const selection of [selected, [...selected].reverse()]) {
        const applied = applySelectedXmlPatches(left, selection.map((candidate) => candidate.xmlPatch!));
        assert.strictEqual(applied.ok, true, applied.ok ? undefined : applied.message);
        if (!applied.ok) {continue;}
        const owner = elementChildren(parseXmlDocument(applied.source).root)[0]!;
        const collection = elementChildren(owner).find((element) => element.localName === 'ChildObjects')!;
        const children = elementChildren(collection);
        const firstSectionIndex = children.findIndex((element) => element.localName === 'TabularSection');
        const lastAttributeIndex = Math.max(...children.flatMap((element, index) => element.localName === 'Attribute' ? [index] : []));
        assert.ok(lastAttributeIndex < firstSectionIndex, 'all Attributes must precede all TabularSections');
        assert.deepStrictEqual(children.filter((element) => element.localName === 'Attribute')
          .map((element) => element.attributes.find((attribute) => attribute.localName === 'uuid')?.value),
        [uuid(2), uuid(3), uuid(4), uuid(1)], 'the target-only sibling stays in its original slot and unselected source-only children are not copied');
        assert.deepStrictEqual(children.filter((element) => element.localName === 'TabularSection')
          .map((element) => element.attributes.find((attribute) => attribute.localName === 'uuid')?.value),
        combined ? [uuid(6), uuid(5)] : [uuid(5), uuid(6)]);
      }
    }
  });

  test('leaves ordered candidates read-only when the host denies ownership capability', async () => {
    const metadataInput = makeInput(
      metadataOwnerXml(['Catalog'], 'Attribute', ['First', 'Second']),
      metadataOwnerXml(['Catalog'], 'Attribute', ['Second', 'First']),
      'metadataXml',
      'Catalog',
    );
    (metadataInput as AdapterCompareInput & { allowMetadataChildOrder?: boolean }).allowMetadataChildOrder = false;
    const metadata = await metadataXmlAdapter.compare(metadataInput);
    assert.strictEqual((await resolveCandidates(metadata)).filter((candidate) => candidate.kind === 'xmlNodeMove').length, 0);

    const formInput = makeInput(formXml(['First', 'Second'], [], []), formXml(['Second', 'First'], [], []), 'formXml', 'Catalog');
    (formInput as AdapterCompareInput & { allowFormSectionOrder?: boolean }).allowFormSectionOrder = false;
    const form = await formXmlAdapter.compare(formInput);
    assert.strictEqual((await resolveCandidates(form)).filter((candidate) => candidate.kind === 'xmlNodeMove').length, 0);
  });

  test('rejects foreign UUID lookalikes and ambiguous or foreign ownership markers', async () => {
    const valid = metadataOwnerXml(['Catalog'], 'Attribute', ['First', 'Second']);
    const foreignUuid = valid.replace(`uuid="${uuid(20)}"`, `xmlns:x="urn:foreign" x:uuid="${uuid(20)}"`);
    const foreignOwnershipMarker = valid.replace('<Properties><Name>Owner0</Name></Properties>',
      '<Properties xmlns:x="urn:foreign"><Name>Owner0</Name><x:ObjectBelonging>Own</x:ObjectBelonging></Properties>');
    const duplicateOwnershipMarker = valid.replace('<Properties><Name>Owner0</Name></Properties>',
      '<Properties><Name>Owner0</Name><ObjectBelonging>Own</ObjectBelonging><ObjectBelonging>Own</ObjectBelonging></Properties>');

    for (const unsafe of [foreignUuid, foreignOwnershipMarker, duplicateOwnershipMarker]) {
      const compared = await metadataXmlAdapter.compare(makeInput(
        unsafe,
        reverseAttributeOrder(unsafe),
        'metadataXml',
        'Catalog',
      ));
      assert.strictEqual((await resolveCandidates(compared)).filter((candidate) => candidate.kind === 'xmlNodeMove').length, 0);
    }
  });

  test('does not grant order capability to an own nested owner under an adopted ancestor', async () => {
    const target = metadataOwnerXml(['Catalog', 'TabularSection'], 'Attribute', ['First', 'Second'])
      .replace('<Properties><Name>Owner0</Name></Properties>',
        '<Properties><Name>Owner0</Name><ObjectBelonging>Adopted</ObjectBelonging></Properties>');
    const source = reverseAttributeOrder(target);
    const compared = await metadataXmlAdapter.compare(makeInput(target, source, 'metadataXml', 'Catalog'));
    assert.strictEqual((await resolveCandidates(compared)).filter((candidate) => candidate.kind === 'xmlNodeMove').length, 0);
  });

  test('keeps ordered metadata collections read-only when ChildObjects has unknown or foreign siblings', async () => {
    const base = metadataOwnerXml(['Catalog'], 'Attribute', ['First', 'Second']);
    const target = base.replace('</ChildObjects>', '<Unsupported uuid="' + uuid(30) + '"/></ChildObjects>');
    const incoming = reverseAttributeOrder(target);
    const foreignTarget = base.replace('</ChildObjects>', '<x:Attribute xmlns:x="urn:foreign" uuid="' + uuid(30) + '"/></ChildObjects>');
    const foreignIncoming = reverseAttributeOrder(foreignTarget);

    for (const [left, right] of [[target, incoming], [foreignTarget, foreignIncoming]]) {
      const compared = await metadataXmlAdapter.compare(makeInput(left!, right!, 'metadataXml', 'Catalog'));
      const candidates = await resolveCandidates(compared);
      assert.strictEqual(candidates.filter((candidate) => candidate.kind === 'xmlNodeMove').length, 0,
        `unexpected move candidate for unsafe ChildObjects: ${describeNodes(compared.nodes).join(' | ')}`);
    }
  });

  test('runtime move guards reject foreign UUID and inherited ownership markers', () => {
    const valid = metadataOwnerXml(['Catalog'], 'Attribute', ['First', 'Second']);
    const foreignUuid = valid.replace(`uuid="${uuid(20)}"`, `xmlns:x="urn:foreign" x:uuid="${uuid(20)}"`);
    const foreignOwnershipMarker = valid.replace('<Properties><Name>Owner0</Name></Properties>',
      '<Properties xmlns:x="urn:foreign"><Name>Owner0</Name><x:ObjectBelonging>Own</x:ObjectBelonging></Properties>');
    const adoptedAncestor = metadataOwnerXml(['Catalog', 'TabularSection'], 'Attribute', ['First', 'Second'])
      .replace('<Properties><Name>Owner0</Name></Properties>',
        '<Properties><Name>Owner0</Name><ObjectBelonging>Adopted</ObjectBelonging></Properties>');

    for (const xml of [foreignUuid, foreignOwnershipMarker, adoptedAncestor]) {
      assert.throws(() => applyXmlPatch(xml, metadataMovePatch(xml)), /order scope|owner|identity|UUID|ownership/iu);
    }
  });
});

async function resolveCandidates(result: AdapterCompareResult): Promise<MergeCandidate[]> {
  const candidates: MergeCandidate[] = [];
  for (const factory of result.candidateFactories.values()) {
    const outcome = await factory();
    assert.strictEqual(outcome.ok, true, outcome.ok ? undefined : JSON.stringify(outcome.diagnostics));
    if (outcome.ok) {candidates.push(outcome.candidate);}
  }
  return candidates;
}

function describeNodes(nodes: readonly CompareTreeNode[]): string[] {
  return nodes.flatMap((node) => [`${node.kind}:${node.label}`, ...describeNodes(node.children)]);
}

function metadataOwnerXml(ownerChain: readonly string[], childKind: string, childNames: readonly string[]): string {
  const buildOwner = (depth: number): string => {
    const owner = ownerChain[depth]!;
    const nested = depth + 1 < ownerChain.length
      ? buildOwner(depth + 1)
      : childNames.map((name, index) => metadataChild(childKind, name, name === 'First' ? 1 : name === 'Second' ? 2 : index + 1)).join('');
    const name = `Owner${depth}`;
    return `<${owner} uuid="${uuid(20 + depth)}"><Properties><Name>${name}</Name></Properties><ChildObjects>${nested}</ChildObjects></${owner}>`;
  };
  return `<MetaDataObject xmlns="${MDCLASSES}" version="2.20">${buildOwner(0)}</MetaDataObject>`;
}

function metadataChild(kind: string, name: string, id: number): string {
  return `<${kind} uuid="${uuid(id)}"><Properties><Name>${name}</Name></Properties></${kind}>`;
}

function reverseAttributeOrder(xml: string): string {
  return xml
    .replace(metadataChild('Attribute', 'First', 1), '__FIRST_ATTRIBUTE__')
    .replace(metadataChild('Attribute', 'Second', 2), metadataChild('Attribute', 'First', 1))
    .replace('__FIRST_ATTRIBUTE__', metadataChild('Attribute', 'Second', 2));
}

function metadataMovePatch(xml: string): XmlPatchPayload {
  const root = parseXmlDocument(xml).root;
  let owner = elementChildren(root)[0]!;
  while (owner.localName === 'Catalog' && elementChildren(owner).some((child) => child.localName === 'ChildObjects')) {
    const nested = elementChildren(owner).find((child) => child.localName === 'ChildObjects')!;
    const nextOwner = elementChildren(nested).find((child) => child.localName === 'TabularSection');
    if (!nextOwner) {break;}
    owner = nextOwner;
  }
  const collection = elementChildren(owner).find((child) => child.localName === 'ChildObjects')!;
  const children = elementChildren(collection).filter((child) => child.localName === 'Attribute');
  const filePath = 'left/Catalog.xml';
  return {
    kind: 'moveNode',
    target: buildXmlAddress(filePath, children[0]!),
    destinationParent: buildXmlAddress(filePath, collection),
    insertBefore: buildXmlAddress(filePath, children[1]!),
    insertOrder: 0,
    orderScope: { kind: 'metadataChildObjects', elementKind: 'Attribute' },
    expectedOldHash: hashXmlText(xml),
    newHash: '',
    semanticKind: 'metadataXml',
  };
}

function mixedMetadataOrder(attributes: readonly string[], sections: readonly string[]): string {
  const attributeIds: Record<string, number> = { First: 1, TargetOnly: 2, Second: 3, New: 4 };
  const children = [
    ...attributes.map((name) => metadataChild('Attribute', name, attributeIds[name]!)),
    ...sections.map((name, index) => metadataChild('TabularSection', name, name === 'One' ? 5 : name === 'Two' ? 6 : 5 + index)),
  ].join('');
  return `<MetaDataObject xmlns="${MDCLASSES}" version="2.20"><Catalog uuid="${uuid(20)}"><Properties><Name>Products</Name></Properties><ChildObjects>${children}</ChildObjects></Catalog></MetaDataObject>`;
}

function formXml(attributes: readonly string[], commands: readonly string[], parameters: readonly string[]): string {
  const formItems = (kind: 'Attribute' | 'Command' | 'Parameter', values: readonly string[]) => values.map((name) => {
    const stableIndex = name === 'First' ? 0 : 1;
    const id = kind === 'Parameter' ? '' : ` id="${(kind === 'Attribute' ? 10 : 20) + stableIndex}"`;
    const body = '';
    return `<${kind} name="${name}"${id}>${body}</${kind}>`;
  }).join('');
  return `<Form xmlns="${LOGFORM}" version="2.20"><AutoCommandBar name="Auto" id="-1"/><ChildItems/><Attributes>${formItems('Attribute', attributes)}</Attributes><Commands>${formItems('Command', commands)}</Commands><Parameters>${formItems('Parameter', parameters)}</Parameters></Form>`;
}

function orderScope(patch?: XmlPatchPayload): OrderScope | undefined {
  return (patch as (XmlPatchPayload & { orderScope?: OrderScope }) | undefined)?.orderScope;
}

function formSectionScope(patch?: XmlPatchPayload): 'Attributes' | 'Commands' | 'Parameters' | undefined {
  const scope = orderScope(patch);
  return scope?.kind === 'formSection' ? scope.section : undefined;
}

function makeInput(left: string, right: string, kind: 'metadataXml' | 'formXml', metadataType: string): AdapterCompareInput {
  const leftObject = metadataObject('left-object', path.join('left', metadataType + '.xml'), 'left', metadataType);
  const rightObject = metadataObject('right-object', path.join('right', metadataType + '.xml'), 'right', metadataType);
  return {
    strategy: 'full',
    leftInventory: { rootPath: 'left', objects: [], artifactsByObjectId: new Map() },
    rightInventory: { rootPath: 'right', objects: [], artifactsByObjectId: new Map() },
    match: { left: leftObject, right: rightObject },
    session: makeSession(),
    artifactPaths: { left: path.join('left', kind === 'formXml' ? 'Form.xml' : metadataType + '.xml'), right: path.join('right', kind === 'formXml' ? 'Form.xml' : metadataType + '.xml') },
    snapshots: { left, right },
  };
}

function metadataObject(objectId: string, descriptorPath: string, containerPath: string, metadataType: string) {
  return { objectId, qualifiedName: `${metadataType}.Owner`, metadataType, descriptorPath, containerPath };
}

function makeSession(): CompareSession {
  const session = CompareSession.create({
    sessionId: 'ordered-xml-session',
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
    snapshotId: `ordered-snapshot-${side}`,
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

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}
