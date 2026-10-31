import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { pathToFileURL } from 'url';

import { buildSemanticObjectOutput } from '../../../src/compareMerge/extensions/extensionSemanticMaterializer';
import {
  projectCapturedAdoptedTemplateBundle,
  type CapturedAdoptedTemplatePhysicalSide,
  type CapturedAdoptedTemplateProjectionInput,
} from '../../../src/compareMerge/extensions/extensionAdoptedTemplateCapture';
import {
  materializeCapturedAdoptedTemplateBundle,
  type CapturedAdoptedTemplateBundle,
} from '../../../src/compareMerge/extensions/extensionAdoptedTemplateBridge';
import type { AdoptedDesignerIdentity } from '../../../src/compareMerge/extensions/adoptedDesignerProjection';
import type { ExtensionIndexedObject, ExtensionMetadataIndex } from '../../../src/compareMerge/extensions/extensionMetadataIndex';
import type { ExtensionSemanticSelection, ExtensionTransferRow } from '../../../src/compareMerge/extensions/extensionTransfer';
import type { AdoptedSemanticArtifactCapture } from '../../../src/compareMerge/extensions/extensionAdoptedSemanticBridge';
import { MISSING_TARGET_HASH, type MergeCandidate, type MergeFileWitness, type XmlPatchPayload } from '../../../src/compareMerge/merge/mergePreview';
import { hashXmlText } from '../../../src/compareMerge/xml/xmlPatch';
import { buildXmlAddress, elementChildren, parseXmlDocument, textContent, type XmlElement } from '../../../src/compareMerge/xml/xmlDom';
import { namespaceUriForName } from '../../../src/compareMerge/adapters/semanticXml/semanticXmlIdentity';

const BASE_UUID = '11111111-1111-4111-8111-111111111111';
const TARGET_UUID = '22222222-2222-4222-8222-222222222222';
const SOURCE_UUID = '33333333-3333-4333-8333-333333333333';
const MD = 'http://v8.1c.ru/8.3/MDClasses';
const READABLE = 'http://v8.1c.ru/8.3/xcf/readable';

