import * as assert from 'assert';
import crypto = require('crypto');
import * as fs from 'fs/promises';
import * as path from 'path';

import {
  buildConfigurationCompare,
  type ConfigurationCompareInput,
  type ConfigurationCompareResult,
} from '../../../src/compareMerge/configurationCompareService';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import { elementChildren, parseXmlDocument, textContent, type XmlElement } from '../../../src/compareMerge/xml/xmlDom';
import {
  createExtensionCompareTempRoot,
  writeCompareBytes,
  writeDesignerConfiguration,
  type ExtensionCompareObjectFixture,
} from '../../helpers/extensionCompareFixtures';
import { createMergeMutationTestRuntime } from './mergeMutationTestSupport';

const VERSION = '2.20';
const CONFIGURATION_UUID = '11111111-1111-4111-8111-111111111111';
const BASE_OWNER_UUID = '22222222-2222-4222-8222-222222222222';
const BASE_OWNER_GENERATED_UUID = '12121212-1212-4121-8121-121212121212';
const TARGET_OWNER_UUID = '33333333-3333-4333-8333-333333333333';
const SOURCE_OWNER_UUID = '44444444-4444-4444-8444-444444444444';
const BASE_SIBLING_UUID = '55555555-5555-4555-8555-555555555555';
const BASE_SIBLING_GENERATED_UUID = '13131313-1313-4131-8131-131313131313';
const TARGET_SIBLING_UUID = '66666666-6666-4666-8666-666666666666';
const SOURCE_SIBLING_UUID = '77777777-7777-4777-8777-777777777777';
const BASE_FORM_UUID = '88888888-8888-4888-8888-888888888888';
const TARGET_FORM_UUID = '99999999-9999-4999-8999-999999999999';
const SOURCE_FORM_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ATTRIBUTE_UUIDS = {
  A: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
  B: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
  C: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3',
  TargetOnly: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4',
} as const;
const NESTED_ATTRIBUTE_UUIDS = {
  X: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
  Y: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2',
  TargetOnly: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
} as const;
const TABULAR_UUIDS = {
  Lines: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
  Primary: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2',
  Secondary: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3',
} as const;
const TABULAR_GENERATED_UUIDS = {
  Lines: '14141414-1414-4141-8141-141414141411',
  Primary: '15151515-1515-4151-8151-151515151511',
  Secondary: '16161616-1616-4161-8161-161616161611',
} as const;
const TARGET_BASE_FORM = '<BaseForm version="2.20"><ChildItems><Button name="BaseButton" id="90"/></ChildItems><Attributes><Attribute name="FormA" id="1"/><Attribute name="FormB" id="2"/></Attributes><Commands><Command name="RunA" id="10"/><Command name="RunB" id="11"/></Commands><Parameters><Parameter name="OptionA"/><Parameter name="OptionB"/></Parameters></BaseForm>';
const OBJECT_PATH = 'Catalogs/Products.xml';
const FORM_DESCRIPTOR_PATH = 'Catalogs/Products/Forms/Main.xml';
const FORM_BODY_PATH = 'Catalogs/Products/Forms/Main/Ext/Form.xml';
const SIBLING_PATH = 'Catalogs/Sibling.xml';
const MD_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';
const LOGFORM_NAMESPACE = 'http://v8.1c.ru/8.3/xcf/logform';

type Direction = 'adopted-to-adopted' | 'cf-to-adopted' | 'adopted-to-cf';
type Ownership = 'own' | 'adopted';
type RootRole = 'base' | 'target-cfe' | 'source-cfe' | 'target-cf' | 'source-cf';

