import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';

import { buildConfigurationCompare } from '../../../src/compareMerge/configurationCompareService';
import {
  createExtensionAdoptedUuidSnapshot,
  prepareExtensionAdoptedSemanticRow,
} from '../../../src/compareMerge/extensions/extensionAdoptedSemanticHost';
import { indexExtensionMetadataRoot, type ExtensionIndexedObject, type ExtensionMetadataIndex } from '../../../src/compareMerge/extensions/extensionMetadataIndex';
import { analyzeExtensionTransfers, type ExtensionTransferRow } from '../../../src/compareMerge/extensions/extensionTransfer';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import { elementChildren, parseXmlDocument, textContent, type XmlElement } from '../../../src/compareMerge/xml/xmlDom';
import { parseCfeObjectIdentity } from '../../../src/extensionSupport/cfeProject/ownership';
import { createMergeMutationTestRuntime } from './mergeMutationTestSupport';
import {
  createExtensionCompareTempRoot,
  metadataObjectXml,
  writeDesignerConfiguration,
  type ExtensionCompareObjectFixture,
} from '../../helpers/extensionCompareFixtures';

const MD = 'http://v8.1c.ru/8.3/MDClasses';
const ROOT_UUID = '11111111-1111-4111-8111-111111111111';
const CONFIGURATION_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REGISTERED_FORM_UUID = '22222222-2222-4222-8222-222222222222';
const REGISTERED_FORM_CHILD_UUID = '33333333-3333-4333-8333-333333333333';
const UNREGISTERED_TEMPLATE_UUID = '44444444-4444-4444-8444-444444444444';
const BODY_UUID = '55555555-5555-4555-8555-555555555555';
const TARGET_OWNER_UUID = '66666666-6666-4666-8666-666666666666';
const TARGET_LOCAL_UUID = '77777777-7777-4777-8777-777777777777';
const COLLISION_UUID = '88888888-8888-4888-8888-888888888888';
const TARGET_COLLISION_OWNER_UUID = '99999999-9999-4999-8999-999999999999';
const UNIQUE_PROMOTION_UUID = 'abababab-abab-4bab-8bab-abababababab';
const SECOND_OWNER_UUID = 'acacacac-acac-4cac-8cac-acacacacacac';
const NESTED_FORM_LOCAL_UUID = 'adadadad-adad-4dad-8dad-adadadadadad';
const TABULAR_SECTION_UUID = 'aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae';
const NEW_SOURCE_CHILD_UUID = 'afafafaf-afaf-4faf-8faf-afafafafafaf';

