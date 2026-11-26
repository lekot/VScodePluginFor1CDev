import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { buildConfigurationCompare } from '../../../src/compareMerge/configurationCompareService';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import { parseLinkedFormReferenceOwnerState } from '../../../src/compareMerge/linkedDesignerValidation';
import type { LinkedFormReferenceOwnerReference } from '../../../src/compareMerge/linkedDesignerTypes';
import { elementChildren, parseXmlDocument, textContent } from '../../../src/compareMerge/xml/xmlDom';
import { buildConfigurationInventory } from '../../../src/compareMerge/inventory/configurationInventory';
import { indexMetadataFolder } from '../../../src/compareMerge/metadata/metadataIndexer';
import { matchMetadataIdentities } from '../../../src/compareMerge/metadata/metadataMatcher';
import bslModuleIndexerRuntime = require('../../../src/compareMerge/bsl/bslModuleIndexer');
import { buildLinkedDesignerCompareIndex } from '../../../src/compareMerge/linkedDesignerPackageIndex';
import fsPromisesRuntime = require('fs/promises');
import { createMergeMutationTestRuntime } from './mergeMutationTestSupport';
import { writeCompareBytes, writeDesignerConfiguration, type ExtensionCompareObjectFixture } from '../../helpers/extensionCompareFixtures';

const mutationCoordinators: Array<{ dispose(): Promise<void> }> = [];