suite('Public adopted order integration (#335)', () => {
  for (const direction of ['adopted-to-adopted', 'cf-to-adopted', 'adopted-to-cf'] as const) {
    test(`public preview, approval, and execution preserve metadata/Form order and ownership (${direction})`, async function (this: Mocha.Context) {
      this.timeout(180000);
      await withTempRoot(async (tempRoot) => {
        const roots = await writeOrderScenario(tempRoot, direction);
        const baseBefore = await hashDirectory(roots.base);
        const sourceBefore = await hashDirectory(roots.source);
        const targetConfigurationBefore = await fs.readFile(path.join(roots.target, 'Configuration.xml'));
        const targetMetadataBefore = await readUtf8(roots.target, OBJECT_PATH);
        const targetRootAttributeUuids = metadataChildUuids(targetMetadataBefore, 'Attribute');
        const targetTabularUuids = metadataChildUuids(targetMetadataBefore, 'TabularSection');
        const targetNestedAttributeUuids = metadataChildUuids(targetMetadataBefore, 'Attribute', 'Lines');
        const targetFormDescriptorBefore = await fs.readFile(path.join(roots.target, FORM_DESCRIPTOR_PATH));
        const targetSiblingBefore = await fs.readFile(path.join(roots.target, SIBLING_PATH));
        const targetFormBefore = await readUtf8(roots.target, FORM_BODY_PATH);
        const targetBaseFormBefore = directBaseFormXml(targetFormBefore);

        const compare = await openCompare(tempRoot, roots.target, roots.source, {
          extensionBaseRoots: roots.extensionBaseRoots,
        });
        try {
          const orderNodes = collectNodes(compare.result.workspace.payload.root)
            .filter((node) => node.kind === 'metadataOrderMove');
          const metadataNodes = orderNodes.filter((node) => pathMatches(node.mergeState?.targetFilePath, OBJECT_PATH));
          const formNodes = orderNodes.filter((node) => pathMatches(node.mergeState?.targetFilePath, FORM_BODY_PATH));
          const descriptorDiagnostics = collectNodes(compare.result.workspace.payload.root).filter((node) => node.kind === 'extensionSemanticFile'
            && (node.label === 'Дескриптор' || node.id.includes('adopted-issue')));
          assert.ok(metadataNodes.length > 0,
            `expected adopted metadata order moves; found ${describeNodes(orderNodes)}; descriptor diagnostics=${describeNodes(descriptorDiagnostics)}`);
          assert.ok(formNodes.length >= 3,
            `expected Attributes, Commands, and Parameters moves; found ${describeNodes(orderNodes)}`);
          assert.ok(metadataNodes.every((node) => node.mergeable === true), describeNodes(metadataNodes));
          assert.ok(formNodes.every((node) => node.mergeable === true), describeNodes(formNodes));

          const preview = await createPreview(compare.result, [...metadataNodes, ...formNodes].map((node) => node.id));
          assert.strictEqual(preview.operationCount, 2,
            `root/nested metadata and three Form section moves should batch into one write per physical file: ${JSON.stringify(preview)}`);
          const approved = compare.result.workspace.approvePreview(preview.previewId);
          assert.strictEqual(approved.ok, true, `approval failed: ${JSON.stringify(approved.diagnostics)}`);
          const executed = await compare.result.workspace.executeApprovedPreview(preview.previewId, { destructiveConfirmed: true });
          assert.strictEqual(executed.ok, true, `execution failed: ${JSON.stringify(executed)}`);

          const writtenMetadata = await readUtf8(roots.target, OBJECT_PATH);
          const writtenForm = await readUtf8(roots.target, FORM_BODY_PATH);
          const writtenRootAttributes = metadataNames(writtenMetadata, 'Attribute');
          const writtenNestedAttributes = nestedMetadataNames(writtenMetadata, 'Lines', 'Attribute');
          assert.deepStrictEqual(writtenRootAttributes.filter((name) => name !== 'TargetOnly'), ['FieldB', 'FieldA'],
            'selected base Attribute order matches the incoming source order');
          assert.ok(writtenRootAttributes.includes('TargetOnly'), 'the target-only root Attribute remains registered');
          assert.deepStrictEqual(writtenNestedAttributes.filter((name) => name !== 'NestedTargetOnly'), ['NestedY', 'NestedX'],
            'selected nested base Attribute order matches the incoming source order');
          assert.ok(writtenNestedAttributes.includes('NestedTargetOnly'), 'the nested target-only Attribute remains registered');
          assert.deepStrictEqual(metadataChildUuids(writtenMetadata, 'Attribute'), targetRootAttributeUuids,
            'reordering does not rewrite the target root Attribute UUIDs');
          assert.deepStrictEqual(metadataChildUuids(writtenMetadata, 'TabularSection'), targetTabularUuids,
            'reordering does not rewrite the target TabularSection UUIDs');
          assert.deepStrictEqual(metadataChildUuids(writtenMetadata, 'Attribute', 'Lines'), targetNestedAttributeUuids,
            'reordering does not rewrite nested target Attribute UUIDs');
          assert.deepStrictEqual(formNames(writtenForm, 'Attributes', 'Attribute'), ['FormB', 'FormA']);
          assert.deepStrictEqual(formNames(writtenForm, 'Commands', 'Command'), ['RunB', 'RunA']);
          assert.deepStrictEqual(formNames(writtenForm, 'Parameters', 'Parameter'), ['OptionB', 'OptionA']);
          assert.match(writtenMetadata, /<Comment>Target-only property<\/Comment>/u,
            'the unselected target-only root property remains in the physical owner');
          assert.deepStrictEqual(await fs.readFile(path.join(roots.target, 'Configuration.xml')), targetConfigurationBefore);
          assert.deepStrictEqual(await fs.readFile(path.join(roots.target, FORM_DESCRIPTOR_PATH)), targetFormDescriptorBefore);
          assert.deepStrictEqual(await fs.readFile(path.join(roots.target, SIBLING_PATH)), targetSiblingBefore,
            'the unrelated registered sibling descriptor is byte-for-byte unchanged');
          if (targetBaseFormBefore) {
            assert.strictEqual(directBaseFormXml(writtenForm), targetBaseFormBefore,
              'the target BaseForm subtree is restored exactly after Form order materialization');
          } else {
            assert.strictEqual(directBaseFormXml(writtenForm), undefined,
              'an own CF target must not receive a source BaseForm');
          }
          assert.strictEqual(await hashDirectory(roots.base), baseBefore, 'the captured base configuration changed');
          assert.strictEqual(await hashDirectory(roots.source), sourceBefore, 'the incoming configuration changed');
          assertTargetOwnership(writtenMetadata, direction);
        } finally {
          await compare.dispose();
        }
      });
    });
  }

  test('a partial ambiguous Attribute order stays read-only while Comment and TabularSection order merge', async function (this: Mocha.Context) {
    this.timeout(180000);
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base');
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cfe');
      await writeConfigurationRoot(base, 'base', {
        attributes: ['A', 'B', 'C'],
        tabularSections: ['Primary', 'Secondary'],
        comment: 'Base comment',
        includeForm: false,
      });
      await writeConfigurationRoot(target, 'target-cfe', {
        attributes: ['B', 'A', 'C'],
        tabularSections: ['Primary', 'Secondary'],
        comment: 'Base comment',
        includeForm: false,
      });
      await writeConfigurationRoot(source, 'source-cfe', {
        attributes: ['B', 'A'],
        tabularSections: ['Secondary', 'Primary'],
        comment: 'Incoming comment',
        includeForm: false,
      });
      const targetBefore = await fs.readFile(path.join(target, OBJECT_PATH));
      const baseBefore = await hashDirectory(base);
      const sourceBefore = await hashDirectory(source);
      const compare = await openCompare(tempRoot, target, source, { extensionBaseRoots: { left: base, right: base } });
      try {
        const nodes = collectNodes(compare.result.workspace.payload.root).filter((node) => node.kind === 'metadataOrderMove'
          && pathMatches(node.mergeState?.targetFilePath, OBJECT_PATH));
        const attributeNodes = nodes.filter((node) => orderPointerKind(node) === 'Attribute');
        const tabularNodes = nodes.filter((node) => orderPointerKind(node) === 'TabularSection');
        assert.ok(attributeNodes.length > 0, `expected an Attribute order decision: ${describeNodes(nodes)}`);
        assert.ok(attributeNodes.every((node) => node.mergeable === false
          && (node.mergeState?.reason ?? node.conflict?.message ?? '').length > 0),
        `the exact ambiguous Attribute collection must be scoped read-only: ${describeNodes(attributeNodes)}`);
        assert.ok(tabularNodes.length > 0 && tabularNodes.every((node) => node.mergeable === true),
          `independent TabularSection order remains selectable: ${describeNodes(tabularNodes)}`);
        const comment = collectNodes(compare.result.workspace.payload.root).find((node) => node.kind === 'xmlProperty'
          && node.mergeable === true && node.rightValue?.includes('Incoming comment')
          && pathMatches(node.mergeState?.targetFilePath, OBJECT_PATH));
        assert.ok(comment, `independent Comment remains selectable: ${describeNodes(collectNodes(compare.result.workspace.payload.root))}`);

        const preview = await createPreview(compare.result, [comment!.id, ...tabularNodes.map((node) => node.id)]);
        const approved = compare.result.workspace.approvePreview(preview.previewId);
        assert.strictEqual(approved.ok, true, JSON.stringify(approved));
        const executed = await compare.result.workspace.executeApprovedPreview(preview.previewId, { destructiveConfirmed: true });
        assert.strictEqual(executed.ok, true, JSON.stringify(executed));

        const written = await readUtf8(target, OBJECT_PATH);
        assert.deepStrictEqual(metadataNames(written, 'Attribute'), ['FieldB', 'FieldA', 'FieldC'],
          'the selected Comment/TabularSection changes do not rewrite the ambiguous Attribute collection');
        assert.deepStrictEqual(metadataNames(written, 'TabularSection'), ['Secondary', 'Primary']);
        assert.strictEqual(metadataComment(written), 'Incoming comment');
        assert.deepStrictEqual(await hashDirectory(base), baseBefore);
        assert.deepStrictEqual(await hashDirectory(source), sourceBefore);
        assert.notDeepStrictEqual(await fs.readFile(path.join(target, OBJECT_PATH)), targetBefore);
      } finally {
        await compare.dispose();
      }
    });
  });

  test('a post-approval allocated borrowed UUID collision blocks without overwriting target files', async function (this: Mocha.Context) {
    this.timeout(180000);
    await withTempRoot(async (tempRoot) => {
      const base = path.join(tempRoot, 'base');
      const target = path.join(tempRoot, 'target-cfe');
      const source = path.join(tempRoot, 'source-cfe');
      await writeConfigurationRoot(base, 'base', {
        attributes: ['A', 'B'], tabularSections: [], comment: 'Base comment', includeForm: false,
      });
      await writeConfigurationRoot(target, 'target-cfe', {
        attributes: ['A'], tabularSections: [], comment: 'Base comment', includeForm: false,
      });
      await writeConfigurationRoot(source, 'source-cfe', {
        attributes: ['B', 'A'], tabularSections: [], comment: 'Base comment', includeForm: false,
      });
      const randomUuidCalls: RandomUuidCall[] = [];
      let compare: OpenCompareHandle | undefined;
      try {
        compare = await withDeterministicRandomUuid(randomUuidCalls, async () => openCompare(tempRoot, target, source, {
          withRuntime: true,
          extensionBaseRoots: { left: base, right: base },
        }));
        const metadataMoves = collectNodes(compare.result.workspace.payload.root).filter((node) => node.kind === 'metadataOrderMove'
          && node.mergeable === true && pathMatches(node.mergeState?.targetFilePath, OBJECT_PATH));
        assert.ok(metadataMoves.length > 0, `expected an adopted Attribute order candidate: ${describeNodes(collectNodes(compare.result.workspace.payload.root))}`);
        const preview = await createPreview(compare.result, metadataMoves.map((node) => node.id));
        const approved = compare.result.workspace.approvePreview(preview.previewId);
        assert.strictEqual(approved.ok, true, JSON.stringify(approved));

        const allocated = randomUuidCalls.find((call) => call.stack.includes('allocateExtensionAdoptedChildUuids'));
        assert.ok(allocated, `deterministic UUID spy did not observe borrowed shell allocation; calls=${JSON.stringify(randomUuidCalls)}`);
        const allocatedUuid = allocated!.value;
        const targetOwnerBeforeExecute = await fs.readFile(path.join(target, OBJECT_PATH));
        const targetSiblingPath = path.join(target, SIBLING_PATH);
        const collisionSibling = metadataOwnerDescriptor({
          ownership: 'adopted',
          uuid: allocatedUuid,
          anchorUuid: BASE_SIBLING_UUID,
          name: 'Sibling',
          comment: 'Collision owner',
          childObjects: '',
        });
        await fs.writeFile(targetSiblingPath, collisionSibling, 'utf8');
        const collisionBytesBeforeExecute = await fs.readFile(targetSiblingPath);
        const configurationBeforeExecute = await fs.readFile(path.join(target, 'Configuration.xml'));

        const executed = await compare.result.workspace.executeApprovedPreview(preview.previewId, { destructiveConfirmed: true });

        assert.strictEqual(executed.ok, false,
          `execution must reject the UUID proof after another registered owner claims ${allocatedUuid}: ${JSON.stringify(executed)}`);
        assert.deepStrictEqual(await fs.readFile(path.join(target, OBJECT_PATH)), targetOwnerBeforeExecute,
          'the approved order patch must not write its owner after UUID collision');
        assert.deepStrictEqual(await fs.readFile(targetSiblingPath), collisionBytesBeforeExecute,
          'the concurrently injected registered owner remains exactly as injected');
        assert.deepStrictEqual(await fs.readFile(path.join(target, 'Configuration.xml')), configurationBeforeExecute,
          'the rejected execution does not rewrite registrations');
      } finally {
        await compare?.dispose();
      }
    });
  });
});