suite('Extension adopted compare-global UUID ownership (#335)', () => {
  test('does not preview CFE-to-CF child promotion when another target owner already has its UUID', async () => {
    const tempRoot = await createExtensionCompareTempRoot('issue335-adopted-uuid-public-');
    const targetPath = path.join(tempRoot, 'target-cf');
    const sourcePath = path.join(tempRoot, 'incoming-cfe');
    const targetProduct = mdClasses({ type: 'Catalog', name: 'Products', uuid: TARGET_OWNER_UUID, propertiesXml: '<Synonym>target-only</Synonym>' });
    const targetCollision = mdClasses({
      type: 'Catalog', name: 'Other', uuid: TARGET_COLLISION_OWNER_UUID,
      childObjectsXml: `<Attribute uuid="${COLLISION_UUID}"><Properties><Name>Existing</Name></Properties></Attribute>`,
    });
    const incomingProduct = mdClasses({
      type: 'Catalog', name: 'Products', uuid: TARGET_LOCAL_UUID, belonging: 'Adopted', anchorUuid: TARGET_OWNER_UUID,
      propertiesXml: '<Synonym>incoming own child collision</Synonym>',
      childObjectsXml: `<Attribute uuid="${COLLISION_UUID}"><Properties><Name>Promoted</Name></Properties></Attribute>`,
    });
    await writeDesignerConfiguration(targetPath, { name: 'Shared', objects: [targetProduct, targetCollision] });
    await writeDesignerConfiguration(sourcePath, { name: 'Shared', purpose: 'Customization', objects: [incomingProduct] });
    await namespaceConfiguration(targetPath);
    await namespaceConfiguration(sourcePath);

    const runtime = await createMergeMutationTestRuntime(targetPath);
    try {
      const result = await buildConfigurationCompare({
        leftRootPath: targetPath,
        rightRootPath: sourcePath,
        backupRootPath: path.join(tempRoot, 'backups'),
        extensionBaseRoots: { right: targetPath },
        mutationEngine: runtime.engine,
        configurationId: runtime.configurationId,
      });
      try {
        const row = collectNodes(result.projection.root).find((node) => node.kind === 'extensionMetadataObject' && node.label === 'Catalog.Products');
        assert.ok(row, 'the proven adopted owner remains visible');
        const child = collectNodes(row!).find((node) => node.kind === 'xmlElement'
          && node.label === 'Promoted');
        assert.ok(child, `the promoted child is exposed as an individual semantic choice: ${JSON.stringify(collectNodes(row!).map((node) => ({ label: node.label, rightValue: node.rightValue, mergeable: node.mergeable, state: node.mergeState })))}`);

        const preview = await result.workspace.createPreviewForNodeIds([child!.id]);

        assert.strictEqual(preview.ok, false, `a compare-global UUID collision must reject selection before preview: ${JSON.stringify(preview)}`);
      } finally {
        result.workspace.dispose();
      }
    } finally {
      await runtime.coordinator.dispose();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('captures Configuration UUID and UUIDs from registered nested metadata descriptors only', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'issue335-adopted-uuid-'));
    try {
      await writeDesignerConfiguration(rootPath, {
        uuid: CONFIGURATION_UUID,
        name: 'UUID registry fixture',
        registrations: [{ type: 'Catalog', name: 'Products' }],
      });
      await namespaceConfiguration(rootPath);
      const descriptorRelativePath = 'Catalogs/Products.xml';
      const descriptorContent = Buffer.from(
        `<MetaDataObject xmlns="${MD}" version="2.20"><Catalog uuid="${ROOT_UUID}"><Properties><Name>Products</Name></Properties><ChildObjects><Form>Main</Form></ChildObjects></Catalog></MetaDataObject>`,
        'utf8',
      );
      const formDescriptorRelativePath = 'Catalogs/Products/Forms/Main.xml';
      const formDescriptorContent = Buffer.from(
        `<MetaDataObject xmlns="${MD}" version="2.20"><Form uuid="${REGISTERED_FORM_UUID}"><Properties><Name>Main</Name></Properties><ChildObjects><Attribute uuid="${REGISTERED_FORM_CHILD_UUID}"><Properties><Name>Data</Name></Properties></Attribute></ChildObjects></Form></MetaDataObject>`,
        'utf8',
      );
      const templateDescriptorContent = Buffer.from(
        `<MetaDataObject xmlns="${MD}" version="2.20"><Template uuid="${UNREGISTERED_TEMPLATE_UUID}"><Properties><Name>Unregistered</Name></Properties></Template></MetaDataObject>`,
        'utf8',
      );
      const formBodyContent = Buffer.from(`<Form uuid="${BODY_UUID}"/>`, 'utf8');
      await writeFile(rootPath, descriptorRelativePath, descriptorContent);
      await writeFile(rootPath, formDescriptorRelativePath, formDescriptorContent);
      await writeFile(rootPath, 'Catalogs/Products/Templates/Unregistered.xml', templateDescriptorContent);
      await writeFile(rootPath, 'Catalogs/Products/Forms/Main/Ext/Form.xml', formBodyContent);

      const object = indexedObject(rootPath, descriptorRelativePath, descriptorContent, [
        { relativePath: formDescriptorRelativePath, content: formDescriptorContent },
        { relativePath: 'Catalogs/Products/Templates/Unregistered.xml', content: templateDescriptorContent },
        { relativePath: 'Catalogs/Products/Forms/Main/Ext/Form.xml', content: formBodyContent },
      ]);
      const configurationContent = await fs.readFile(path.join(rootPath, 'Configuration.xml'));
      const targetRoot: ExtensionMetadataIndex = {
        rootPath,
        canonicalRootPath: rootPath,
        sourceId: 'target',
        side: 'left',
        rootKind: 'cf',
        hasConfigurationXml: true,
        configurationContent,
        configurationHash: hash(configurationContent),
        configurationUuid: CONFIGURATION_UUID,
        configurationName: 'UUID registry fixture',
        formatVersion: '2.20',
        objects: [object],
        diagnostics: [],
        cfeMarkerSeen: false,
      };

      const snapshot = await createExtensionAdoptedUuidSnapshot({ targetRoot, incomingRoot: targetRoot });

      assert.ok(snapshot.reservedTargetUuids.has(CONFIGURATION_UUID));
      assert.ok(snapshot.reservedTargetUuids.has(REGISTERED_FORM_UUID));
      assert.ok(snapshot.reservedTargetUuids.has(REGISTERED_FORM_CHILD_UUID));
      assert.ok(!snapshot.reservedTargetUuids.has(UNREGISTERED_TEMPLATE_UUID), 'unregistered XML is not a metadata identity source');
      assert.ok(!snapshot.reservedTargetUuids.has(BODY_UUID), 'Form.xml visual/body UUIDs are outside the metadata registry');
    } finally {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });

  test('allows a unique promoted child and writes it without rewriting its UUID', async () => withPublicCompare({
    targetObjects: [catalog('Products', TARGET_OWNER_UUID)],
    incomingObjects: [adoptedCatalog('Products', TARGET_LOCAL_UUID, TARGET_OWNER_UUID, [attribute(UNIQUE_PROMOTION_UUID, 'Promoted')])],
  }, async ({ result, targetPath }) => {
    const child = findNode(result.projection.root, 'Catalog.Products', 'Promoted');
    assert.ok(child, 'unique source child is selectable');
    if (!child) { return; }
    const preview = await result.workspace.createPreviewForNodeIds([child.id]);
    assert.strictEqual(preview.ok, true, JSON.stringify(preview));
    if (!preview.ok) { return; }
    assert.strictEqual(result.workspace.approvePreview(preview.preview.previewId).ok, true);
    const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId, { destructiveConfirmed: true });
    assert.strictEqual(execution.ok, true, JSON.stringify(execution));
    const output = await fs.readFile(path.join(targetPath, 'Catalogs', 'Products.xml'), 'utf8');
    assert.match(output, new RegExp(`<Attribute uuid="${UNIQUE_PROMOTION_UUID}"[\\s\\S]*?<Name>Promoted</Name>`, 'u'));
  }));

  test('blocks a promoted Attribute UUID already used by another owner under a different child kind and name', async () => withPublicCompare({
    targetObjects: [
      catalog('Products', TARGET_OWNER_UUID),
      catalog('Other', TARGET_COLLISION_OWNER_UUID, [dimension(COLLISION_UUID, 'DifferentKind')]),
    ],
    incomingObjects: [adoptedCatalog('Products', TARGET_LOCAL_UUID, TARGET_OWNER_UUID, [attribute(COLLISION_UUID, 'Promoted')])],
  }, async ({ result }) => {
    const child = findNode(result.projection.root, 'Catalog.Products', 'Promoted');
    assert.ok(child);
    if (!child) { return; }
    const preview = await result.workspace.createPreviewForNodeIds([child.id]);
    assert.strictEqual(preview.ok, false, `UUID uniqueness is global across metadata kinds and names: ${JSON.stringify(preview)}`);
  }));

  test('blocks a promoted child UUID captured from a registered nested Form descriptor', async () => withPublicCompare({
    targetObjects: [catalog('Products', TARGET_OWNER_UUID, ['<Form>Main</Form>'])],
    incomingObjects: [adoptedCatalog('Products', TARGET_LOCAL_UUID, TARGET_OWNER_UUID, [attribute(COLLISION_UUID, 'Promoted')])],
    targetFiles: [{
      relativePath: 'Catalogs/Products/Forms/Main.xml',
      content: nestedFormDescriptor(COLLISION_UUID),
    }],
  }, async ({ result }) => {
    const child = findNode(result.projection.root, 'Catalog.Products', 'Promoted');
    assert.ok(child);
    if (!child) { return; }
    const preview = await result.workspace.createPreviewForNodeIds([child.id]);
    assert.strictEqual(preview.ok, false, `registered nested Form UUID must close the target registry: ${JSON.stringify(preview)}`);
  }));

  test('does not expose the whole right-only ChildObjects wrapper as an executable collision bypass', async () => withPublicCompare({
    targetObjects: [catalogWithoutChildObjects('Products', TARGET_OWNER_UUID), catalog('Other', TARGET_COLLISION_OWNER_UUID, [attribute(COLLISION_UUID, 'ExistingElsewhere')])],
    incomingObjects: [adoptedCatalog('Products', TARGET_LOCAL_UUID, TARGET_OWNER_UUID, [attribute(COLLISION_UUID, 'Promoted')])],
  }, async ({ result }) => {
    const container = findChildObjectsContainer(result.projection.root, 'Catalog.Products');
    assert.ok(container, `the right-only container is projected: ${JSON.stringify(collectNodes(result.projection.root).map((node) => ({ label: node.label, kind: node.kind, id: node.id, mergeable: node.mergeable, state: node.mergeState })))}`);
    if (!container) { return; }
    const child = findNode(result.projection.root, 'Catalog.Products', 'Promoted');
    assert.ok(child?.mergeState?.state === 'blocked' && child.mergeState.reason?.includes(COLLISION_UUID), 'the descendant carries the scoped collision reason');
    const wrapperPreview = await result.workspace.createPreviewForNodeIds([container.id]);
    assert.strictEqual(wrapperPreview.ok, false, `the wrapper itself must not bypass child selection policy: ${JSON.stringify(wrapperPreview)}`);
    assert.strictEqual(wrapperPreview.diagnostics[0]?.code, 'CONFIG_COMPARE_UNKNOWN_SELECTION');
    if (!child) { return; }
    const childPreview = await result.workspace.createPreviewForNodeIds([child.id]);
    assert.strictEqual(childPreview.ok, false, `a colliding descendant remains blocked: ${JSON.stringify(childPreview)}`);
  }));

  test('allows a unique child under right-only ChildObjects and rejects stale other-owner proof before preview', async () => withPublicCompare({
    targetObjects: [catalogWithoutChildObjects('Products', TARGET_OWNER_UUID), catalog('Other', TARGET_COLLISION_OWNER_UUID, [attribute(COLLISION_UUID, 'ExistingElsewhere')])],
    incomingObjects: [adoptedCatalog('Products', TARGET_LOCAL_UUID, TARGET_OWNER_UUID, [attribute(UNIQUE_PROMOTION_UUID, 'Promoted')])],
  }, async ({ result, targetPath }) => {
    const child = findNode(result.projection.root, 'Catalog.Products', 'Promoted');
    assert.ok(child, 'the unique descendant remains individually selectable');
    if (!child) { return; }
    await fs.appendFile(path.join(targetPath, 'Catalogs', 'Other.xml'), '\n');
    const preview = await result.workspace.createPreviewForNodeIds([child.id]);
    assert.strictEqual(preview.ok, false, `the child must recheck other-owner UUID witnesses before preview: ${JSON.stringify(preview)}`);
  }));

  test('executes a unique child under a right-only ChildObjects container', async () => withPublicCompare({
    targetObjects: [catalogWithoutChildObjects('Products', TARGET_OWNER_UUID)],
    incomingObjects: [adoptedCatalog('Products', TARGET_LOCAL_UUID, TARGET_OWNER_UUID, [attribute(UNIQUE_PROMOTION_UUID, 'Promoted')])],
  }, async ({ result, targetPath }) => {
    const container = findChildObjectsContainer(result.projection.root, 'Catalog.Products');
    const child = findNode(result.projection.root, 'Catalog.Products', 'Promoted');
    assert.ok(container && child, 'the wrapper and the individual unique child are both projected');
    if (!container || !child) { return; }
    const wrapperPreview = await result.workspace.createPreviewForNodeIds([container.id]);
    assert.strictEqual(wrapperPreview.ok, false);
    assert.strictEqual(wrapperPreview.diagnostics[0]?.code, 'CONFIG_COMPARE_UNKNOWN_SELECTION');
    const preview = await result.workspace.createPreviewForNodeIds([child.id]);
    assert.strictEqual(preview.ok, true, JSON.stringify(preview));
    if (!preview.ok) { return; }
    assert.strictEqual(result.workspace.approvePreview(preview.preview.previewId).ok, true);
    const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId, { destructiveConfirmed: true });
    assert.strictEqual(execution.ok, true, JSON.stringify(execution));
    const output = await fs.readFile(path.join(targetPath, 'Catalogs', 'Products.xml'), 'utf8');
    assert.match(output, new RegExp(`<Attribute uuid="${UNIQUE_PROMOTION_UUID}"[\\s\\S]*?<Name>Promoted</Name>`, 'u'));
  }));

  test('rechecks other-owner UUID proof under lease when a unique child beneath right-only ChildObjects is selected', async () => withPublicCompare({
    targetObjects: [catalogWithoutChildObjects('Products', TARGET_OWNER_UUID), catalog('Other', TARGET_COLLISION_OWNER_UUID, [attribute(COLLISION_UUID, 'ExistingElsewhere')])],
    incomingObjects: [adoptedCatalog('Products', TARGET_LOCAL_UUID, TARGET_OWNER_UUID, [attribute(UNIQUE_PROMOTION_UUID, 'Promoted')])],
  }, async ({ result, targetPath }) => {
    const child = findNode(result.projection.root, 'Catalog.Products', 'Promoted');
    assert.ok(child);
    if (!child) { return; }
    const before = await fs.readFile(path.join(targetPath, 'Catalogs', 'Products.xml'));
    const preview = await result.workspace.createPreviewForNodeIds([child.id]);
    assert.strictEqual(preview.ok, true, JSON.stringify(preview));
    if (!preview.ok) { return; }
    assert.strictEqual(result.workspace.approvePreview(preview.preview.previewId).ok, true);
    await fs.appendFile(path.join(targetPath, 'Catalogs', 'Other.xml'), '\n');
    const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId, { destructiveConfirmed: true });
    assert.strictEqual(execution.ok, false, `a stale global proof must stop execution: ${JSON.stringify(execution)}`);
    assert.deepStrictEqual(await fs.readFile(path.join(targetPath, 'Catalogs', 'Products.xml')), before, 'no partial Product descriptor write occurs');
  }));

  test('keeps unrelated new child and scalar selectable when a sibling promotion collides', async () => withPublicCompare({
    targetObjects: [
      catalog('Products', TARGET_OWNER_UUID, [], '<Synonym>Before</Synonym>'),
      catalog('Other', TARGET_COLLISION_OWNER_UUID, [attribute(COLLISION_UUID, 'Existing')]),
    ],
    incomingObjects: [adoptedCatalog('Products', TARGET_LOCAL_UUID, TARGET_OWNER_UUID, [
      attribute(COLLISION_UUID, 'Conflicting'),
      attribute(UNIQUE_PROMOTION_UUID, 'Independent'),
    ], '<Synonym>After</Synonym>')],
  }, async ({ result }) => {
    const nodes = collectNodes(result.projection.root);
    const conflict = findNode(result.projection.root, 'Catalog.Products', 'Conflicting');
    const independent = findNode(result.projection.root, 'Catalog.Products', 'Independent');
    const synonym = nodes.find((node) => node.kind === 'xmlProperty' && node.label === 'Synonym'
      && node.rightValue === 'After' && node.mergeState?.targetFilePath?.replace(/\\/gu, '/').endsWith('/Catalogs/Products.xml'));
    assert.ok(conflict && independent && synonym, `expected scoped conflict and independent choices: ${JSON.stringify(nodes.map((node) => ({ label: node.label, kind: node.kind, mergeable: node.mergeable })))}`);
    if (!conflict || !independent || !synonym) { return; }
    const preview = await result.workspace.createPreviewForNodeIds([independent.id, synonym.id]);
    assert.strictEqual(preview.ok, true, `unselected collision must not poison sibling changes: ${JSON.stringify(preview)}`);
    const blockedConflict = await result.workspace.createPreviewForNodeIds([conflict.id]);
    assert.strictEqual(blockedConflict.ok, false, `colliding sibling remains blocked: ${JSON.stringify(blockedConflict)}`);
  }));

  test('blocks a new TabularSection when a nested Attribute UUID collides elsewhere, but permits a unique subtree', async () => {
    await withPublicCompare({
      targetObjects: [
        catalog('Products', TARGET_OWNER_UUID),
        catalog('Other', TARGET_COLLISION_OWNER_UUID, [attribute(COLLISION_UUID, 'Existing')]),
      ],
      incomingObjects: [adoptedCatalog('Products', TARGET_LOCAL_UUID, TARGET_OWNER_UUID, [tabularSection(TABULAR_SECTION_UUID, COLLISION_UUID)])],
    }, async ({ result }) => {
      const section = findNode(result.projection.root, 'Catalog.Products', 'Lines');
      assert.ok(section, 'new TabularSection is individually represented');
      if (!section) { return; }
      const preview = await result.workspace.createPreviewForNodeIds([section.id]);
      assert.strictEqual(preview.ok, false, `parent selection must not bypass a nested UUID collision: ${JSON.stringify(preview)}`);
    });

    await withPublicCompare({
      targetObjects: [catalog('Products', TARGET_OWNER_UUID)],
      incomingObjects: [adoptedCatalog('Products', TARGET_LOCAL_UUID, TARGET_OWNER_UUID, [tabularSection(TABULAR_SECTION_UUID, UNIQUE_PROMOTION_UUID)])],
    }, async ({ result }) => {
      const section = findNode(result.projection.root, 'Catalog.Products', 'Lines');
      assert.ok(section);
      if (!section) { return; }
      const preview = await result.workspace.createPreviewForNodeIds([section.id]);
      assert.strictEqual(preview.ok, true, `unique subtree identities should receive the needed negative proof: ${JSON.stringify(preview)}`);
    });
  });

  test('blocks both incoming promotions when separate owners propose the same new UUID', async () => withPublicCompare({
    targetObjects: [catalog('Products', TARGET_OWNER_UUID), catalog('Services', SECOND_OWNER_UUID)],
    incomingObjects: [
      adoptedCatalog('Products', TARGET_LOCAL_UUID, TARGET_OWNER_UUID, [attribute(UNIQUE_PROMOTION_UUID, 'FirstPromotion')]),
      adoptedCatalog('Services', 'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc', SECOND_OWNER_UUID, [attribute(UNIQUE_PROMOTION_UUID, 'SecondPromotion')]),
    ],
  }, async ({ result }) => {
    for (const [owner, childName] of [['Catalog.Products', 'FirstPromotion'], ['Catalog.Services', 'SecondPromotion']] as const) {
      const child = findNode(result.projection.root, owner, childName);
      assert.ok(child, `${owner} exposes its promotion`);
      if (!child) { continue; }
      const preview = await result.workspace.createPreviewForNodeIds([child.id]);
      assert.strictEqual(preview.ok, false, `both source definitions must be blocked by compare-wide ambiguity: ${owner}: ${JSON.stringify(preview)}`);
    }
  }));

  test('allows a multi-owner batch of unique promotions with shared negative-proof witnesses', async () => withPublicCompare({
    targetObjects: [catalog('Products', TARGET_OWNER_UUID), catalog('Services', SECOND_OWNER_UUID)],
    incomingObjects: [
      adoptedCatalog('Products', TARGET_LOCAL_UUID, TARGET_OWNER_UUID, [attribute(UNIQUE_PROMOTION_UUID, 'ProductsPromotion')]),
      adoptedCatalog('Services', 'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc', SECOND_OWNER_UUID, [attribute(NEW_SOURCE_CHILD_UUID, 'ServicesPromotion')]),
    ],
  }, async ({ result, targetPath }) => {
    const products = findNode(result.projection.root, 'Catalog.Products', 'ProductsPromotion');
    const services = findNode(result.projection.root, 'Catalog.Services', 'ServicesPromotion');
    assert.ok(products && services);
    if (!products || !services) { return; }
    const preview = await result.workspace.createPreviewForNodeIds([products.id, services.id]);
    assert.strictEqual(preview.ok, true, `selected registry witnesses shared across the batch must not conflict: ${JSON.stringify(preview)}`);
    if (!preview.ok) { return; }
    assert.strictEqual(result.workspace.approvePreview(preview.preview.previewId).ok, true);
    const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId, { destructiveConfirmed: true });
    assert.strictEqual(execution.ok, true, JSON.stringify(execution));
    const productsOutput = await fs.readFile(path.join(targetPath, 'Catalogs', 'Products.xml'), 'utf8');
    const servicesOutput = await fs.readFile(path.join(targetPath, 'Catalogs', 'Services.xml'), 'utf8');
    assert.match(productsOutput, new RegExp(`<Attribute uuid="${UNIQUE_PROMOTION_UUID}"`, 'u'));
    assert.match(servicesOutput, new RegExp(`<Attribute uuid="${NEW_SOURCE_CHILD_UUID}"`, 'u'));
  }));

  test('blocks a UUID promoted under a different ancestor scope instead of matching it to the old path', async () => withPublicCompare({
    targetObjects: [catalog('Products', TARGET_OWNER_UUID, [attribute(COLLISION_UUID, 'OwnerAttribute')])],
    incomingObjects: [adoptedCatalog('Products', TARGET_LOCAL_UUID, TARGET_OWNER_UUID, [tabularSection(TABULAR_SECTION_UUID, COLLISION_UUID)])],
  }, async ({ result }) => {
    const section = findNode(result.projection.root, 'Catalog.Products', 'Lines');
    const blocked = collectNodes(result.projection.root).filter((node) => node.kind === 'extensionSemanticFile' && node.mergeState?.state === 'blocked');
    assert.strictEqual(section, undefined, `a UUID moved to a different ancestor cannot be selected as the old child: ${JSON.stringify(collectNodes(result.projection.root).map((node) => ({ label: node.label, kind: node.kind, mergeable: node.mergeable, state: node.mergeState })))}`);
    assert.ok(blocked.some((node) => node.mergeState?.reason?.includes(COLLISION_UUID)), 'the scoped blocker must identify the duplicate global UUID');
  }));

  test('does not attach compare-global UUID witnesses to an independent scalar update', async () => withPublicCompare({
    targetObjects: [catalog('Products', TARGET_OWNER_UUID, [], '<Synonym>Before</Synonym>'), catalog('Other', TARGET_COLLISION_OWNER_UUID)],
    incomingObjects: [adoptedCatalog('Products', TARGET_LOCAL_UUID, TARGET_OWNER_UUID, [], '<Synonym>After</Synonym>')],
  }, async ({ result, targetPath }) => {
    const synonym = collectNodes(result.projection.root).find((node) => node.kind === 'xmlProperty'
      && node.label === 'Synonym' && node.rightValue === 'After');
    assert.ok(synonym);
    if (!synonym) { return; }
    await fs.appendFile(path.join(targetPath, 'Catalogs', 'Other.xml'), '\n');
    const preview = await result.workspace.createPreviewForNodeIds([synonym.id]);
    assert.strictEqual(preview.ok, true, `unrelated owner drift must not add a global registry lease to a scalar: ${JSON.stringify(preview)}`);
  }));

  test('updates an existing target own child when the proven base lacks it and the adopted source uses the same UUID', async () => withPublicCompare({
    targetObjects: [catalog('Products', TARGET_OWNER_UUID, [attribute(COLLISION_UUID, 'Existing', '<Comment>Before</Comment>')])],
    incomingObjects: [adoptedCatalog('Products', TARGET_LOCAL_UUID, TARGET_OWNER_UUID, [
      attribute(COLLISION_UUID, 'Existing', '<Comment>After</Comment>'),
    ])],
    baseObjects: [catalog('Products', TARGET_OWNER_UUID)],
  }, async ({ result, targetPath, sourcePath, basePath }) => {
    const [targetIndex, incomingIndex, baseIndex] = await Promise.all([
      indexExtensionMetadataRoot({ rootPath: targetPath, sourceId: 'left-source', side: 'left' }),
      indexExtensionMetadataRoot({ rootPath: sourcePath, sourceId: 'right-source', side: 'right' }),
      indexExtensionMetadataRoot({ rootPath: basePath, sourceId: 'right-base-source', side: 'right' }),
    ]);
    const transferAnalysis = await analyzeExtensionTransfers({
      target: targetIndex,
      incoming: incomingIndex,
      incomingBase: baseIndex,
      targetBaseIsIncoming: false,
      incomingBaseIsTarget: false,
    });
    const transfer = transferAnalysis.rows.find((row) => row.qualifiedName === 'Catalog.Products');
    assert.strictEqual(transfer?.semanticAction, 'adopted-to-cf-overlay', JSON.stringify({
      transfer: transfer && { semanticAction: transfer.semanticAction, action: transfer.action, reason: transfer.reason },
      roots: [targetIndex, incomingIndex, baseIndex].map((root) => ({ rootKind: root.rootKind, configurationUuid: root.configurationUuid, configurationName: root.configurationName, formatVersion: root.formatVersion })),
    }));
    const comment = collectNodes(result.projection.root).find((node) => node.kind === 'xmlProperty'
      && node.label === 'Comment' && node.rightValue === 'After');
    assert.ok(comment, `the target child absent from the proven base should remain an update, not a promotion collision: ${JSON.stringify(collectNodes(result.projection.root).map((node) => ({ label: node.label, kind: node.kind, mergeable: node.mergeable, state: node.mergeState, left: node.leftValue, right: node.rightValue })))}`);
    if (!comment) { return; }
    const preview = await result.workspace.createPreviewForNodeIds([comment.id]);
    assert.strictEqual(preview.ok, true, JSON.stringify({
      preview,
      nodes: collectNodes(result.projection.root).map((node) => ({ label: node.label, kind: node.kind, mergeable: node.mergeable, state: node.mergeState, left: node.leftValue, right: node.rightValue })),
    }));
    if (!preview.ok) { return; }
    assert.strictEqual(result.workspace.approvePreview(preview.preview.previewId).ok, true);
    const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId, { destructiveConfirmed: true });
    assert.strictEqual(execution.ok, true, JSON.stringify(execution));
    const output = await fs.readFile(path.join(targetPath, 'Catalogs', 'Products.xml'), 'utf8');
    assertUpdatedAttribute(output, COLLISION_UUID);
  }));

  test('updates an existing target Attribute under an adopted TabularSection when the proven base lacks it', async () => withPublicCompare({
    targetObjects: [catalog('Products', TARGET_OWNER_UUID, [
      `<TabularSection uuid="${TABULAR_SECTION_UUID}"><Properties><Name>Lines</Name></Properties><ChildObjects>${attribute(COLLISION_UUID, 'Existing', '<Comment>Before</Comment>')}</ChildObjects></TabularSection>`,
    ])],
    incomingObjects: [adoptedCatalog('Products', TARGET_LOCAL_UUID, TARGET_OWNER_UUID, [
      `<TabularSection uuid="${SECOND_OWNER_UUID}"><Properties><ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>${TABULAR_SECTION_UUID}</ExtendedConfigurationObject><Name>Lines</Name></Properties><ChildObjects>${attribute(COLLISION_UUID, 'Existing', '<Comment>After</Comment>')}</ChildObjects></TabularSection>`,
    ])],
    baseObjects: [catalog('Products', TARGET_OWNER_UUID, [
      `<TabularSection uuid="${TABULAR_SECTION_UUID}"><Properties><Name>Lines</Name></Properties><ChildObjects/></TabularSection>`,
    ])],
  }, async ({ result, targetPath, sourcePath, basePath }) => {
    const [targetIndex, incomingIndex, baseIndex] = await Promise.all([
      indexExtensionMetadataRoot({ rootPath: targetPath, sourceId: 'left-source', side: 'left' }),
      indexExtensionMetadataRoot({ rootPath: sourcePath, sourceId: 'right-source', side: 'right' }),
      indexExtensionMetadataRoot({ rootPath: basePath, sourceId: 'right-base-source', side: 'right' }),
    ]);
    const transferAnalysis = await analyzeExtensionTransfers({
      target: targetIndex,
      incoming: incomingIndex,
      incomingBase: baseIndex,
      targetBaseIsIncoming: false,
      incomingBaseIsTarget: false,
    });
    const transfer = transferAnalysis.rows.find((row) => row.qualifiedName === 'Catalog.Products');
    assert.strictEqual(transfer?.semanticAction, 'adopted-to-cf-overlay', JSON.stringify({
      transfer: transfer && { semanticAction: transfer.semanticAction, action: transfer.action, reason: transfer.reason },
      roots: [targetIndex, incomingIndex, baseIndex].map((root) => ({ rootKind: root.rootKind, configurationUuid: root.configurationUuid, configurationName: root.configurationName, formatVersion: root.formatVersion })),
    }));
    const comment = collectNodes(result.projection.root).find((node) => node.kind === 'xmlProperty'
      && node.label === 'Comment' && node.rightValue === 'After');
    assert.ok(comment, `the target Attribute under the proven TabularSection should remain an update: ${JSON.stringify(collectNodes(result.projection.root).map((node) => ({ label: node.label, kind: node.kind, mergeable: node.mergeable, state: node.mergeState, left: node.leftValue, right: node.rightValue })))}`);
    if (!comment) { return; }
    const preview = await result.workspace.createPreviewForNodeIds([comment.id]);
    assert.strictEqual(preview.ok, true, JSON.stringify({ preview, comment: { id: comment.id, state: comment.mergeState } }));
    if (!preview.ok) { return; }
    assert.strictEqual(result.workspace.approvePreview(preview.preview.previewId).ok, true);
    const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId, { destructiveConfirmed: true });
    assert.strictEqual(execution.ok, true, JSON.stringify(execution));
    const output = await fs.readFile(path.join(targetPath, 'Catalogs', 'Products.xml'), 'utf8');
    assertUpdatedAttribute(output, COLLISION_UUID, TABULAR_SECTION_UUID);
  }));

  test('incomplete nested descriptor capture blocks new-child selection while preserving an independent scalar', async () => withPublicCompare({
    targetObjects: [catalog('Products', TARGET_OWNER_UUID, ['<Form>Main</Form>'], '<Synonym>Before</Synonym>')],
    incomingObjects: [adoptedCatalog('Products', TARGET_LOCAL_UUID, TARGET_OWNER_UUID, [attribute(UNIQUE_PROMOTION_UUID, 'Promoted')], '<Synonym>After</Synonym>')],
    targetFiles: [{ relativePath: 'Catalogs/Products/Forms/Main.xml', content: '<MetaDataObject xmlns="urn:foreign" version="2.20"><Form uuid="broken"/></MetaDataObject>' }],
  }, async ({ result }) => {
    const child = findNode(result.projection.root, 'Catalog.Products', 'Promoted');
    const synonym = collectNodes(result.projection.root).find((node) => node.kind === 'xmlProperty'
      && node.label === 'Synonym' && node.rightValue === 'After');
    assert.ok(child && synonym, 'both the new child and independent scalar are shown');
    if (!child || !synonym) { return; }
    const childPreview = await result.workspace.createPreviewForNodeIds([child.id]);
    assert.strictEqual(childPreview.ok, false, `an incomplete global registry cannot prove new-child uniqueness: ${JSON.stringify(childPreview)}`);
    const scalarPreview = await result.workspace.createPreviewForNodeIds([synonym.id]);
    assert.strictEqual(scalarPreview.ok, true, `incomplete UUID proof is scoped to new-child operations: ${JSON.stringify(scalarPreview)}`);
  }));

  for (const dependency of ['Catalogs/Other.xml', 'Catalogs/Products/Forms/Main.xml', 'Configuration.xml'] as const) {
    test(`rejects a promotion preview when captured registry file ${dependency} changed after comparison`, async () => withPromotionDependency(dependency, async ({ result, targetPath, child }) => {
      await fs.appendFile(path.join(targetPath, dependency), '\n');
      const preview = await result.workspace.createPreviewForNodeIds([child.id]);
      assert.strictEqual(preview.ok, false, `changed global registry capture must invalidate selected promotion: ${dependency} ${JSON.stringify(preview)}`);
    }));

    test(`rechecks ${dependency} under the execution lease for a selected promotion`, async () => withPromotionDependency(dependency, async ({ result, targetPath }) => {
      const child = findNode(result.projection.root, 'Catalog.Products', 'Promoted');
      assert.ok(child);
      if (!child) { return; }
      const before = await fs.readFile(path.join(targetPath, 'Catalogs', 'Products.xml'));
      const preview = await result.workspace.createPreviewForNodeIds([child.id]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      if (!preview.ok) { return; }
      assert.strictEqual(result.workspace.approvePreview(preview.preview.previewId).ok, true);
      await fs.appendFile(path.join(targetPath, dependency), '\n');
    const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId, { destructiveConfirmed: true });
      assert.strictEqual(execution.ok, false, `lease must reject stale ${dependency}: ${JSON.stringify(execution)}`);
      assert.deepStrictEqual(await fs.readFile(path.join(targetPath, 'Catalogs', 'Products.xml')), before, 'no partial target write may occur');
    }));
  }

  for (const collision of [CONFIGURATION_UUID, NESTED_FORM_LOCAL_UUID] as const) {
    test(`rejects CF-to-CFE local allocation that collides with registered target UUID ${collision}`, async () => withHostPromotion(collision, async ({ prepared, snapshot }) => {
      assert.strictEqual(prepared.applicable, true);
      if (!prepared.applicable) { return; }
      assert.ok(prepared.blockers.some((blocker) => /уже существует|конфликт/u.test(blocker.reason)), JSON.stringify(prepared.blockers));
      assert.strictEqual(prepared.artifacts.some((artifact) => artifact.kind === 'metadataXml'), false);
      assert.strictEqual(snapshot.childUuidByAnchor.size, 0, 'a rejected allocation must not leave a partial local-UUID map');
    }));
  }
});

