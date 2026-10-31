import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';

import {
  buildConfigurationCompare,
  type ConfigurationCompareInput,
  type ConfigurationCompareResult,
} from '../../../src/compareMerge/configurationCompareService';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import {
  createExtensionCompareTempRoot,
  metadataObjectXml,
  pathExists,
  readUtf8,
  writeCompareBytes,
  writeDesignerConfiguration,
  type ExtensionCompareObjectFixture,
} from '../../helpers/extensionCompareFixtures';
import { createMergeMutationTestRuntime } from './mergeMutationTestSupport';

const MD = 'http://v8.1c.ru/8.3/MDClasses';
const BASE_TEMPLATE_UUID = '11111111-1111-4111-8111-111111111111';
const TARGET_TEMPLATE_UUID = '22222222-2222-4222-8222-222222222222';
const SOURCE_TEMPLATE_UUID = '33333333-3333-4333-8333-333333333333';
const BASE_CATALOG_UUID = '44444444-4444-4444-8444-444444444444';
const TARGET_CATALOG_UUID = '55555555-5555-4555-8555-555555555555';
const SOURCE_CATALOG_UUID = '66666666-6666-4666-8666-666666666666';

suite('Public adopted Template integration (#335)', () => {
  test('transfers a root CommonTemplate type/body bundle with a selected Comment in all directions', async function (this: Mocha.Context) {
    this.timeout(240000);
    for (const direction of ['cf-to-cfe', 'cfe-to-cf', 'cfe-cfe-adopted'] as const) {
      await withTempRoot(async (tempRoot) => {
        const base = path.join(tempRoot, 'base-cf');
        const target = path.join(tempRoot, 'target');
        const source = path.join(tempRoot, 'source');
        const targetIsCfe = direction !== 'cfe-to-cf';
        const sourceIsCfe = direction !== 'cf-to-cfe';
        const baseTemplate: ExtensionCompareObjectFixture = {
          type: 'CommonTemplate', name: 'Print', uuid: BASE_TEMPLATE_UUID,
          propertiesXml: '<TemplateType>SpreadsheetDocument</TemplateType><Comment>base comment</Comment>',
        };
        const targetTemplate: ExtensionCompareObjectFixture = targetIsCfe
          ? adoptedTemplate(BASE_TEMPLATE_UUID, TARGET_TEMPLATE_UUID, 'SpreadsheetDocument', 'target note')
          : { ...baseTemplate, propertiesXml: '<TemplateType>SpreadsheetDocument</TemplateType><Comment>target note</Comment>' };
        const sourceTemplate: ExtensionCompareObjectFixture = sourceIsCfe
          ? adoptedTemplate(BASE_TEMPLATE_UUID, SOURCE_TEMPLATE_UUID, 'BinaryData', 'incoming note')
          : { ...baseTemplate, propertiesXml: '<TemplateType>BinaryData</TemplateType><Comment>incoming note</Comment>' };

        await writeConfiguration(base, { name: 'Shared configuration', objects: [baseTemplate] });
        await writeConfiguration(target, {
          ...(targetIsCfe ? { purpose: 'Customization' as const, name: 'Shared configuration' } : { name: 'Shared configuration' }),
          objects: [targetTemplate],
        });
        await writeConfiguration(source, {
          ...(sourceIsCfe ? { purpose: 'Customization' as const, name: 'Shared configuration' } : { name: 'Shared configuration' }),
          objects: [sourceTemplate],
        });
        await writeTemplateBody(base, 'CommonTemplates/Print.xml', 'SpreadsheetDocument', Buffer.from('base spreadsheet body'));
        await writeTemplateBody(target, 'CommonTemplates/Print.xml', 'SpreadsheetDocument', Buffer.from('target spreadsheet body'));
        await writeTemplateBody(source, 'CommonTemplates/Print.xml', 'BinaryData', Buffer.from('selected binary body'));
        const baseBefore = await snapshotTree(base);
        const sourceBefore = await snapshotTree(source);

        const compare = await openCompare(tempRoot, target, source, {
          withRuntime: true,
          extensionBaseRoots: direction === 'cf-to-cfe' ? { left: base }
            : direction === 'cfe-to-cf' ? { right: base } : { left: base, right: base },
        });
        try {
          const allNodes = collectNodes(compare.result.projection.root);
          const bundle = allNodes.find((node) => node.kind === 'adoptedTemplateBundle'
            && node.label === 'Перенести тип и тело макета'
            && (node.mergeState?.targetFilePath ?? '').replace(/\\/gu, '/').endsWith('CommonTemplates/Print.xml'));
          assert.ok(bundle, `${direction}: exact root TemplateType/body package should be offered: ${JSON.stringify(describe(allNodes))}`);
          assert.strictEqual(bundle!.mergeable, true, `${direction}: the captured type/body bundle is executable`);
          assert.strictEqual(bundle!.rightValue, 'BinaryData', `${direction}: the bundle carries the selected TemplateType`);
          assert.ok(bundle!.children.some((node) => node.label === 'TemplateType' && node.mergeable === false),
            `${direction}: TemplateType stays visible only as a read-only child of the bundle`);
          const comment = allNodes.find((node) => node.kind === 'xmlProperty' && node.label === 'Comment'
            && node.rightValue === 'incoming note'
            && (node.mergeState?.targetFilePath ?? '').replace(/\\/gu, '/').endsWith('/CommonTemplates/Print.xml'));
          assert.ok(comment, `${direction}: ordinary Comment remains visible beside the bundle`);
          assert.strictEqual(comment!.mergeable, true, `${direction}: the body blocker must not disable Comment`);

          const preview = await createPreview(compare.result, [bundle!.id, comment!.id]);
          assert.strictEqual(compare.result.workspace.approvePreview(preview.previewId).ok, true);
          const executed = await compare.result.workspace.executeApprovedPreview(preview.previewId, { destructiveConfirmed: true });
          assert.strictEqual(executed.ok, true, JSON.stringify({ diagnostics: executed.diagnostics, failed: executed.result?.failed }));

          const targetDescriptor = await readUtf8(target, 'CommonTemplates/Print.xml');
          assert.match(targetDescriptor, new RegExp(`<CommonTemplate uuid="${targetIsCfe ? TARGET_TEMPLATE_UUID : BASE_TEMPLATE_UUID}"`, 'u'));
          assert.match(targetDescriptor, /<TemplateType(?:\s[^>]*)?>BinaryData<\/TemplateType>/u);
          assert.match(targetDescriptor, /<Comment(?:\s[^>]*)?>incoming note<\/Comment>/u);
          if (targetIsCfe) {
            assert.match(targetDescriptor, new RegExp(`<ExtendedConfigurationObject>${BASE_TEMPLATE_UUID}<\/ExtendedConfigurationObject>`, 'u'));
            assert.match(targetDescriptor, /<xr:Property>Template<\/xr:Property><xr:State>Extended<\/xr:State>/u);
          } else {
            assert.doesNotMatch(targetDescriptor, /<ObjectBelonging>|<ExtendedConfigurationObject>/u);
          }
          assert.strictEqual(await fs.readFile(path.join(target, 'CommonTemplates/Print/Ext/Template.bin'), 'utf8'), 'selected binary body');
          assert.strictEqual(await pathExists(path.join(target, 'CommonTemplates/Print/Ext/Template.xml')), false,
            `${direction}: the captured previous body path should be deleted after the type change`);
          assert.deepStrictEqual(await snapshotTree(base), baseBefore, `${direction}: captured base must stay unchanged`);
          assert.deepStrictEqual(await snapshotTree(source), sourceBefore, `${direction}: incoming source must stay unchanged`);
        } finally {
          await compare.dispose();
        }
      });
    }
  });

  test('executes a nested same-type body-only bundle and co-selects a Comment without touching the owner', async function (this: Mocha.Context) {
    this.timeout(180000);
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cfe');
      const baseOwner = catalogFixture(BASE_CATALOG_UUID, false, '<Template>Print</Template>');
      const targetOwner = catalogFixture(TARGET_CATALOG_UUID, true, '<Template>Print</Template>');
      const sourceOwner = catalogFixture(SOURCE_CATALOG_UUID, true, '<Template>Print</Template>');
      await writeConfiguration(base, { name: 'Shared configuration', objects: [baseOwner] });
      await writeConfiguration(target, { purpose: 'Customization', name: 'Shared configuration', objects: [targetOwner] });
      await writeConfiguration(source, { purpose: 'Customization', name: 'Shared configuration', objects: [sourceOwner] });
      const baseDescriptor = nestedTemplate(BASE_TEMPLATE_UUID, undefined, 'BinaryData', 'base comment');
      const targetDescriptor = nestedTemplate(TARGET_TEMPLATE_UUID, BASE_TEMPLATE_UUID, 'BinaryData', 'target comment');
      const sourceDescriptor = nestedTemplate(SOURCE_TEMPLATE_UUID, BASE_TEMPLATE_UUID, 'BinaryData', 'incoming comment');
      const relativeDescriptorPath = 'Catalogs/Products/Templates/Print.xml';
      await Promise.all([
        writeCompareBytes(base, relativeDescriptorPath, baseDescriptor),
        writeCompareBytes(target, relativeDescriptorPath, targetDescriptor),
        writeCompareBytes(source, relativeDescriptorPath, sourceDescriptor),
        writeCompareBytes(base, 'Catalogs/Products/Templates/Print/Ext/Template.bin', Buffer.from('base body')),
        writeCompareBytes(target, 'Catalogs/Products/Templates/Print/Ext/Template.bin', Buffer.from('target body')),
        writeCompareBytes(source, 'Catalogs/Products/Templates/Print/Ext/Template.bin', Buffer.from('nested selected body')),
      ]);
      const baseBefore = await snapshotTree(base);
      const sourceBefore = await snapshotTree(source);
      const targetOwnerBefore = await fs.readFile(path.join(target, 'Catalogs/Products.xml'));

      const compare = await openCompare(tempRoot, target, source, {
        withRuntime: true,
        extensionBaseRoots: { left: base, right: base },
      });
      try {
        const allNodes = collectNodes(compare.result.projection.root);
        assert.strictEqual(allNodes.some((node) => node.mergeState?.reason?.includes('ChildObjects/Template отсутствует Properties.')),
          false, 'the registered native Template name leaf is validated as a registration, not inline metadata');
        const bundle = allNodes.find((node) => node.kind === 'adoptedTemplateBundle'
          && node.label === 'Перенести тело макета'
          && (node.mergeState?.targetFilePath ?? '').replace(/\\/gu, '/').endsWith(relativeDescriptorPath));
        assert.ok(bundle, `nested body-only change should be offered as one action: ${JSON.stringify(describe(allNodes))}`);
        assert.strictEqual(bundle!.mergeable, true);
        const comment = allNodes.find((node) => node.kind === 'xmlProperty' && node.label === 'Comment'
          && node.rightValue === 'incoming comment'
          && (node.mergeState?.targetFilePath ?? '').replace(/\\/gu, '/').endsWith(`/${relativeDescriptorPath}`));
        assert.ok(comment, 'nested Comment remains a separate selectable descriptor property');
        assert.strictEqual(comment!.mergeable, true);

        const preview = await createPreview(compare.result, [bundle!.id, comment!.id]);
        assert.strictEqual(compare.result.workspace.approvePreview(preview.previewId).ok, true);
        const executed = await compare.result.workspace.executeApprovedPreview(preview.previewId, { destructiveConfirmed: true });
        assert.strictEqual(executed.ok, true, JSON.stringify({ diagnostics: executed.diagnostics, failed: executed.result?.failed }));

        const output = await readUtf8(target, relativeDescriptorPath);
        assert.match(output, new RegExp(`<Template uuid="${TARGET_TEMPLATE_UUID}"`, 'u'));
        assert.match(output, new RegExp(`<ExtendedConfigurationObject>${BASE_TEMPLATE_UUID}<\/ExtendedConfigurationObject>`, 'u'));
        assert.match(output, /<TemplateType(?:\s[^>]*)?>BinaryData<\/TemplateType>/u);
        assert.match(output, /<Comment(?:\s[^>]*)?>incoming comment<\/Comment>/u);
        assert.match(output, /<xr:Property>Template<\/xr:Property><xr:State>Extended<\/xr:State>/u);
        assert.strictEqual(await fs.readFile(path.join(target, 'Catalogs/Products/Templates/Print/Ext/Template.bin'), 'utf8'), 'nested selected body');
        assert.deepStrictEqual(await fs.readFile(path.join(target, 'Catalogs/Products.xml')), targetOwnerBefore,
          'nested descriptor output must not rewrite its parent Catalog descriptor');
        assert.deepStrictEqual(await snapshotTree(base), baseBefore, 'both captured bases remain unchanged');
        assert.deepStrictEqual(await snapshotTree(source), sourceBefore, 'the adopted source remains unchanged');
      } finally {
        await compare.dispose();
      }
    });
  });

  test('keeps source-only and malformed Template registrations scoped while owner Comment remains selectable', async () => {
    const sourceRegistrations = [
      { xml: '<Template>Print</Template><Template>Added</Template>', reason: 'base registration' },
      { xml: '<Template><Properties><Name>Print</Name></Properties></Template>', reason: 'plain-name registration' },
    ];
    for (const scenario of sourceRegistrations) {
      await withTempRoot(async (tempRoot) => {
        const base = path.join(tempRoot, 'base-cf');
        const target = path.join(tempRoot, 'target-cfe');
        const source = path.join(tempRoot, 'source-cfe');
        const baseOwner = catalogFixture(BASE_CATALOG_UUID, false, '<Template>Print</Template>', 'base owner');
        const targetOwner = catalogFixture(TARGET_CATALOG_UUID, true, '<Template>Print</Template>', 'target owner');
        const sourceOwner = catalogFixture(SOURCE_CATALOG_UUID, true, scenario.xml, 'incoming owner');
        await writeConfiguration(base, { name: 'Shared configuration', objects: [baseOwner] });
        await writeConfiguration(target, { purpose: 'Customization', name: 'Shared configuration', objects: [targetOwner] });
        await writeConfiguration(source, { purpose: 'Customization', name: 'Shared configuration', objects: [sourceOwner] });
        const descriptorPath = 'Catalogs/Products/Templates/Print.xml';
        await Promise.all([
          writeCompareBytes(base, descriptorPath, nestedTemplate(BASE_TEMPLATE_UUID, undefined, 'BinaryData', 'base')),
          writeCompareBytes(target, descriptorPath, nestedTemplate(TARGET_TEMPLATE_UUID, BASE_TEMPLATE_UUID, 'BinaryData', 'target')),
          writeCompareBytes(source, descriptorPath, nestedTemplate(SOURCE_TEMPLATE_UUID, BASE_TEMPLATE_UUID, 'BinaryData', 'incoming')),
          writeCompareBytes(base, 'Catalogs/Products/Templates/Print/Ext/Template.bin', Buffer.from('base')),
          writeCompareBytes(target, 'Catalogs/Products/Templates/Print/Ext/Template.bin', Buffer.from('target')),
          writeCompareBytes(source, 'Catalogs/Products/Templates/Print/Ext/Template.bin', Buffer.from('incoming')),
        ]);

        const compare = await openCompare(tempRoot, target, source, { extensionBaseRoots: { left: base, right: base } });
        try {
          const allNodes = collectNodes(compare.result.projection.root);
          const issue = allNodes.find((node) => node.kind === 'extensionSemanticFile'
            && (node.mergeState?.targetFilePath ?? '').replace(/\\/gu, '/').endsWith('Catalogs/Products.xml')
            && node.mergeState?.reason?.includes('Template registration'));
          assert.ok(issue, `${scenario.reason}: registration mismatch/malformed shape stays visible and scoped: ${describe(allNodes)}`);
          assert.strictEqual(issue!.mergeable, false);
          const ownerComment = allNodes.find((node) => node.kind === 'xmlProperty'
            && node.label === 'Comment' && node.rightValue === 'incoming owner');
          assert.ok(ownerComment, `${scenario.reason}: owner Comment remains in the projected tree`);
          assert.strictEqual(ownerComment!.mergeable, true, `${scenario.reason}: registration scope does not disable Comment`);
        } finally {
          await compare.dispose();
        }
      });
    }
  });

  test('keeps HTML body profiles scoped read-only while unrelated owner properties remain selectable', async () => {
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base-cf');
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cf');
      const baseTemplate: ExtensionCompareObjectFixture = {
        type: 'CommonTemplate', name: 'Print', uuid: BASE_TEMPLATE_UUID,
        propertiesXml: '<TemplateType>SpreadsheetDocument</TemplateType><Comment>base</Comment>',
      };
      const targetTemplate = adoptedTemplate(BASE_TEMPLATE_UUID, TARGET_TEMPLATE_UUID, 'SpreadsheetDocument', 'target');
      const sourceTemplate: ExtensionCompareObjectFixture = {
        ...baseTemplate,
        propertiesXml: '<TemplateType>HTMLDocument</TemplateType><Comment>incoming</Comment>',
      };
      await writeConfiguration(base, { name: 'Shared configuration', objects: [baseTemplate] });
      await writeConfiguration(target, { purpose: 'Customization', name: 'Shared configuration', objects: [targetTemplate] });
      await writeConfiguration(source, { name: 'Shared configuration', objects: [sourceTemplate] });
      await writeTemplateBody(base, 'CommonTemplates/Print.xml', 'SpreadsheetDocument', Buffer.from('base body'));
      await writeTemplateBody(target, 'CommonTemplates/Print.xml', 'SpreadsheetDocument', Buffer.from('target body'));
      const compare = await openCompare(tempRoot, target, source, { extensionBaseRoots: { left: base } });
      try {
        const allNodes = collectNodes(compare.result.projection.root);
        const blocker = allNodes.find((node) => node.kind === 'extensionSemanticFile'
          && node.label.includes('Проверка adopted макета')
          && (node.mergeState?.targetFilePath ?? '').replace(/\\/gu, '/').endsWith('CommonTemplates/Print.xml'));
        assert.ok(blocker, `unsupported HTML physical profile should have a scoped explanation: ${JSON.stringify(describe(allNodes))}`);
        assert.strictEqual(blocker!.mergeable, false);
        const comment = allNodes.find((node) => node.kind === 'xmlProperty' && node.label === 'Comment'
          && node.rightValue === 'incoming'
          && (node.mergeState?.targetFilePath ?? '').replace(/\\/gu, '/').endsWith('/CommonTemplates/Print.xml'));
        assert.ok(comment);
        assert.strictEqual(comment!.mergeable, true, 'template profile refusal must not disable an unrelated scalar');
      } finally {
        await compare.dispose();
      }
    });
  });
});

