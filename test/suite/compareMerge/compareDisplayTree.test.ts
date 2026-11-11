import * as assert from 'assert';

import { METADATA_TYPE_DESCRIPTORS } from '../../../src/constants/metadataTypeDescriptors';
import type { CompareTreeNode, CompareTreeStatus } from '../../../src/compareMerge/compareTreeTypes';
import {
  buildCompareDisplayTree,
  type CompareDisplayNode,
} from '../../../src/compareMerge/projection/compareDisplayTree';

suite('CompareDisplayTree', () => {
  test('coalesces proven metadata aliases while preserving original child actions and candidate IDs', () => {
    const canonicalChild = node({
      id: 'xml-property:synonym',
      label: 'Synonym',
      kind: 'xmlProperty',
      status: 'changed',
      mergeable: true,
    });
    const metadataMatch = ownerNode({
      id: 'metadata:match:Catalog.Products',
      label: 'Catalog.Products',
      status: 'equal',
      ownerKey: 'Catalog:uuid:catalog-products',
      aliases: ['Catalog:name:Catalog.Products', 'Catalog:uuid:catalog-products'],
      qualifiedName: 'Catalog.Products',
      metadataType: 'Catalog',
      identities: [identity('left', 'Catalog.Products', 'catalog-products'), identity('right', 'Catalog.Products', 'catalog-products')],
    });
    const operation = ownerNode({
      id: 'metadata:object-operation',
      label: 'Products',
      status: 'equal',
      ownerKey: 'Catalog:uuid:catalog-products',
      aliases: ['Catalog:uuid:catalog-products'],
      qualifiedName: 'Catalog.Products',
      metadataType: 'Catalog',
      identities: [],
      mergeable: false,
      children: [canonicalChild],
    });

    const display = buildCompareDisplayTree(root([metadataGroup([metadataMatch, operation])]));
    const catalog = flatten(display.root).find((candidate) => candidate.kind === 'metadataOwner');

    assert.ok(catalog);
    assert.deepStrictEqual(new Set(catalog.canonicalNodeIds), new Set([metadataMatch.id, operation.id]));
    assert.deepStrictEqual(catalog.candidateNodeIds, []);
    const property = flatten(catalog).find((candidate) => candidate.key === canonicalChild.id);
    assert.ok(property);
    assert.deepStrictEqual(property.canonicalNodeIds, [canonicalChild.id]);
    assert.deepStrictEqual(property.candidateNodeIds, [canonicalChild.id]);
  });

  test('keeps an ambiguous duplicate UUID visible as separate identities and never invents an owner action', () => {
    const first = ownerNode({
      id: 'metadata:duplicate:first',
      label: 'Catalog.Products',
      status: 'changed',
      ownerKey: 'Catalog:uuid:duplicate',
      aliases: ['Catalog:uuid:duplicate', 'Catalog:name:Catalog.Products'],
      qualifiedName: 'Catalog.Products',
      metadataType: 'Catalog',
      identities: [identity('left', 'Catalog.Products', 'duplicate')],
      mergeable: true,
    });
    const second = ownerNode({
      ...first,
      id: 'metadata:duplicate:second',
      label: 'Catalog.OtherProducts',
      ownerKey: 'Catalog:uuid:duplicate',
      aliases: ['Catalog:uuid:duplicate', 'Catalog:name:Catalog.OtherProducts'],
      qualifiedName: 'Catalog.OtherProducts',
      metadataType: 'Catalog',
      identities: [identity('left', 'Catalog.OtherProducts', 'duplicate')],
    });
    const duplicateDiagnostic = node({
      id: 'metadata:conflict:duplicateUuid',
      label: 'duplicate UUID',
      kind: 'metadataConflict',
      status: 'changed',
      conflict: { kind: 'duplicateUuid', blocking: true, message: 'UUID повторяется.' },
      mergeable: false,
      presentation: {
        ownerKey: 'Catalog:uuid:duplicate',
        ownerAliases: ['Catalog:uuid:duplicate'],
        metadataType: 'Catalog',
        qualifiedName: 'Catalog.Products',
        identityConflict: true,
        ambiguousIdentitySet: true,
        identities: [identity('left', 'Catalog.Products', 'duplicate'), identity('left', 'Catalog.OtherProducts', 'duplicate')],
      },
    });

    const independent = ownerNode({
      id: 'metadata:independent',
      label: 'Catalog.Independent',
      status: 'changed',
      ownerKey: 'Catalog:uuid:independent',
      aliases: ['Catalog:uuid:independent', 'Catalog:name:Catalog.Independent'],
      qualifiedName: 'Catalog.Independent',
      metadataType: 'Catalog',
      identities: [identity('left', 'Catalog.Independent', 'independent')],
      mergeable: true,
    });
    const display = buildCompareDisplayTree(root([metadataGroup([first, second, independent, duplicateDiagnostic])]));
    const owners = flatten(display.root).filter((candidate) => candidate.kind === 'metadataOwner');
    const duplicateOwners = owners.filter((candidate) =>
      candidate.identities.some((candidateIdentity) => candidateIdentity.uuid === 'duplicate')
    );
    const independentOwner = owners.find((candidate) =>
      candidate.qualifiedNames?.includes('Catalog.Independent')
    );
    const standaloneConflicts = flatten(display.root).filter((candidate) => candidate.key === duplicateDiagnostic.id);

    assert.strictEqual(owners.length, 3);
    assert.strictEqual(duplicateOwners.length, 2);
    assert.strictEqual(standaloneConflicts.length, 1);
    assert.strictEqual(new Set(owners.map((candidate) => candidate.key)).size, 3);
    assert.deepStrictEqual(
      duplicateOwners.flatMap((candidate) => candidate.canonicalNodeIds).sort(),
      [first.id, second.id].sort()
    );
    assert.deepStrictEqual(
      duplicateOwners.flatMap((candidate) => candidate.identities.map((identity) => identity.qualifiedName)).sort(),
      ['Catalog.OtherProducts', 'Catalog.Products']
    );
    assert.ok(duplicateOwners.every((candidate) => candidate.candidateNodeIds.length === 0));
    assert.ok(duplicateOwners.every((candidate) => candidate.mergeState?.state === 'identityConflict'));
    assert.ok(independentOwner);
    assert.deepStrictEqual(independentOwner.candidateNodeIds, ['metadata:independent']);
    assert.strictEqual(independentOwner.mergeState?.state, undefined);
    assert.ok(first.mergeable, 'display conflicts must not mutate the canonical mergeability guard');
    assert.ok(standaloneConflicts[0]!.candidateNodeIds.length === 0);
  });

  test('keeps three duplicate qualified-name identities independently keyed and read-only', () => {
    const duplicateName = 'Catalog.DuplicateName';
    const duplicateOwners = ['one', 'two', 'three'].map((suffix) => ownerNode({
      id: `metadata:duplicate-name:${suffix}`,
      label: duplicateName,
      status: 'changed',
      ownerKey: `Catalog:name:${duplicateName}`,
      aliases: [`Catalog:name:${duplicateName}`],
      qualifiedName: duplicateName,
      metadataType: 'Catalog',
      identities: [identity('left', duplicateName, `uuid-${suffix}`)],
      mergeable: true,
    }));
    const duplicateDiagnostic = node({
      id: 'metadata:conflict:duplicateName',
      label: duplicateName,
      kind: 'metadataConflict',
      status: 'changed',
      conflict: { kind: 'duplicateQualifiedName', blocking: true, message: 'Имя повторяется.' },
      presentation: {
        ownerKey: `Catalog:name:${duplicateName}`,
        ownerAliases: [`Catalog:name:${duplicateName}`],
        metadataType: 'Catalog',
        qualifiedName: duplicateName,
        identityConflict: true,
        ambiguousIdentitySet: true,
        identities: duplicateOwners.map((owner) => owner.presentation!.identities![0]!),
      },
    });

    const display = buildCompareDisplayTree(root([metadataGroup([...duplicateOwners, duplicateDiagnostic])]));
    const nodes = flatten(display.root);
    const projectedOwners = nodes.filter((candidate) => candidate.kind === 'metadataOwner');

    assert.strictEqual(projectedOwners.length, 3);
    assert.strictEqual(new Set(projectedOwners.map((candidate) => candidate.key)).size, 3);
    assert.deepStrictEqual(
      projectedOwners.flatMap((candidate) => candidate.canonicalNodeIds).sort(),
      duplicateOwners.map((owner) => owner.id).sort()
    );
    assert.deepStrictEqual(
      projectedOwners.flatMap((candidate) => candidate.identities.map((identity) => identity.uuid)).sort(),
      ['uuid-one', 'uuid-three', 'uuid-two']
    );
    assert.ok(projectedOwners.every((candidate) => candidate.candidateNodeIds.length === 0));
    assert.ok(projectedOwners.every((candidate) => candidate.mergeState?.state === 'identityConflict'));
    assert.ok(duplicateOwners.every((owner) => owner.mergeable), 'display projection must leave canonical nodes unchanged');
  });

  test('preserves destructive flags on canonical artifacts and coalesced executable owners', () => {
    const destructiveArtifact = node({
      id: 'artifact:delete',
      label: 'Deleted file',
      kind: 'binaryFile',
      status: 'leftOnly',
      mergeable: true,
      destructive: true,
    });
    const owner = ownerNode({
      id: 'metadata:destructive-owner',
      label: 'Catalog.Destructive',
      status: 'changed',
      ownerKey: 'Catalog:uuid:destructive',
      aliases: ['Catalog:uuid:destructive'],
      qualifiedName: 'Catalog.Destructive',
      metadataType: 'Catalog',
      identities: [identity('left', 'Catalog.Destructive', 'destructive')],
      mergeable: true,
      children: [destructiveArtifact],
    });
    owner.destructive = true;

    const display = buildCompareDisplayTree(root([metadataGroup([owner])]));
    const nodes = flatten(display.root);
    const projectedOwner = nodes.find((candidate) => candidate.kind === 'metadataOwner');
    const projectedArtifact = nodes.find((candidate) => candidate.key === destructiveArtifact.id);
    const typeGroup = nodes.find((candidate) => candidate.kind === 'metadataTypeGroup');

    assert.ok(projectedOwner);
    assert.deepStrictEqual(projectedOwner.candidateNodeIds, [owner.id]);
    assert.strictEqual(projectedOwner.destructive, true);
    assert.ok(projectedArtifact);
    assert.deepStrictEqual(projectedArtifact.candidateNodeIds, [destructiveArtifact.id]);
    assert.strictEqual(projectedArtifact.destructive, true);
    assert.ok(typeGroup);
    assert.strictEqual(typeGroup.destructive, undefined, 'presentation groups must not invent destructive actions');
  });

  test('attaches typed BSL aliases to nested Form owners and refuses aliases that resolve ambiguously', () => {
    const catalog = ownerNode({
      id: 'metadata:catalog',
      label: 'Catalog.Products',
      status: 'equal',
      ownerKey: 'Catalog:name:Catalog.Products',
      aliases: ['Catalog:name:Catalog.Products'],
      qualifiedName: 'Catalog.Products',
      metadataType: 'Catalog',
      identities: [identity('left', 'Catalog.Products', 'catalog-products'), identity('right', 'Catalog.Products', 'catalog-products')],
    });
    const edit = ownerNode({
      id: 'metadata:form:edit',
      label: 'Catalog.Products.Form.Edit',
      status: 'equal',
      ownerKey: 'Form:name:Catalog.Products.Form.Edit',
      aliases: ['Form:name:Catalog.Products.Form.Edit'],
      qualifiedName: 'Catalog.Products.Form.Edit',
      metadataType: 'Form',
      identities: [identity('left', 'Catalog.Products.Form.Edit', 'form-edit'), identity('right', 'Catalog.Products.Form.Edit', 'form-edit')],
    });
    const print = ownerNode({
      ...edit,
      id: 'metadata:form:print',
      label: 'Catalog.Products.Form.Print',
      ownerKey: 'Form:name:Catalog.Products.Form.Print',
      aliases: ['Form:name:Catalog.Products.Form.Print'],
      qualifiedName: 'Catalog.Products.Form.Print',
      metadataType: 'Form',
      identities: [identity('left', 'Catalog.Products.Form.Print', 'form-print'), identity('right', 'Catalog.Products.Form.Print', 'form-print')],
    });
    const editModule = bslNode('bsl:module:edit', 'Form:name:Catalog.Products.Form.Edit');
    const printModule = bslNode('bsl:module:print', 'Form:name:Catalog.Products.Form.Print');
    const ambiguousModule = bslNode('bsl:module:ambiguous', 'Form:name:Catalog.Products.Form.Edit');
    const duplicateForm = ownerNode({
      ...edit,
      id: 'metadata:form:edit-duplicate',
      label: 'Catalog.Products.Form.Edit',
      ownerKey: 'Form:name:Catalog.Products.Form.Edit:duplicate',
      aliases: ['Form:name:Catalog.Products.Form.Edit'],
      qualifiedName: 'Catalog.Products.Form.Edit',
      metadataType: 'Form',
      identities: [identity('left', 'Catalog.Products.Form.Edit', 'different-form-edit')],
    });
    const duplicateFormConflict = node({
      id: 'metadata:conflict:form-name-duplicate',
      label: 'Catalog.Products.Form.Edit',
      kind: 'metadataConflict',
      status: 'changed',
      conflict: { kind: 'duplicateQualifiedName', blocking: true, message: 'Имя повторяется.' },
      presentation: {
        ownerKey: 'Form:name:Catalog.Products.Form.Edit',
        ownerAliases: ['Form:name:Catalog.Products.Form.Edit'],
        metadataType: 'Form',
        qualifiedName: 'Catalog.Products.Form.Edit',
        identityConflict: true,
        ambiguousIdentitySet: true,
        identities: [identity('left', 'Catalog.Products.Form.Edit', 'form-edit'), identity('left', 'Catalog.Products.Form.Edit', 'different-form-edit')],
      },
    });

    const display = buildCompareDisplayTree(root([
      metadataGroup([catalog, edit, print, duplicateForm, duplicateFormConflict]),
      branch('bsl', 'bslGroup', [editModule, printModule, ambiguousModule]),
    ]));
    const nodes = flatten(display.root);
    const printOwner = nodes.find((candidate) => candidate.kind === 'metadataOwner' && candidate.qualifiedNames?.includes('Catalog.Products.Form.Print'));
    const editOwners = nodes.filter((candidate) => candidate.kind === 'metadataOwner' && candidate.qualifiedNames?.includes('Catalog.Products.Form.Edit'));

    assert.strictEqual(editOwners.length, 2);
    assert.ok(printOwner);
    assert.ok(printOwner.children.some((child) => child.key === printModule.id));
    assert.ok(nodes.some((candidate) => candidate.key === ambiguousModule.id), 'an ambiguous alias must fall back to the BSL group');
    assert.ok(nodes.some((candidate) => candidate.label === 'Процедуры и функции'));
    assert.ok(nodes.some((candidate) => candidate.key === editModule.id), 'the shared Form QName must not attach to either duplicate identity');
    assert.strictEqual(
      nodes.find((candidate) => candidate.key === duplicateFormConflict.id)?.label,
      'Повтор имени Catalog.Products.Form.Edit'
    );
  });

  test('keeps owner XML and multiple BSL artifact labels distinct under the same proven owner', () => {
    const owner = ownerNode({
      id: 'metadata:catalog:products',
      label: 'Catalog.Products',
      status: 'equal',
      ownerKey: 'Catalog:name:Catalog.Products',
      aliases: ['Catalog:name:Catalog.Products'],
      qualifiedName: 'Catalog.Products',
      metadataType: 'Catalog',
      identities: [identity('left', 'Catalog.Products', 'products'), identity('right', 'Catalog.Products', 'products')],
    });
    const objectModule = bslNode(
      'bsl:module:Catalog.Products.Object',
      'Catalog:name:Catalog.Products',
      'Object'
    );
    const managerModule = bslNode(
      'bsl:module:Catalog.Products.Manager',
      'Catalog:name:Catalog.Products',
      'Manager'
    );
    const descriptor = node({
      id: 'metadataXml:Catalog.Products',
      label: 'Descriptor XML',
      kind: 'metadataXml',
      status: 'changed',
      presentation: {
        ownerAliases: ['Catalog:name:Catalog.Products'],
        metadataType: 'Catalog',
        qualifiedName: 'Catalog.Products',
      },
    });

    const display = buildCompareDisplayTree(root([
      metadataGroup([owner]),
      branch('bsl', 'bslGroup', [objectModule, managerModule]),
      branch('adapterChanges', 'adapterGroup', [descriptor]),
    ]));
    const productOwner = flatten(display.root).find((candidate) =>
      candidate.kind === 'metadataOwner' && candidate.qualifiedNames?.includes('Catalog.Products')
    );

    assert.ok(productOwner);
    assert.deepStrictEqual(
      new Map(productOwner.children.map((child) => [child.key, child.label])),
      new Map([
        [objectModule.id, 'Модуль объекта'],
        [managerModule.id, 'Модуль менеджера'],
        [descriptor.id, 'Свойства'],
      ])
    );
  });

  test('renders each canonical CFE row once and keeps same-base local identities separate', () => {
    const first = extensionRow('extension-row:first', 'Catalog.Products', 'local-products', 'base-products');
    const second = extensionRow('extension-row:second', 'Catalog.ProductsCopy', 'local-copy', 'base-products');
    const display = buildCompareDisplayTree(root([
      branch('extensionObjects', 'extensionObjectGroup', [first, second]),
    ]));
    const nodes = flatten(display.root);

    assert.strictEqual(nodes.filter((candidate) => candidate.canonicalNodeIds.includes(first.id)).length, 1);
    assert.strictEqual(nodes.filter((candidate) => candidate.canonicalNodeIds.includes(second.id)).length, 1);
    const rows = nodes.filter((candidate) => candidate.kind === 'extensionMetadataObject');
    assert.strictEqual(rows.length, 2);
    assert.notStrictEqual(rows[0]!.key, rows[1]!.key);
    assert.ok(nodes.some((candidate) => candidate.label === 'Объекты расширения'));
  });

  test('projects a wide metadata inventory with one display entry per canonical owner', () => {
    const count = 10_000;
    const owners = Array.from({ length: count }, (_unused, index) => ownerNode({
      id: `metadata:owner:${index}`,
      label: `Catalog.Products${index}`,
      status: index % 3 === 0 ? 'changed' : 'equal',
      ownerKey: `Catalog:name:Catalog.Products${index}`,
      aliases: [`Catalog:name:Catalog.Products${index}`],
      qualifiedName: `Catalog.Products${index}`,
      metadataType: 'Catalog',
      identities: [identity('left', `Catalog.Products${index}`, `uuid-${index}`)],
    }));
    const display = buildCompareDisplayTree(root([metadataGroup(owners)]));
    const projectedOwners = flatten(display.root).filter((candidate) => candidate.kind === 'metadataOwner');

    assert.strictEqual(projectedOwners.length, count);
    assert.strictEqual(new Set(projectedOwners.flatMap((owner) => owner.canonicalNodeIds)).size, count);
    assert.strictEqual(display.root.canonicalNodeIds.length, 0, 'presentation groups must not fabricate canonical IDs');
  });

  test('uses a Russian display label for every registered metadata root type', () => {
    const owners = METADATA_TYPE_DESCRIPTORS.map((descriptor, index) => {
      const qualifiedName = `${descriptor.type}.DisplayLabel${index}`;
      return ownerNode({
        id: `metadata:label:${descriptor.type}`,
        label: qualifiedName,
        status: 'equal',
        ownerKey: `${descriptor.type}:name:${qualifiedName}`,
        aliases: [`${descriptor.type}:name:${qualifiedName}`],
        qualifiedName,
        metadataType: descriptor.type,
        identities: [
          identity('left', qualifiedName, `label-${index}`),
          identity('right', qualifiedName, `label-${index}`),
        ],
      });
    });
    const display = buildCompareDisplayTree(root([metadataGroup(owners)]));
    const nodes = flatten(display.root);

    assert.strictEqual(METADATA_TYPE_DESCRIPTORS.length, 46);
    for (const descriptor of METADATA_TYPE_DESCRIPTORS) {
      const typeGroup = nodes.find((candidate) =>
        candidate.kind === 'metadataTypeGroup' &&
        candidate.children.some((child) => child.metadataType === descriptor.type)
      );
      assert.ok(typeGroup, `${descriptor.type} should have a display group`);
      assert.notStrictEqual(typeGroup.label, descriptor.type, `${descriptor.type} needs a Russian label`);
    }
  });
});