suite('Captured adopted Template bundle', () => {
  test('rejects an absent source body when effective type changed despite a shared Template.xml path', () => {
    const input = makeCaptureInput({
      baseType: 'SpreadsheetDocument',
      targetType: 'SpreadsheetDocument',
      sourceType: 'DataCompositionSchema',
      sourceBodyMissing: true,
    });

    const result = projectCapturedAdoptedTemplateBundle(input);

    assert.ok(!result.ok && /тип|TemplateType|наследован/iu.test(result.reason),
      result.ok ? 'missing source body with a changed effective type must be blocked' : result.reason);
  });

  test('rejects an absent target body when its effective type changed despite a shared Template.xml path', () => {
    const input = makeCaptureInput({
      baseType: 'SpreadsheetDocument',
      targetType: 'DataCompositionSchema',
      sourceType: 'SpreadsheetDocument',
      targetBodyMissing: true,
    });

    const result = projectCapturedAdoptedTemplateBundle(input);

    assert.ok(!result.ok && /тип|TemplateType|наследован/iu.test(result.reason),
      result.ok ? 'missing target body with a changed effective type must be blocked' : result.reason);
  });

  test('rejects a captured identity whose adopted anchor does not match the exact base UUID', () => {
    const input = makeCaptureInput({ baseType: 'BinaryData', targetType: 'BinaryData', sourceType: 'BinaryData' });
    const forged = {
      ...input,
      targetDescriptor: {
        ...input.targetDescriptor,
        identity: { ...input.targetDescriptor.identity, sourceUuid: SOURCE_UUID },
      },
    } satisfies CapturedAdoptedTemplateProjectionInput;

    const result = projectCapturedAdoptedTemplateBundle(forged);

    assert.ok(!result.ok, 'an adopted descriptor cannot be relabeled to another base anchor');
  });

  test('rejects source-base Template body bytes that do not match the target-side base capture', () => {
    const input = makeCaptureInput({ baseType: 'BinaryData', targetType: 'BinaryData', sourceType: 'BinaryData' });
    const mismatched = {
      ...input,
      sourceBaseBody: capture(Buffer.from('different source base body'), ownIdentity(), 'base-source', input.sourceBaseBody.witness.relativePath),
    } satisfies CapturedAdoptedTemplateProjectionInput;

    const result = projectCapturedAdoptedTemplateBundle(mismatched);

    assert.ok(!result.ok, 'independent base captures must prove the same bytes before inheritance');
  });

  test('allows an absent adopted side to inherit when its effective type still matches the own base', () => {
    const input = makeCaptureInput({
      baseType: 'SpreadsheetDocument',
      targetType: 'SpreadsheetDocument',
      sourceType: 'SpreadsheetDocument',
      sourceBodyMissing: true,
    });

    const result = projectCapturedAdoptedTemplateBundle(input);

    assert.strictEqual(result.ok, true, result.ok ? undefined : result.reason);
    if (result.ok) {
      assert.deepStrictEqual(result.recipe.sourceLogicalBody, Buffer.from('captured base body'));
    }
  });

  test('writes root type transition, selected Comment, and old-body deletion as one descriptor write', async () => {
    const fixture = await createTemplateWriterFixture({
      targetType: 'TextDocument',
      sourceType: 'BinaryData',
      baseType: 'TextDocument',
      targetComment: 'Old target comment',
      sourceComment: 'Incoming comment',
      targetTemplateTypeNotify: true,
    });
    const selections = [
      makeTemplatePatchSelection(fixture, 'template-type', 'TemplateType', '<TemplateType>BinaryData</TemplateType>', true),
      makeTemplatePatchSelection(fixture, 'template-comment', 'Comment', '<Comment>Selected comment</Comment>', false),
    ];

    const output = await buildSemanticObjectOutput({
      targetRootPath: fixture.targetRootPath,
      sourceRootPath: fixture.sourceRootPath,
      targetDescriptorRelativePath: fixture.row.target!.descriptorRelativePath!,
      row: fixture.row,
      witnesses: [],
      selections,
    });

    assert.ok(!('diagnostic' in output), `root Template transition should materialize: ${'diagnostic' in output ? output.diagnostic.suggestedAction : ''}`);
    if ('diagnostic' in output) { return; }
    const descriptorWrites = output.writes.filter((write) => write.relativePath === fixture.recipe.targetDescriptor.witness.relativePath);
    assert.strictEqual(descriptorWrites.length, 1, 'TemplateType and Comment are applied before one physical descriptor write');
    const descriptorXml = descriptorWrites[0]!.content.toString('utf8');
    assert.strictEqual(textContent(findTemplateProperty(descriptorXml, 'CommonTemplate', 'TemplateType')).trim(), 'BinaryData');
    assert.strictEqual(textContent(findTemplateProperty(descriptorXml, 'CommonTemplate', 'Comment')).trim(), 'Selected comment');
    assert.match(descriptorXml, /<xr:Property>Template<\/xr:Property><xr:State>Extended<\/xr:State>/u);
    assert.doesNotMatch(descriptorXml, /<xr:Property>TemplateType<\/xr:Property>/u,
      'the selected type transition removes only the generic TemplateType=Notify marker');
    assert.match(descriptorXml, /<xr:Property>Comment<\/xr:Property><xr:State>Notify<\/xr:State>/u,
      'unrelated selected scalar notification remains intact');
    assert.ok(output.writes.some((write) => write.relativePath === fixture.recipe.sourceBodyRelativePath
      && write.content.equals(fixture.sourceBodyBytes)), 'destination receives the exact physical source body bytes');
    assert.deepStrictEqual(output.deletePaths, [fixture.recipe.targetBodyRelativePath], 'the captured old physical target body is deleted under CAS');
    assert.strictEqual(new Set(output.outputRelativePaths).size, output.outputRelativePaths.length);
    assert.ok(await fs.readFile(path.join(fixture.targetRootPath, 'CommonTemplates/Print/Ext/TargetOnly.bin'))
      .then((bytes) => bytes.equals(Buffer.from('preserve target-only sibling'))), 'unselected target-only sidecar survives');
  });

  test('writes body-only replacements in all three ownership directions without a fake descriptor patch', async () => {
    for (const direction of ['cf-to-adopted', 'adopted-to-cf', 'adopted-to-adopted'] as const) {
      const fixture = await createTemplateWriterFixture({ direction, targetType: 'BinaryData', sourceType: 'BinaryData', baseType: 'BinaryData' });
      assert.notStrictEqual(hash(fixture.targetBodyBytes), hash(fixture.sourceBodyBytes), 'fixture body bytes differ physically');
      const output = await buildSemanticObjectOutput({
        targetRootPath: fixture.targetRootPath,
        sourceRootPath: fixture.sourceRootPath,
        targetDescriptorRelativePath: fixture.row.target!.descriptorRelativePath!,
        row: fixture.row,
        witnesses: [],
        selections: [makeTemplateBodyOnlySelection(fixture)],
      });

      assert.ok(!('diagnostic' in output), `${direction}: body-only bundle should materialize: ${'diagnostic' in output ? output.diagnostic.suggestedAction : ''}`);
      if ('diagnostic' in output) { continue; }
      assert.strictEqual(output.writes.filter((write) => write.relativePath === fixture.recipe.targetBodyRelativePath).length, 1,
        `${direction}: exactly one physical body write`);
      assert.ok(output.writes.find((write) => write.relativePath === fixture.recipe.targetBodyRelativePath)!.content.equals(fixture.sourceBodyBytes));
      const descriptorWrite = output.writes.find((write) => write.relativePath === fixture.recipe.targetDescriptor.witness.relativePath);
      if (direction === 'adopted-to-cf') {
        assert.strictEqual(descriptorWrite, undefined, 'CF output does not acquire a CFE Template=Extended state');
      } else {
        assert.ok(descriptorWrite, `${direction}: selected CFE body change marks Template as Extended`);
        assert.match(descriptorWrite!.content.toString('utf8'), /<xr:Property>Template<\/xr:Property><xr:State>Extended<\/xr:State>/u);
      }
      assert.deepStrictEqual(output.deletePaths, []);
    }
  });

  test('adds the Extended state in a fresh readable namespace when the captured xr prefix is foreign', async () => {
    const fixture = await createTemplateWriterFixture({
      targetType: 'BinaryData', sourceType: 'BinaryData', baseType: 'BinaryData', shadowedReadablePrefix: true,
    });
    const output = await buildSemanticObjectOutput({
      targetRootPath: fixture.targetRootPath,
      sourceRootPath: fixture.sourceRootPath,
      targetDescriptorRelativePath: fixture.row.target!.descriptorRelativePath!,
      row: fixture.row,
      witnesses: [],
      selections: [makeTemplateBodyOnlySelection(fixture)],
    });

    assert.ok(!('diagnostic' in output), `foreign xr binding should remain safe: ${'diagnostic' in output ? output.diagnostic.suggestedAction : ''}`);
    if ('diagnostic' in output) { return; }
    const descriptorWrite = output.writes.find((write) => write.relativePath === fixture.recipe.targetDescriptor.witness.relativePath);
    assert.ok(descriptorWrite);
    const root = parseXmlDocument(descriptorWrite!.content.toString('utf8')).root;
    const template = elementChildren(root).find((element) => element.localName === 'CommonTemplate');
    assert.ok(template);
    const internalInfo = elementChildren(template!).find((element) => element.localName === 'InternalInfo');
    assert.ok(internalInfo);
    const state = elementChildren(internalInfo!).find((element) => element.localName === 'PropertyState'
      && namespaceUriForName(element) === READABLE);
    assert.ok(state, 'the generated state uses the readable namespace rather than foreign xr');
    assert.ok(elementChildren(internalInfo!).some((element) => element.localName === 'Payload'
      && namespaceUriForName(element) === 'urn:vendor'), 'foreign payload remains untouched');
  });

  test('blocks granular DCS edits to the old Template.xml when the selected bundle replaces and deletes it', async () => {
    const fixture = await createTemplateWriterFixture({
      targetType: 'DataCompositionSchema', sourceType: 'BinaryData', baseType: 'DataCompositionSchema',
    });
    const output = await buildSemanticObjectOutput({
      targetRootPath: fixture.targetRootPath,
      sourceRootPath: fixture.sourceRootPath,
      targetDescriptorRelativePath: fixture.row.target!.descriptorRelativePath!,
      row: fixture.row,
      witnesses: [],
      selections: [
        makeTemplatePatchSelection(fixture, 'template-type', 'TemplateType', '<TemplateType>BinaryData</TemplateType>', true),
        makeDcsTemplateSelection(fixture),
      ],
    });

    assert.ok('diagnostic' in output, 'a body replacement cannot also write the old Template.xml through a granular DCS patch');
    if ('diagnostic' in output) {
      assert.match(output.diagnostic.suggestedAction ?? '', /DCS|тела|макета/iu,
        'the conflict is surfaced as a body-bundle conflict, before ordinary stale-file checks');
    }
  });

  test('writes a nested Template descriptor and body while leaving the owner descriptor effective content untouched', async () => {
    const fixture = await createTemplateWriterFixture({ nested: true, targetType: 'BinaryData', sourceType: 'BinaryData', baseType: 'BinaryData' });
    const output = await buildSemanticObjectOutput({
      targetRootPath: fixture.targetRootPath,
      sourceRootPath: fixture.sourceRootPath,
      targetDescriptorRelativePath: fixture.row.target!.descriptorRelativePath!,
      row: fixture.row,
      witnesses: [],
      selections: [makeTemplateBodyOnlySelection(fixture)],
    });

    assert.ok(!('diagnostic' in output), `nested Template bundle should materialize: ${'diagnostic' in output ? output.diagnostic.suggestedAction : ''}`);
    if ('diagnostic' in output) { return; }
    assert.strictEqual(output.writes.filter((write) => write.relativePath === fixture.recipe.targetDescriptor.witness.relativePath).length, 1,
      'nested Template.xml is written at its captured Templates/<name>.xml path');
    assert.strictEqual(output.writes.filter((write) => write.relativePath === fixture.recipe.sourceBodyRelativePath).length, 1,
      'nested Ext/Template body is written once');
    assert.strictEqual(output.effectiveDescriptorRelativePath, fixture.row.target!.descriptorRelativePath);
    assert.deepStrictEqual(output.effectiveDescriptorContent, fixture.row.target!.descriptorContent,
      'nested writes do not replace the owner Catalog descriptor in the row effective state');
    assert.strictEqual(output.writes.filter((write) => write.relativePath === fixture.row.target!.descriptorRelativePath).length, 0,
      'the owner descriptor is not rewritten for a nested-only effect');
  });

  test('rejects stale target, source, base, and newly appeared destination bodies before producing a preview', async () => {
    for (const stale of ['target', 'source', 'base'] as const) {
      const fixture = await createTemplateWriterFixture({ targetType: 'BinaryData', sourceType: 'BinaryData', baseType: 'BinaryData' });
      const witness = stale === 'target'
        ? fixture.recipe.targetBody.kind === 'file' ? fixture.recipe.targetBody.capture.witness : fixture.recipe.targetBody.witness
        : stale === 'source'
          ? fixture.recipe.sourceBody.kind === 'file' ? fixture.recipe.sourceBody.capture.witness : fixture.recipe.sourceBody.witness
          : fixture.recipe.targetBaseBody.witness;
      const rootPath = stale === 'target' ? fixture.targetRootPath : stale === 'source' ? fixture.sourceRootPath : fixture.baseRootPath;
      await writeRelative(rootPath, witness.relativePath, Buffer.from(`stale ${stale} template body`));
      const output = await buildSemanticObjectOutput({
        targetRootPath: fixture.targetRootPath,
        sourceRootPath: fixture.sourceRootPath,
        targetDescriptorRelativePath: fixture.row.target!.descriptorRelativePath!,
        row: fixture.row,
        witnesses: [],
        selections: [makeTemplateBodyOnlySelection(fixture)],
      });
      assert.ok('diagnostic' in output, `${stale}: changed captured body bytes must block before preview`);
    }

    const fixture = await createTemplateWriterFixture({ targetType: 'TextDocument', sourceType: 'BinaryData', baseType: 'TextDocument' });
    const destination = fixture.recipe.sourceBodyRelativePath;
    await writeRelative(fixture.targetRootPath, destination, Buffer.from('appeared after capture'));
    const output = await buildSemanticObjectOutput({
      targetRootPath: fixture.targetRootPath,
      sourceRootPath: fixture.sourceRootPath,
      targetDescriptorRelativePath: fixture.row.target!.descriptorRelativePath!,
      row: fixture.row,
      witnesses: [],
      selections: [makeTemplatePatchSelection(fixture, 'template-type', 'TemplateType', '<TemplateType>BinaryData</TemplateType>', true)],
    });
    assert.ok('diagnostic' in output, 'a captured missing destination body becoming a file must fail the missing-path witness');
  });

  test('fails closed when the captured descriptor recipe or physical witness list is tampered', () => {
    const projected = projectCapturedAdoptedTemplateBundle(makeCaptureInput({
      baseType: 'BinaryData', targetType: 'BinaryData', sourceType: 'BinaryData',
    }));
    assert.strictEqual(projected.ok, true, projected.ok ? undefined : projected.reason);
    if (!projected.ok) { return; }
    const mergedLogicalTarget = Buffer.from(projected.recipe.descriptorRecipe.initialLogicalTarget);
    const alteredLogical = materializeCapturedAdoptedTemplateBundle({
      recipe: {
        ...projected.recipe,
        descriptorRecipe: {
          ...projected.recipe.descriptorRecipe,
          initialLogicalTarget: Buffer.from(projected.recipe.descriptorRecipe.initialLogicalTarget.toString('utf8').replace('fixture', 'forged')),
        },
      },
      mergedLogicalTarget,
    });
    const strippedWitnesses = materializeCapturedAdoptedTemplateBundle({
      recipe: { ...projected.recipe, requiredWitnesses: [] },
      mergedLogicalTarget,
    });
    assert.strictEqual(alteredLogical.ok, false, 'descriptor projection bytes are checked against a fresh projection');
    assert.strictEqual(strippedWitnesses.ok, false, 'all raw body/base witnesses remain mandatory');
  });

  test('does not repair the Extended marker for a selected logical no-op', () => {
    const input = makeCaptureInput({
      baseType: 'BinaryData',
      targetType: 'BinaryData',
      sourceType: 'BinaryData',
      targetBodyMissing: false,
      sourceBodyMissing: false,
    });
    if (input.targetBody.kind !== 'file' || input.sourceBody.kind !== 'file') { return; }
    const identical = Buffer.from('same body');
    const alignedInput = {
      ...input,
      targetDescriptor: capture(templateDescriptor('CommonTemplate', 'Print', TARGET_UUID, 'BinaryData', BASE_UUID), adoptedIdentity(TARGET_UUID), 'target', 'CommonTemplates/Print.xml'),
      sourceDescriptor: capture(templateDescriptor('CommonTemplate', 'Print', SOURCE_UUID, 'BinaryData', BASE_UUID), adoptedIdentity(SOURCE_UUID), 'source', 'CommonTemplates/Print.xml'),
      targetBody: fileSide(identical, adoptedIdentity(TARGET_UUID), 'target', 'CommonTemplates/Print/Ext/Template.bin'),
      sourceBody: fileSide(identical, adoptedIdentity(SOURCE_UUID), 'source', 'CommonTemplates/Print/Ext/Template.bin'),
      targetDestinationBody: fileSide(identical, adoptedIdentity(TARGET_UUID), 'target', 'CommonTemplates/Print/Ext/Template.bin'),
      targetBaseBody: capture(identical, ownIdentity(), 'base-target', 'CommonTemplates/Print/Ext/Template.bin'),
      sourceBaseBody: capture(identical, ownIdentity(), 'base-source', 'CommonTemplates/Print/Ext/Template.bin'),
    } satisfies CapturedAdoptedTemplateProjectionInput;
    const projected = projectCapturedAdoptedTemplateBundle(alignedInput);
    assert.strictEqual(projected.ok, true, projected.ok ? undefined : projected.reason);
    if (!projected.ok) { return; }
    const materialized = materializeCapturedAdoptedTemplateBundle({
      recipe: projected.recipe,
      mergedLogicalTarget: projected.recipe.descriptorRecipe.initialLogicalTarget,
    });
    assert.strictEqual(materialized.ok, true, materialized.ok ? undefined : materialized.reason);
    if (!materialized.ok) { return; }
    assert.strictEqual(materialized.changed, false);
    assert.strictEqual(materialized.bodyEffect, false);
    assert.strictEqual(materialized.descriptorContent, undefined, 'an unrelated selected no-op does not repair Template state');
  });
});