function mdClasses(fixture: ExtensionCompareObjectFixture): ExtensionCompareObjectFixture {
  return {
    ...fixture,
    descriptorXml: metadataObjectXml(fixture).replace('<MetaDataObject', `<MetaDataObject xmlns="${MD}"`),
  };
}

function collectNodes(root: CompareTreeNode): CompareTreeNode[] {
  return [root, ...root.children.flatMap(collectNodes)];
}

function indexedObject(
  rootPath: string,
  descriptorRelativePath: string,
  descriptorContent: Buffer,
  sidecarFiles: readonly { relativePath: string; content: Buffer }[],
  side: 'left' | 'right' = 'left',
  sourceId = 'target',
): ExtensionIndexedObject {
  return {
    side,
    sourceId,
    metadataType: 'Catalog',
    name: 'Products',
    qualifiedName: 'Catalog.Products',
    descriptorRelativePath,
    sidecarRelativePath: 'Catalogs/Products',
    identity: parseCfeObjectIdentity(descriptorContent.toString('utf8'), descriptorRelativePath),
    descriptorContent,
    descriptorHash: hash(descriptorContent),
    sidecarFiles: sidecarFiles.map(({ relativePath, content }) => ({
      relativePath,
      content: Buffer.from(content),
      hash: hash(content),
      ...(relativePath.endsWith('.xml') ? { rootExpandedName: rootExpandedName(content) } : {}),
    })),
    supportedRootType: true,
    valid: true,
  };
}