interface ScenarioRoots {
  readonly base: string;
  readonly target: string;
  readonly source: string;
  readonly extensionBaseRoots: ConfigurationCompareInput['extensionBaseRoots'];
}

interface ConfigurationShape {
  readonly attributes: readonly string[];
  readonly tabularSections: readonly string[];
  readonly comment: string;
  readonly includeForm: boolean;
  readonly targetOnly?: boolean;
  readonly partialAttributes?: boolean;
  readonly reverseNestedAttributes?: boolean;
}

interface OpenCompareOptions extends Pick<ConfigurationCompareInput, 'extensionBaseRoots'> {
  readonly withRuntime?: boolean;
}

interface OpenCompareHandle {
  readonly result: ConfigurationCompareResult;
  dispose(): Promise<void>;
}

interface RandomUuidCall {
  readonly value: string;
  readonly stack: string;
}

async function writeOrderScenario(tempRoot: string, direction: Direction): Promise<ScenarioRoots> {
  const base = path.join(tempRoot, 'base');
  const target = path.join(tempRoot, 'target');
  const source = path.join(tempRoot, 'source');
  const targetRole: RootRole = direction === 'adopted-to-cf' ? 'target-cf' : 'target-cfe';
  const sourceRole: RootRole = direction === 'cf-to-adopted' ? 'source-cf' : 'source-cfe';
  await writeConfigurationRoot(base, 'base', {
    attributes: ['A', 'B'], tabularSections: ['Lines'], comment: 'Base comment', includeForm: true,
  });
  await writeConfigurationRoot(target, targetRole, {
    attributes: ['A', 'B'], tabularSections: ['Lines'], comment: 'Target-only property', includeForm: true, targetOnly: true,
  });
  await writeConfigurationRoot(source, sourceRole, {
    attributes: ['B', 'A'], tabularSections: ['Lines'], comment: 'Base comment', includeForm: true,
  });
  const extensionBaseRoots: ConfigurationCompareInput['extensionBaseRoots'] = direction === 'adopted-to-adopted'
    ? { left: base, right: base }
    : direction === 'cf-to-adopted'
      ? { left: base }
      : { right: base };
  return { base, target, source, extensionBaseRoots };
}