interface TemplateWriterFixture {
  readonly targetRootPath: string;
  readonly sourceRootPath: string;
  readonly baseRootPath: string;
  readonly recipe: CapturedAdoptedTemplateBundle;
  readonly row: ExtensionTransferRow;
  readonly targetBodyBytes: Buffer;
  readonly sourceBodyBytes: Buffer;
  readonly targetDescriptorBytes: Buffer;
  readonly sourceDescriptorBytes: Buffer;
}

let templateWriterFixtureSequence = 0;

async function createTemplateWriterFixture(options: {
  readonly direction?: 'cf-to-adopted' | 'adopted-to-cf' | 'adopted-to-adopted';
  readonly nested?: boolean;
  readonly targetType?: string;
  readonly sourceType?: string;
  readonly baseType?: string;
  readonly targetComment?: string;
  readonly sourceComment?: string;
  readonly targetTemplateTypeNotify?: boolean;
  readonly shadowedReadablePrefix?: boolean;
} = {}): Promise<TemplateWriterFixture> {
  const direction = options.direction ?? 'adopted-to-adopted';
  const nested = options.nested ?? false;
  const metadataType = nested ? 'Template' : 'CommonTemplate';
  const ownerType = 'Catalog';
  const ownerName = 'Products';
  const name = 'Print';
  const targetType = options.targetType ?? 'BinaryData';
  const sourceType = options.sourceType ?? targetType;
  const baseType = options.baseType ?? targetType;
  const ownBaseIdentity = ownIdentityFor(metadataType, name, BASE_UUID);
  const targetIdentity = sideIdentity(direction !== 'adopted-to-cf', metadataType, name, TARGET_UUID, BASE_UUID);
  const sourceIdentity = sideIdentity(direction !== 'cf-to-adopted', metadataType, name, SOURCE_UUID, BASE_UUID);
  const targetRelativePath = nested ? 'Catalogs/Products/Templates/Print.xml' : 'CommonTemplates/Print.xml';
  const ownerRelativePath = 'Catalogs/Products.xml';
  const targetRowPath = nested ? ownerRelativePath : targetRelativePath;
  const bodyPathFor = (templateType: string) => `${targetRelativePath.slice(0, -'.xml'.length)}/Ext/Template.${templateExtension(templateType)}`;
  const baseDescriptorBytes = writerTemplateDescriptor(metadataType as 'Template' | 'CommonTemplate', name, BASE_UUID, baseType, undefined, 'Base comment');
  const targetDescriptorBytes = writerTemplateDescriptor(metadataType as 'Template' | 'CommonTemplate', name, targetIdentity.uuid, targetType,
    targetIdentity.sourceUuid, options.targetComment ?? 'Shared comment', options.targetTemplateTypeNotify ?? false, options.shadowedReadablePrefix ?? false);
  const sourceDescriptorBytes = writerTemplateDescriptor(metadataType as 'Template' | 'CommonTemplate', name, sourceIdentity.uuid, sourceType,
    sourceIdentity.sourceUuid, options.sourceComment ?? options.targetComment ?? 'Shared comment');
  const targetBodyBytes = targetType === 'DataCompositionSchema'
    ? Buffer.from('<DataCompositionSchema><Name>target body</Name></DataCompositionSchema>')
    : Buffer.from('physical target template body');
  const sourceBodyBytes = Buffer.from('physical source template body');
  const baseBodyBytes = baseType === 'DataCompositionSchema'
    ? Buffer.from('<DataCompositionSchema><Name>base body</Name></DataCompositionSchema>')
    : Buffer.from('physical common base template body');
  const targetBodyRelativePath = bodyPathFor(targetType);
  const sourceBodyRelativePath = bodyPathFor(sourceType);
  const targetPath = bodyPathFor(sourceType);

  const outputRoot = path.resolve(process.cwd(), `.tmp-issue335-template-writer-${process.pid}-${Date.now()}-${templateWriterFixtureSequence++}`);
  const targetRootPath = path.join(outputRoot, 'target');
  const sourceRootPath = path.join(outputRoot, 'source');
  const baseRootPath = path.join(outputRoot, 'base');
  await Promise.all([targetRootPath, sourceRootPath, baseRootPath].map((rootPath) => fs.mkdir(rootPath, { recursive: true })));
  const configs = new Map([
    ['target', Buffer.from('target configuration')],
    ['source', Buffer.from('source configuration')],
    ['base', Buffer.from('base configuration')],
  ]);
  for (const [sourceId, rootPath] of [['target', targetRootPath], ['source', sourceRootPath], ['base', baseRootPath]] as const) {
    await writeRelative(rootPath, 'Configuration.xml', configs.get(sourceId)!);
  }

  let targetOwnerCapture: AdoptedSemanticArtifactCapture | undefined;
  let sourceOwnerCapture: AdoptedSemanticArtifactCapture | undefined;
  let baseOwnerCapture: AdoptedSemanticArtifactCapture | undefined;
  let targetOwnerBytes: Buffer | undefined;
  let sourceOwnerBytes: Buffer | undefined;
  let baseOwnerBytes: Buffer | undefined;
  let targetIndexObject: ExtensionIndexedObject;
  let sourceIndexObject: ExtensionIndexedObject;
  let baseIndexObject: ExtensionIndexedObject;
  if (nested) {
    const targetOwnerIdentity = sideIdentity(direction !== 'adopted-to-cf', ownerType, ownerName, TARGET_UUID, BASE_UUID);
    const sourceOwnerIdentity = sideIdentity(direction !== 'cf-to-adopted', ownerType, ownerName, SOURCE_UUID, BASE_UUID);
    const baseOwnerIdentity = ownIdentityFor(ownerType, ownerName, BASE_UUID);
    targetOwnerBytes = ownerDescriptor(targetOwnerIdentity, name);
    sourceOwnerBytes = ownerDescriptor(sourceOwnerIdentity, name);
    baseOwnerBytes = ownerDescriptor(baseOwnerIdentity, name);
    targetOwnerCapture = capture(targetOwnerBytes, targetOwnerIdentity, 'target', ownerRelativePath);
    sourceOwnerCapture = capture(sourceOwnerBytes, sourceOwnerIdentity, 'source', ownerRelativePath);
    baseOwnerCapture = capture(baseOwnerBytes, baseOwnerIdentity, 'base', ownerRelativePath);
    targetIndexObject = indexedObject(targetOwnerIdentity, targetOwnerBytes, 'target', ownerRelativePath, [
      capturedFile(targetRelativePath, targetDescriptorBytes), capturedFile(targetBodyRelativePath, targetBodyBytes),
    ]);
    sourceIndexObject = indexedObject(sourceOwnerIdentity, sourceOwnerBytes, 'source', ownerRelativePath, [
      capturedFile(targetRelativePath, sourceDescriptorBytes), capturedFile(sourceBodyRelativePath, sourceBodyBytes),
    ]);
    baseIndexObject = indexedObject(baseOwnerIdentity, baseOwnerBytes, 'base', ownerRelativePath, [
      capturedFile(targetRelativePath, baseDescriptorBytes), capturedFile(bodyPathFor(baseType), baseBodyBytes),
    ]);
  } else {
    targetIndexObject = indexedObject(targetIdentity, targetDescriptorBytes, 'target', targetRelativePath,
      [capturedFile(targetBodyRelativePath, targetBodyBytes), capturedFile('CommonTemplates/Print/Ext/TargetOnly.bin', Buffer.from('preserve target-only sibling'))]);
    sourceIndexObject = indexedObject(sourceIdentity, sourceDescriptorBytes, 'source', targetRelativePath,
      [capturedFile(sourceBodyRelativePath, sourceBodyBytes)]);
    baseIndexObject = indexedObject(ownBaseIdentity, baseDescriptorBytes, 'base', targetRelativePath,
      [capturedFile(bodyPathFor(baseType), baseBodyBytes)]);
  }

  await writeRelative(targetRootPath, targetRowPath, nested ? targetOwnerBytes! : targetDescriptorBytes);
  await writeRelative(sourceRootPath, targetRowPath, nested ? sourceOwnerBytes! : sourceDescriptorBytes);
  await writeRelative(baseRootPath, targetRowPath, nested ? baseOwnerBytes! : baseDescriptorBytes);
  if (nested) {
    await writeRelative(targetRootPath, targetRelativePath, targetDescriptorBytes);
    await writeRelative(sourceRootPath, targetRelativePath, sourceDescriptorBytes);
    await writeRelative(baseRootPath, targetRelativePath, baseDescriptorBytes);
  }
  await writeRelative(targetRootPath, targetBodyRelativePath, targetBodyBytes);
  await writeRelative(sourceRootPath, sourceBodyRelativePath, sourceBodyBytes);
  await writeRelative(baseRootPath, bodyPathFor(baseType), baseBodyBytes);
  if (!nested) { await writeRelative(targetRootPath, 'CommonTemplates/Print/Ext/TargetOnly.bin', Buffer.from('preserve target-only sibling')); }

  const targetBodySide = fileSide(targetBodyBytes, targetIdentity, 'target', targetBodyRelativePath);
  const sourceBodySide = fileSide(sourceBodyBytes, sourceIdentity, 'source', sourceBodyRelativePath);
  const targetDestinationBody = targetPath === targetBodyRelativePath
    ? targetBodySide
    : missingSide('target', targetPath);
  const configurationWitnesses = [...configs].map(([sourceId, bytes]) => fileWitness(sourceId, 'Configuration.xml', bytes));
  const projected = projectCapturedAdoptedTemplateBundle({
    direction,
    formatVersion: '2.20',
    metadataType: metadataType as 'Template' | 'CommonTemplate',
    targetDescriptor: capture(targetDescriptorBytes, targetIdentity, 'target', targetRelativePath),
    sourceDescriptor: capture(sourceDescriptorBytes, sourceIdentity, 'source', targetRelativePath),
    targetBaseDescriptor: capture(baseDescriptorBytes, ownBaseIdentity, 'base', targetRelativePath),
    sourceBaseDescriptor: capture(baseDescriptorBytes, ownBaseIdentity, 'base', targetRelativePath),
    targetBody: targetBodySide,
    sourceBody: sourceBodySide,
    targetDestinationBody,
    targetBaseBody: capture(baseBodyBytes, ownBaseIdentity, 'base', bodyPathFor(baseType)),
    sourceBaseBody: capture(baseBodyBytes, ownBaseIdentity, 'base', bodyPathFor(baseType)),
    ...(nested ? {
      ownerProof: {
        target: targetOwnerCapture!, source: sourceOwnerCapture!, targetBase: baseOwnerCapture!, sourceBase: baseOwnerCapture!,
      },
    } : {}),
    configurationWitnesses,
  });
  if (!projected.ok) { throw new Error(projected.reason); }

  const targetRoot = metadataIndex(targetRootPath, 'target', targetIdentity.ownership, targetIndexObject, configs.get('target')!);
  const sourceRoot = metadataIndex(sourceRootPath, 'source', sourceIdentity.ownership, sourceIndexObject, configs.get('source')!);
  const baseRoot = metadataIndex(baseRootPath, 'base', 'own', baseIndexObject, configs.get('base')!);
  const row: ExtensionTransferRow = {
    id: nested ? 'Catalog:Products' : 'CommonTemplate:Print',
    qualifiedName: nested ? 'Catalog.Products' : 'CommonTemplate.Print',
    status: 'changed',
    target: targetIndexObject,
    incoming: sourceIndexObject,
    targetRoot,
    incomingRoot: sourceRoot,
    targetBase: baseRoot,
    incomingBase: baseRoot,
    action: 'overlay-adopted',
    mergeable: true,
    sameProvenBase: true,
  };
  return {
    targetRootPath,
    sourceRootPath,
    baseRootPath,
    recipe: projected.recipe,
    row,
    targetBodyBytes,
    sourceBodyBytes,
    targetDescriptorBytes,
    sourceDescriptorBytes,
  };
}