interface OpenCompareOptions extends Pick<ConfigurationCompareInput, 'extensionBaseRoots'> {
  readonly withRuntime?: boolean;
}

interface OpenCompareHandle {
  readonly result: ConfigurationCompareResult;
  dispose(): Promise<void>;
}

async function openCompare(
  tempRoot: string,
  leftRootPath: string,
  rightRootPath: string,
  options: OpenCompareOptions,
): Promise<OpenCompareHandle> {
  const runtime = options.withRuntime ? await createMergeMutationTestRuntime(leftRootPath) : undefined;
  try {
    const result = await buildConfigurationCompare({
      leftRootPath,
      rightRootPath,
      backupRootPath: path.join(tempRoot, 'backups'),
      extensionBaseRoots: options.extensionBaseRoots,
      mutationEngine: runtime?.engine,
      configurationId: runtime?.configurationId,
    });
    return {
      result,
      dispose: async () => {
        result.workspace.dispose();
        await runtime?.coordinator.dispose();
      },
    };
  } catch (error) {
    await runtime?.coordinator.dispose();
    throw error;
  }
}

async function writeConfiguration(
  root: string,
  fixture: Parameters<typeof writeDesignerConfiguration>[1],
): Promise<void> {
  await writeDesignerConfiguration(root, {
    ...fixture,
    objects: fixture?.objects?.map(mdClassesFixture),
  });
  const configPath = path.join(root, 'Configuration.xml');
  const original = await fs.readFile(configPath, 'utf8');
  const qualified = original.replace('<MetaDataObject ', `<MetaDataObject xmlns="${MD}" `);
  assert.notStrictEqual(qualified, original, 'fixture Configuration.xml must use the native MDClasses namespace');
  await fs.writeFile(configPath, qualified, 'utf8');
}