async function writeConfigurationRoot(rootPath: string, role: RootRole, shape: ConfigurationShape): Promise<void> {
  const ownerOwnership: Ownership = role === 'target-cfe' || role === 'source-cfe' ? 'adopted' : 'own';
  const ownerUuid = role === 'target-cfe' ? TARGET_OWNER_UUID
    : role === 'source-cfe' ? SOURCE_OWNER_UUID : BASE_OWNER_UUID;
  const isTarget = role === 'target-cfe' || role === 'target-cf';
  const ownerDescriptor = metadataOwnerDescriptor({
    ownership: ownerOwnership,
    uuid: ownerUuid,
    anchorUuid: ownerOwnership === 'adopted' ? BASE_OWNER_UUID : undefined,
    name: 'Products',
    comment: shape.comment,
    attributes: shape.attributes,
    tabularSections: shape.tabularSections,
    targetOnly: isTarget && shape.targetOnly === true,
    partialAttributes: shape.partialAttributes,
    reverseNestedAttributes: shape.reverseNestedAttributes ?? (role === 'source-cfe' || role === 'source-cf'),
    includeForm: shape.includeForm,
    childObjects: undefined,
  });
  const siblingOwnership: Ownership = role === 'target-cfe' || role === 'source-cfe' ? 'adopted' : 'own';
  const siblingUuid = role === 'target-cfe' ? TARGET_SIBLING_UUID
    : role === 'source-cfe' ? SOURCE_SIBLING_UUID : BASE_SIBLING_UUID;
  const siblingDescriptor = metadataOwnerDescriptor({
    ownership: siblingOwnership,
    uuid: siblingUuid,
    anchorUuid: siblingOwnership === 'adopted' ? BASE_SIBLING_UUID : undefined,
    name: 'Sibling',
    comment: 'Sibling stays unchanged',
    childObjects: '',
  });
  const objects: ExtensionCompareObjectFixture[] = [
    { type: 'Catalog', name: 'Products', uuid: ownerUuid, descriptorXml: ownerDescriptor },
    { type: 'Catalog', name: 'Sibling', uuid: siblingUuid, descriptorXml: siblingDescriptor },
  ];
  const isCfe = ownerOwnership === 'adopted';
  await writeDesignerConfiguration(rootPath, {
    uuid: CONFIGURATION_UUID,
    name: 'Adopted order acceptance',
    ...(isCfe ? { purpose: 'Customization' as const, namePrefix: 'Ext_' } : {}),
    objects,
  });
  await qualifyConfigurationRoot(rootPath);

  if (!shape.includeForm) { return; }
  const formOwnership: Ownership = isCfe ? 'adopted' : 'own';
  const formUuid = role === 'target-cfe' ? TARGET_FORM_UUID
    : role === 'source-cfe' ? SOURCE_FORM_UUID : BASE_FORM_UUID;
  const formDescriptor = metadataFormDescriptor(formOwnership, formUuid,
    formOwnership === 'adopted' ? BASE_FORM_UUID : undefined);
  await writeCompareBytes(rootPath, FORM_DESCRIPTOR_PATH, formDescriptor);
  const formOrder = role === 'source-cfe' || role === 'source-cf'
    ? { attributes: ['FormB', 'FormA'], commands: ['RunB', 'RunA'], parameters: ['OptionB', 'OptionA'] }
    : { attributes: ['FormA', 'FormB'], commands: ['RunA', 'RunB'], parameters: ['OptionA', 'OptionB'] };
  const baseForm = isCfe ? TARGET_BASE_FORM : undefined;
  await writeCompareBytes(rootPath, FORM_BODY_PATH, formXml(formOrder, baseForm));
}