function makeTemplateBodyOnlySelection(fixture: TemplateWriterFixture): ExtensionSemanticSelection & { readonly adoptedTemplateBundle: CapturedAdoptedTemplateBundle } {
  const targetUri = templateTargetUri(fixture);
  const candidate: MergeCandidate = {
    kind: 'xmlNodeReplace', sourceId: fixture.recipe.sourceDescriptor.witness.sourceId,
    snapshotId: 'adopted-template-body-only', nodeId: 'template-body-only', targetUri,
    sourceWitnesses: [fixture.recipe.sourceDescriptor.witness, fixture.recipe.sourceBody.kind === 'file'
      ? fixture.recipe.sourceBody.capture.witness : fixture.recipe.sourceBody.witness],
  };
  return {
    nodeId: 'template-body-only', rowId: fixture.row.id, kind: 'metadataXml',
    targetRelativePath: fixture.recipe.targetDescriptor.witness.relativePath,
    sourceRelativePath: fixture.recipe.sourceDescriptor.witness.relativePath,
    targetHash: fixture.recipe.targetDescriptor.witness.expectedHash,
    sourceHash: fixture.recipe.sourceDescriptor.witness.expectedHash,
    candidateFactory: async () => ({ ok: true, candidate }),
    adoptedTemplateBundle: fixture.recipe,
  };
}

