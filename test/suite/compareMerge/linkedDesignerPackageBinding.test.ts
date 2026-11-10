import * as assert from 'assert';

import { bindLinkedDesignerPackageNodes } from '../../../src/compareMerge/linkedDesignerPackageIndex';
import type { AdapterCompareResult, ExecutableCandidateFactory } from '../../../src/compareMerge/adapters/mergeAdapter';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import type { LinkedDesignerPackageRecipe } from '../../../src/compareMerge/linkedDesignerTypes';

const candidateFactory: ExecutableCandidateFactory = async () => ({ ok: false, diagnostics: [] });

suite('Linked Designer package binding', () => {
  test('keeps package and node getter reads linear as both populations grow', () => {
    const size = 300;
    const reads = { id: 0, kind: 0, children: 0 };
    const nodes: CompareTreeNode[] = [];
    const packages: LinkedDesignerPackageRecipe[] = [];

    for (let index = 0; index < size; index += 1) {
      const name = `Form${index.toString().padStart(3, '0')}`;
      const id = `registration:${name}`;
      nodes.push(instrumentedNode(id, name, reads));
      packages.push(packageRecipe({
        packageId: `package:${name}`,
        qualifiedName: `Catalog.Products.Form.${name}`,
      }));
      packages.push(packageRecipe({
        packageId: `root:${name}`,
        qualifiedName: `Catalog.Products.${name}`,
        rootRegistration: { rootTag: 'Configuration', objectName: name },
      }));
    }

    const result = adapterResult(nodes);
    const bound = bindLinkedDesignerPackageNodes({ results: [result], packages });
    const getterReads = reads.id + reads.kind + reads.children;

    assert.strictEqual(bound.packagesByNodeId.size, size);
    assert.ok(
      getterReads <= 64 * (nodes.length + packages.length),
      `expected linear node indexing; got ${getterReads} id/kind/children reads for ${nodes.length} nodes and ${packages.length} packages`,
    );
  });

  test('keeps blocked-presence overlay traversal linear in nodes and blocked ids', () => {
    const size = 300;
    const reads = { childMaps: 0 };
    const sharedEmptyChildren: CompareTreeNode[] = [];
    Object.defineProperty(sharedEmptyChildren, 'map', {
      value: () => {
        reads.childMaps += 1;
        return sharedEmptyChildren;
      },
    });
    const nodes: CompareTreeNode[] = [];
    const blocked = new Map<string, string>();

    for (let index = 0; index < size; index += 1) {
      const id = `blocked:${index}`;
      blocked.set(id, 'blocked');
      nodes.push({
        id,
        label: id,
        kind: 'xmlElement',
        status: 'rightOnly',
        mergeable: true,
        children: sharedEmptyChildren,
      });
    }

    const bound = bindLinkedDesignerPackageNodes({
      results: [adapterResult(nodes, [...blocked.keys()])],
      packages: [],
      blockedPresenceNodeIds: blocked,
    });

    assert.ok(bound.results[0]!.nodes.every((node) => node.mergeable === false));
    assert.ok(
      reads.childMaps <= 64 * (nodes.length + blocked.size),
      `expected one blocked forest traversal; got ${reads.childMaps} child-array visits for ${nodes.length} nodes and ${blocked.size} blocked ids`,
    );
  });

  test('keeps the first root result with only a factory ahead of a later matching tree node', () => {
    const nodeId = `fileObject:rightOnly:${encodeURIComponent('Catalog.Products.Form.Main')}`;
    const recipe = packageRecipe({
      action: 'copy',
      qualifiedName: 'Catalog.Products.Form.Main',
      rootRegistration: { rootTag: 'Configuration', objectName: 'Products' },
      registrationNodeId: 'preexisting-root-binding',
    });
    const first = adapterResult([], [nodeId]);
    const later = adapterResult([treeNode(nodeId)]);

    const bound = bindLinkedDesignerPackageNodes({ results: [first, later], packages: [recipe] });

    assert.strictEqual(bound.packagesByNodeId.has(nodeId), false);
    assert.strictEqual(recipe.registrationNodeId, 'preexisting-root-binding');
    assert.strictEqual(bound.results[0]!.candidateFactories.has(nodeId), true);
  });

  test('binds the first eligible DFS registration with XML and label fallbacks, normalized names, and suffix paths', () => {
    const form = packageRecipe({
      packageId: 'form',
      qualifiedName: 'Catalog.Products.Form.Café',
      ownerTargetRelativePath: 'Catalogs\\Products.xml',
    });
    const template = packageRecipe({
      packageId: 'template',
      kind: 'Template',
      qualifiedName: 'Catalog.Products.Template.Print',
    });
    const command = packageRecipe({
      packageId: 'command',
      kind: 'Command',
      qualifiedName: 'Catalog.Products.Command.Sync',
    });
    const ineligible = treeNode('changed-first', {
      label: 'Form: Café',
      status: 'changed',
      rightValue: '<Form>Café</Form>',
    });
    const formNode = treeNode('form-registration', {
      label: 'Form: ignored-label',
      rightValue: '<Form>Café</Form>',
      mergeState: { state: 'ready', targetFilePath: 'prefixCatalogs/Products.xml' },
    });
    const templateNode = treeNode('template-registration', {
      label: 'Template: Print',
      rightValue: undefined,
      mergeState: { state: 'ready', targetFilePath: 'target/Catalogs/Products.xml' },
    });
    const commandNode = treeNode('command-registration', {
      label: 'Sync',
      rightValue: undefined,
      mergeState: { state: 'ready', targetFilePath: 'target/Catalogs/Products.xml' },
    });
    const result = adapterResult([treeNode('container', { kind: 'group', children: [
      ineligible,
      formNode,
      templateNode,
      commandNode,
    ] })]);

    const bound = bindLinkedDesignerPackageNodes({ results: [result], packages: [form, template, command] });

    assert.strictEqual(bound.packagesByNodeId.get('form-registration'), form);
    assert.strictEqual(bound.packagesByNodeId.get('template-registration'), template);
    assert.strictEqual(bound.packagesByNodeId.get('command-registration'), command);
    assert.strictEqual(form.registrationNodeId, 'form-registration');
    assert.strictEqual(template.registrationNodeId, 'template-registration');
    assert.strictEqual(command.registrationNodeId, 'command-registration');
  });

  test('keeps earliest DFS selection when owner paths have overlapping suffixes', () => {
    const nestedOwner = packageRecipe({
      packageId: 'nested-owner',
      ownerTargetRelativePath: 'Catalogs/Products.xml',
    });
    const shortOwner = packageRecipe({
      packageId: 'short-owner',
      ownerTargetRelativePath: 'Products.xml',
    });
    const earliest = treeNode('earliest', {
      mergeState: { state: 'ready', targetFilePath: 'base/Catalogs/Products.xml' },
    });
    const later = treeNode('later', {
      mergeState: { state: 'ready', targetFilePath: 'base/Products.xml' },
    });

    const bound = bindLinkedDesignerPackageNodes({
      results: [adapterResult([earliest, later])],
      packages: [nestedOwner, shortOwner],
    });

    assert.strictEqual(nestedOwner.registrationNodeId, 'earliest');
    assert.strictEqual(shortOwner.registrationNodeId, 'earliest');
    assert.strictEqual(bound.packagesByNodeId.get('earliest'), shortOwner);
    assert.strictEqual(bound.packagesByNodeId.has('later'), false);
  });

  test('preserves the truthy slash owner suffix while rejecting empty and absent owners', () => {
    const slashOwner = packageRecipe({ ownerTargetRelativePath: '/' });
    const emptyOwner = packageRecipe({ packageId: 'empty', ownerTargetRelativePath: '' });
    const absentOwner = packageRecipe({ packageId: 'absent', ownerTargetRelativePath: undefined });
    const makeRegistration = (id: string): CompareTreeNode => treeNode(id, {
      mergeState: { state: 'ready', targetFilePath: 'unrelated/target.xml' },
    });

    const slashBound = bindLinkedDesignerPackageNodes({
      results: [adapterResult([makeRegistration('slash')])],
      packages: [slashOwner],
    });
    const emptyBound = bindLinkedDesignerPackageNodes({
      results: [adapterResult([makeRegistration('empty')])],
      packages: [emptyOwner],
    });
    const absentBound = bindLinkedDesignerPackageNodes({
      results: [adapterResult([makeRegistration('absent')])],
      packages: [absentOwner],
    });

    assert.strictEqual(slashBound.packagesByNodeId.get('slash'), slashOwner);
    assert.strictEqual(slashOwner.registrationNodeId, 'slash');
    assert.strictEqual(emptyBound.packagesByNodeId.size, 0);
    assert.strictEqual(absentBound.packagesByNodeId.size, 0);
  });

  test('counts copy and delete registrations together when owner keys and names normalize equally', () => {
    const copy = packageRecipe({
      packageId: 'copy',
      action: 'copy',
      qualifiedName: 'Catalog.Products.Form.Main',
      ownerTargetRelativePath: 'Catalogs\\Products.xml',
      registrationNodeId: 'keep-copy-binding',
    });
    const deletion = packageRecipe({
      packageId: 'delete',
      action: 'delete',
      qualifiedName: 'Catalog.Products.Form.MAIN',
      ownerTargetRelativePath: 'Catalogs/Products.xml',
      registrationNodeId: 'keep-delete-binding',
    });
    const node = treeNode('registration', {
      label: 'Form: Main',
      rightValue: '<Form>Main</Form>',
    });

    const bound = bindLinkedDesignerPackageNodes({ results: [adapterResult([node])], packages: [copy, deletion] });

    assert.strictEqual(bound.packagesByNodeId.has('registration'), false);
    assert.strictEqual(copy.registrationNodeId, 'keep-copy-binding');
    assert.strictEqual(deletion.registrationNodeId, 'keep-delete-binding');
  });

  test('removes only top-level legacy package-presence nodes and keeps nested lookalikes', () => {
    const recipe = packageRecipe({ qualifiedName: 'Catalog.Products.Form.Main' });
    const legacyId = `fileObject:rightOnly:${encodeURIComponent(recipe.qualifiedName)}`;
    const unrelatedTopLevel = treeNode('container', { kind: 'group', children: [treeNode(legacyId, { kind: 'fileObject' })] });
    const topLevel = treeNode(legacyId, { kind: 'fileObject' });
    const inputResult = adapterResult([unrelatedTopLevel, topLevel], [legacyId]);

    const bound = bindLinkedDesignerPackageNodes({ results: [inputResult], packages: [recipe] });
    const projected = bound.results[0]!;

    assert.deepStrictEqual(projected.nodes.map((node) => node.id), ['container']);
    assert.strictEqual(projected.nodes[0]!.children[0]!.id, legacyId);
    assert.strictEqual(projected.candidateFactories.has(legacyId), false);
    assert.deepStrictEqual(inputResult.nodes.map((node) => node.id), ['container', legacyId]);
    assert.strictEqual(inputResult.candidateFactories.has(legacyId), true);

    const nestedOnly = adapterResult([
      treeNode('nested-container', { kind: 'group', children: [treeNode(legacyId, { kind: 'fileObject' })] }),
    ], [legacyId]);
    const nestedOnlyBound = bindLinkedDesignerPackageNodes({ results: [nestedOnly], packages: [recipe] });
    assert.strictEqual(nestedOnlyBound.results[0]!.nodes[0]!.children[0]!.id, legacyId);
    assert.strictEqual(nestedOnlyBound.results[0]!.candidateFactories.has(legacyId), true);
  });

  test('preserves blocked parent and child factory deletion according to insertion order across duplicate ids', () => {
    const parentId = 'presence:parent';
    const childId = 'presence:child';
    const first = adapterResult([
      treeNode(parentId, { children: [treeNode(childId)] }),
    ], [parentId, childId]);
    const second = adapterResult([treeNode(childId)], [childId]);

    const parentFirst = bindLinkedDesignerPackageNodes({
      results: [first, second],
      packages: [],
      blockedPresenceNodeIds: new Map([[parentId, 'parent blocked'], [childId, 'child blocked']]),
    });
    assert.deepStrictEqual([...parentFirst.results[0]!.candidateFactories.keys()], [childId]);
    assert.strictEqual(parentFirst.results[0]!.nodes[0]!.children.length, 0);
    assert.strictEqual(parentFirst.results[1]!.candidateFactories.has(childId), false);
    assert.strictEqual(parentFirst.results[1]!.nodes[0]!.mergeable, false);

    const childFirst = bindLinkedDesignerPackageNodes({
      results: [first],
      packages: [],
      blockedPresenceNodeIds: new Map([[childId, 'child blocked'], [parentId, 'parent blocked']]),
    });
    assert.strictEqual(childFirst.results[0]!.candidateFactories.has(parentId), false);
    assert.strictEqual(childFirst.results[0]!.candidateFactories.has(childId), false);
    assert.strictEqual(childFirst.results[0]!.nodes[0]!.children.length, 0);
    assert.strictEqual(first.candidateFactories.has(parentId), true);
    assert.strictEqual(first.candidateFactories.has(childId), true);
    assert.strictEqual(first.nodes[0]!.children[0]!.mergeable, true);
  });

  test('blocks every repeated occurrence of an id and removes its factory once without mutating input', () => {
    const nodeId = 'presence:duplicated';
    const first = treeNode(nodeId);
    const second = treeNode(nodeId, { label: 'duplicate occurrence' });
    const inputResult = adapterResult([first, second], [nodeId]);

    const bound = bindLinkedDesignerPackageNodes({
      results: [inputResult],
      packages: [],
      blockedPresenceNodeIds: new Map([[nodeId, 'presence is not proven']]),
    });

    assert.strictEqual(bound.results[0]!.candidateFactories.has(nodeId), false);
    assert.ok(bound.results[0]!.nodes.every((node) => node.mergeable === false));
    assert.ok(bound.results[0]!.nodes.every((node) => node.children.length === 0));
    assert.strictEqual(inputResult.candidateFactories.has(nodeId), true);
    assert.strictEqual(inputResult.nodes[0]!.mergeable, true);
    assert.strictEqual(inputResult.nodes[1]!.mergeable, true);
  });

  test('keeps last root binding, mutable recipe ids, and unbound preexisting ids without mutating inputs', () => {
    const rootId = `fileObject:rightOnly:${encodeURIComponent('Catalog.Products.Form.Main')}`;
    const rootFirst = packageRecipe({
      packageId: 'root-first',
      qualifiedName: 'Catalog.Products.Form.Main',
      rootRegistration: { rootTag: 'Configuration', objectName: 'First' },
      registrationNodeId: 'old-first',
    });
    const rootLast = packageRecipe({
      packageId: 'root-last',
      qualifiedName: 'Catalog.Products.Form.Main',
      rootRegistration: { rootTag: 'Configuration', objectName: 'Last' },
      registrationNodeId: 'old-last',
    });
    const unbound = packageRecipe({
      packageId: 'unbound',
      qualifiedName: 'Catalog.Products.Form.Missing',
      registrationNodeId: 'keep-unbound',
    });
    const node = treeNode(rootId, { kind: 'fileObject' });
    const original = adapterResult([node], [rootId]);
    const originalNodes = original.nodes;
    const originalFactories = original.candidateFactories;

    const bound = bindLinkedDesignerPackageNodes({ results: [original], packages: [rootFirst, rootLast, unbound] });

    assert.strictEqual(bound.packagesByNodeId.get(rootId), rootLast);
    assert.strictEqual(rootFirst.registrationNodeId, rootId);
    assert.strictEqual(rootLast.registrationNodeId, rootId);
    assert.strictEqual(unbound.registrationNodeId, 'keep-unbound');
    assert.notStrictEqual(bound.results[0]!.nodes, originalNodes);
    assert.strictEqual(bound.results[0]!.nodes[0], node);
    assert.notStrictEqual(bound.results[0]!.candidateFactories, originalFactories);
    assert.strictEqual(originalFactories.has(rootId), true);
    assert.deepStrictEqual(original.nodes, [node]);
  });
});