function metadataOwnerDescriptor(input: {
  readonly ownership: Ownership;
  readonly uuid: string;
  readonly anchorUuid?: string;
  readonly name: string;
  readonly comment: string;
  readonly attributes?: readonly string[];
  readonly tabularSections?: readonly string[];
  readonly targetOnly?: boolean;
  readonly partialAttributes?: boolean;
  readonly reverseNestedAttributes?: boolean;
  readonly includeForm?: boolean;
  readonly childObjects?: string;
}): string {
  const adopted = input.ownership === 'adopted';
  const properties = `<Name>${input.name}</Name><Comment>${xmlEscape(input.comment)}</Comment>${adopted
    ? `<ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>${input.anchorUuid}</ExtendedConfigurationObject>`
    : ''}`;
  const childObjects = input.childObjects ?? [
    ...attributeChildren(input.attributes ?? [], adopted, 'root', input.partialAttributes),
    ...(input.targetOnly ? [rootAttribute('TargetOnly', ATTRIBUTE_UUIDS.TargetOnly, false)] : []),
    ...(input.tabularSections ?? []).map((name) => tabularSection(name, adopted, input.targetOnly === true, input.reverseNestedAttributes === true)),
    ...(input.includeForm ? ['<Form>Main</Form>'] : []),
  ].join('');
  const generatedUuid = input.name === 'Products' ? BASE_OWNER_GENERATED_UUID : BASE_SIBLING_GENERATED_UUID;
  return `<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="${MD_NAMESPACE}" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xs="http://www.w3.org/2001/XMLSchema" version="${VERSION}"><Catalog uuid="${input.uuid}"><Properties>${properties}</Properties><InternalInfo><xr:GeneratedType name="CatalogRef" uuid="${generatedUuid}"/></InternalInfo><ChildObjects>${childObjects}</ChildObjects></Catalog></MetaDataObject>`;
}