function makeTemplatePatchSelection(
  fixture: TemplateWriterFixture,
  nodeId: string,
  propertyName: 'TemplateType' | 'Comment',
  replacementXml: string,
  selectedBundle: boolean,
): ExtensionSemanticSelection {
  const logicalTarget = fixture.recipe.descriptorRecipe.initialLogicalTarget.toString('utf8');
  const targetUri = templateTargetUri(fixture);
  const element = findTemplateProperty(logicalTarget, fixture.recipe.metadataType, propertyName);
  const patch: XmlPatchPayload = {
    kind: 'replaceNode', target: buildXmlAddress(targetUri, element),
    expectedOldHash: hashXmlText(logicalTarget), newHash: hashXmlText(replacementXml), replacementXml,
    semanticKind: 'metadataXml', sourceWitnesses: [fixture.recipe.sourceDescriptor.witness],
  };
  const candidate: MergeCandidate = {
    kind: 'xmlNodeReplace', sourceId: fixture.recipe.sourceDescriptor.witness.sourceId,
    snapshotId: `adopted-template-${nodeId}`, nodeId, targetUri, xmlPatch: patch,
  };
  const selection: ExtensionSemanticSelection = {
    nodeId, rowId: fixture.row.id, kind: 'metadataXml',
    targetRelativePath: fixture.recipe.targetDescriptor.witness.relativePath,
    sourceRelativePath: fixture.recipe.sourceDescriptor.witness.relativePath,
    targetHash: fixture.recipe.targetDescriptor.witness.expectedHash,
    sourceHash: fixture.recipe.sourceDescriptor.witness.expectedHash,
    candidateFactory: async () => ({ ok: true, candidate }),
  };
  if (selectedBundle) {
    return { ...selection, adoptedTemplateBundle: fixture.recipe } as ExtensionSemanticSelection & { readonly adoptedTemplateBundle: CapturedAdoptedTemplateBundle };
  }
  return { ...selection, adoptedArtifact: templateAdoptedArtifact(fixture) };
}