async function writeFile(rootPath: string, relativePath: string, content: Buffer): Promise<void> {
  const absolutePath = path.join(rootPath, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content);
}

function rootExpandedName(content: Buffer): string {
  const match = /<(?:(?<prefix>[\w.-]+):)?(?<local>[\w.-]+)(?:\s|>)/u.exec(content.toString('utf8'));
  if (!match?.groups?.local) { return ''; }
  return match.groups.local === 'MetaDataObject' ? `{${MD}}MetaDataObject` : match.groups.local;
}

function hash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function assertUpdatedAttribute(xml: string, uuid: string, tabularSectionUuid?: string): void {
  const document = parseXmlDocument(xml);
  const catalogElement = elementChildren(document.root).find((child) => child.localName === 'Catalog');
  assert.ok(catalogElement, 'output contains a Catalog metadata root');
  if (!catalogElement) { return; }
  let childObjects = requireDirectChild(catalogElement, 'ChildObjects');
  if (tabularSectionUuid) {
    const section = elementChildren(childObjects).find((child) => child.localName === 'TabularSection'
      && child.attributes.some((attribute) => attribute.localName === 'uuid' && attribute.value.toLowerCase() === tabularSectionUuid.toLowerCase()));
    assert.ok(section, `output retains TabularSection ${tabularSectionUuid}`);
    if (!section) { return; }
    childObjects = requireDirectChild(section, 'ChildObjects');
  }
  const attributes = elementChildren(childObjects).filter((child) => child.localName === 'Attribute'
    && child.attributes.some((attribute) => attribute.localName === 'uuid' && attribute.value.toLowerCase() === uuid.toLowerCase()));
  assert.strictEqual(attributes.length, 1, `output contains exactly one direct Attribute with UUID ${uuid}`);
  const attribute = attributes[0];
  if (!attribute) { return; }
  const properties = requireDirectChild(attribute, 'Properties');
  assert.strictEqual(textContent(requireDirectChild(properties, 'Name')).trim(), 'Existing');
  assert.strictEqual(textContent(requireDirectChild(properties, 'Comment')).trim(), 'After');
}