function adoptedTemplate(
  baseUuid: string,
  localUuid: string,
  templateType: string,
  comment: string,
): ExtensionCompareObjectFixture {
  return {
    type: 'CommonTemplate', name: 'Print', uuid: localUuid, belonging: 'Adopted', anchorUuid: baseUuid,
    propertiesXml: `<TemplateType>${templateType}</TemplateType><Comment>${comment}</Comment>`,
  };
}

function catalogFixture(uuid: string, adopted: boolean, childObjectsXml: string, comment = 'shared owner'): ExtensionCompareObjectFixture {
  return {
    type: 'Catalog', name: 'Products', uuid,
    ...(adopted ? { belonging: 'Adopted' as const, anchorUuid: BASE_CATALOG_UUID } : {}),
    propertiesXml: `<Comment>${comment}</Comment>`,
    childObjectsXml,
  };
}

function nestedTemplate(uuid: string, anchor: string | undefined, type: string, comment: string): string {
  const ownership = anchor
    ? `<ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>${anchor}</ExtendedConfigurationObject>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="${MD}" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="2.20">` +
    `<Template uuid="${uuid}"><Properties><Name>Print</Name>${ownership}<TemplateType>${type}</TemplateType><Comment>${comment}</Comment></Properties></Template></MetaDataObject>`;
}