function makeDcsTemplateSelection(fixture: TemplateWriterFixture): ExtensionSemanticSelection {
  const targetPath = fixture.recipe.targetBodyRelativePath;
  const targetUri = pathToFileURL(path.resolve(fixture.targetRootPath, targetPath)).toString();
  const oldXml = fixture.targetBodyBytes.toString('utf8');
  const name = elementChildren(parseXmlDocument(oldXml).root).find((element) => element.localName === 'Name');
  assert.ok(name);
  const replacementXml = '<Name>selected body edit</Name>';
  const patch: XmlPatchPayload = {
    kind: 'replaceNode', target: buildXmlAddress(targetUri, name!),
    expectedOldHash: hashXmlText(oldXml), newHash: hashXmlText(replacementXml), replacementXml,
    semanticKind: 'dcsXml', sourceWitnesses: [fixture.recipe.sourceBody.kind === 'file'
      ? fixture.recipe.sourceBody.capture.witness : fixture.recipe.sourceBody.witness],
  };
  const candidate: MergeCandidate = {
    kind: 'xmlNodeReplace', sourceId: fixture.recipe.sourceDescriptor.witness.sourceId,
    snapshotId: 'adopted-template-granular-dcs', nodeId: 'dcs-body-edit', targetUri, xmlPatch: patch,
  };
  return {
    nodeId: 'dcs-body-edit', rowId: fixture.row.id, kind: 'dcsXml',
    targetRelativePath: targetPath,
    sourceRelativePath: fixture.recipe.sourceBodyRelativePath,
    targetHash: fixture.recipe.targetBody.kind === 'file' ? fixture.recipe.targetBody.capture.witness.expectedHash : MISSING_TARGET_HASH,
    sourceHash: fixture.recipe.sourceBody.kind === 'file' ? fixture.recipe.sourceBody.capture.witness.expectedHash : MISSING_TARGET_HASH,
    candidateFactory: async () => ({ ok: true, candidate }),
  };
}