function root(children: CompareTreeNode[]): CompareTreeNode {
  return { id: 'configCompare', label: 'Compare', kind: 'configCompare', status: 'changed', children };
}

function metadataGroup(children: CompareTreeNode[]): CompareTreeNode {
  return { id: 'metadata', label: 'Metadata', kind: 'metadataGroup', status: 'changed', children };
}

function branch(id: string, kind: string, children: CompareTreeNode[]): CompareTreeNode {
  return { id, label: id, kind, status: 'changed', children };
}

function ownerNode(input: {
  id: string;
  label: string;
  status: CompareTreeStatus;
  ownerKey: string;
  aliases: string[];
  qualifiedName: string;
  metadataType: string;
  identities: NonNullable<CompareTreeNode['presentation']>['identities'];
  mergeable?: boolean;
  children?: CompareTreeNode[];
}): CompareTreeNode {
  return {
    id: input.id,
    label: input.label,
    kind: 'metadataObject',
    status: input.status,
    mergeable: input.mergeable ?? false,
    presentation: {
      ownerKey: input.ownerKey,
      ownerAliases: input.aliases,
      qualifiedName: input.qualifiedName,
      metadataType: input.metadataType,
      identities: input.identities,
    },
    children: input.children ?? [],
  };
}

function node(input: Partial<CompareTreeNode> & Pick<CompareTreeNode, 'id' | 'label' | 'kind' | 'status'>): CompareTreeNode {
  return {
    ...input,
    children: input.children ?? [],
  };
}

function bslNode(id: string, alias: string, moduleKind = 'Form'): CompareTreeNode {
  const separator = alias.indexOf(':');
  const metadataType = separator > 0 ? alias.slice(0, separator) : 'Form';
  return node({
    id,
    label: id,
    kind: 'bslModule',
    status: 'changed',
    presentation: {
      ownerAliases: [alias],
      metadataType,
      moduleKind,
      qualifiedName: alias.slice(separator + 1),
    },
  });
}

function extensionRow(id: string, qualifiedName: string, uuid: string, sourceUuid: string): CompareTreeNode {
  return node({
    id,
    label: qualifiedName,
    kind: 'extensionMetadataObject',
    status: 'changed',
    presentation: {
      ownerKey: `extension-row:${id}`,
      ownerAliases: [`extension-row:${id}`],
      metadataType: 'Catalog',
      qualifiedName,
      identities: [{ side: 'left', qualifiedName, uuid, ownership: 'adopted', sourceUuid }],
    },
  });
}

function identity(side: 'left' | 'right', qualifiedName: string, uuid: string) {
  return { side, qualifiedName, uuid };
}

function flatten(root: CompareDisplayNode): CompareDisplayNode[] {
  return [root, ...root.children.flatMap((child) => flatten(child))];
}