async function writeTemplateBody(root: string, descriptorPath: string, type: string, content: Buffer): Promise<void> {
  const extension = type === 'SpreadsheetDocument' ? 'xml' : type === 'BinaryData' ? 'bin' : 'html';
  const descriptorStem = descriptorPath.replace(/\.xml$/iu, '');
  await writeCompareBytes(root, `${descriptorStem}/Ext/Template.${extension}`, content);
}

function mdClassesFixture(fixture: ExtensionCompareObjectFixture): ExtensionCompareObjectFixture {
  if (fixture.descriptorXml) {return fixture;}
  const descriptorXml = metadataObjectXml(fixture).replace('<MetaDataObject', `<MetaDataObject xmlns="${MD}"`);
  return { ...fixture, descriptorXml };
}

function collectNodes(root: CompareTreeNode): CompareTreeNode[] {
  return [root, ...root.children.flatMap(collectNodes)];
}

function describe(nodes: readonly CompareTreeNode[]): string {
  return JSON.stringify(nodes.map((node) => ({
    id: node.id, label: node.label, kind: node.kind, mergeable: node.mergeable,
    target: node.mergeState?.targetFilePath, reason: node.mergeState?.reason, conflict: node.conflict,
  })));
}

async function createPreview(result: ConfigurationCompareResult, nodeIds: readonly string[]) {
  const created = await result.workspace.createPreviewForNodeIds(nodeIds);
  if (!created.ok) {assert.fail(`preview failed: ${JSON.stringify(created.diagnostics)}`);}
  return created.preview;
}

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(directory: string, prefix = ''): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = path.posix.join(prefix, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { await visit(absolute, relative); }
      else { files[relative] = (await fs.readFile(absolute)).toString('base64'); }
    }
  }
  await visit(root);
  return files;
}

async function withTempRoot(callback: (tempRoot: string) => Promise<void>): Promise<void> {
  const tempRoot = await createExtensionCompareTempRoot('issue335-adopted-template-public-');
  try { await callback(tempRoot); }
  finally { await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}