function packageRecipe(overrides: Partial<LinkedDesignerPackageRecipe> = {}): LinkedDesignerPackageRecipe {
  return {
    packageId: 'package',
    action: 'copy',
    kind: 'Form',
    qualifiedName: 'Catalog.Products.Form.Main',
    ownerTargetRelativePath: 'Catalogs/Products.xml',
    members: [],
    ...overrides,
  };
}

function treeNode(id: string, overrides: Partial<CompareTreeNode> = {}): CompareTreeNode {
  return {
    id,
    label: 'Form: Main',
    kind: 'xmlElement',
    status: 'rightOnly',
    rightValue: '<Form>Main</Form>',
    mergeable: true,
    mergeState: { state: 'ready', targetFilePath: 'target/Catalogs/Products.xml' },
    children: [],
    ...overrides,
  };
}

function adapterResult(nodes: CompareTreeNode[], factoryIds: readonly string[] = []): AdapterCompareResult {
  const candidateFactories = new Map<string, ExecutableCandidateFactory>();
  for (const id of factoryIds) {
    candidateFactories.set(id, candidateFactory);
  }
  return { nodes, candidateFactories, diagnostics: [] };
}

function instrumentedNode(
  id: string,
  name: string,
  reads: { id: number; kind: number; children: number },
): CompareTreeNode {
  return {
    get id() {
      reads.id += 1;
      return id;
    },
    label: `Form: ${name}`,
    get kind() {
      reads.kind += 1;
      return 'xmlElement';
    },
    status: 'rightOnly',
    get rightValue() {
      return `<Form>${name}</Form>`;
    },
    mergeable: true,
    mergeState: { state: 'ready', targetFilePath: 'target/Catalogs/Products.xml' },
    get children() {
      reads.children += 1;
      return [];
    },
  };
}