function requireDirectChild(parent: XmlElement, localName: string): XmlElement {
  const match = elementChildren(parent).find((child) => child.localName === localName);
  if (!match) { throw new Error(`Missing direct ${localName} under ${parent.localName}`); }
  return match;
}

type PublicCompareResult = Awaited<ReturnType<typeof buildConfigurationCompare>>;

interface PublicCompareContext {
  readonly result: PublicCompareResult;
  readonly targetPath: string;
  readonly sourcePath: string;
  readonly basePath: string;
  readonly tempRoot: string;
}

async function withPublicCompare(
  input: {
    readonly targetObjects: readonly ExtensionCompareObjectFixture[];
    readonly incomingObjects: readonly ExtensionCompareObjectFixture[];
    readonly baseObjects?: readonly ExtensionCompareObjectFixture[];
    readonly targetFiles?: readonly { readonly relativePath: string; readonly content: string | Buffer }[];
  },
  run: (context: PublicCompareContext) => Promise<void>,
): Promise<void> {
  const tempRoot = await createExtensionCompareTempRoot('issue335-adopted-uuid-matrix-');
  const targetPath = path.join(tempRoot, 'target-cf');
  const sourcePath = path.join(tempRoot, 'incoming-cfe');
  const basePath = input.baseObjects ? path.join(tempRoot, 'captured-base-cf') : targetPath;
  await writeDesignerConfiguration(targetPath, { name: 'UUID matrix configuration', objects: input.targetObjects.map(mdClasses) });
  await writeDesignerConfiguration(sourcePath, {
    name: 'UUID matrix configuration',
    purpose: 'Customization',
    objects: input.incomingObjects.map(mdClasses),
  });
  if (input.baseObjects) {
    await writeDesignerConfiguration(basePath, { name: 'UUID matrix configuration', objects: input.baseObjects.map(mdClasses) });
  }
  await namespaceConfiguration(targetPath);
  await namespaceConfiguration(sourcePath);
  if (input.baseObjects) { await namespaceConfiguration(basePath); }
  for (const file of input.targetFiles ?? []) {
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8');
    await writeFile(targetPath, file.relativePath, content);
  }

  const runtime = await createMergeMutationTestRuntime(targetPath);
  try {
    const result = await buildConfigurationCompare({
      leftRootPath: targetPath,
      rightRootPath: sourcePath,
      backupRootPath: path.join(tempRoot, 'backups'),
      extensionBaseRoots: { right: basePath },
      mutationEngine: runtime.engine,
      configurationId: runtime.configurationId,
    });
    try {
      await run({ result, targetPath, sourcePath, basePath, tempRoot });
    } finally {
      result.workspace.dispose();
    }
  } finally {
    await runtime.coordinator.dispose();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function withPromotionDependency(
  dependency: 'Catalogs/Other.xml' | 'Catalogs/Products/Forms/Main.xml' | 'Configuration.xml',
  run: (context: PublicCompareContext & { readonly child: CompareTreeNode }) => Promise<void>,
): Promise<void> {
  const hasNestedForm = dependency === 'Catalogs/Products/Forms/Main.xml';
  const targetObjects = [
    catalog('Products', TARGET_OWNER_UUID, hasNestedForm ? ['<Form>Main</Form>'] : []),
    ...(dependency === 'Catalogs/Other.xml' ? [catalog('Other', TARGET_COLLISION_OWNER_UUID)] : []),
  ];
  await withPublicCompare({
    targetObjects,
    incomingObjects: [adoptedCatalog('Products', TARGET_LOCAL_UUID, TARGET_OWNER_UUID, [attribute(UNIQUE_PROMOTION_UUID, 'Promoted')])],
    ...(hasNestedForm ? { targetFiles: [{ relativePath: dependency, content: nestedFormDescriptor(REGISTERED_FORM_UUID) }] } : {}),
  }, async (context) => {
    const child = findNode(context.result.projection.root, 'Catalog.Products', 'Promoted');
    assert.ok(child, `promotion candidate exists before dependency drift: ${dependency}`);
    if (!child) { return; }
    await run({ ...context, child });
  });
}

function catalog(
  name: string,
  uuid: string,
  childObjects: readonly string[] = [],
  propertiesXml = '',
): ExtensionCompareObjectFixture {
  return { type: 'Catalog', name, uuid, childObjectsXml: childObjects.join(''), propertiesXml };
}

function catalogWithoutChildObjects(name: string, uuid: string, propertiesXml = ''): ExtensionCompareObjectFixture {
  return { type: 'Catalog', name, uuid, propertiesXml };
}

function adoptedCatalog(
  name: string,
  uuid: string,
  anchorUuid: string,
  childObjects: readonly string[] = [],
  propertiesXml = '',
): ExtensionCompareObjectFixture {
  return { ...catalog(name, uuid, childObjects, propertiesXml), belonging: 'Adopted', anchorUuid };
}

function attribute(uuid: string, name: string, extraProperties = ''): string {
  return `<Attribute uuid="${uuid}"><Properties><Name>${name}</Name>${extraProperties}</Properties></Attribute>`;
}

function adoptedAttribute(uuid: string, anchorUuid: string, name: string, extraProperties = ''): string {
  return `<Attribute uuid="${uuid}"><Properties><ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>${anchorUuid}</ExtendedConfigurationObject><Name>${name}</Name>${extraProperties}</Properties></Attribute>`;
}

function dimension(uuid: string, name: string): string {
  return `<Dimension uuid="${uuid}"><Properties><Name>${name}</Name><Type xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xs="http://www.w3.org/2001/XMLSchema"><v8:Type>xs:string</v8:Type></Type></Properties></Dimension>`;
}

function tabularSection(uuid: string, childUuid: string): string {
  return `<TabularSection uuid="${uuid}"><Properties><Name>Lines</Name></Properties><ChildObjects>${attribute(childUuid, 'Nested')}</ChildObjects></TabularSection>`;
}

function nestedFormDescriptor(uuid: string): Buffer {
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="${MD}" version="2.20"><Form uuid="${uuid}"><Properties><Name>Main</Name></Properties><ChildObjects/></Form></MetaDataObject>`, 'utf8');
}

function findNode(root: CompareTreeNode, ownerLabel: string, nodeLabel: string): CompareTreeNode | undefined {
  const owner = collectNodes(root).find((node) => node.kind === 'extensionMetadataObject' && node.label === ownerLabel);
  return owner && collectNodes(owner).find((node) => node.kind === 'xmlElement'
    && (node.label === nodeLabel || node.label.includes(nodeLabel)));
}

function findChildObjectsContainer(root: CompareTreeNode, ownerLabel: string): CompareTreeNode | undefined {
  const owner = collectNodes(root).find((node) => node.kind === 'extensionMetadataObject' && node.label === ownerLabel);
  return owner && collectNodes(owner).find((node) => node.kind === 'xmlElement'
    && node.label === 'ChildObjects');
}

async function withHostPromotion(
  allocatedUuid: string,
  run: (context: {
    readonly prepared: Awaited<ReturnType<typeof prepareExtensionAdoptedSemanticRow>>;
    readonly snapshot: Awaited<ReturnType<typeof createExtensionAdoptedUuidSnapshot>>;
  }) => Promise<void>,
): Promise<void> {
  const rootsPath = await fs.mkdtemp(path.join(os.tmpdir(), 'issue335-adopted-allocator-'));
  const targetPath = path.join(rootsPath, 'target-cfe');
  const sourcePath = path.join(rootsPath, 'updated-cf');
  const basePath = path.join(rootsPath, 'base-cf');
  await Promise.all([targetPath, sourcePath, basePath].map((root) => fs.mkdir(root, { recursive: true })));
  try {
    const includeNestedForm = allocatedUuid === NESTED_FORM_LOCAL_UUID;
    const formRegistration = includeNestedForm ? ['<Form>Main</Form>'] : [];
    const nestedFormSidecar = includeNestedForm
      ? [
        { relativePath: 'Catalogs/Products/Forms/Main.xml', content: hostFormDescriptor({ uuid: NESTED_FORM_LOCAL_UUID, adoptedFrom: REGISTERED_FORM_UUID }) },
        { relativePath: 'Catalogs/Products/Forms/Main/Ext/Form.xml', content: hostFormXml('target', true) },
      ]
      : [];
    const targetOwner = await indexedObject(
      targetPath,
      'Catalogs/Products.xml',
      hostCatalogDescriptor({ uuid: TARGET_LOCAL_UUID, adoptedFrom: TARGET_OWNER_UUID, children: formRegistration }),
      nestedFormSidecar,
      'left',
      'target-cfe',
    );
    const sourceOwner = await indexedObject(
      sourcePath,
      'Catalogs/Products.xml',
      hostCatalogDescriptor({ uuid: TARGET_OWNER_UUID, children: [...formRegistration, attribute(NEW_SOURCE_CHILD_UUID, 'Inherited', '<Comment>Incoming</Comment>')] }),
      includeNestedForm
        ? [
          { relativePath: 'Catalogs/Products/Forms/Main.xml', content: hostFormDescriptor({ uuid: REGISTERED_FORM_UUID }) },
          { relativePath: 'Catalogs/Products/Forms/Main/Ext/Form.xml', content: hostFormXml('source') },
        ]
        : [],
      'right',
      'incoming-cf',
    );
    const baseOwner = await indexedObject(
      basePath,
      'Catalogs/Products.xml',
      hostCatalogDescriptor({ uuid: TARGET_OWNER_UUID, children: [...formRegistration, attribute(NEW_SOURCE_CHILD_UUID, 'Inherited', '<Comment>Base</Comment>')] }),
      includeNestedForm
        ? [
          { relativePath: 'Catalogs/Products/Forms/Main.xml', content: hostFormDescriptor({ uuid: REGISTERED_FORM_UUID }) },
          { relativePath: 'Catalogs/Products/Forms/Main/Ext/Form.xml', content: hostFormXml('base') },
        ]
        : [],
      'left',
      'base-cf',
    );
    for (const [root, owner] of [[targetPath, targetOwner], [sourcePath, sourceOwner], [basePath, baseOwner]] as const) {
      await writeFile(root, owner.descriptorRelativePath!, owner.descriptorContent!);
      for (const captured of owner.sidecarFiles) {
        if (captured.content) { await writeFile(root, captured.relativePath, captured.content); }
      }
    }
    const targetRoot = await hostRootIndex(targetPath, 'target-cfe', 'left', 'cfe', [targetOwner]);
    const sourceRoot = await hostRootIndex(sourcePath, 'incoming-cf', 'right', 'cf', [sourceOwner]);
    const baseRoot = await hostRootIndex(basePath, 'base-cf', 'left', 'cf', [baseOwner]);
    const row: ExtensionTransferRow = {
      id: 'Catalog.Products',
      qualifiedName: 'Catalog.Products',
      status: 'changed',
      target: targetOwner,
      incoming: sourceOwner,
      targetRoot,
      incomingRoot: sourceRoot,
      action: 'overlay-adopted',
      mergeable: true,
      targetBase: baseRoot,
      targetBaseIsIncoming: true,
    };
    const snapshot = await createExtensionAdoptedUuidSnapshot({
      targetRoot,
      incomingRoot: sourceRoot,
      allocateUuid: () => allocatedUuid,
    });
    const prepared = await prepareExtensionAdoptedSemanticRow({ row, targetRoot, incomingRoot: sourceRoot, uuidSnapshot: snapshot });
    await run({ prepared, snapshot });
  } finally {
    await fs.rm(rootsPath, { recursive: true, force: true });
  }
}

async function hostRootIndex(
  rootPath: string,
  sourceId: string,
  side: 'left' | 'right',
  rootKind: 'cf' | 'cfe',
  objects: ExtensionIndexedObject[],
): Promise<ExtensionMetadataIndex> {
  await writeDesignerConfiguration(rootPath, {
    uuid: CONFIGURATION_UUID,
    name: 'UUID allocator fixture',
    registrations: [...new Map(objects.map((object) => [object.qualifiedName, { type: object.metadataType as ExtensionCompareObjectFixture['type'], name: object.name }])).values()],
    ...(rootKind === 'cfe' ? { purpose: 'Customization', namePrefix: 'Ext_' } : {}),
  });
  await namespaceConfiguration(rootPath);
  const configurationContent = await fs.readFile(path.join(rootPath, 'Configuration.xml'));
  return {
    rootPath,
    canonicalRootPath: rootPath,
    sourceId,
    side,
    rootKind,
    hasConfigurationXml: true,
    configurationContent,
    configurationHash: hash(configurationContent),
    formatVersion: '2.20',
    configurationUuid: CONFIGURATION_UUID,
    configurationName: 'UUID allocator fixture',
    ...(rootKind === 'cfe' ? { objectBelonging: 'Adopted', purpose: 'Customization', namePrefix: 'Ext_' } : {}),
    objects,
    diagnostics: [],
    cfeMarkerSeen: rootKind === 'cfe',
  };
}

function hostCatalogDescriptor(input: { uuid: string; adoptedFrom?: string; children: readonly string[] }): Buffer {
  const ownership = input.adoptedFrom
    ? `<ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>${input.adoptedFrom}</ExtendedConfigurationObject>`
    : '';
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="${MD}" version="2.20"><Catalog uuid="${input.uuid}"><Properties><Name>Products</Name>${ownership}</Properties><ChildObjects>${input.children.join('')}</ChildObjects></Catalog></MetaDataObject>`, 'utf8');
}

function hostFormDescriptor(input: { uuid: string; adoptedFrom?: string }): Buffer {
  const ownership = input.adoptedFrom
    ? `<ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>${input.adoptedFrom}</ExtendedConfigurationObject>`
    : '';
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="${MD}" version="2.20"><Form uuid="${input.uuid}"><Properties><Name>Main</Name>${ownership}</Properties><ChildObjects/></Form></MetaDataObject>`, 'utf8');
}

function hostFormXml(title: string, borrowed = false): Buffer {
  const baseForm = borrowed ? '<BaseForm/>' : '';
  return Buffer.from(`<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20"><AutoCommandBar name="FormCommandBar" id="-1"/><ChildItems><InputField name="Field" id="1"><Title>${title}</Title></InputField></ChildItems><Attributes/><Commands/><Parameters/>${baseForm}</Form>`, 'utf8');
}

async function namespaceConfiguration(rootPath: string): Promise<void> {
  const configPath = path.join(rootPath, 'Configuration.xml');
  const content = await fs.readFile(configPath, 'utf8');
  const namespaced = content.includes(`xmlns="${MD}"`)
    ? content
    : content.replace('<MetaDataObject ', `<MetaDataObject xmlns="${MD}" `);
  await fs.writeFile(configPath, namespaced, 'utf8');
}