suite('Linked Designer packages', () => {
  suiteTeardown(async () => {
    await Promise.all(mutationCoordinators.splice(0).map((coordinator) => coordinator.dispose()));
  });

  test('accepts legacy and native metadata namespaces while rejecting foreign or mixed envelopes', () => {
    const reference: LinkedFormReferenceOwnerReference = {
      metadataType: 'Catalog',
      qualifiedName: 'Catalog.Products',
      targetRelativePath: 'Catalogs/Products.xml',
      targetHash: 'a'.repeat(64),
    };
    const nativeNamespace = 'http://v8.1c.ru/8.3/MDClasses';
    const validPayload = '<Properties><Name>Products</Name><DefaultObjectForm>Main</DefaultObjectForm></Properties><ChildObjects><Form>Main</Form></ChildObjects>';
    const accepted = [
      {
        label: 'legacy namespace-less descriptor',
        xml: `<MetaDataObject><Catalog uuid="1">${validPayload}</Catalog></MetaDataObject>`,
      },
      {
        label: 'legacy descriptor with explicit empty namespace resets',
        xml: '<MetaDataObject><Catalog xmlns="" uuid="1"><Properties xmlns=""><Name>Products</Name><DefaultObjectForm>Main</DefaultObjectForm></Properties><ChildObjects xmlns=""><Form>Main</Form></ChildObjects></Catalog></MetaDataObject>',
      },
      {
        label: 'native default namespace descriptor',
        xml: `<MetaDataObject xmlns="${nativeNamespace}"><Catalog uuid="1">${validPayload}</Catalog></MetaDataObject>`,
      },
      {
        label: 'native prefixed namespace descriptor',
        xml: `<md:MetaDataObject xmlns:md="${nativeNamespace}"><md:Catalog uuid="1"><md:Properties><md:Name>Products</md:Name><md:DefaultObjectForm>Main</md:DefaultObjectForm></md:Properties><md:ChildObjects><md:Form>Main</md:Form></md:ChildObjects></md:Catalog></md:MetaDataObject>`,
      },
    ];
    const rejected = [
      {
        label: 'foreign wrapper and owner namespace',
        xml: `<MetaDataObject xmlns="urn:vendor"><Catalog uuid="1">${validPayload}</Catalog></MetaDataObject>`,
      },
      {
        label: 'native wrapper with namespace-less owner',
        xml: `<MetaDataObject xmlns="${nativeNamespace}"><Catalog xmlns="" uuid="1">${validPayload}</Catalog></MetaDataObject>`,
      },
      {
        label: 'namespace-less wrapper with native owner',
        xml: `<MetaDataObject><Catalog xmlns="${nativeNamespace}" uuid="1">${validPayload}</Catalog></MetaDataObject>`,
      },
      {
        label: 'foreign namespace reset on the owner Properties container',
        xml: `<MetaDataObject xmlns="${nativeNamespace}"><Catalog uuid="1"><Properties xmlns="urn:vendor"><Name>Products</Name><DefaultObjectForm>Main</DefaultObjectForm></Properties><ChildObjects><Form>Main</Form></ChildObjects></Catalog></MetaDataObject>`,
      },
      {
        label: 'nested Name cannot prove the root owner name',
        xml: '<MetaDataObject><Catalog uuid="1"><Properties><DefaultObjectForm>Main</DefaultObjectForm></Properties><ChildObjects><Form><Properties><Name>Products</Name></Properties></Form></ChildObjects></Catalog></MetaDataObject>',
      },
    ];

    for (const fixture of accepted) {
      const state = parseLinkedFormReferenceOwnerState(reference, fixture.xml);
      assert.ok(state, `${fixture.label} should be accepted`);
      assert.deepStrictEqual(state!.baselineReferences, [{ propertyName: 'DefaultObjectForm', value: 'Main' }], fixture.label);
      assert.deepStrictEqual(state!.baselineRegisteredForms, ['Main'], fixture.label);
    }
    for (const fixture of rejected) {
      assert.strictEqual(parseLinkedFormReferenceOwnerState(reference, fixture.xml), undefined, fixture.label);
    }
  });

  test('selects a nested Form registration as one captured package and preserves target-only siblings', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linked-designer-package-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const ownerRelative = path.join('Catalogs', 'Products.xml');
    const formDescriptorRelative = path.join('Catalogs', 'Products', 'Forms', 'Main.xml');
    const formXmlRelative = path.join('Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form.xml');
    const moduleRelative = path.join('Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form', 'Module.bsl');
    const modulePath = path.join(rightRoot, moduleRelative);
    const moduleReadPathKeys = new Set([path.resolve(modulePath).toLowerCase()]);
    const originalReadFileDescriptor = Object.getOwnPropertyDescriptor(fsPromisesRuntime, 'readFile')!;
    const originalReadFile = fsPromisesRuntime.readFile;
    let moduleContentReads = 0;
    let result: Awaited<ReturnType<typeof buildConfigurationCompare>> | undefined;

    try {
      const instrumentedReadFile = ((...args: Parameters<typeof originalReadFile>) => {
        if (typeof args[0] === 'string' && moduleReadPathKeys.has(path.resolve(args[0]).toLowerCase())) {
          moduleContentReads += 1;
        }
        return Reflect.apply(originalReadFile, fsPromisesRuntime, args);
      }) as typeof originalReadFile;
      Object.defineProperty(fsPromisesRuntime, 'readFile', { ...originalReadFileDescriptor, value: instrumentedReadFile });
      await writeCatalogConfigurationPair(leftRoot, rightRoot);
      await writeFile(path.join(leftRoot, ownerRelative), catalogDescriptor('Products', false));
      await writeFile(path.join(rightRoot, ownerRelative), catalogDescriptor('Products', true));
      await writeFile(path.join(leftRoot, 'Catalogs', 'Products', 'Forms', 'Legacy.xml'), '<Legacy/>');
      await writeFile(path.join(rightRoot, formDescriptorRelative), formDescriptor('Main'));
      await writeFile(path.join(rightRoot, formXmlRelative), formXml('OnChange'));
      await writeFile(modulePath, [
        'Procedure OnChange()',
        '  Value = 1;',
        'EndProcedure',
      ].join('\n'));
      moduleReadPathKeys.add((await fs.realpath(modulePath)).toLowerCase());

      const runtime = await createMergeMutationTestRuntime(leftRoot);
      mutationCoordinators.push(runtime.coordinator);
      result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
        mutationEngine: runtime.engine,
        configurationId: runtime.configurationId,
      });
      assert.strictEqual(moduleContentReads, 0, 'unpaired package BSL remains path-only until the package is selected');

      const registration = collectNodes(result.projection.root, (node) =>
        node.kind === 'xmlElement' && node.label === 'Форма: Main' && node.status === 'rightOnly'
      )[0];
      assert.ok(registration, 'the new Form registration should be visible');
      assert.strictEqual(registration!.mergeable, true, registration!.mergeState?.reason);
      assert.strictEqual(
        result.workspace.listMergeableNodeIds().includes(registration!.id),
        true,
        'the registration should materialize the linked package'
      );

      const preview = await result.workspace.createPreviewForNodeIds([registration!.id]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      assert.ok(moduleContentReads > 0, 'selected package preview captures the deferred BSL member');
      assert.ok(preview.preview.operationCount >= 4, 'registration, descriptor, Form.xml, and module writes should be previewed');
      result.workspace.approvePreview(preview.preview.previewId);
      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId);
      assert.strictEqual(execution.ok, true, JSON.stringify(execution));

      const finalOwner = parseXmlDocument(await fs.readFile(path.join(leftRoot, ownerRelative), 'utf8')).root;
      const owner = elementChildren(finalOwner).find((node) => node.localName === 'Catalog');
      const childObjects = owner && elementChildren(owner).find((node) => node.localName === 'ChildObjects');
      const forms = childObjects ? elementChildren(childObjects).filter((node) => node.localName === 'Form') : [];
      assert.strictEqual(forms.length, 1);
      assert.strictEqual(textContent(forms[0]!), 'Main');
      assert.strictEqual(await fs.readFile(path.join(leftRoot, formDescriptorRelative), 'utf8'), formDescriptor('Main'));
      assert.strictEqual(await fs.readFile(path.join(leftRoot, formXmlRelative), 'utf8'), formXml('OnChange'));
      assert.match(await fs.readFile(path.join(leftRoot, moduleRelative), 'utf8'), /Procedure OnChange/u);
      assert.strictEqual(await fs.readFile(path.join(leftRoot, 'Catalogs', 'Products', 'Forms', 'Legacy.xml'), 'utf8'), '<Legacy/>');
    } finally {
      Object.defineProperty(fsPromisesRuntime, 'readFile', originalReadFileDescriptor);
      result?.workspace.dispose();
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('captures deferred non-BSL sidecar bytes only when selected for preview', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linked-designer-selected-capture-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const formXmlPath = path.join(rightRoot, 'Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form.xml');
    let result: Awaited<ReturnType<typeof buildConfigurationCompare>> | undefined;
    try {
      await writeCatalogConfigurationPair(leftRoot, rightRoot);
      await writeFile(path.join(leftRoot, 'Catalogs', 'Products.xml'), catalogDescriptor('Products', false));
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products.xml'), catalogDescriptor('Products', true));
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products', 'Forms', 'Main.xml'), formDescriptor('Main'));
      await writeFile(formXmlPath, formXmlWithoutEvent());
      const runtime = await createMergeMutationTestRuntime(leftRoot);
      mutationCoordinators.push(runtime.coordinator);

      result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
        mutationEngine: runtime.engine,
        configurationId: runtime.configurationId,
      });
      const registration = collectNodes(result.workspace.payload.root, (node) =>
        node.kind === 'xmlElement' && node.label === 'Форма: Main' && node.status === 'rightOnly'
      )[0];
      assert.ok(registration?.mergeable, registration?.mergeState?.reason);

      const changedFormXml = formXmlWithoutEvent().replace('<Attributes/>', '<!-- captured when selected --><Attributes/>');
      await writeFile(formXmlPath, changedFormXml);
      const selectedPreview = await result.workspace.createPreviewForNodeIds([registration!.id]);
      assert.strictEqual(selectedPreview.ok, true, JSON.stringify(selectedPreview));
      assert.ok(selectedPreview.preview.operationCount >= 3, 'the selected package should include the registration, descriptor and Form.xml writes');
      result.workspace.approvePreview(selectedPreview.preview.previewId);
      const execution = await result.workspace.executeApprovedPreview(selectedPreview.preview.previewId);
      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      assert.strictEqual(await fs.readFile(path.join(leftRoot, 'Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form.xml'), 'utf8'), changedFormXml);
    } finally {
      result?.workspace.dispose();
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('keeps form-reference owner descriptors hash-only during compare and unrelated routine preview', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linked-designer-owner-reference-lazy-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const ownerPath = path.join(leftRoot, 'Catalogs', 'Products.xml');
    const leftModulePath = path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const rightModulePath = path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const originalReadFileDescriptor = Object.getOwnPropertyDescriptor(fsPromisesRuntime, 'readFile')!;
    const originalReadFile = fsPromisesRuntime.readFile;
    const ownerPathKeys = new Set([path.resolve(ownerPath).toLowerCase()]);
    let ownerReads = 0;
    let result: Awaited<ReturnType<typeof buildConfigurationCompare>> | undefined;
    let runtime: Awaited<ReturnType<typeof createMergeMutationTestRuntime>> | undefined;

    try {
      await writeCatalogConfigurationPair(leftRoot, rightRoot);
      await writeFile(ownerPath, catalogDescriptor('Products', false));
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products.xml'), catalogDescriptor('Products', false));
      await writeFile(leftModulePath, 'Procedure Existing()\nEndProcedure');
      await writeFile(rightModulePath, 'Procedure Existing()\nEndProcedure\nProcedure Added()\nEndProcedure');
      ownerPathKeys.add((await fs.realpath(ownerPath)).toLowerCase());
      runtime = await createMergeMutationTestRuntime(leftRoot);
      mutationCoordinators.push(runtime.coordinator);

      const instrumentedReadFile = ((...args: Parameters<typeof originalReadFile>) => {
        if (typeof args[0] === 'string' && ownerPathKeys.has(path.resolve(args[0]).toLowerCase())) {ownerReads += 1;}
        return Reflect.apply(originalReadFile, fsPromisesRuntime, args);
      }) as typeof originalReadFile;
      Object.defineProperty(fsPromisesRuntime, 'readFile', { ...originalReadFileDescriptor, value: instrumentedReadFile });
      result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
        mutationEngine: runtime.engine,
        configurationId: runtime.configurationId,
      });

      assert.strictEqual(ownerReads, 1, 'compare should use the hydrated descriptor hash instead of rereading owner XML text');
      const readsAfterCompare = ownerReads;
      const routineId = 'bsl:routine:Catalog.Products.Object:added';
      assert.ok(result.workspace.listMergeableNodeIds().includes(routineId));
      const preview = await result.workspace.createPreviewForNodeIds([routineId]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      assert.strictEqual(ownerReads, readsAfterCompare, 'unrelated BSL preview should not load a form-reference owner descriptor');
    } finally {
      Object.defineProperty(fsPromisesRuntime, 'readFile', originalReadFileDescriptor);
      result?.workspace.dispose();
      if (!result && runtime) {await runtime.coordinator.dispose();}
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('does not retain parsed owner XML parents through compact reference values', function () {
    this.timeout(30000);
    const modulePath = path.resolve(process.cwd(), 'out', 'src', 'compareMerge', 'linkedDesignerValidation.js');
    const childScript = `
      const { parseLinkedFormReferenceOwnerState } = require(process.argv[1]);
      const states = [];
      global.gc();
      const before = process.memoryUsage().heapUsed;
      for (let index = 0; index < 1000; index += 1) {
        const name = 'Object' + index;
        const reference = { metadataType: 'Catalog', qualifiedName: 'Catalog.' + name,
          targetRelativePath: 'Catalogs/' + name + '.xml', targetHash: 'a'.repeat(64) };
        const xml = '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses"><Catalog><Properties><Name>' + name
          + '</Name><DefaultObjectForm>Form1</DefaultObjectForm></Properties><Description>' + 'x'.repeat(64 * 1024)
          + '</Description></Catalog></MetaDataObject>';
        states.push(parseLinkedFormReferenceOwnerState(reference, xml));
      }
      global.gc();
      process.stdout.write(JSON.stringify({ count: states.filter(Boolean).length,
        retainedBytes: process.memoryUsage().heapUsed - before }));
    `;
    const output = execFileSync(process.execPath, [
      '--expose-gc', '--max-old-space-size=192', '-e', childScript, modulePath,
    ], { encoding: 'utf8', timeout: 25000 });
    const result = JSON.parse(output) as { count: number; retainedBytes: number };
    assert.strictEqual(result.count, 1000);
    assert.ok(result.retainedBytes < 8 * 1024 * 1024, `retained ${Math.round(result.retainedBytes / 1024 / 1024)} MiB of owner XML`);
  });

  test('rejects a Form delete preview when a new potential owner descriptor appeared after compare', async () => {
    const scenario = await createFullFormDeletionCase();
    try {
      await writeFile(path.join(scenario.leftRoot, 'Catalogs', 'Orders.xml'), catalogDescriptor('Orders', false));
      const preview = await scenario.result.workspace.createPreviewForNodeIds([scenario.registration.id]);
      assert.strictEqual(preview.ok, false, JSON.stringify(preview));
      assert.match(JSON.stringify(preview), /набор metadata owner descriptors изменился после сравнения|descriptor.*после сравнения|состав.*descriptor|владельц.*измен/iu);
    } finally {
      scenario.result.workspace.dispose();
      await fs.rm(scenario.tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('rechecks folder-style metadata owner descriptors without reading XML during the path-set scan', async () => {
    const scenario = await createFullFormDeletionCase(false, 'DefaultObjectForm', true);
    try {
      const preview = await scenario.result.workspace.createPreviewForNodeIds([scenario.registration.id]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
    } finally {
      scenario.result.workspace.dispose();
      await fs.rm(scenario.tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('protects negative form-reference owners and Configuration.xml after a Form delete is approved', async () => {
    const scenario = await createFormDeletionWithConstantOwnerCase();
    try {
      const preview = await scenario.result.workspace.createPreviewForNodeIds([scenario.registration.id]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      assert.strictEqual(scenario.result.workspace.approvePreview(preview.preview.previewId).ok, true);

      await writeFile(path.join(scenario.leftRoot, 'Constants', 'Reader.xml'), constantDescriptor('Reader', 'Catalog.Products.Form.Main'));
      const execution = await scenario.result.workspace.executeApprovedPreview(preview.preview.previewId, { destructiveConfirmed: true });
      assert.strictEqual(execution.ok, false, JSON.stringify(execution));
      assert.match(JSON.stringify(execution), /changed|изменил|PLAN_CONFLICT/iu);
      assert.ok(await pathExists(path.join(scenario.leftRoot, 'Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form.xml')));
    } finally {
      scenario.result.workspace.dispose();
      await fs.rm(scenario.tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('protects target Configuration.xml after a nested Form delete is approved', async () => {
    const scenario = await createFullFormDeletionCase();
    try {
      const preview = await scenario.result.workspace.createPreviewForNodeIds([scenario.registration.id]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      assert.strictEqual(scenario.result.workspace.approvePreview(preview.preview.previewId).ok, true);

      await writeFile(path.join(scenario.leftRoot, 'Configuration.xml'), configurationWithCatalogAndConstant());
      const execution = await scenario.result.workspace.executeApprovedPreview(preview.preview.previewId, { destructiveConfirmed: true });
      assert.strictEqual(execution.ok, false, JSON.stringify(execution));
      assert.match(JSON.stringify(execution), /witness changed after preview|changed|изменил|PLAN_CONFLICT/iu);
      assert.ok(await pathExists(path.join(scenario.leftRoot, 'Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form.xml')));
    } finally {
      scenario.result.workspace.dispose();
      await fs.rm(scenario.tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('rejects selected package preview when its source path set changes after compare', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linked-designer-pathset-change-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const unexpectedPath = path.join(rightRoot, 'Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Unexpected.xml');
    let result: Awaited<ReturnType<typeof buildConfigurationCompare>> | undefined;
    try {
      await writeCatalogConfigurationPair(leftRoot, rightRoot);
      await writeFile(path.join(leftRoot, 'Catalogs', 'Products.xml'), catalogDescriptor('Products', false));
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products.xml'), catalogDescriptor('Products', true));
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products', 'Forms', 'Main.xml'), formDescriptor('Main'));
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form.xml'), formXmlWithoutEvent());

      result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
      });
      const registration = collectNodes(result.workspace.payload.root, (node) =>
        node.kind === 'xmlElement' && node.label === 'Форма: Main' && node.status === 'rightOnly'
      )[0];
      assert.ok(registration?.mergeable, registration?.mergeState?.reason);

      await writeFile(unexpectedPath, '<Unexpected/>');
      const preview = await result.workspace.createPreviewForNodeIds([registration!.id]);
      assert.strictEqual(preview.ok, false, JSON.stringify(preview));
      assert.match(JSON.stringify(preview), /состав файлов или каталогов Designer-пакета изменился после сравнения/iu);
    } finally {
      result?.workspace.dispose();
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('resolves mixed-case package descriptors using the inventory canonical key on case-sensitive platforms', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linked-designer-case-sensitive-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    try {
      await writeFile(path.join(leftRoot, 'Configuration.xml'), configurationWithCatalogAndCommonForm(true));
      await writeFile(path.join(rightRoot, 'Configuration.xml'), configurationWithCatalogAndCommonForm(false));
      await writeFile(path.join(leftRoot, 'Catalogs', 'Products.xml'), catalogDescriptor('Products', false));
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products.xml'), catalogDescriptor('Products', true));
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products', 'Forms', 'Main.xml'), formDescriptor('Main'));
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form.xml'), formXmlWithoutEvent());
      await writeFile(path.join(leftRoot, 'CommonForms', 'Shared.xml'), commonFormDescriptor('Shared'));
      await writeFile(path.join(leftRoot, 'CommonForms', 'Shared', 'Ext', 'Form.xml'), formXmlWithoutEvent());

      const leftIdentities = await indexMetadataFolder({ sourceId: 'left-source', side: 'left', folderPath: leftRoot });
      const rightIdentities = await indexMetadataFolder({ sourceId: 'right-source', side: 'right', folderPath: rightRoot });
      const metadata = matchMetadataIdentities({ left: leftIdentities, right: rightIdentities });
      const [leftInventory, rightInventory] = await Promise.all([
        buildConfigurationInventory(leftRoot, { identities: leftIdentities }),
        buildConfigurationInventory(rightRoot, { identities: rightIdentities }),
      ]);

      // configurationInventory intentionally lowercases descriptor map keys on every host.
      // Simulate the case-preserving lookup branch used on Linux while retaining this host's
      // filesystem and path implementation, so Windows CI/local runs catch the same mismatch.
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      assert.ok(originalPlatform?.configurable, 'process.platform must be restorable for this isolated lookup test');
      Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' });
      let linkedIndex: Awaited<ReturnType<typeof buildLinkedDesignerCompareIndex>>;
      try {
        linkedIndex = await buildLinkedDesignerCompareIndex({
          metadata,
          leftInventory,
          rightInventory,
          leftRootPath: leftRoot,
          rightRootPath: rightRoot,
          strategy: 'full',
        });
      } finally {
        Object.defineProperty(process, 'platform', originalPlatform);
      }

      assert.deepStrictEqual(
        linkedIndex.packages.map((item) => [item.action, item.qualifiedName]).sort(),
        [['copy', 'Catalog.Products.Form.Main'], ['delete', 'CommonForm.Shared']].sort(),
        JSON.stringify(linkedIndex.diagnostics),
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('resolves manifest-backed root and nested packages under Linux path casing and suppresses whole-object BSL rows', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linked-designer-linux-descriptor-key-'));
    const leftRoot = path.join(tempRoot, 'target');
    const rightRoot = path.join(tempRoot, 'incoming');
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const originalIndexer = bslModuleIndexerRuntime.indexBslModuleSource;
    assert.ok(originalPlatform?.configurable, 'process.platform must be restorable for this isolated path lookup test');
    const indexedModuleIds: string[] = [];
    let result: Awaited<ReturnType<typeof buildConfigurationCompare>> | undefined;
    bslModuleIndexerRuntime.indexBslModuleSource = (input) => {
      indexedModuleIds.push(input.identity.moduleId);
      return originalIndexer(input);
    };
    try {
      await writeFile(path.join(leftRoot, 'Configuration.xml'), linuxDescriptorKeyConfiguration(false));
      await writeFile(path.join(rightRoot, 'Configuration.xml'), linuxDescriptorKeyConfiguration(true));
      await writeFile(path.join(leftRoot, 'Catalogs', 'Products.xml'), catalogDescriptor('Products', false));
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products.xml'), catalogDescriptor('Products', true));
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products', 'Forms', 'Main.xml'), formDescriptor('Main'));
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form.xml'), formXmlWithoutEvent());
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form', 'Module.bsl'), routine('NestedFormModule'));

      await writeFile(path.join(rightRoot, 'CommonForms', 'Shared.xml'), commonFormDescriptor('Shared'));
      await writeFile(path.join(rightRoot, 'CommonForms', 'Shared', 'Ext', 'Form.xml'), formXmlWithoutEvent());
      await writeFile(path.join(rightRoot, 'CommonTemplates', 'Print.xml'), commonTemplateDescriptor('Print'));
      await writeFile(path.join(rightRoot, 'CommonTemplates', 'Print', 'Ext', 'Template.xml'), '<document/>');
      await writeFile(path.join(rightRoot, 'CommonCommands', 'Run.xml'), commonCommandDescriptor('Run'));
      await writeFile(path.join(rightRoot, 'CommonCommands', 'Run', 'Ext', 'CommandModule.bsl'), routine('RunCommand'));

      await writeFile(path.join(rightRoot, 'InformationRegisters', 'Stock.xml'), informationRegisterDescriptor('Stock'));
      await writeFile(path.join(rightRoot, 'InformationRegisters', 'Stock', 'Ext', 'RecordSetModule.bsl'), routine('StockRecordSet'));
      await writeFile(path.join(rightRoot, 'DataProcessors', 'Importer.xml'), dataProcessorDescriptor('Importer'));
      await writeFile(path.join(rightRoot, 'DataProcessors', 'Importer', 'Ext', 'ObjectModule.bsl'), routine('ImporterObject'));
      const incomingFiles = await collectFileBytes(rightRoot);

      Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' });
      result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
      });

      const root = result.workspace.payload.root;
      const rootPackageIds = [
        'fileObject:rightOnly:CommonForm.Shared',
        'fileObject:rightOnly:CommonTemplate.Print',
        'fileObject:rightOnly:CommonCommand.Run',
      ];
      const rootPackages = rootPackageIds.map((id) => collectNodes(root, (node) => node.id === id)[0]);
      assert.ok(rootPackages.every((node) => node?.mergeable), JSON.stringify(rootPackages.map((node) => node?.mergeState)));
      const nestedForm = collectNodes(root, (node) => node.kind === 'xmlElement' && node.label === 'Форма: Main' && node.status === 'rightOnly')[0];
      assert.ok(nestedForm?.mergeable, nestedForm?.mergeState?.reason);
      const wholeObjectIds = [
        'fileObject:rightOnly:InformationRegister.Stock',
        'fileObject:rightOnly:DataProcessor.Importer',
      ];
      const wholeObjects = wholeObjectIds.map((id) => collectNodes(root, (node) => node.id === id)[0]);
      assert.ok(wholeObjects.every((node) => node?.mergeable), JSON.stringify(wholeObjects.map((node) => node?.mergeState)));

      const unresolvedModuleMessages = result.session.state.messages.filter((message) =>
        message.code === 'BSL_MODULE_RIGHT_ONLY' && /Stock\.RecordSet|Importer\.Object|Run\.Command|Form\.Main/u.test(message.nodeId ?? '')
      );
      assert.deepStrictEqual(unresolvedModuleMessages, [], 'whole-object/package BSL members must not surface as separate unmatched modules');
      assert.deepStrictEqual(indexedModuleIds, [], 'unmatched whole-object/package BSL members must not be parsed');

      const commonFormDescriptorPath = path.join(rightRoot, 'CommonForms', 'Shared.xml');
      const selectedCommonFormId = rootPackageIds[0]!;
      await writeFile(commonFormDescriptorPath, commonFormDescriptor('Drifted'));
      const driftPreview = await result.workspace.createPreviewForNodeIds([selectedCommonFormId]);
      assert.strictEqual(driftPreview.ok, false, 'selected package preview must detect descriptor drift since compare');
      assert.match(JSON.stringify(driftPreview), /Файл Designer-пакета изменился после сравнения/iu);
      assert.match(JSON.stringify(driftPreview), /CommonForms.*Shared\.xml/iu);
      await writeFile(commonFormDescriptorPath, commonFormDescriptor('Shared'));

      const selectedIds = [...rootPackageIds, nestedForm!.id, ...wholeObjectIds];
      const preview = await result.workspace.createPreviewForNodeIds(selectedIds);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      if (!preview.ok) {return;}
      const approval = result.workspace.approvePreview(preview.preview.previewId);
      assert.strictEqual(approval.ok, true, JSON.stringify(approval));
      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId, { destructiveConfirmed: true });
      assert.strictEqual(execution.ok, true, JSON.stringify(execution));

      for (const relativePath of [
        path.join('Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form.xml'),
        path.join('CommonForms', 'Shared', 'Ext', 'Form.xml'),
        path.join('CommonTemplates', 'Print', 'Ext', 'Template.xml'),
        path.join('CommonCommands', 'Run', 'Ext', 'CommandModule.bsl'),
        path.join('InformationRegisters', 'Stock', 'Ext', 'RecordSetModule.bsl'),
        path.join('DataProcessors', 'Importer', 'Ext', 'ObjectModule.bsl'),
      ]) {
        assert.ok(await pathExists(path.join(leftRoot, relativePath)), `${relativePath} should be materialized`);
      }
      assert.deepStrictEqual(await collectFileBytes(rightRoot), incomingFiles, 'all source package and object bytes must remain unchanged');
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform);
      bslModuleIndexerRuntime.indexBslModuleSource = originalIndexer;
      result?.workspace.dispose();
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('does not enable a Form package when an unrelated sidecar replaces the required Form.xml', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linked-designer-missing-body-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    let result: Awaited<ReturnType<typeof buildConfigurationCompare>> | undefined;
    try {
      await writeCatalogConfigurationPair(leftRoot, rightRoot);
      await writeFile(path.join(leftRoot, 'Catalogs', 'Products.xml'), catalogDescriptor('Products', false));
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products.xml'), catalogDescriptor('Products', true));
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products', 'Forms', 'Main.xml'), formDescriptor('Main'));
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Help.xml'), '<Help/>');

      result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
      });
      const mainNodes = collectNodes(result.workspace.payload.root, (node) => node.label === 'Main');
      assert.strictEqual(mainNodes.some((node) => node.mergeable), false, 'the registration must stay blocked without its exact required body');
      assert.strictEqual(result.workspace.listMergeableNodeIds().some((id) => id.startsWith('fileObject:rightOnly:')), false,
        'the legacy whole-object candidate must not bypass linked package validation');
    } finally {
      result?.workspace.dispose();
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('bundles a matched TemplateType change with its exact new and old body files', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linked-designer-template-type-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const descriptorRelative = path.join('Templates', 'Print.xml');
    const oldBodyRelative = path.join('Templates', 'Print', 'Ext', 'Template.xml');
    const newBodyRelative = path.join('Templates', 'Print', 'Ext', 'Template.html');
    const targetOnlyRelative = path.join('Templates', 'Print', 'Ext', 'keep.txt');
    let result: Awaited<ReturnType<typeof buildConfigurationCompare>> | undefined;
    try {
      await writeTemplateConfigurationPair(leftRoot, rightRoot);
      await writeFile(path.join(leftRoot, descriptorRelative), templateDescriptor('Print', 'SpreadsheetDocument'));
      await writeFile(path.join(rightRoot, descriptorRelative), templateDescriptor('Print', 'HTMLDocument'));
      await writeFile(path.join(leftRoot, oldBodyRelative), '<document><old/></document>');
      await writeFile(path.join(rightRoot, newBodyRelative), '<html><body>incoming</body></html>');
      await writeFile(path.join(leftRoot, targetOnlyRelative), 'preserve');

      const runtime = await createMergeMutationTestRuntime(leftRoot);
      mutationCoordinators.push(runtime.coordinator);
      result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
        mutationEngine: runtime.engine,
        configurationId: runtime.configurationId,
      });
      const strategy = await result.workspace.setStrategy('full');
      assert.strictEqual(strategy.ok, true, JSON.stringify(strategy));
      const transition = collectNodes(result.workspace.payload.root, (node) =>
        node.label === 'Тип макета и содержимое: SpreadsheetDocument → HTMLDocument'
      )[0];
      assert.ok(transition?.mergeable, 'the matched type transition must be offered as one linked bundle');
      const scalar = collectNodes(result.workspace.payload.root, (node) =>
        node.kind === 'xmlProperty' && node.label === 'TemplateType' && node.mergeState?.targetFilePath?.endsWith('Print.xml') === true
      )[0];
      assert.ok(scalar, 'the raw TemplateType property remains visible');
      assert.strictEqual(scalar!.mergeable, false, 'the raw TemplateType scalar must not be independently selectable');
      const bodyNodes = collectNodes(result.workspace.payload.root, (node) =>
        node.kind === 'fileArtifact' && [oldBodyRelative, newBodyRelative].some((relative) =>
          node.mergeState?.targetFilePath?.endsWith(relative.replace(/\\/gu, '/')) === true
          || node.mergeState?.targetFilePath?.endsWith(relative.replace(/\//gu, path.sep)) === true
        )
      );
      assert.ok(bodyNodes.length >= 2, 'the exact old and new body paths should remain visible in the compare');
      assert.strictEqual(bodyNodes.some((node) => node.mergeable), false, 'body-only candidates must be bundled when TemplateType changes');

      const preview = await result.workspace.createPreviewForNodeIds([transition!.id]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      assert.strictEqual(result.workspace.approvePreview(preview.preview.previewId).ok, true);
      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId, { destructiveConfirmed: true });
      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      assert.strictEqual(await fs.readFile(path.join(leftRoot, newBodyRelative), 'utf8'), '<html><body>incoming</body></html>');
      assert.strictEqual(await pathExists(path.join(leftRoot, oldBodyRelative)), false);
      assert.strictEqual(await fs.readFile(path.join(leftRoot, targetOnlyRelative), 'utf8'), 'preserve');
      const descriptor = parseXmlDocument(await fs.readFile(path.join(leftRoot, descriptorRelative), 'utf8')).root;
      const template = elementChildren(descriptor).find((node) => node.localName === 'Template');
      const properties = template && elementChildren(template).find((node) => node.localName === 'Properties');
      const type = properties && elementChildren(properties).find((node) => node.localName === 'TemplateType');
      assert.strictEqual(textContent(type!), 'HTMLDocument');
    } finally {
      result?.workspace.dispose();
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('replaces the shared Template.xml body once when SpreadsheetDocument changes to DCS', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linked-designer-template-same-body-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const descriptorRelative = path.join('Templates', 'Print.xml');
    const bodyRelative = path.join('Templates', 'Print', 'Ext', 'Template.xml');
    let result: Awaited<ReturnType<typeof buildConfigurationCompare>> | undefined;
    const incomingBody = '<d:DataCompositionSchema xmlns:d="http://v8.1c.ru/8.1/data-composition-system/schema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:dcsset="http://v8.1c.ru/8.1/data-composition-system/settings"><d:dataSource><dcsset:name>Target</dcsset:name><d:query>SELECT 1</d:query></d:dataSource><d:settingsVariant><dcsset:name>Default</dcsset:name><d:settings/></d:settingsVariant></d:DataCompositionSchema>';
    try {
      await writeTemplateConfigurationPair(leftRoot, rightRoot);
      await writeFile(path.join(leftRoot, descriptorRelative), templateDescriptor('Print', 'SpreadsheetDocument'));
      await writeFile(path.join(rightRoot, descriptorRelative), templateDescriptor('Print', 'DataCompositionSchema'));
      await writeFile(path.join(leftRoot, bodyRelative), '<document><spreadsheet/></document>');
      await writeFile(path.join(rightRoot, bodyRelative), incomingBody);

      const runtime = await createMergeMutationTestRuntime(leftRoot);
      mutationCoordinators.push(runtime.coordinator);
      result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
        mutationEngine: runtime.engine,
        configurationId: runtime.configurationId,
      });
      const transition = collectNodes(result.workspace.payload.root, (node) =>
        node.label === 'Тип макета и содержимое: SpreadsheetDocument → DataCompositionSchema'
      )[0];
      assert.ok(transition?.mergeable, transition?.mergeState?.reason);
      assert.strictEqual(result.workspace.listMergeableNodeIds().includes(transition!.id), true);

      const preview = await result.workspace.createPreviewForNodeIds([transition!.id]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      assert.strictEqual(preview.preview.operationCount, 2, 'the descriptor patch and same-path body overwrite should each appear once');
      assert.strictEqual(result.workspace.approvePreview(preview.preview.previewId).ok, true);
      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId, { destructiveConfirmed: true });
      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      assert.strictEqual(await fs.readFile(path.join(leftRoot, bodyRelative), 'utf8'), incomingBody);
      const descriptor = parseXmlDocument(await fs.readFile(path.join(leftRoot, descriptorRelative), 'utf8')).root;
      const template = elementChildren(descriptor).find((node) => node.localName === 'Template');
      const properties = template && elementChildren(template).find((node) => node.localName === 'Properties');
      const type = properties && elementChildren(properties).find((node) => node.localName === 'TemplateType');
      assert.strictEqual(textContent(type!), 'DataCompositionSchema');
    } finally {
      result?.workspace.dispose();
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('uses the nested Template descriptor version for its DCS sidecar', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linked-nested-dcs-owner-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const ownerName = 'Products';
    const templateName = 'Sales';
    const ownerUuid = '81234567-89ab-cdef-0123-456789abcdef';
    const templateUuid = '91234567-89ab-cdef-0123-456789abcdef';
    const ownerRelative = path.join('Catalogs', `${ownerName}.xml`);
    const templateRelative = path.join('Catalogs', ownerName, 'Templates', `${templateName}.xml`);
    const bodyRelative = path.join('Catalogs', ownerName, 'Templates', templateName, 'Ext', 'Template.xml');
    const incomingDcs = linkedDcsXml('SELECT 2');
    let result: Awaited<ReturnType<typeof buildConfigurationCompare>> | undefined;
    try {
      await writeCatalogConfigurationPair(leftRoot, rightRoot);
      await writeFile(path.join(leftRoot, ownerRelative), nestedTemplateOwnerDescriptor(ownerName, ownerUuid, templateName, '2.20'));
      await writeFile(path.join(rightRoot, ownerRelative), nestedTemplateOwnerDescriptor(ownerName, ownerUuid, templateName, '2.20'));
      await writeFile(path.join(leftRoot, templateRelative), nestedTemplateDescriptor(templateName, templateUuid, '2.22'));
      await writeFile(path.join(rightRoot, templateRelative), nestedTemplateDescriptor(templateName, templateUuid, '2.20'));
      await writeFile(path.join(leftRoot, bodyRelative), linkedDcsXml('SELECT 1'));
      await writeFile(path.join(rightRoot, bodyRelative), incomingDcs);

      const leftInventory = await buildConfigurationInventory(leftRoot);
      const nestedTemplate = leftInventory.objects.find((object) => object.qualifiedName === 'Catalog.Products.Template.Sales');
      assert.ok(nestedTemplate, 'the fixture must expose its nested Template descriptor identity');
      const dcsArtifact = leftInventory.artifactsByObjectId.get(nestedTemplate!.objectId)?.find((artifact) => artifact.kind === 'dcsXml');
      assert.ok(dcsArtifact, 'the fixture must attach Template.xml to the nested Template, not its parent Catalog');

      result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups-invalid'),
      });
      const unsupportedOwner = collectNodes(result.workspace.payload.root, (node) =>
        node.kind === 'diagnostic' && node.label === 'XML_DCS_OWNER_VERSION_UNSUPPORTED'
          && node.leftValue?.replace(/\\/gu, '/').endsWith('/Templates/Sales/Ext/Template.xml') === true
      )[0];
      assert.ok(unsupportedOwner, 'an unsupported nested Template descriptor must block its DCS sidecar');
      assert.match(unsupportedOwner!.rightValue ?? '', /2\.22|верси/iu);
      result.workspace.dispose();
      result = undefined;

      await writeFile(path.join(leftRoot, templateRelative), nestedTemplateDescriptor(templateName, templateUuid, '2.20'));
      result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups-valid'),
      });
      const validQuery = findDcsQueryNode(result.workspace.payload.root);
      assert.ok(validQuery?.mergeable, validQuery?.mergeState?.reason);

      const targetTemplateDescriptor = path.join(leftRoot, templateRelative);
      const capturedTargetDescriptor = nestedTemplateDescriptor(templateName, templateUuid, '2.20');
      await writeFile(targetTemplateDescriptor, nestedTemplateDescriptor(templateName, templateUuid, '2.21'));
      const stalePreview = await result.workspace.createPreviewForNodeIds([validQuery!.id]);
      assert.strictEqual(stalePreview.ok, false, JSON.stringify(stalePreview));
      assert.match(JSON.stringify(stalePreview), /изменил|changed|после сравнения/iu);
      const previewDcs = parseXmlDocument(await fs.readFile(path.join(leftRoot, bodyRelative), 'utf8')).root;
      const previewDataSet = elementChildren(previewDcs).find((node) => node.localName === 'dataSet');
      const previewQuery = previewDataSet && elementChildren(previewDataSet).find((node) => node.localName === 'query');
      assert.strictEqual(textContent(previewQuery!), 'SELECT 1', 'a stale nested owner descriptor must prevent preview writes');

      await writeFile(targetTemplateDescriptor, capturedTargetDescriptor);
      const preview = await result.workspace.createPreviewForNodeIds([validQuery!.id]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      assert.strictEqual(result.workspace.approvePreview(preview.preview.previewId).ok, true);
      await writeFile(targetTemplateDescriptor, nestedTemplateDescriptor(templateName, templateUuid, '2.21'));
      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId);
      assert.strictEqual(execution.ok, false, JSON.stringify(execution));
      assert.match(JSON.stringify(execution), /changed|изменил|PLAN_CONFLICT/iu);
      const finalDcs = parseXmlDocument(await fs.readFile(path.join(leftRoot, bodyRelative), 'utf8')).root;
      const dataSet = elementChildren(finalDcs).find((node) => node.localName === 'dataSet');
      const queryField = dataSet && elementChildren(dataSet).find((node) => node.localName === 'query');
      assert.strictEqual(textContent(queryField!), 'SELECT 1', 'a stale nested owner descriptor must prevent execution writes');
    } finally {
      result?.workspace.dispose();
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('bundles an ordinary CFE CommonTemplate type change with its body', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linked-cfe-common-template-'));
    const leftRoot = path.join(tempRoot, 'left-cfe');
    const rightRoot = path.join(tempRoot, 'right-cfe');
    const name = 'Ext_Print';
    const uuid = '51234567-89ab-cdef-0123-456789abcdef';
    const descriptorRelative = path.join('CommonTemplates', `${name}.xml`);
    const bodyRelative = path.join('CommonTemplates', name, 'Ext', 'Template.xml');
    const incomingBody = '<DataCompositionSchema/>';
    let result: Awaited<ReturnType<typeof buildConfigurationCompare>> | undefined;
    try {
      const templateObject = (templateType: string): ExtensionCompareObjectFixture => ({
        type: 'CommonTemplate',
        name,
        uuid,
        belonging: 'Own',
        descriptorXml: `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><CommonTemplate uuid="${uuid}"><Properties><Name>${name}</Name><TemplateType>${templateType}</TemplateType></Properties></CommonTemplate></MetaDataObject>`,
      });
      await writeDesignerConfiguration(leftRoot, { purpose: 'Customization', namePrefix: 'Ext_', objects: [templateObject('SpreadsheetDocument')] });
      await writeDesignerConfiguration(rightRoot, { purpose: 'Customization', namePrefix: 'Ext_', objects: [templateObject('DataCompositionSchema')] });
      await writeCompareBytes(leftRoot, bodyRelative, '<document><spreadsheet/></document>');
      await writeCompareBytes(rightRoot, bodyRelative, incomingBody);
      const runtime = await createMergeMutationTestRuntime(leftRoot);
      mutationCoordinators.push(runtime.coordinator);
      result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
        mutationEngine: runtime.engine,
        configurationId: runtime.configurationId,
      });

      const transition = collectNodes(result.workspace.payload.root, (node) =>
        node.label === 'Тип макета и содержимое: SpreadsheetDocument → DataCompositionSchema'
      )[0];
      assert.ok(transition?.mergeable, transition?.mergeState?.reason);
      const preview = await result.workspace.createPreviewForNodeIds([transition!.id]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      assert.strictEqual(preview.preview.operationCount, 2);
      assert.strictEqual(result.workspace.approvePreview(preview.preview.previewId).ok, true);
      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId, { destructiveConfirmed: true });
      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      assert.strictEqual(await fs.readFile(path.join(leftRoot, bodyRelative), 'utf8'), incomingBody);
      const descriptor = parseXmlDocument(await fs.readFile(path.join(leftRoot, descriptorRelative), 'utf8')).root;
      const commonTemplate = elementChildren(descriptor).find((node) => node.localName === 'CommonTemplate');
      const properties = commonTemplate && elementChildren(commonTemplate).find((node) => node.localName === 'Properties');
      const type = properties && elementChildren(properties).find((node) => node.localName === 'TemplateType');
      assert.strictEqual(textContent(type!), 'DataCompositionSchema');
    } finally {
      result?.workspace.dispose();
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('bundles a nested CFE Template descriptor transition without replacing its owner', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linked-cfe-nested-template-'));
    const leftRoot = path.join(tempRoot, 'left-cfe');
    const rightRoot = path.join(tempRoot, 'right-cfe');
    const ownerName = 'Ext_Products';
    const ownerUuid = '61234567-89ab-cdef-0123-456789abcdef';
    const templateName = 'Print';
    const templateUuid = '71234567-89ab-cdef-0123-456789abcdef';
    const ownerRelative = path.join('Catalogs', `${ownerName}.xml`);
    const nestedDescriptorRelative = path.join('Catalogs', ownerName, 'Templates', `${templateName}.xml`);
    const bodyRelative = path.join('Catalogs', ownerName, 'Templates', templateName, 'Ext', 'Template.html');
    const incomingBody = '<html><body>incoming</body></html>';
    let result: Awaited<ReturnType<typeof buildConfigurationCompare>> | undefined;
    try {
      const ownerObject = (): ExtensionCompareObjectFixture => ({
        type: 'Catalog',
        name: ownerName,
        uuid: ownerUuid,
        belonging: 'Own',
        childObjectsXml: `<Template>${templateName}</Template>`,
        descriptorXml: `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Catalog uuid="${ownerUuid}"><Properties><Name>${ownerName}</Name></Properties><ChildObjects><Template>${templateName}</Template></ChildObjects></Catalog></MetaDataObject>`,
      });
      const templateDescriptor = (templateType: string): string =>
        `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Template uuid="${templateUuid}"><Properties><Name>${templateName}</Name><TemplateType>${templateType}</TemplateType></Properties></Template></MetaDataObject>`;
      await writeDesignerConfiguration(leftRoot, { purpose: 'Customization', namePrefix: 'Ext_', objects: [ownerObject()] });
      await writeDesignerConfiguration(rightRoot, { purpose: 'Customization', namePrefix: 'Ext_', objects: [ownerObject()] });
      await writeCompareBytes(leftRoot, nestedDescriptorRelative, templateDescriptor('SpreadsheetDocument'));
      await writeCompareBytes(rightRoot, nestedDescriptorRelative, templateDescriptor('HTMLDocument'));
      await writeCompareBytes(leftRoot, path.join('Catalogs', ownerName, 'Templates', templateName, 'Ext', 'Template.xml'), '<document><old/></document>');
      await writeCompareBytes(rightRoot, bodyRelative, incomingBody);
      const runtime = await createMergeMutationTestRuntime(leftRoot);
      mutationCoordinators.push(runtime.coordinator);
      result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
        mutationEngine: runtime.engine,
        configurationId: runtime.configurationId,
      });

      const transition = collectNodes(result.workspace.payload.root, (node) =>
        node.label === 'Тип макета и содержимое: SpreadsheetDocument → HTMLDocument'
      )[0];
      assert.ok(transition?.mergeable, transition?.mergeState?.reason);
      const preview = await result.workspace.createPreviewForNodeIds([transition!.id]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      assert.strictEqual(preview.preview.operationCount, 3);
      assert.strictEqual(result.workspace.approvePreview(preview.preview.previewId).ok, true);
      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId, { destructiveConfirmed: true });
      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      assert.strictEqual(await fs.readFile(path.join(leftRoot, bodyRelative), 'utf8'), incomingBody);
      assert.strictEqual(await pathExists(path.join(leftRoot, 'Catalogs', ownerName, 'Templates', templateName, 'Ext', 'Template.xml')), false);
      assert.match(await fs.readFile(path.join(leftRoot, ownerRelative), 'utf8'), /<Template>Print<\/Template>/u);
      const descriptor = parseXmlDocument(await fs.readFile(path.join(leftRoot, nestedDescriptorRelative), 'utf8')).root;
      const template = elementChildren(descriptor).find((node) => node.localName === 'Template');
      const properties = template && elementChildren(template).find((node) => node.localName === 'Properties');
      const type = properties && elementChildren(properties).find((node) => node.localName === 'TemplateType');
      assert.strictEqual(textContent(type!), 'HTMLDocument');
    } finally {
      result?.workspace.dispose();
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('blocks a package delete when its sidecar directory changes before preview', async () => {
    const scenario = await createFullFormDeletionCase(true);
    try {
      const packageDirectory = path.join(scenario.leftRoot, 'Catalogs', 'Products', 'Forms', 'Main');
      await writeFile(path.join(packageDirectory, 'Ext', 'added-after-compare.txt'), 'keep this file');

      const preview = await scenario.result.workspace.createPreviewForNodeIds([scenario.registration.id]);
      assert.strictEqual(preview.ok, false, JSON.stringify(preview));
      assert.match(JSON.stringify(preview), /каталог удаляемого Designer-пакета изменился/iu);
       assert.match(await fs.readFile(path.join(scenario.leftRoot, 'Catalogs', 'Products.xml'), 'utf8'), /<Form>Main<\/Form>/u);
      assert.strictEqual(await fs.readFile(path.join(packageDirectory, 'Ext', 'added-after-compare.txt'), 'utf8'), 'keep this file');
    } finally {
      scenario.result.workspace.dispose();
      await fs.rm(scenario.tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('rejects a package delete under the execution lease when a file appears after approval', async () => {
    const scenario = await createFullFormDeletionCase();
    try {
      const preview = await scenario.result.workspace.createPreviewForNodeIds([scenario.registration.id]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      const approved = scenario.result.workspace.approvePreview(preview.preview.previewId);
      assert.strictEqual(approved.ok, true, JSON.stringify(approved));

      const packageDirectory = path.join(scenario.leftRoot, 'Catalogs', 'Products', 'Forms', 'Main');
      await writeFile(path.join(packageDirectory, 'Ext', 'added-after-approval.txt'), 'keep this file');
      const execution = await scenario.result.workspace.executeApprovedPreview(preview.preview.previewId, { destructiveConfirmed: true });

      assert.strictEqual(execution.ok, false, JSON.stringify(execution));
      assert.match(JSON.stringify(execution), /changed|изменился|PLAN_CONFLICT/iu);
       assert.match(await fs.readFile(path.join(scenario.leftRoot, 'Catalogs', 'Products.xml'), 'utf8'), /<Form>Main<\/Form>/u);
      assert.strictEqual(await fs.readFile(path.join(packageDirectory, 'Ext', 'Form.xml'), 'utf8'), formXml('OnChange'));
      assert.strictEqual(await fs.readFile(path.join(packageDirectory, 'Ext', 'added-after-approval.txt'), 'utf8'), 'keep this file');
    } finally {
      scenario.result.workspace.dispose();
      await fs.rm(scenario.tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('blocks deleting a BSL handler while an unchanged target Form still references it', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linked-designer-handler-delete-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const moduleRelative = path.join('Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form', 'Module.bsl');
    let result: Awaited<ReturnType<typeof buildConfigurationCompare>> | undefined;
    try {
      await writeCatalogConfigurationPair(leftRoot, rightRoot);
      await writeFile(path.join(leftRoot, 'Catalogs', 'Products.xml'), catalogDescriptor('Products', true));
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products.xml'), catalogDescriptor('Products', true));
      await writeFile(path.join(leftRoot, 'Catalogs', 'Products', 'Forms', 'Main.xml'), formDescriptor('Main'));
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products', 'Forms', 'Main.xml'), formDescriptor('Main'));
      await writeFile(path.join(leftRoot, 'Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form.xml'), formXml('OnChange'));
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form.xml'), formXml('OnChange'));
      await writeFile(path.join(leftRoot, moduleRelative), routine('OnChange'));
      await writeFile(path.join(rightRoot, moduleRelative), routine('Shared'));

      result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
      });
      const handler = collectNodes(result.workspace.payload.root, (node) => node.id === 'bsl:routine:Catalog.Products.Form.Main.FormModule:onchange')[0];
      assert.ok(handler?.mergeable, 'the target-only handler should be selectable for deletion');
      const preview = await result.workspace.createPreviewForNodeIds([handler!.id]);
      assert.strictEqual(preview.ok, false, JSON.stringify(preview));
      assert.match(JSON.stringify(preview), /OnChange.*нет|нет.*OnChange/iu);
      assert.match(await fs.readFile(path.join(leftRoot, moduleRelative), 'utf8'), /Procedure OnChange/u);
    } finally {
      result?.workspace.dispose();
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('rechecks captured Form.xml dependencies before previewing a BSL handler deletion', async () => {
    const scenario = await createHandlerComparison(formXmlWithoutEvent(), formXmlWithoutEvent(), routine('OnChange'), routine('Shared'));
    try {
      const handler = collectNodes(scenario.result.workspace.payload.root, (node) => node.id === 'bsl:routine:Catalog.Products.Form.Main.FormModule:onchange')[0];
      assert.ok(handler?.mergeable, 'the target-only handler should be selectable');
      await writeFile(path.join(scenario.leftRoot, scenario.formRelative), formXml('OnChange'));

      const preview = await scenario.result.workspace.createPreviewForNodeIds([handler!.id]);
      assert.strictEqual(preview.ok, false, JSON.stringify(preview));
      assert.match(JSON.stringify(preview), /Form\.xml.*изменил|Form\.xml.*changed|зависим.*изменил/iu);
      assert.match(await fs.readFile(path.join(scenario.leftRoot, scenario.moduleRelative), 'utf8'), /Procedure OnChange/u);
    } finally {
      scenario.result.workspace.dispose();
      await fs.rm(scenario.tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('rechecks captured Form.xml dependencies under the execution lease after approval', async () => {
    const scenario = await createHandlerComparison(formXmlWithoutEvent(), formXmlWithoutEvent(), routine('OnChange'), routine('Shared'));
    try {
      const handler = collectNodes(scenario.result.workspace.payload.root, (node) => node.id === 'bsl:routine:Catalog.Products.Form.Main.FormModule:onchange')[0];
      assert.ok(handler?.mergeable, 'the target-only handler should be selectable');
      const preview = await scenario.result.workspace.createPreviewForNodeIds([handler!.id]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      assert.strictEqual(scenario.result.workspace.approvePreview(preview.preview.previewId).ok, true);
      await writeFile(path.join(scenario.leftRoot, scenario.formRelative), formXml('OnChange'));

      const execution = await scenario.result.workspace.executeApprovedPreview(preview.preview.previewId, { destructiveConfirmed: true });
      assert.strictEqual(execution.ok, false, JSON.stringify(execution));
      assert.match(JSON.stringify(execution), /changed|изменил|PLAN_CONFLICT/iu);
      assert.match(await fs.readFile(path.join(scenario.leftRoot, scenario.moduleRelative), 'utf8'), /Procedure OnChange/u);
    } finally {
      scenario.result.workspace.dispose();
      await fs.rm(scenario.tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('rechecks an existing handler module before previewing an Event addition', async () => {
    const scenario = await createHandlerComparison(formXmlWithoutEvent(), formXml('OnChange'), routine('OnChange'), routine('OnChange'));
    try {
      const event = collectNodes(scenario.result.workspace.payload.root, (node) =>
        node.kind === 'xmlProperty' && node.label === 'Событие: OnChange' && node.rightValue?.trim() === 'OnChange'
      )[0];
      assert.ok(event?.mergeable, 'the individual Event should be selectable while the target handler exists; ' + describeEventNodes(scenario.result.workspace.payload.root));
      await writeFile(path.join(scenario.leftRoot, scenario.moduleRelative), routine('Shared'));

      const preview = await scenario.result.workspace.createPreviewForNodeIds([event!.id]);
      assert.strictEqual(preview.ok, false, JSON.stringify(preview));
      assert.match(JSON.stringify(preview), /Module\.bsl.*изменил|Module\.bsl.*changed|зависим.*изменил/iu);
      assert.doesNotMatch(await fs.readFile(path.join(scenario.leftRoot, scenario.formRelative), 'utf8'), />OnChange</u);
    } finally {
      scenario.result.workspace.dispose();
      await fs.rm(scenario.tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('rechecks an existing handler module under the execution lease after Event approval', async () => {
    const scenario = await createHandlerComparison(formXmlWithoutEvent(), formXml('OnChange'), routine('OnChange'), routine('OnChange'));
    try {
      const event = collectNodes(scenario.result.workspace.payload.root, (node) =>
        node.kind === 'xmlProperty' && node.label === 'Событие: OnChange' && node.rightValue?.trim() === 'OnChange'
      )[0];
      assert.ok(event?.mergeable, 'the individual Event should be selectable while the target handler exists; ' + describeEventNodes(scenario.result.workspace.payload.root));
      const preview = await scenario.result.workspace.createPreviewForNodeIds([event!.id]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      assert.strictEqual(scenario.result.workspace.approvePreview(preview.preview.previewId).ok, true);
      await writeFile(path.join(scenario.leftRoot, scenario.moduleRelative), routine('Shared'));

      const execution = await scenario.result.workspace.executeApprovedPreview(preview.preview.previewId);
      assert.strictEqual(execution.ok, false, JSON.stringify(execution));
      assert.match(JSON.stringify(execution), /changed|изменил|PLAN_CONFLICT/iu);
      assert.doesNotMatch(await fs.readFile(path.join(scenario.leftRoot, scenario.formRelative), 'utf8'), />OnChange</u);
    } finally {
      scenario.result.workspace.dispose();
      await fs.rm(scenario.tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('blocks deleting the default Form unless its DefaultObjectForm reference is selected for clearing', async () => {
    const scenario = await createFullFormDeletionCase(true, 'DefaultObjectForm');
    try {
      const ownerPath = path.join(scenario.leftRoot, 'Catalogs', 'Products.xml');
      const deletionOnly = await scenario.result.workspace.createPreviewForNodeIds([scenario.registration.id]);
      assert.strictEqual(deletionOnly.ok, false, JSON.stringify(deletionOnly));
      assert.match(JSON.stringify(deletionOnly), /DefaultObjectForm.*не разрешается|не разрешается.*DefaultObjectForm/iu);

      const clearNode = collectNodes(scenario.result.workspace.payload.root, (node) =>
        node.mergeable === true && /DefaultObjectForm/iu.test(node.payloadRef ?? '')
      )[0];
      assert.ok(clearNode, 'the incoming DefaultObjectForm clear should be selectable');
      const paired = await scenario.result.workspace.createPreviewForNodeIds([scenario.registration.id, clearNode!.id]);
      assert.strictEqual(paired.ok, true, JSON.stringify(paired));
      assert.strictEqual(scenario.result.workspace.approvePreview(paired.preview.previewId).ok, true);
      const execution = await scenario.result.workspace.executeApprovedPreview(paired.preview.previewId, { destructiveConfirmed: true });
      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      const finalOwner = parseXmlDocument(await fs.readFile(ownerPath, 'utf8')).root;
      const owner = elementChildren(finalOwner).find((node) => node.localName === 'Catalog');
      const properties = owner && elementChildren(owner).find((node) => node.localName === 'Properties');
      const defaultObjectForm = properties && elementChildren(properties).find((node) => node.localName === 'DefaultObjectForm');
      assert.ok(defaultObjectForm, 'the schema property should remain after the reference is cleared');
      assert.strictEqual(textContent(defaultObjectForm!), '');
      assert.strictEqual(await pathExists(path.join(scenario.leftRoot, 'Catalogs', 'Products', 'Forms', 'Main.xml')), false);
      assert.strictEqual(await pathExists(path.join(scenario.leftRoot, 'Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form.xml')), false);
    } finally {
      scenario.result.workspace.dispose();
      await fs.rm(scenario.tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('blocks deleting a Form referenced by another supported default-form property', async () => {
    const scenario = await createFullFormDeletionCase(true, 'DefaultListForm');
    try {
      const deletionOnly = await scenario.result.workspace.createPreviewForNodeIds([scenario.registration.id]);
      assert.strictEqual(deletionOnly.ok, false, JSON.stringify(deletionOnly));
      assert.match(JSON.stringify(deletionOnly), /DefaultListForm.*форма|DefaultListForm.*целев/iu);
    } finally {
      scenario.result.workspace.dispose();
      await fs.rm(scenario.tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('blocks deleting a CommonForm referenced by an unchanged Constant and allows an explicit clear', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linked-designer-cross-owner-reference-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    let result: Awaited<ReturnType<typeof buildConfigurationCompare>> | undefined;
    try {
      await writeFile(path.join(leftRoot, 'Configuration.xml'), configurationWithCommonForm(true));
      await writeFile(path.join(rightRoot, 'Configuration.xml'), configurationWithCommonForm(false));
      await writeFile(path.join(leftRoot, 'CommonForms', 'Shared.xml'), commonFormDescriptor('Shared'));
      await writeFile(path.join(leftRoot, 'CommonForms', 'Shared', 'Ext', 'Form.xml'), formXmlWithoutEvent());
      await writeFile(path.join(leftRoot, 'Constants', 'Reader.xml'), constantDescriptor('Reader', 'CommonForm.Shared'));
      await writeFile(path.join(rightRoot, 'Constants', 'Reader.xml'), constantDescriptor('Reader', ''));

      const runtime = await createMergeMutationTestRuntime(leftRoot);
      mutationCoordinators.push(runtime.coordinator);
      result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
        mutationEngine: runtime.engine,
        configurationId: runtime.configurationId,
      });
      const full = await result.workspace.setStrategy('full');
      assert.strictEqual(full.ok, true, JSON.stringify(full));
      const commonForm = collectNodes(result.workspace.payload.root, (node) =>
        node.id === 'fileObject:leftOnly:CommonForm.Shared' && node.mergeable === true
      )[0];
      assert.ok(commonForm, 'the existing root CommonForm package should be selectable');

      const deletionOnly = await result.workspace.createPreviewForNodeIds([commonForm!.id]);
      assert.strictEqual(deletionOnly.ok, false, JSON.stringify(deletionOnly));
      assert.match(JSON.stringify(deletionOnly), /DefaultForm.*CommonForm\.Shared|CommonForm\.Shared.*DefaultForm/iu);
      assert.strictEqual(await fs.readFile(path.join(leftRoot, 'CommonForms', 'Shared.xml'), 'utf8'), commonFormDescriptor('Shared'));

      const clear = collectNodes(result.workspace.payload.root, (node) =>
        node.mergeable === true && node.payloadRef?.includes('DefaultForm') === true && node.rightValue === ''
      )[0];
      assert.ok(clear, 'the Constant.DefaultForm clear should be separately selectable');
      const paired = await result.workspace.createPreviewForNodeIds([commonForm!.id, clear!.id]);
      assert.strictEqual(paired.ok, true, JSON.stringify(paired));
      assert.strictEqual(result.workspace.approvePreview(paired.preview.previewId).ok, true);
      const execution = await result.workspace.executeApprovedPreview(paired.preview.previewId, { destructiveConfirmed: true });
      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      const clearedConstant = parseXmlDocument(await fs.readFile(path.join(leftRoot, 'Constants', 'Reader.xml'), 'utf8')).root;
      const constantProperties = elementChildren(clearedConstant).find((node) => node.localName === 'Constant');
      const constantPropertyBag = constantProperties && elementChildren(constantProperties).find((node) => node.localName === 'Properties');
      const clearedDefaultForm = constantPropertyBag && elementChildren(constantPropertyBag).find((node) => node.localName === 'DefaultForm');
      assert.ok(clearedDefaultForm, 'the DefaultForm property remains present after clearing');
      assert.strictEqual(textContent(clearedDefaultForm!), '', 'the DefaultForm reference should be empty regardless of serializer namespace declarations');
      assert.strictEqual(await pathExists(path.join(leftRoot, 'CommonForms', 'Shared.xml')), false);
      assert.strictEqual(await pathExists(path.join(leftRoot, 'CommonForms', 'Shared', 'Ext', 'Form.xml')), false);
    } finally {
      result?.workspace.dispose();
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('adds an event handler to an existing empty module and preserves its directive envelope', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linked-designer-empty-module-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const moduleRelative = path.join('Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form', 'Module.bsl');
    let result: Awaited<ReturnType<typeof buildConfigurationCompare>> | undefined;
    try {
      await writeCatalogConfigurationPair(leftRoot, rightRoot);
      await writeFile(path.join(leftRoot, 'Catalogs', 'Products.xml'), catalogDescriptor('Products', true));
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products.xml'), catalogDescriptor('Products', true));
      await writeFile(path.join(leftRoot, 'Catalogs', 'Products', 'Forms', 'Main.xml'), formDescriptor('Main'));
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products', 'Forms', 'Main.xml'), formDescriptor('Main'));
      await writeFile(path.join(leftRoot, 'Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form.xml'), formXml(''));
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form.xml'), formXml('OnChange'));
      await writeFile(path.join(leftRoot, moduleRelative), '');
      await writeFile(path.join(rightRoot, moduleRelative), routineWithDirective('OnChange'));

      const runtime = await createMergeMutationTestRuntime(leftRoot);
      mutationCoordinators.push(runtime.coordinator);
      result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
        mutationEngine: runtime.engine,
        configurationId: runtime.configurationId,
      });
      const handler = collectNodes(result.workspace.payload.root, (node) => node.id === 'bsl:routine:Catalog.Products.Form.Main.FormModule:onchange')[0];
      const event = collectNodes(result.workspace.payload.root, (node) => /Event(?:%5B|\[)/iu.test(node.payloadRef ?? '') && node.rightValue?.includes('OnChange') === true)[0];
      assert.ok(handler?.mergeable, 'the added routine should be selectable');
      assert.ok(event?.mergeable, 'the Event should be selectable with its linked handler; candidates=' + JSON.stringify(collectNodes(result.workspace.payload.root, (node) => node.kind === 'xmlProperty').map((node) => ({ id: node.id, label: node.label, status: node.status, mergeable: node.mergeable, left: node.leftValue, right: node.rightValue, ref: node.payloadRef }))));

      const preview = await result.workspace.createPreviewForNodeIds([event!.id, handler!.id]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      result.workspace.approvePreview(preview.preview.previewId);
      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId);
      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      assert.match(await fs.readFile(path.join(leftRoot, moduleRelative), 'utf8'), /&AtClient\r?\nProcedure OnChange/u);
      assert.match(await fs.readFile(path.join(leftRoot, 'Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form.xml'), 'utf8'), /<Event[^>]*>OnChange<\/Event>/u);
    } finally {
      result?.workspace.dispose();
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('adds an explicitly selected Russian Event handler when the target Form module is missing', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linked-designer-missing-module-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const moduleRelative = path.join('Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form', 'Module.bsl');
    const handlerName = 'ОбработчикОткрытия';
    const handlerSource = ['&НаКлиенте', `Процедура ${handlerName}()`, '    Возврат;', 'КонецПроцедуры'].join('\r\n');
    let result: Awaited<ReturnType<typeof buildConfigurationCompare>> | undefined;
    try {
      await writeCatalogConfigurationPair(leftRoot, rightRoot);
      await writeFile(path.join(leftRoot, 'Catalogs', 'Products.xml'), catalogDescriptor('Products', true));
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products.xml'), catalogDescriptor('Products', true));
      await writeFile(path.join(leftRoot, 'Catalogs', 'Products', 'Forms', 'Main.xml'), formDescriptor('Main'));
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products', 'Forms', 'Main.xml'), formDescriptor('Main'));
      await writeFile(path.join(leftRoot, 'Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form.xml'), formXml(''));
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form.xml'), formXml(handlerName));
      await writeFile(path.join(rightRoot, moduleRelative), handlerSource);

      const runtime = await createMergeMutationTestRuntime(leftRoot);
      mutationCoordinators.push(runtime.coordinator);
      result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
        mutationEngine: runtime.engine,
        configurationId: runtime.configurationId,
      });
      const handler = collectNodes(result.workspace.payload.root, (node) =>
        node.id.toLocaleLowerCase('ru-RU').includes(':обработчикоткрытия')
      )[0];
      const event = collectNodes(result.workspace.payload.root, (node) =>
        node.payloadRef?.includes('Event') === true && node.rightValue?.includes(handlerName) === true
      )[0];
      assert.ok(handler?.mergeable, `the incoming routine should be separately selectable; ${handler?.mergeState?.reason ?? ''}`);
      assert.ok(event?.mergeable, `the Event should be selectable with its explicitly selected handler; ${event?.mergeState?.reason ?? ''}`);
      assert.strictEqual(await pathExists(path.join(leftRoot, moduleRelative)), false, 'the target must start without Module.bsl');

      const preview = await result.workspace.createPreviewForNodeIds([event!.id, handler!.id]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      result.workspace.approvePreview(preview.preview.previewId);
      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId);
      assert.strictEqual(execution.ok, true, JSON.stringify(execution));

      const finalModule = await fs.readFile(path.join(leftRoot, moduleRelative), 'utf8');
      assert.match(finalModule, /^&НаКлиенте\r\nПроцедура ОбработчикОткрытия\(\)/u);
      assert.match(await fs.readFile(path.join(leftRoot, 'Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form.xml'), 'utf8'), />ОбработчикОткрытия<\/Event>/u);
    } finally {
      result?.workspace.dispose();
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('allows deleting an Event and its handler together', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linked-designer-event-handler-delete-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const moduleRelative = path.join('Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form', 'Module.bsl');
    let result: Awaited<ReturnType<typeof buildConfigurationCompare>> | undefined;
    try {
      await writeCatalogConfigurationPair(leftRoot, rightRoot);
      await writeFile(path.join(leftRoot, 'Catalogs', 'Products.xml'), catalogDescriptor('Products', true));
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products.xml'), catalogDescriptor('Products', true));
      await writeFile(path.join(leftRoot, 'Catalogs', 'Products', 'Forms', 'Main.xml'), formDescriptor('Main'));
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products', 'Forms', 'Main.xml'), formDescriptor('Main'));
      await writeFile(path.join(leftRoot, 'Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form.xml'), formXml('OnChange'));
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form.xml'), formXmlWithoutEvent());
      await writeFile(path.join(leftRoot, moduleRelative), routine('OnChange'));
      await writeFile(path.join(rightRoot, moduleRelative), routine('Shared'));

      const runtime = await createMergeMutationTestRuntime(leftRoot);
      mutationCoordinators.push(runtime.coordinator);
      result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
        mutationEngine: runtime.engine,
        configurationId: runtime.configurationId,
      });
      const strategy = await result.workspace.setStrategy('full');
      assert.strictEqual(strategy.ok, true, JSON.stringify(strategy));
      const handler = collectNodes(result.workspace.payload.root, (node) => node.id === 'bsl:routine:Catalog.Products.Form.Main.FormModule:onchange')[0];
      const event = collectNodes(result.workspace.payload.root, (node) =>
        node.kind === 'xmlProperty' && node.status === 'leftOnly' && node.label === 'Событие: OnChange'
      )[0];
      assert.ok(handler?.mergeable, 'the target-only handler should be selectable');
      assert.ok(event?.mergeable, 'deleting an Event should not require an incoming handler; ' + describeEventNodes(result.workspace.payload.root));

      const preview = await result.workspace.createPreviewForNodeIds([event!.id, handler!.id]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      result.workspace.approvePreview(preview.preview.previewId);
      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId, { destructiveConfirmed: true });
      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      assert.doesNotMatch(await fs.readFile(path.join(leftRoot, moduleRelative), 'utf8'), /Procedure OnChange/u);
      assert.doesNotMatch(await fs.readFile(path.join(leftRoot, 'Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form.xml'), 'utf8'), />OnChange</u);
    } finally {
      result?.workspace.dispose();
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

async function createFullFormDeletionCase(
  withDefaultFormReference = false,
  referenceProperty = 'DefaultObjectForm',
  hierarchicalOwnerDescriptor = false,
): Promise<{
  tempRoot: string;
  leftRoot: string;
  result: Awaited<ReturnType<typeof buildConfigurationCompare>>;
  registration: CompareTreeNode;
}> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linked-designer-delete-'));
  const leftRoot = path.join(tempRoot, 'left');
  const rightRoot = path.join(tempRoot, 'right');
  const ownerRelative = hierarchicalOwnerDescriptor
    ? path.join('Catalogs', 'Products', 'Products.xml')
    : path.join('Catalogs', 'Products.xml');
  const formDescriptorRelative = path.join('Catalogs', 'Products', 'Forms', 'Main.xml');
  const formXmlRelative = path.join('Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form.xml');
  await writeCatalogConfigurationPair(leftRoot, rightRoot);
  await writeFile(path.join(leftRoot, ownerRelative), withDefaultFormReference ? catalogDescriptorWithDefaultForm('Products', true, 'Main', referenceProperty) : catalogDescriptor('Products', true));
  await writeFile(path.join(rightRoot, ownerRelative), withDefaultFormReference ? catalogDescriptorWithDefaultForm('Products', false, '', referenceProperty) : catalogDescriptor('Products', false));
  await writeFile(path.join(leftRoot, formDescriptorRelative), formDescriptor('Main'));
  await writeFile(path.join(leftRoot, formXmlRelative), formXml('OnChange'));
  const runtime = await createMergeMutationTestRuntime(leftRoot);
  mutationCoordinators.push(runtime.coordinator);
  const result = await buildConfigurationCompare({
    leftRootPath: leftRoot,
    rightRootPath: rightRoot,
    backupRootPath: path.join(tempRoot, 'backups'),
    mutationEngine: runtime.engine,
    configurationId: runtime.configurationId,
  });
  const strategy = await result.workspace.setStrategy('full');
  assert.strictEqual(strategy.ok, true, JSON.stringify(strategy));
  const registration = collectNodes(result.workspace.payload.root, (node) =>
    node.kind === 'xmlElement' && node.label === 'Форма: Main' && node.status === 'leftOnly'
  )[0];
  assert.ok(registration, 'the existing Form registration should be selectable for a full-strategy delete; candidates=' + JSON.stringify(collectNodes(result.workspace.payload.root, (node) => node.kind === 'xmlElement').map((node) => ({ id: node.id, label: node.label, status: node.status, mergeable: node.mergeable, left: node.leftValue, right: node.rightValue, ref: node.payloadRef }))));
  assert.strictEqual(registration!.mergeable, true, registration!.mergeState?.reason);
  return { tempRoot, leftRoot, result, registration: registration! };
}

async function createFormDeletionWithConstantOwnerCase(): Promise<{
  tempRoot: string;
  leftRoot: string;
  result: Awaited<ReturnType<typeof buildConfigurationCompare>>;
  registration: CompareTreeNode;
}> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linked-designer-negative-owner-'));
  const leftRoot = path.join(tempRoot, 'left');
  const rightRoot = path.join(tempRoot, 'right');
  const configuration = configurationWithCatalogAndConstant();
  await writeFile(path.join(leftRoot, 'Configuration.xml'), configuration);
  await writeFile(path.join(rightRoot, 'Configuration.xml'), configuration);
  await writeFile(path.join(leftRoot, 'Catalogs', 'Products.xml'), catalogDescriptor('Products', true));
  await writeFile(path.join(rightRoot, 'Catalogs', 'Products.xml'), catalogDescriptor('Products', false));
  await writeFile(path.join(leftRoot, 'Constants', 'Reader.xml'), constantDescriptor('Reader', ''));
  await writeFile(path.join(rightRoot, 'Constants', 'Reader.xml'), constantDescriptor('Reader', ''));
  await writeFile(path.join(leftRoot, 'Catalogs', 'Products', 'Forms', 'Main.xml'), formDescriptor('Main'));
  await writeFile(path.join(leftRoot, 'Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form.xml'), formXml('OnChange'));
  const runtime = await createMergeMutationTestRuntime(leftRoot);
  mutationCoordinators.push(runtime.coordinator);
  const result = await buildConfigurationCompare({
    leftRootPath: leftRoot,
    rightRootPath: rightRoot,
    backupRootPath: path.join(tempRoot, 'backups'),
    mutationEngine: runtime.engine,
    configurationId: runtime.configurationId,
  });
  const strategy = await result.workspace.setStrategy('full');
  assert.strictEqual(strategy.ok, true, JSON.stringify(strategy));
  const registration = collectNodes(result.workspace.payload.root, (node) =>
    node.kind === 'xmlElement' && node.label === 'Форма: Main' && node.status === 'leftOnly'
  )[0];
  assert.ok(registration?.mergeable, registration?.mergeState?.reason);
  return { tempRoot, leftRoot, result, registration: registration! };
}

async function createHandlerComparison(
  targetFormXml: string,
  sourceFormXml: string,
  targetModule: string,
  sourceModule: string,
): Promise<{
  tempRoot: string;
  leftRoot: string;
  result: Awaited<ReturnType<typeof buildConfigurationCompare>>;
  formRelative: string;
  moduleRelative: string;
}> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linked-designer-dependency-'));
  const leftRoot = path.join(tempRoot, 'left');
  const rightRoot = path.join(tempRoot, 'right');
  const formRelative = path.join('Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form.xml');
  const moduleRelative = path.join('Catalogs', 'Products', 'Forms', 'Main', 'Ext', 'Form', 'Module.bsl');
  await writeCatalogConfigurationPair(leftRoot, rightRoot);
  await writeFile(path.join(leftRoot, 'Catalogs', 'Products.xml'), catalogDescriptor('Products', true));
  await writeFile(path.join(rightRoot, 'Catalogs', 'Products.xml'), catalogDescriptor('Products', true));
  await writeFile(path.join(leftRoot, 'Catalogs', 'Products', 'Forms', 'Main.xml'), formDescriptor('Main'));
  await writeFile(path.join(rightRoot, 'Catalogs', 'Products', 'Forms', 'Main.xml'), formDescriptor('Main'));
  await writeFile(path.join(leftRoot, formRelative), targetFormXml);
  await writeFile(path.join(rightRoot, formRelative), sourceFormXml);
  await writeFile(path.join(leftRoot, moduleRelative), targetModule);
  await writeFile(path.join(rightRoot, moduleRelative), sourceModule);
  const runtime = await createMergeMutationTestRuntime(leftRoot);
  mutationCoordinators.push(runtime.coordinator);
  const result = await buildConfigurationCompare({
    leftRootPath: leftRoot,
    rightRootPath: rightRoot,
    backupRootPath: path.join(tempRoot, 'backups'),
    mutationEngine: runtime.engine,
    configurationId: runtime.configurationId,
  });
  return { tempRoot, leftRoot, result, formRelative, moduleRelative };
}

function catalogDescriptor(name: string, withForm: boolean): string {
  return `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Catalog uuid="01234567-89ab-cdef-0123-456789abcdef"><Properties><Name>${name}</Name></Properties>${withForm ? '<ChildObjects><Form>Main</Form></ChildObjects>' : ''}</Catalog></MetaDataObject>`;
}

function nestedTemplateOwnerDescriptor(name: string, uuid: string, templateName: string, version: string): string {
  return `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="${version}"><Catalog uuid="${uuid}"><Properties><Name>${name}</Name></Properties><ChildObjects><Template>${templateName}</Template></ChildObjects></Catalog></MetaDataObject>`;
}

function nestedTemplateDescriptor(name: string, uuid: string, version: string): string {
  return `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="${version}"><Template uuid="${uuid}"><Properties><Name>${name}</Name><TemplateType>DataCompositionSchema</TemplateType></Properties></Template></MetaDataObject>`;
}

function linkedDcsXml(query: string): string {
  return `<d:DataCompositionSchema xmlns:d="http://v8.1c.ru/8.1/data-composition-system/schema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:dcsset="http://v8.1c.ru/8.1/data-composition-system/settings"><d:dataSource><d:name>Source</d:name><d:dataSourceType>Local</d:dataSourceType></d:dataSource><d:dataSet xsi:type="d:DataSetQuery"><d:name>Query</d:name><d:dataSource>Source</d:dataSource><d:query>${query}</d:query></d:dataSet><d:settingsVariant><dcsset:name>Default</dcsset:name><d:settings/></d:settingsVariant></d:DataCompositionSchema>`;
}

function findDcsQueryNode(root: CompareTreeNode): CompareTreeNode | undefined {
  return collectNodes(root, (node) => node.kind === 'xmlProperty' && Boolean(node.rightValue?.includes('SELECT')))[0];
}

function templateDescriptor(name: string, templateType: string): string {
  return `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Template uuid="41234567-89ab-cdef-0123-456789abcdef"><Properties><Name>${name}</Name><TemplateType>${templateType}</TemplateType></Properties></Template></MetaDataObject>`;
}

async function writeTemplateConfigurationPair(leftRoot: string, rightRoot: string): Promise<void> {
  const configuration = `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Configuration uuid="31234567-89ab-cdef-0123-456789abcdef"><Properties><Name>Config</Name></Properties><ChildObjects><Template>Print</Template></ChildObjects></Configuration></MetaDataObject>`;
  await writeFile(path.join(leftRoot, 'Configuration.xml'), configuration);
  await writeFile(path.join(rightRoot, 'Configuration.xml'), configuration);
}

function catalogDescriptorWithDefaultForm(name: string, withForm: boolean, defaultForm: string, propertyName = 'DefaultObjectForm'): string {
  return `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Catalog uuid="01234567-89ab-cdef-0123-456789abcdef"><Properties><Name>${name}</Name><${propertyName}>${defaultForm}</${propertyName}></Properties>${withForm ? '<ChildObjects><Form>Main</Form></ChildObjects>' : ''}</Catalog></MetaDataObject>`;
}

function formDescriptor(name: string): string {
  return `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Form uuid="fedcba98-7654-3210-fedc-ba9876543210"><Properties><Name>${name}</Name><FormType>Managed</FormType></Properties></Form></MetaDataObject>`;
}

function commonFormDescriptor(name: string): string {
  return `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><CommonForm uuid="11234567-89ab-cdef-0123-456789abcdef"><Properties><Name>${name}</Name></Properties></CommonForm></MetaDataObject>`;
}

function constantDescriptor(name: string, defaultForm: string): string {
  return `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Constant uuid="21234567-89ab-cdef-0123-456789abcdef"><Properties><Name>${name}</Name><DefaultForm>${defaultForm}</DefaultForm></Properties></Constant></MetaDataObject>`;
}

function configurationWithCommonForm(include: boolean): string {
  return `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Configuration uuid="31234567-89ab-cdef-0123-456789abcdef"><Properties><Name>Config</Name></Properties><ChildObjects><Constant>Reader</Constant>${include ? '<CommonForm>Shared</CommonForm>' : ''}</ChildObjects></Configuration></MetaDataObject>`;
}

async function writeCatalogConfigurationPair(leftRoot: string, rightRoot: string): Promise<void> {
  await writeFile(path.join(leftRoot, 'Configuration.xml'), configurationWithCatalog());
  await writeFile(path.join(rightRoot, 'Configuration.xml'), configurationWithCatalog());
}

function configurationWithCatalog(): string {
  return `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Configuration uuid="31234567-89ab-cdef-0123-456789abcdef"><Properties><Name>Config</Name></Properties><ChildObjects><Catalog>Products</Catalog></ChildObjects></Configuration></MetaDataObject>`;
}

function configurationWithCatalogAndConstant(): string {
  return `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Configuration uuid="31234567-89ab-cdef-0123-456789abcdef"><Properties><Name>Config</Name></Properties><ChildObjects><Catalog>Products</Catalog><Constant>Reader</Constant></ChildObjects></Configuration></MetaDataObject>`;
}

function configurationWithCatalogAndCommonForm(includeCommonForm: boolean): string {
  return `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Configuration uuid="31234567-89ab-cdef-0123-456789abcdef"><Properties><Name>Config</Name></Properties><ChildObjects><Catalog>Products</Catalog>${includeCommonForm ? '<CommonForm>Shared</CommonForm>' : ''}</ChildObjects></Configuration></MetaDataObject>`;
}

function linuxDescriptorKeyConfiguration(includeIncomingObjects: boolean): string {
  const incomingObjects = includeIncomingObjects
    ? '<CommonForm>Shared</CommonForm><CommonTemplate>Print</CommonTemplate><CommonCommand>Run</CommonCommand><InformationRegister>Stock</InformationRegister><DataProcessor>Importer</DataProcessor>'
    : '';
  return `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Configuration uuid="31234567-89ab-cdef-0123-456789abcdef"><Properties><Name>Config</Name></Properties><ChildObjects><Catalog>Products</Catalog>${incomingObjects}</ChildObjects></Configuration></MetaDataObject>`;
}

function commonTemplateDescriptor(name: string): string {
  return `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses"><CommonTemplate uuid="31234567-89ab-cdef-0123-456789abcd01"><Properties><Name>${name}</Name><TemplateType>DataCompositionSchema</TemplateType></Properties></CommonTemplate></MetaDataObject>`;
}

function commonCommandDescriptor(name: string): string {
  return `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses"><CommonCommand uuid="31234567-89ab-cdef-0123-456789abcd02"><Properties><Name>${name}</Name></Properties></CommonCommand></MetaDataObject>`;
}

function informationRegisterDescriptor(name: string): string {
  return `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses"><InformationRegister uuid="31234567-89ab-cdef-0123-456789abcd03"><Properties><Name>${name}</Name></Properties></InformationRegister></MetaDataObject>`;
}

function dataProcessorDescriptor(name: string): string {
  return `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses"><DataProcessor uuid="31234567-89ab-cdef-0123-456789abcd04"><Properties><Name>${name}</Name></Properties></DataProcessor></MetaDataObject>`;
}

async function collectFileBytes(rootPath: string): Promise<Map<string, Buffer>> {
  const results = new Map<string, Buffer>();
  const pending = [rootPath];
  while (pending.length > 0) {
    const directoryPath = pending.pop()!;
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {pending.push(entryPath); continue;}
      if (entry.isFile()) {
        const relativePath = path.relative(rootPath, entryPath).replace(/\\/gu, '/');
        results.set(relativePath, await fs.readFile(entryPath));
      }
    }
  }
  return new Map([...results.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function formXml(handler: string): string {
  return `<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20"><Attributes/><Commands/><ChildItems><InputField name="Field" id="1"><Events><Event name="OnChange">${handler}</Event></Events></InputField></ChildItems></Form>`;
}

function formXmlWithoutEvent(): string {
  return '<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20"><Attributes/><Commands/><ChildItems><InputField name="Field" id="1"/></ChildItems></Form>';
}

function routine(name: string): string {
  return [`Procedure ${name}()`, '  Value = 1;', 'EndProcedure'].join('\n');
}

function routineWithDirective(name: string): string {
  return [`&AtClient`, ...routine(name).split('\n')].join('\r\n');
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

async function pathExists(filePath: string): Promise<boolean> {
  try {await fs.access(filePath); return true;} catch {return false;}
}

function collectNodes(root: CompareTreeNode, predicate: (node: CompareTreeNode) => boolean): CompareTreeNode[] {
  const result: CompareTreeNode[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (predicate(node)) {result.push(node);}
    pending.push(...node.children);
  }
  return result;
}

function describeEventNodes(root: CompareTreeNode): string {
  return JSON.stringify(collectNodes(root, (node) =>
    /Event|Событие/iu.test(node.label) || /Event/iu.test(node.payloadRef ?? '')
  ).map((node) => ({
    id: node.id,
    label: node.label,
    kind: node.kind,
    status: node.status,
    mergeable: node.mergeable,
    left: node.leftValue,
    right: node.rightValue,
    payloadRef: node.payloadRef,
    reason: node.mergeState?.reason,
  })));
}