function metadataFormDescriptor(ownership: Ownership, uuid: string, anchorUuid?: string): string {
  const marker = ownership === 'adopted'
    ? `<ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>${anchorUuid}</ExtendedConfigurationObject>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="${MD_NAMESPACE}" version="${VERSION}"><Form uuid="${uuid}"><Properties>${marker}<Name>Main</Name><Comment>Managed form</Comment></Properties></Form></MetaDataObject>`;
}

function rootAttribute(name: string, uuid: string, adopted: boolean, anchorUuid?: string): string {
  return metadataChild('Attribute', name, uuid, adopted, anchorUuid, false);
}

function attributeChildren(names: readonly string[], adopted: boolean, scope: 'root' | 'nested', partial = false): string[] {
  const represented = partial ? names.slice(0, 2) : names;
  return represented.map((name) => {
    const uuid = scope === 'root' ? ATTRIBUTE_UUIDS[name as keyof typeof ATTRIBUTE_UUIDS] : NESTED_ATTRIBUTE_UUIDS[name as keyof typeof NESTED_ATTRIBUTE_UUIDS];
    if (!uuid) { throw new Error(`Missing stable UUID for ${scope} Attribute ${name}`); }
    return metadataChild('Attribute', scope === 'root' ? `Field${name}` : name === 'TargetOnly' ? 'NestedTargetOnly' : `Nested${name}`,
      uuid, adopted, adopted ? uuid : undefined, scope === 'nested');
  });
}

function metadataChild(
  kind: string,
  name: string,
  baseUuid: string,
  adopted: boolean,
  anchorUuid: string | undefined,
  nested = false,
): string {
  const localUuid = adopted ? localChildUuid(nested ? 'nested' : 'root', name) : baseUuid;
  const properties = adopted
    ? `<Name>${name}</Name><ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>${anchorUuid}</ExtendedConfigurationObject>`
    : `<Name>${name}</Name><Comment>Base ${name}</Comment><Type><v8:Type>xs:string</v8:Type></Type>`;
  const internalInfo = adopted ? '' : `<InternalInfo><xr:GeneratedType name="${name}Ref" category="Object"/></InternalInfo>`;
  return `<${kind} uuid="${localUuid}"><Properties>${properties}</Properties>${internalInfo}</${kind}>`;
}

function tabularSection(name: string, adopted: boolean, targetOnly: boolean, reverseNestedAttributes: boolean): string {
  const baseUuid = TABULAR_UUIDS[name as keyof typeof TABULAR_UUIDS];
  if (!baseUuid) { throw new Error(`Missing stable UUID for TabularSection ${name}`); }
  const anchorUuid = adopted ? baseUuid : undefined;
  const localUuid = adopted ? localChildUuid('tabular', name) : baseUuid;
  const properties = adopted
    ? `<Name>${name}</Name><ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>${anchorUuid}</ExtendedConfigurationObject>`
    : `<Name>${name}</Name><Comment>Base table ${name}</Comment>`;
  const nestedOrder: readonly string[] = name === 'Lines'
    ? (reverseNestedAttributes ? ['Y', 'X'] : ['X', 'Y'])
    : [];
  const nested = nestedOrder.map((item) => {
    const uuid = NESTED_ATTRIBUTE_UUIDS[item as keyof typeof NESTED_ATTRIBUTE_UUIDS];
    return metadataChild('Attribute', `Nested${item}`, uuid, adopted, adopted ? uuid : undefined, true);
  });
  if (targetOnly && name === 'Lines') {
    nested.push(metadataChild('Attribute', 'NestedTargetOnly', NESTED_ATTRIBUTE_UUIDS.TargetOnly, false, undefined, true));
  }
  const generatedUuid = TABULAR_GENERATED_UUIDS[name as keyof typeof TABULAR_GENERATED_UUIDS];
  return `<TabularSection uuid="${localUuid}"><Properties>${properties}</Properties>${adopted ? '' : `<InternalInfo><xr:GeneratedType name="${name}Ref" uuid="${generatedUuid}"/></InternalInfo>`}<ChildObjects>${nested.join('')}</ChildObjects></TabularSection>`;
}