function templateAdoptedArtifact(fixture: TemplateWriterFixture): NonNullable<ExtensionSemanticSelection['adoptedArtifact']> {
  return {
    kind: 'metadataXml',
    targetRelativePath: fixture.recipe.targetDescriptor.witness.relativePath,
    sourceRelativePath: fixture.recipe.sourceDescriptor.witness.relativePath,
    targetFilePath: path.resolve(fixture.targetRootPath, fixture.recipe.targetDescriptor.witness.relativePath),
    sourceFilePath: path.resolve(fixture.sourceRootPath, fixture.recipe.sourceDescriptor.witness.relativePath),
    targetHash: fixture.recipe.targetDescriptor.witness.expectedHash,
    sourceHash: fixture.recipe.sourceDescriptor.witness.expectedHash,
    targetXml: Buffer.from(fixture.recipe.descriptorRecipe.initialLogicalTarget),
    sourceXml: Buffer.from(fixture.recipe.descriptorRecipe.initialLogicalSource),
    recipe: fixture.recipe.descriptorRecipe,
    issues: fixture.recipe.descriptorRecipe.issues,
    uuidCandidateWitnesses: new Map(),
    dependencyWitnesses: fixture.recipe.descriptorRecipe.requiredWitnesses,
  };
}

function templateTargetUri(fixture: TemplateWriterFixture): string {
  return pathToFileURL(path.resolve(fixture.targetRootPath, fixture.recipe.targetDescriptor.witness.relativePath)).toString();
}

function findTemplateProperty(xml: string, metadataType: 'Template' | 'CommonTemplate', propertyName: 'TemplateType' | 'Comment'): XmlElement {
  const root = parseXmlDocument(xml).root;
  const metadata = elementChildren(root).find((element) => element.localName === metadataType);
  assert.ok(metadata);
  const properties = elementChildren(metadata!).find((element) => element.localName === 'Properties');
  assert.ok(properties);
  const property = elementChildren(properties!).find((element) => element.localName === propertyName);
  assert.ok(property);
  return property!;
}

function writerTemplateDescriptor(
  metadataType: 'Template' | 'CommonTemplate',
  name: string,
  uuid: string,
  templateType: string,
  sourceUuid?: string,
  comment = 'Shared comment',
  templateTypeNotify = false,
  shadowedReadablePrefix = false,
): Buffer {
  const markers = sourceUuid ? `<ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>${sourceUuid}</ExtendedConfigurationObject>` : '';
  const readableBinding = shadowedReadablePrefix ? 'xmlns:xr="urn:vendor"' : 'xmlns:xr="http://v8.1c.ru/8.3/xcf/readable"';
  const typeState = templateTypeNotify ? '<xr:PropertyState><xr:Property>TemplateType</xr:Property><xr:State>Notify</xr:State></xr:PropertyState>' : '';
  const vendorPayload = shadowedReadablePrefix ? '<xr:Payload>preserve vendor payload</xr:Payload>' : '';
  const internalInfo = sourceUuid ? `<InternalInfo>${typeState}${vendorPayload}</InternalInfo>` : '';
  return Buffer.from(`<MetaDataObject xmlns="${MD}" ${readableBinding} version="2.20"><${metadataType} uuid="${uuid}">${internalInfo}<Properties><Name>${name}</Name><TemplateType>${templateType}</TemplateType><Comment>${comment}</Comment>${markers}</Properties></${metadataType}></MetaDataObject>`);
}

function ownerDescriptor(identity: AdoptedDesignerIdentity, nestedTemplateName: string): Buffer {
  const markers = identity.ownership === 'adopted'
    ? `<ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>${identity.sourceUuid}</ExtendedConfigurationObject>` : '';
  return Buffer.from(`<MetaDataObject xmlns="${MD}" version="2.20"><${identity.type} uuid="${identity.uuid}"><Properties><Name>${identity.name}</Name>${markers}</Properties><ChildObjects><Template>${nestedTemplateName}</Template></ChildObjects></${identity.type}></MetaDataObject>`);
}

function ownIdentityFor(type: string, name: string, uuid: string): AdoptedDesignerIdentity {
  return { ownership: 'own', type, name, uuid };
}

function sideIdentity(adopted: boolean, type: string, name: string, uuid: string, sourceUuid: string): AdoptedDesignerIdentity {
  return adopted ? { ownership: 'adopted', type, name, uuid, sourceUuid } : { ownership: 'own', type, name, uuid: BASE_UUID };
}

function templateExtension(templateType: string): string {
  return ({ TextDocument: 'txt', BinaryData: 'bin', SpreadsheetDocument: 'xml', DataCompositionSchema: 'xml', ActiveDocument: 'xml' } as Record<string, string>)[templateType]!;
}

function indexedObject(
  identity: AdoptedDesignerIdentity,
  descriptorContent: Buffer,
  sourceId: string,
  descriptorRelativePath: string,
  sidecarFiles: readonly { readonly relativePath: string; readonly hash: string; readonly content: Buffer }[],
): ExtensionIndexedObject {
  return {
    side: sourceId === 'source' ? 'right' : 'left', sourceId, metadataType: identity.type, name: identity.name,
    qualifiedName: `${identity.type}.${identity.name}`, descriptorRelativePath,
    descriptorRootTag: identity.type, descriptorContent, descriptorHash: hash(descriptorContent),
    identity: { ...identity, path: descriptorRelativePath }, sidecarFiles, supportedRootType: true, valid: true,
  };
}