function metadataFormSectionItems(section: string, names: readonly string[]): string {
  const itemTag = section === 'Attributes' ? 'Attribute' : section === 'Commands' ? 'Command' : 'Parameter';
  return `<${section}>${names.map((name) => {
    const id = name === 'FormA' ? '1' : name === 'FormB' ? '2'
      : name === 'RunA' ? '10' : name === 'RunB' ? '11' : undefined;
    return `<${itemTag} name="${name}"${id ? ` id="${id}"` : ''}/>`;
  }).join('')}</${section}>`;
}

function formXml(order: {
  readonly attributes: readonly string[];
  readonly commands: readonly string[];
  readonly parameters: readonly string[];
}, baseForm?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Form xmlns="${LOGFORM_NAMESPACE}" version="${VERSION}"><AutoCommandBar/><ChildItems><Button name="BaseButton" id="90"/></ChildItems>${metadataFormSectionItems('Attributes', order.attributes)}${metadataFormSectionItems('Commands', order.commands)}${metadataFormSectionItems('Parameters', order.parameters)}${baseForm ?? ''}</Form>`;
}

function metadataNames(xml: string, kind: string): string[] {
  const owner = metadataOwner(xml);
  const container = elementChildren(owner).find((child) => child.localName === 'ChildObjects');
  if (!container) { return []; }
  return elementChildren(container).filter((child) => child.localName === kind).map(metadataName);
}

function nestedMetadataNames(xml: string, ownerName: string, kind: string): string[] {
  const owner = metadataOwner(xml);
  const rootObjects = elementChildren(owner).find((child) => child.localName === 'ChildObjects');
  const tabular = rootObjects && elementChildren(rootObjects).find((child) => child.localName === 'TabularSection' && metadataName(child) === ownerName);
  const nestedObjects = tabular && elementChildren(tabular).find((child) => child.localName === 'ChildObjects');
  return nestedObjects
    ? elementChildren(nestedObjects).filter((child) => child.localName === kind).map(metadataName)
    : [];
}

function metadataChildUuids(xml: string, kind: string, ownerName?: string): readonly (readonly [string, string])[] {
  const owner = metadataOwner(xml);
  const rootObjects = elementChildren(owner).find((child) => child.localName === 'ChildObjects');
  const parent = ownerName === undefined
    ? owner
    : rootObjects && elementChildren(rootObjects).find((child) => child.localName === 'TabularSection' && metadataName(child) === ownerName);
  const container = parent && elementChildren(parent).find((child) => child.localName === 'ChildObjects');
  return container
    ? elementChildren(container).filter((child) => child.localName === kind)
      .map((child) => [metadataName(child), attribute(child, 'uuid') ?? ''] as const)
      .sort(([left], [right]) => left.localeCompare(right))
    : [];
}

function metadataOwner(xml: string): XmlElement {
  const root = parseXmlDocument(xml).root;
  const owner = elementChildren(root).find((child) => child.localName === 'Catalog' && attribute(child, 'uuid') === BASE_OWNER_UUID)
    ?? elementChildren(root).find((child) => child.localName === 'Catalog');
  assert.ok(owner, 'Catalog descriptor has a root owner');
  return owner!;
}

function metadataName(element: XmlElement): string {
  const properties = elementChildren(element).find((child) => child.localName === 'Properties');
  const name = properties && elementChildren(properties).find((child) => child.localName === 'Name');
  assert.ok(name, `${element.localName} has Properties/Name`);
  return textContent(name!).trim();
}

function metadataComment(xml: string): string {
  const owner = metadataOwner(xml);
  const properties = elementChildren(owner).find((child) => child.localName === 'Properties');
  const comment = properties && elementChildren(properties).find((child) => child.localName === 'Comment');
  assert.ok(comment, 'owner has Properties/Comment');
  return textContent(comment!).trim();
}

function formNames(xml: string, section: string, kind: string): string[] {
  const root = parseXmlDocument(xml).root;
  const collection = elementChildren(root).find((child) => child.localName === section);
  return collection
    ? elementChildren(collection).filter((child) => child.localName === kind)
      .map((child) => child.attributes.find((attributeItem) => attributeItem.name === 'name')?.value ?? '')
    : [];
}

function directBaseFormXml(xml: string): string | undefined {
  return /<BaseForm\b[^>]*>[\s\S]*?<\/BaseForm>/u.exec(xml)?.[0];
}

function assertTargetOwnership(xml: string, direction: Direction): void {
  if (direction === 'adopted-to-cf') {
    assert.match(xml, new RegExp(`<Catalog uuid="${BASE_OWNER_UUID}"`, 'u'));
    assert.doesNotMatch(xml, /ObjectBelonging|ExtendedConfigurationObject/u);
    return;
  }
  assert.match(xml, new RegExp(`<Catalog uuid="${TARGET_OWNER_UUID}"`, 'u'));
  assert.match(xml, new RegExp(`<ExtendedConfigurationObject>${BASE_OWNER_UUID}</ExtendedConfigurationObject>`, 'u'));
  assert.match(xml, new RegExp(`<xr:GeneratedType name="CatalogRef" uuid="${BASE_OWNER_GENERATED_UUID}"/>`, 'u'));
}

function orderPointerKind(node: CompareTreeNode): string | undefined {
  const pointer = node.payloadRef?.startsWith('xmlPatch:') ? node.payloadRef.slice('xmlPatch:'.length) : '';
  const last = pointer.slice(pointer.lastIndexOf('/') + 1);
  return /^([A-Za-z][\w]*)\[/u.exec(last)?.[1];
}

async function openCompare(
  tempRoot: string,
  target: string,
  source: string,
  options: OpenCompareOptions,
): Promise<OpenCompareHandle> {
  const runtime = options.withRuntime ? await createMergeMutationTestRuntime(target) : undefined;
  try {
    const result = await buildConfigurationCompare({
      leftRootPath: target,
      rightRootPath: source,
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

async function createPreview(result: ConfigurationCompareResult, nodeIds: readonly string[]) {
  const created = await result.workspace.createPreviewForNodeIds(nodeIds);
  if (!created.ok) { assert.fail(`preview failed: ${JSON.stringify(created.diagnostics)}`); }
  return created.preview;
}

async function withDeterministicRandomUuid<T>(calls: RandomUuidCall[], action: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  assert.ok(original?.value, 'crypto.randomUUID is available in this Node runtime');
  let sequence = 0;
  Object.defineProperty(crypto, 'randomUUID', {
    configurable: true,
    enumerable: original!.enumerable,
    writable: true,
    value: () => {
      sequence += 1;
      const value = `f0000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`;
      calls.push({ value, stack: new Error().stack ?? '' });
      return value;
    },
  });
  try {
    return await action();
  } finally {
    Object.defineProperty(crypto, 'randomUUID', original!);
  }
}

async function qualifyConfigurationRoot(rootPath: string): Promise<void> {
  const descriptorPath = path.join(rootPath, 'Configuration.xml');
  const xml = await fs.readFile(descriptorPath, 'utf8');
  const qualified = xml.replace('<MetaDataObject ', `<MetaDataObject xmlns="${MD_NAMESPACE}" `);
  assert.notStrictEqual(qualified, xml, 'configuration fixture must be qualified with MDClasses namespace');
  await fs.writeFile(descriptorPath, qualified, 'utf8');
}

async function readUtf8(rootPath: string, relativePath: string): Promise<string> {
  return fs.readFile(path.join(rootPath, relativePath), 'utf8');
}

async function hashDirectory(rootPath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) { throw new Error(`Unexpected symbolic link in fixture: ${fullPath}`); }
      if (entry.isDirectory()) { await visit(fullPath); }
      else if (entry.isFile()) {
        hash.update(path.relative(rootPath, fullPath).replace(/\\/gu, '/'));
        hash.update('\0');
        hash.update(await fs.readFile(fullPath));
        hash.update('\n');
      }
    }
  };
  await visit(rootPath);
  return hash.digest('hex');
}

async function withTempRoot(callback: (tempRoot: string) => Promise<void>): Promise<void> {
  const tempRoot = await createExtensionCompareTempRoot('issue335-adopted-order-public-');
  try {
    await callback(tempRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function collectNodes(root: CompareTreeNode): CompareTreeNode[] {
  return [root, ...root.children.flatMap(collectNodes)];
}

function describeNodes(nodes: readonly CompareTreeNode[]): string {
  return JSON.stringify(nodes.map((node) => ({
    id: node.id,
    label: node.label,
    kind: node.kind,
    mergeable: node.mergeable,
    pointer: node.payloadRef,
    state: node.mergeState,
    conflict: node.conflict,
  })));
}

function normalizedPath(value: string | undefined): string {
  return value?.replace(/\\/gu, '/') ?? '';
}

function pathMatches(value: string | undefined, relativePath: string): boolean {
  const normalized = normalizedPath(value);
  return normalized === relativePath || normalized.endsWith(`/${relativePath}`);
}

function localChildUuid(scope: string, name: string): string {
  const suffix = name === 'FieldA' ? '111111111111' : name === 'FieldB' ? '222222222222'
    : name === 'FieldC' ? '333333333333' : name === 'NestedX' ? '444444444444'
      : name === 'NestedY' ? '555555555555' : name === 'Lines' ? '666666666666'
        : name === 'Primary' ? '777777777777' : name === 'Secondary' ? '888888888888'
          : '999999999999';
  const head = scope === 'root' ? 'e0000000' : scope === 'nested' ? 'e1000000' : 'e2000000';
  return `${head}-0000-4000-8000-${suffix}`;
}

function attribute(element: XmlElement, name: string): string | undefined {
  return element.attributes.find((item) => item.name === name)?.value;
}

function xmlEscape(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}