function capturedFile(relativePath: string, content: Buffer): { readonly relativePath: string; readonly hash: string; readonly content: Buffer } {
  return { relativePath, hash: hash(content), content: Buffer.from(content) };
}

function metadataIndex(
  rootPath: string,
  sourceId: string,
  ownership: 'own' | 'adopted',
  object: ExtensionIndexedObject,
  configurationContent: Buffer,
): ExtensionMetadataIndex {
  return {
    rootPath, canonicalRootPath: rootPath, sourceId, side: sourceId === 'source' ? 'right' : 'left',
    rootKind: ownership === 'adopted' ? 'cfe' : 'cf',
    hasConfigurationXml: true, configurationContent, configurationHash: hash(configurationContent),
    formatVersion: '2.20', objects: [object], diagnostics: [], cfeMarkerSeen: ownership === 'adopted',
  };
}

async function writeRelative(rootPath: string, relativePath: string, content: Buffer): Promise<void> {
  const absolute = path.resolve(rootPath, relativePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content);
}

function makeCaptureInput(options: {
  readonly baseType: string;
  readonly targetType: string;
  readonly sourceType: string;
  readonly targetBodyMissing?: boolean;
  readonly sourceBodyMissing?: boolean;
}): CapturedAdoptedTemplateProjectionInput {
  const descriptorPath = 'CommonTemplates/Print.xml';
  const baseDescriptor = templateDescriptor('CommonTemplate', 'Print', BASE_UUID, options.baseType);
  const targetDescriptor = templateDescriptor('CommonTemplate', 'Print', TARGET_UUID, options.targetType, BASE_UUID);
  const sourceDescriptor = templateDescriptor('CommonTemplate', 'Print', SOURCE_UUID, options.sourceType, BASE_UUID);
  const baseBodyPath = bodyPath(descriptorPath, options.baseType);
  const targetBodyPath = bodyPath(descriptorPath, options.targetType);
  const sourceBodyPath = bodyPath(descriptorPath, options.sourceType);
  const selectedDestinationPath = bodyPath(descriptorPath, options.sourceType);
  const baseBytes = Buffer.from('captured base body');
  const targetBytes = Buffer.from('captured target body');
  const sourceBytes = Buffer.from('captured source body');
  const targetIdentity = adoptedIdentity(TARGET_UUID);
  const sourceIdentity = adoptedIdentity(SOURCE_UUID);
  const baseIdentity = ownIdentity();
  const targetBody = options.targetBodyMissing
    ? missingSide('target', targetBodyPath)
    : fileSide(targetBytes, targetIdentity, 'target', targetBodyPath);
  const sourceBody = options.sourceBodyMissing
    ? missingSide('source', sourceBodyPath)
    : fileSide(sourceBytes, sourceIdentity, 'source', sourceBodyPath);
  const targetDestinationBody = selectedDestinationPath === targetBodyPath
    ? targetBody
    : missingSide('target', selectedDestinationPath);

  return {
    direction: 'adopted-to-adopted',
    formatVersion: '2.20',
    metadataType: 'CommonTemplate',
    targetDescriptor: capture(targetDescriptor, targetIdentity, 'target', descriptorPath),
    sourceDescriptor: capture(sourceDescriptor, sourceIdentity, 'source', descriptorPath),
    targetBaseDescriptor: capture(baseDescriptor, baseIdentity, 'base-target', descriptorPath),
    sourceBaseDescriptor: capture(baseDescriptor, baseIdentity, 'base-source', descriptorPath),
    targetBody,
    sourceBody,
    targetDestinationBody,
    targetBaseBody: capture(baseBytes, baseIdentity, 'base-target', baseBodyPath),
    sourceBaseBody: capture(baseBytes, baseIdentity, 'base-source', baseBodyPath),
    configurationWitnesses: [],
  };
}

function templateDescriptor(
  metadataType: 'CommonTemplate',
  name: string,
  uuid: string,
  templateType: string,
  anchor?: string,
): Buffer {
  const anchorXml = anchor ? `<ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>${anchor}</ExtendedConfigurationObject>` : '';
  return Buffer.from(`<MetaDataObject xmlns="${MD}" version="2.20"><${metadataType} uuid="${uuid}"><Properties><Name>${name}</Name><TemplateType>${templateType}</TemplateType><Comment>fixture</Comment>${anchorXml}</Properties></${metadataType}></MetaDataObject>`);
}

function bodyPath(descriptorPath: string, templateType: string): string {
  const extension: Record<string, string> = {
    TextDocument: 'txt',
    BinaryData: 'bin',
    SpreadsheetDocument: 'xml',
    DataCompositionSchema: 'xml',
    ActiveDocument: 'xml',
  };
  return `${descriptorPath.slice(0, -'.xml'.length)}/Ext/Template.${extension[templateType]}`;
}

function ownIdentity(): AdoptedDesignerIdentity {
  return { ownership: 'own', type: 'CommonTemplate', name: 'Print', uuid: BASE_UUID };
}

function adoptedIdentity(uuid: string): AdoptedDesignerIdentity {
  return { ownership: 'adopted', type: 'CommonTemplate', name: 'Print', uuid, sourceUuid: BASE_UUID };
}

function capture(content: Buffer, identity: AdoptedDesignerIdentity, sourceId: string, relativePath: string): AdoptedSemanticArtifactCapture {
  return { content, identity, witness: fileWitness(sourceId, relativePath, content) };
}

function fileSide(content: Buffer, identity: AdoptedDesignerIdentity, sourceId: string, relativePath: string): CapturedAdoptedTemplatePhysicalSide {
  return { kind: 'file', capture: capture(content, identity, sourceId, relativePath) };
}

function missingSide(sourceId: string, relativePath: string): CapturedAdoptedTemplatePhysicalSide {
  return { kind: 'missing', witness: { sourceId, relativePath, expectedHash: MISSING_TARGET_HASH, kind: 'file' } };
}

function fileWitness(sourceId: string, relativePath: string, content: Buffer): MergeFileWitness {
  return { sourceId, relativePath, expectedHash: hash(content), kind: 'file' };
}

function hash(content: Buffer): string { return createHash('sha256').update(content).digest('hex'); }
