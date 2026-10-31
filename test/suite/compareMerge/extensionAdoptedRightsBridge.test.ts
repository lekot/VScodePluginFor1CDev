import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { pathToFileURL } from 'url';

import { buildSemanticObjectOutput } from '../../../src/compareMerge/extensions/extensionSemanticMaterializer';
import type { ExtensionIndexedObject, ExtensionMetadataIndex } from '../../../src/compareMerge/extensions/extensionMetadataIndex';
import type { ExtensionSemanticSelection, ExtensionTransferRow } from '../../../src/compareMerge/extensions/extensionTransfer';
import { roleRightsXmlAdapter } from '../../../src/compareMerge/adapters/roleRightsXmlAdapter';
import type { AdapterCompareInput } from '../../../src/compareMerge/adapters/mergeAdapter';
import { CompareSession } from '../../../src/compareMerge/domain/compareSession';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import {
  materializeCapturedAdoptedRightsTarget,
  projectCapturedAdoptedRightsPair,
  type CapturedAdoptedRightsRecipe,
  type CapturedAdoptedRightsSide,
} from '../../../src/compareMerge/extensions/extensionAdoptedRightsBridge';
import type { AdoptedSemanticArtifactCapture } from '../../../src/compareMerge/extensions/extensionAdoptedSemanticBridge';
import type { AdoptedDesignerIdentity } from '../../../src/compareMerge/extensions/adoptedDesignerProjection';
import { MISSING_TARGET_HASH, type MergeCandidate, type MergeFileWitness, type XmlPatchPayload } from '../../../src/compareMerge/merge/mergePreview';
import { hashXmlText } from '../../../src/compareMerge/xml/xmlPatch';
import { buildXmlAddress, elementChildren, parseXmlDocument, textContent, type XmlElement } from '../../../src/compareMerge/xml/xmlDom';
import { namespaceUriForName } from '../../../src/compareMerge/adapters/semanticXml/semanticXmlIdentity';

const BASE_UUID = '11111111-1111-4111-8111-111111111111';
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const TARGET_UUID = '22222222-2222-4222-8222-222222222222';
const SOURCE_UUID = '99999999-9999-4999-8999-999999999999';
const MD = 'http://v8.1c.ru/8.3/MDClasses';
const READABLE = 'http://v8.1c.ru/8.3/xcf/readable';
const RIGHTS = 'http://v8.1c.ru/8.2/roles';

suite('Captured adopted Designer Rights bridge (#335)', () => {
  test('projects an absent adopted source as inherited and snapshots raw witnesses immutably', () => {
    const input = makeInput({
      targetRights: fileSide(rightsXml(false), adoptedIdentity(TARGET_UUID), 'target', 'Roles/Sales/Ext/Rights.xml'),
      sourceRights: missingSide('source', 'Roles/Sales/Ext/Rights.xml'),
    });

    const projected = projectCapturedAdoptedRightsPair(input);

    assert.strictEqual(projected.ok, true, projected.ok ? undefined : projected.reason);
    if (!projected.ok) { return; }
    assert.match(projected.targetXml.toString('utf8'), /<value>false<\/value>/u);
    assert.match(projected.sourceXml.toString('utf8'), /<value>true<\/value>/u,
      'an absent adopted source Rights.xml inherits from the captured own base');
    assert.ok(projected.recipe.requiredWitnesses.some((witness) =>
      witness.sourceId === 'source' && witness.relativePath === 'Roles/Sales/Ext/Rights.xml'
        && witness.expectedHash === MISSING_TARGET_HASH && witness.kind === 'file'));
    assert.ok(projected.recipe.requiredWitnesses.some((witness) =>
      witness.sourceId === 'base' && witness.relativePath === 'Roles/Sales/Rights.xml'));

    input.baseRights.content.fill(0);
    assert.strictEqual(input.targetRights.kind, 'file');
    if (input.targetRights.kind !== 'file') { return; }
    input.targetRights.capture.content.fill(0);
    assert.match(projected.recipe.baseRights.content.toString('utf8'), /<value>true<\/value>/u,
      'the recipe owns a byte snapshot of base Rights.xml');
    assert.strictEqual(projected.recipe.targetRights.kind, 'file');
    if (projected.recipe.targetRights.kind !== 'file') { return; }
    assert.match(projected.recipe.targetRights.capture.content.toString('utf8'), /<value>false<\/value>/u,
      'the recipe owns a byte snapshot of target Rights.xml');
  });

  test('materializes return-to-base as an omission and keeps physical missing witnesses raw', () => {
    const projected = projectCapturedAdoptedRightsPair(makeInput({
      targetRights: fileSide(rightsXml(false), adoptedIdentity(TARGET_UUID), 'target', 'Roles/Sales/Ext/Rights.xml'),
      sourceRights: missingSide('source', 'Roles/Sales/Ext/Rights.xml'),
    }));
    assert.strictEqual(projected.ok, true, projected.ok ? undefined : projected.reason);
    if (!projected.ok) { return; }

    const merged = Buffer.from(projected.targetXml.toString('utf8').replace('<value>false</value>', '<value>true</value>'));
    const materialized = materializeCapturedAdoptedRightsTarget({ recipe: projected.recipe, mergedLogicalTarget: merged });

    assert.strictEqual(materialized.ok, true, materialized.ok ? undefined : materialized.reason);
    if (!materialized.ok) { return; }
    assert.strictEqual(materialized.requiresRightsPropertyState, true);
    assert.strictEqual(materialized.changed, true);
    assert.ok(materialized.content);
    assert.doesNotMatch(materialized.content.toString('utf8'), /<right><name>Read<\/name>/u,
      'returning a selected value to the base is encoded by removing the override');
    assert.ok(materialized.requiredWitnesses.some((witness) => witness.expectedHash === MISSING_TARGET_HASH),
      'absence remains an absence witness and is never replaced with a hash of logical bytes');
    assert.ok(!materialized.requiredWitnesses.some((witness) => witness.sourceId === 'source'
      && witness.expectedHash === hash(projected.sourceXml)),
    'synthetic logical source bytes are not presented as physical captures');
  });

  test('translates only the exact captured logical source witness to the physical missing witness', () => {
    const projected = projectCapturedAdoptedRightsPair(makeInput({
      targetRights: fileSide(rightsXml(false), adoptedIdentity(TARGET_UUID), 'target', 'Roles/Sales/Ext/Rights.xml'),
      sourceRights: missingSide('source', 'Roles/Sales/Ext/Rights.xml'),
    }));
    assert.strictEqual(projected.ok, true, projected.ok ? undefined : projected.reason);
    if (!projected.ok) { return; }

    const materialized = materializeCapturedAdoptedRightsTarget({
      recipe: projected.recipe,
      mergedLogicalTarget: Buffer.from(projected.targetXml.toString('utf8').replace('<value>false</value>', '<value>true</value>')),
      candidateWitnesses: [
        { sourceId: 'source', relativePath: 'Roles/Sales/Ext/Rights.xml', expectedHash: hash(projected.sourceXml), kind: 'file' },
        { sourceId: 'target', relativePath: 'Roles/Sales/Ext/Rights.xml', expectedHash: hash(projected.targetXml), kind: 'file' },
        { sourceId: 'extra', relativePath: 'Catalogs/Products.xml', expectedHash: 'a'.repeat(64), kind: 'file' },
      ],
    });

    assert.strictEqual(materialized.ok, true, materialized.ok ? undefined : materialized.reason);
    if (!materialized.ok) { return; }
    assert.ok(materialized.requiredWitnesses.some((witness) => witness.sourceId === 'source'
      && witness.relativePath === 'Roles/Sales/Ext/Rights.xml'
      && witness.expectedHash === MISSING_TARGET_HASH && witness.kind === 'file'));
    assert.ok(materialized.requiredWitnesses.some((witness) => witness.sourceId === 'target'
      && witness.relativePath === 'Roles/Sales/Ext/Rights.xml'
      && witness.expectedHash === hash(rightsXml(false))));
    assert.ok(materialized.requiredWitnesses.some((witness) => witness.sourceId === 'extra'
      && witness.relativePath === 'Catalogs/Products.xml' && witness.expectedHash === 'a'.repeat(64)),
    'unrelated candidate dependencies remain intact');

    const forgedLogical = materializeCapturedAdoptedRightsTarget({
      recipe: projected.recipe,
      mergedLogicalTarget: projected.targetXml,
      candidateWitnesses: [{
        sourceId: 'source', relativePath: 'Roles/Sales/Ext/Rights.xml', expectedHash: '0'.repeat(64), kind: 'file',
      }],
    });
    assert.strictEqual(forgedLogical.ok, false, 'unknown hash on a logical capture path must fail closed');
  });

  test('fails closed on adopted Rights state/file contradictions and stale raw witnesses', () => {
    const base = makeInput({
      targetRights: fileSide(rightsXml(false), adoptedIdentity(TARGET_UUID), 'target', 'Roles/Sales/Ext/Rights.xml'),
      sourceRights: missingSide('source', 'Roles/Sales/Ext/Rights.xml'),
    });

    const missingFileWithExtended = projectCapturedAdoptedRightsPair({
      ...base,
      targetRights: missingSide('target', 'Roles/Sales/Ext/Rights.xml'),
    });
    assert.strictEqual(missingFileWithExtended.ok, false);
    if (!missingFileWithExtended.ok) { assert.match(missingFileWithExtended.reason, /Rights|Extended|state|состояни/u); }

    const fileWithoutExtended = projectCapturedAdoptedRightsPair({
      ...base,
      targetDescriptor: capture(roleDescriptor(TARGET_UUID, true, false), adoptedIdentity(TARGET_UUID), 'target', 'Roles/Sales.xml'),
    });
    assert.strictEqual(fileWithoutExtended.ok, false);
    if (!fileWithoutExtended.ok) { assert.match(fileWithoutExtended.reason, /Rights|Extended|state|состояни/u); }

    const staleSource = makeInput({
      targetRights: fileSide(rightsXml(false), adoptedIdentity(TARGET_UUID), 'target', 'Roles/Sales/Ext/Rights.xml'),
      sourceRights: fileSide(rightsXml(true), adoptedIdentity(SOURCE_UUID), 'source', 'Roles/Sales/Ext/Rights.xml'),
    });
    assert.strictEqual(staleSource.sourceRights.kind, 'file');
    if (staleSource.sourceRights.kind !== 'file') { return; }
    staleSource.sourceRights.capture.content[0] = 0x20;
    const staleProjection = projectCapturedAdoptedRightsPair(staleSource);
    assert.strictEqual(staleProjection.ok, false);
    if (!staleProjection.ok) { assert.match(staleProjection.reason, /hash|witness|захвачен/u); }
  });

  test('rejects descriptor namespace/version spoofing and Rights captures from another role path', () => {
    const base = makeInput({
      targetRights: fileSide(rightsXml(false), adoptedIdentity(TARGET_UUID), 'target', 'Roles/Sales/Ext/Rights.xml'),
      sourceRights: missingSide('source', 'Roles/Sales/Ext/Rights.xml'),
    });
    const targetXml = base.targetDescriptor.content.toString('utf8');
    const rootSpoof = Buffer.from(targetXml
      .replace('<MetaDataObject ', '<vendor:MetaDataObject xmlns:vendor="urn:foreign" ')
      .replace('</MetaDataObject>', '</vendor:MetaDataObject>'), 'utf8');
    const foreignRoot = projectCapturedAdoptedRightsPair({
      ...base,
      targetDescriptor: capture(rootSpoof, adoptedIdentity(TARGET_UUID), 'target', 'Roles/Sales.xml'),
    });

    const foreignInternalInfo = Buffer.from(targetXml
      .replace('<MetaDataObject ', '<MetaDataObject xmlns:vendor="urn:foreign" ')
      .replace('<InternalInfo>', '<vendor:InternalInfo>')
      .replace('</InternalInfo>', '</vendor:InternalInfo>'), 'utf8');
    const spoofedState = projectCapturedAdoptedRightsPair({
      ...base,
      targetDescriptor: capture(foreignInternalInfo, adoptedIdentity(TARGET_UUID), 'target', 'Roles/Sales.xml'),
    });

    const wrongVersion = Buffer.from(targetXml.replace('version="2.20"', 'version="2.21"'), 'utf8');
    const versionMismatch = projectCapturedAdoptedRightsPair({
      ...base,
      targetDescriptor: capture(wrongVersion, adoptedIdentity(TARGET_UUID), 'target', 'Roles/Sales.xml'),
    });

    const wrongRolePath = projectCapturedAdoptedRightsPair({
      ...base,
      targetRights: fileSide(rightsXml(false), adoptedIdentity(TARGET_UUID), 'target', 'Roles/Other/Ext/Rights.xml'),
    });
    assert.deepStrictEqual(
      [foreignRoot.ok, spoofedState.ok, versionMismatch.ok, wrongRolePath.ok],
      [false, false, false, false],
      'namespace, version, and role-path lookalikes must all be rejected',
    );
  });

  test('rejects zero or malformed Role UUIDs and ownership anchors', () => {
    const base = makeInput({
      targetRights: fileSide(rightsXml(false), adoptedIdentity(TARGET_UUID), 'target', 'Roles/Sales/Ext/Rights.xml'),
      sourceRights: missingSide('source', 'Roles/Sales/Ext/Rights.xml'),
    });
    const zeroRoleIdentity = adoptedIdentity(ZERO_UUID);
    const zeroRole = projectCapturedAdoptedRightsPair({
      ...base,
      targetDescriptor: capture(roleDescriptor(ZERO_UUID, true, true), zeroRoleIdentity, 'target', 'Roles/Sales.xml'),
      targetRights: fileSide(rightsXml(false), zeroRoleIdentity, 'target', 'Roles/Sales/Ext/Rights.xml'),
    });

    const zeroAnchorOwnIdentity: AdoptedDesignerIdentity = { ownership: 'own', type: 'Role', name: 'Sales', uuid: ZERO_UUID };
    const zeroAnchorTargetIdentity: AdoptedDesignerIdentity = { ...adoptedIdentity(TARGET_UUID), sourceUuid: ZERO_UUID };
    const zeroAnchorSourceIdentity: AdoptedDesignerIdentity = { ...adoptedIdentity(SOURCE_UUID), sourceUuid: ZERO_UUID };
    const withZeroAnchor = (uuid: string, rightsExtended: boolean) => Buffer.from(
      roleDescriptor(uuid, true, rightsExtended).toString('utf8').replace(
        `<ExtendedConfigurationObject>${BASE_UUID}</ExtendedConfigurationObject>`,
        `<ExtendedConfigurationObject>${ZERO_UUID}</ExtendedConfigurationObject>`,
      ),
      'utf8',
    );
    const zeroAnchor = projectCapturedAdoptedRightsPair({
      ...base,
      targetDescriptor: capture(withZeroAnchor(TARGET_UUID, true), zeroAnchorTargetIdentity, 'target', 'Roles/Sales.xml'),
      sourceDescriptor: capture(withZeroAnchor(SOURCE_UUID, false), zeroAnchorSourceIdentity, 'source', 'Roles/Sales.xml'),
      baseDescriptor: capture(roleDescriptor(ZERO_UUID, false, false), zeroAnchorOwnIdentity, 'base', 'Roles/Sales.xml'),
      baseRights: capture(rightsXml(true), zeroAnchorOwnIdentity, 'base', 'Roles/Sales/Rights.xml'),
      targetRights: fileSide(rightsXml(false), zeroAnchorTargetIdentity, 'target', 'Roles/Sales/Ext/Rights.xml'),
    });

    const malformedAnchorIdentity: AdoptedDesignerIdentity = { ...adoptedIdentity(TARGET_UUID), sourceUuid: 'not-a-uuid' };
    const malformedAnchorXml = Buffer.from(roleDescriptor(TARGET_UUID, true, true).toString('utf8').replace(
      `<ExtendedConfigurationObject>${BASE_UUID}</ExtendedConfigurationObject>`,
      '<ExtendedConfigurationObject>not-a-uuid</ExtendedConfigurationObject>',
    ), 'utf8');
    const malformedAnchor = projectCapturedAdoptedRightsPair({
      ...base,
      targetDescriptor: capture(malformedAnchorXml, malformedAnchorIdentity, 'target', 'Roles/Sales.xml'),
      targetRights: fileSide(rightsXml(false), malformedAnchorIdentity, 'target', 'Roles/Sales/Ext/Rights.xml'),
    });

    const malformedRoleIdentity = adoptedIdentity('not-a-uuid');
    const malformedRoleXml = Buffer.from(roleDescriptor(TARGET_UUID, true, true).toString('utf8').replace(
      `uuid="${TARGET_UUID}"`, 'uuid="not-a-uuid"',
    ), 'utf8');
    const malformedRole = projectCapturedAdoptedRightsPair({
      ...base,
      targetDescriptor: capture(malformedRoleXml, malformedRoleIdentity, 'target', 'Roles/Sales.xml'),
      targetRights: fileSide(rightsXml(false), malformedRoleIdentity, 'target', 'Roles/Sales/Ext/Rights.xml'),
    });

    assert.deepStrictEqual(
      [zeroRole.ok, zeroAnchor.ok, malformedAnchor.ok, malformedRole.ok],
      [false, false, false, false],
      'Role UUIDs and ownership anchors reject zero and malformed values',
    );
  });

  test('rechecks base, source, and candidate witnesses at materialization', () => {
    const projected = projectCapturedAdoptedRightsPair(makeInput({
      targetRights: fileSide(rightsXml(false), adoptedIdentity(TARGET_UUID), 'target', 'Roles/Sales/Ext/Rights.xml'),
      sourceRights: fileSide(rightsXml(true), adoptedIdentity(SOURCE_UUID), 'source', 'Roles/Sales/Ext/Rights.xml'),
    }));
    assert.strictEqual(projected.ok, true, projected.ok ? undefined : projected.reason);
    if (!projected.ok) { return; }

    const tamperedRecipe = projected.recipe as typeof projected.recipe & { baseRights: AdoptedSemanticArtifactCapture };
    tamperedRecipe.baseRights.content[0] = 0x20;
    const stale = materializeCapturedAdoptedRightsTarget({ recipe: projected.recipe, mergedLogicalTarget: projected.targetXml });
    assert.strictEqual(stale.ok, false);
    if (!stale.ok) { assert.match(stale.reason, /base|hash|witness|захвачен/u); }

    const fresh = projectCapturedAdoptedRightsPair(makeInput({
      targetRights: fileSide(rightsXml(false), adoptedIdentity(TARGET_UUID), 'target', 'Roles/Sales/Ext/Rights.xml'),
      sourceRights: fileSide(rightsXml(true), adoptedIdentity(SOURCE_UUID), 'source', 'Roles/Sales/Ext/Rights.xml'),
    }));
    assert.strictEqual(fresh.ok, true, fresh.ok ? undefined : fresh.reason);
    if (!fresh.ok) { return; }
    const strippedCaptureWitnesses = materializeCapturedAdoptedRightsTarget({
      recipe: { ...fresh.recipe, requiredWitnesses: [] },
      mergedLogicalTarget: fresh.targetXml,
    });
    assert.strictEqual(strippedCaptureWitnesses.ok, false, 'a recipe cannot drop raw dependency witnesses before writer planning');
    const conflict = materializeCapturedAdoptedRightsTarget({
      recipe: fresh.recipe,
      mergedLogicalTarget: fresh.targetXml,
      candidateWitnesses: [{
        sourceId: 'base', relativePath: 'Roles/Sales/Rights.xml', expectedHash: '0'.repeat(64), kind: 'file',
      }],
    });
    assert.strictEqual(conflict.ok, false, 'same source/path cannot silently replace a captured raw hash');
  });

  test('writes one Rights file and combines Comment with Rights=Extended in one ordered descriptor write', async () => {
    const fixture = await createWriterFixture({ baseRead: false, sourceRightsMissing: false });
    const output = await buildSemanticObjectOutput({
      targetRootPath: fixture.targetRootPath,
      sourceRootPath: fixture.sourceRootPath,
      targetDescriptorRelativePath: 'Roles/Sales.xml',
      row: fixture.row,
      witnesses: [],
      selections: [
        makeRightsSelection(fixture, 'true', 'Read'),
        makeRightsSelection(fixture, 'true', 'Insert'),
        makeCommentSelection(fixture, 'Selected comment'),
      ],
    });
    assert.ok(!('diagnostic' in output), `selected Rights and Comment changes should materialize together: ${'diagnostic' in output ? output.diagnostic.suggestedAction : ''}`);
    if ('diagnostic' in output) { return; }

    const descriptorWrites = output.writes.filter((write) => write.relativePath === 'Roles/Sales.xml');
    const rightsWrites = output.writes.filter((write) => write.relativePath === 'Roles/Sales/Ext/Rights.xml');
    assert.strictEqual(descriptorWrites.length, 1, 'the descriptor scalar patch and Extended state share one physical write');
    assert.strictEqual(rightsWrites.length, 1, 'all selected Rights patches are encoded in one physical Rights.xml write');
    assert.strictEqual(new Set(output.outputRelativePaths).size, output.outputRelativePaths.length);

    const descriptor = descriptorWrites[0]!.content.toString('utf8');
    assert.match(descriptor, /<Comment>Selected comment<\/Comment>/u);
    assert.match(descriptor, /<xr:Property>Rights<\/xr:Property><xr:State>Extended<\/xr:State>/u);
    assert.match(descriptor, /<xr:GeneratedType\b/u, 'existing InternalInfo children survive the state update');
    assert.ok(descriptor.indexOf('<InternalInfo>') < descriptor.indexOf('<Properties>'),
      'native descriptor order places InternalInfo before Properties');

    const rights = rightsWrites[0]!.content.toString('utf8');
    assert.match(rights, /<setForNewObjects>false<\/setForNewObjects>/u,
      'the new physical file keeps the captured base policy');
    assert.match(rights, /<right><name>Read<\/name><value>true<\/value><\/right>/u);
    assert.match(rights, /<right><name>Insert<\/name><value>true<\/value><\/right>/u,
      'multiple selected logical patches are encoded into the same Rights file');
    assert.ok(rightsWrites[0]!.sourceWitnesses.some((witness) => witness.sourceId === 'target'
      && witness.relativePath === 'Roles/Sales/Ext/Rights.xml'
      && witness.expectedHash === MISSING_TARGET_HASH && witness.kind === 'file'),
    'creation retains a physical missing-path CAS witness');
  });

  test('adds Rights state in the MDClasses namespace without moving foreign InternalInfo or inheriting a shadowed xr prefix', async () => {
    const fixture = await createWriterFixture({
      baseRead: false,
      sourceRightsMissing: false,
      targetDescriptorOverride: prefixedRoleDescriptorWithForeignInternalInfo(TARGET_UUID),
    });
    const output = await buildSemanticObjectOutput({
      targetRootPath: fixture.targetRootPath,
      sourceRootPath: fixture.sourceRootPath,
      targetDescriptorRelativePath: 'Roles/Sales.xml',
      row: fixture.row,
      witnesses: [],
      selections: [makeRightsSelection(fixture, 'true')],
    });

    assert.ok(!('diagnostic' in output), `prefixed Role descriptor should accept the Rights state: ${'diagnostic' in output ? output.diagnostic.suggestedAction : ''}`);
    if ('diagnostic' in output) { return; }
    const descriptorWrite = output.writes.find((write) => write.relativePath === 'Roles/Sales.xml');
    assert.ok(descriptorWrite, 'Rights=Extended updates the target Role descriptor');
    const xml = descriptorWrite!.content.toString('utf8');
    const root = parseXmlDocument(xml).root;
    const role = elementChildren(root).find((element) => element.localName === 'Role');
    assert.ok(role);
    const properties = elementChildren(role!).find((element) => element.localName === 'Properties');
    const internalInfos = elementChildren(role!).filter((element) => element.localName === 'InternalInfo');
    const mdInternalInfo = internalInfos.find((element) => namespaceUriForName(element) === MD);
    const vendorInternalInfo = internalInfos.find((element) => namespaceUriForName(element) === 'urn:vendor');
    assert.ok(mdInternalInfo, 'writer creates a genuine MDClasses InternalInfo');
    assert.ok(vendorInternalInfo, 'foreign InternalInfo remains as an unrelated payload');
    assert.strictEqual(namespaceUriForName(root), MD);
    assert.strictEqual(namespaceUriForName(role!), MD);
    assert.strictEqual(namespaceUriForName(properties!), MD);
    assert.strictEqual(namespaceUriForName(vendorInternalInfo!), 'urn:vendor');
    const vendorPayload = elementChildren(vendorInternalInfo!).find((element) => element.localName === 'Payload');
    assert.ok(vendorPayload);
    assert.strictEqual(textContent(vendorPayload!).trim(), 'preserve me');

    const rightsState = elementChildren(mdInternalInfo!).find((element) => element.localName === 'PropertyState');
    assert.ok(rightsState);
    assert.strictEqual(namespaceUriForName(rightsState!), READABLE, 'the shadowed xr prefix does not change PropertyState namespace');
    const property = elementChildren(rightsState!).find((element) => element.localName === 'Property');
    const state = elementChildren(rightsState!).find((element) => element.localName === 'State');
    assert.strictEqual(namespaceUriForName(property!), READABLE);
    assert.strictEqual(namespaceUriForName(state!), READABLE);
    assert.strictEqual(textContent(property!).trim(), 'Rights');
    assert.strictEqual(textContent(state!).trim(), 'Extended');

    assert.ok(role!.children.indexOf(mdInternalInfo!) < role!.children.indexOf(properties!),
      'the actual MDClasses InternalInfo is before Properties');
    assert.ok(role!.children.indexOf(properties!) < role!.children.indexOf(vendorInternalInfo!),
      'the foreign InternalInfo remains in its original position after Properties');
  });

  test('writes an adapter-selected right when adopted source inherits the own base and has no physical Rights.xml', async () => {
    const fixture = await createWriterFixture({ baseRead: true, sourceRightsMissing: true, targetRightsPresent: true });
    const adapterResult = await roleRightsXmlAdapter.compare(makeRoleRightsAdapterInput(fixture));
    const readNode = collectTreeNodes(adapterResult.nodes).find((node) => node.payloadRef?.includes('rights-right%3Dread'));
    assert.ok(readNode, 'logical target false and inherited source true expose a selectable Read patch');
    const candidateFactory = adapterResult.candidateFactories.get(readNode!.id);
    assert.ok(candidateFactory, 'the real Rights adapter supplies the executable candidate factory');

    const output = await buildSemanticObjectOutput({
      targetRootPath: fixture.targetRootPath,
      sourceRootPath: fixture.sourceRootPath,
      targetDescriptorRelativePath: 'Roles/Sales.xml',
      row: fixture.row,
      witnesses: [],
      selections: [{
        nodeId: readNode!.id,
        rowId: fixture.row.id,
        kind: 'roleRightsXml',
        targetRelativePath: fixture.recipe.targetRightsRelativePath,
        sourceRelativePath: fixture.recipe.sourceRightsRelativePath,
        targetHash: fixture.recipe.targetRights.kind === 'file'
          ? fixture.recipe.targetRights.capture.witness.expectedHash : MISSING_TARGET_HASH,
        sourceHash: fixture.recipe.sourceRights.kind === 'file'
          ? fixture.recipe.sourceRights.capture.witness.expectedHash : MISSING_TARGET_HASH,
        candidateFactory: candidateFactory!,
        adoptedRights: fixture.recipe,
      } as ExtensionSemanticSelection & { readonly adoptedRights: CapturedAdoptedRightsRecipe }],
    });

    assert.ok(!('diagnostic' in output), `real adapter candidate should translate the projected source witness: ${'diagnostic' in output ? output.diagnostic.suggestedAction : ''}`);
    if ('diagnostic' in output) { return; }
    const rightsWrite = output.writes.find((write) => write.relativePath === fixture.recipe.targetRightsRelativePath);
    assert.ok(rightsWrite, 'the selected patch is encoded into the target physical Rights file');
    assert.ok(rightsWrite!.sourceWitnesses.some((witness) => witness.sourceId === 'source'
      && witness.relativePath === fixture.recipe.sourceRightsRelativePath
      && witness.expectedHash === MISSING_TARGET_HASH && witness.kind === 'file'),
    'the source is guarded by its raw missing witness rather than a logical projection hash');
  });

  test('binds adopted Rights paths with host-appropriate case sensitivity', async () => {
    const output = await withPlatform('linux', async () => {
      const fixture = await createWriterFixture({ baseRead: false, sourceRightsMissing: false });
      const caseAlias = fixture.recipe.targetRightsRelativePath.replace('Roles/', 'roles/');
      return buildSemanticObjectOutput({
        targetRootPath: fixture.targetRootPath,
        sourceRootPath: fixture.sourceRootPath,
        targetDescriptorRelativePath: 'Roles/Sales.xml',
        row: fixture.row,
        witnesses: [],
        selections: [makeRightsSelectionAtPath(fixture, caseAlias)],
      });
    });
    assert.ok('diagnostic' in output, 'Linux must reject a case-different target path even when the candidate URI uses that alias');
  });

  test('preserves case-distinct dependency files on Linux and deduplicates or rejects Windows aliases', async () => {
    const makeInputWitnesses = (conflict: boolean): MergeFileWitness[] => [
      { sourceId: 'source', relativePath: 'Extra/Dependency.xml', expectedHash: 'a'.repeat(64), kind: 'file' },
      { sourceId: 'source', relativePath: 'extra/dependency.xml', expectedHash: conflict ? 'b'.repeat(64) : 'a'.repeat(64), kind: 'file' },
    ];
    const buildWithWitnesses = async (platform: NodeJS.Platform, conflict: boolean) => withPlatform(platform, async () => {
      const fixture = await createWriterFixture({ baseRead: false, sourceRightsMissing: false });
      return buildSemanticObjectOutput({
        targetRootPath: fixture.targetRootPath,
        sourceRootPath: fixture.sourceRootPath,
        targetDescriptorRelativePath: 'Roles/Sales.xml',
        row: fixture.row,
        witnesses: makeInputWitnesses(conflict),
        selections: [makeRightsSelection(fixture, 'true')],
      });
    });

    const linuxOutput = await buildWithWitnesses('linux', true);
    assert.ok(!('diagnostic' in linuxOutput), 'case-distinct paths remain independent on Linux');
    if ('diagnostic' in linuxOutput) { return; }
    const linuxRightsWrite = linuxOutput.writes.find((write) => write.relativePath === 'Roles/Sales/Ext/Rights.xml');
    assert.ok(linuxRightsWrite);
    assert.strictEqual(linuxRightsWrite!.sourceWitnesses.filter((witness) => witness.sourceId === 'source'
      && witness.relativePath.toLowerCase().includes('extra')).length, 2,
    'both case-distinct dependency file witnesses survive the writer');

    const windowsDeduped = await buildWithWitnesses('win32', false);
    assert.ok(!('diagnostic' in windowsDeduped), 'identical Windows case aliases deduplicate');
    if (!('diagnostic' in windowsDeduped)) {
      const write = windowsDeduped.writes.find((candidate) => candidate.relativePath === 'Roles/Sales/Ext/Rights.xml');
      assert.strictEqual(write?.sourceWitnesses.filter((witness) => witness.sourceId === 'source'
        && witness.relativePath.toLowerCase().includes('extra')).length, 1);
    }

    const windowsConflict = await buildWithWitnesses('win32', true);
    assert.ok('diagnostic' in windowsConflict, 'conflicting hashes for Windows case aliases fail closed');
  });

  test('revalidates stale physical Rights and missing-path witnesses before returning a writer preview', async () => {
    for (const stale of ['source-rights', 'base-rights', 'target-missing'] as const) {
      const fixture = await createWriterFixture({ baseRead: false, sourceRightsMissing: false });
      const stalePath = stale === 'source-rights'
        ? path.join(fixture.sourceRootPath, 'Roles/Sales/Ext/Rights.xml')
        : stale === 'base-rights'
          ? path.join(fixture.baseRootPath, 'Roles/Sales/Rights.xml')
          : path.join(fixture.targetRootPath, 'Roles/Sales/Ext/Rights.xml');
      const changed = stale === 'base-rights' ? rightsXml(true) : rightsXml(false);
      await fs.mkdir(path.dirname(stalePath), { recursive: true });
      await fs.writeFile(stalePath, changed);
      const output = await buildSemanticObjectOutput({
        targetRootPath: fixture.targetRootPath,
        sourceRootPath: fixture.sourceRootPath,
        targetDescriptorRelativePath: 'Roles/Sales.xml',
        row: fixture.row,
        witnesses: [],
        selections: [makeRightsSelection(fixture, 'true')],
      });
      assert.ok('diagnostic' in output, `${stale}: stale raw file or missing witness must fail before preview`);
      if ('diagnostic' in output) { assert.match(output.diagnostic.suggestedAction ?? '', /Rights|измен|появ/u); }
    }
  });

  test('does not emit a Rights file or descriptor state for a logical no-op', async () => {
    const fixture = await createWriterFixture({ baseRead: true, sourceRightsMissing: true });
    const targetRightsPath = path.join(fixture.targetRootPath, 'Roles/Sales/Ext/Rights.xml');
    const output = await buildSemanticObjectOutput({
      targetRootPath: fixture.targetRootPath,
      sourceRootPath: fixture.sourceRootPath,
      targetDescriptorRelativePath: 'Roles/Sales.xml',
      row: fixture.row,
      witnesses: [],
      selections: [makeRightsSelection(fixture, 'true')],
    });
    assert.ok('diagnostic' in output, 'a selected no-op has no write plan');
    assert.ok(!await exists(targetRightsPath), 'the missing physical file stays missing');
  });
});

function makeInput(input: {
  targetRights: CapturedAdoptedRightsSide;
  sourceRights: CapturedAdoptedRightsSide;
}): Parameters<typeof projectCapturedAdoptedRightsPair>[0] {
  return {
    direction: 'adopted-to-adopted',
    formatVersion: '2.20',
    targetDescriptor: capture(roleDescriptor(TARGET_UUID, true, true), adoptedIdentity(TARGET_UUID), 'target', 'Roles/Sales.xml'),
    sourceDescriptor: capture(roleDescriptor(SOURCE_UUID, true, input.sourceRights.kind === 'file'), adoptedIdentity(SOURCE_UUID), 'source', 'Roles/Sales.xml'),
    baseDescriptor: capture(roleDescriptor(BASE_UUID, false, false), ownIdentity(), 'base', 'Roles/Sales.xml'),
    baseRights: capture(rightsXml(true), ownIdentity(), 'base', 'Roles/Sales/Rights.xml'),
    targetRights: input.targetRights,
    sourceRights: input.sourceRights,
    configurationWitnesses: [
      fileWitness('target', 'Configuration.xml', Buffer.from('target configuration')),
      fileWitness('source', 'Configuration.xml', Buffer.from('source configuration')),
      fileWitness('base', 'Configuration.xml', Buffer.from('base configuration')),
    ],
    additionalBaseWitnesses: [],
  };
}

function roleDescriptor(uuid: string, adopted: boolean, rightsExtended: boolean): Buffer {
  const markers = adopted
    ? `<ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>${BASE_UUID}</ExtendedConfigurationObject>`
    : '';
  const rightsState = rightsExtended
    ? `<xr:PropertyState><xr:Property>Rights</xr:Property><xr:State>Extended</xr:State></xr:PropertyState>`
    : '';
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="${MD}" xmlns:xr="${READABLE}" version="2.20"><Role uuid="${uuid}"><Properties><Name>Sales</Name>${markers}</Properties><InternalInfo><xr:GeneratedType name="RoleRef" uuid="${BASE_UUID}"/>${rightsState}</InternalInfo><ChildObjects/></Role></MetaDataObject>`, 'utf8');
}

function prefixedRoleDescriptorWithForeignInternalInfo(uuid: string): Buffer {
  const xml = roleDescriptor(uuid, true, false).toString('utf8')
    .replace(`<MetaDataObject xmlns="${MD}" xmlns:xr="${READABLE}"`, `<md:MetaDataObject xmlns:md="${MD}" xmlns:xr="urn:shadowed-xr" xmlns:vendor="urn:vendor"`)
    .replace('<Role uuid=', '<md:Role uuid=')
    .replace('</Role>', '</md:Role>')
    .replace('<InternalInfo><xr:GeneratedType name="RoleRef" uuid="' + BASE_UUID + '"/></InternalInfo>',
      '<vendor:InternalInfo><vendor:Payload>preserve me</vendor:Payload></vendor:InternalInfo>')
    .replace(/<Properties>/gu, '<md:Properties>')
    .replace(/<\/Properties>/gu, '</md:Properties>')
    .replace(/<Name>/gu, '<md:Name>')
    .replace(/<\/Name>/gu, '</md:Name>')
    .replace(/<ObjectBelonging>/gu, '<md:ObjectBelonging>')
    .replace(/<\/ObjectBelonging>/gu, '</md:ObjectBelonging>')
    .replace(/<ExtendedConfigurationObject>/gu, '<md:ExtendedConfigurationObject>')
    .replace(/<\/ExtendedConfigurationObject>/gu, '</md:ExtendedConfigurationObject>')
    .replace('<ChildObjects/>', '<md:ChildObjects/>')
    .replace('</MetaDataObject>', '</md:MetaDataObject>');
  return Buffer.from(xml, 'utf8');
}

function rightsXml(read: boolean): Buffer {
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Rights xmlns="${RIGHTS}" version="2.20"><setForNewObjects>false</setForNewObjects><setForAttributesByDefault>false</setForAttributesByDefault><independentRightsOfChildObjects>false</independentRightsOfChildObjects><object><name>Catalog.Products</name><right><name>Read</name><value>${read}</value></right></object></Rights>`, 'utf8');
}

function ownIdentity(): AdoptedDesignerIdentity {
  return { ownership: 'own', type: 'Role', name: 'Sales', uuid: BASE_UUID };
}

function adoptedIdentity(uuid: string): AdoptedDesignerIdentity {
  return { ownership: 'adopted', type: 'Role', name: 'Sales', uuid, sourceUuid: BASE_UUID };
}

function capture(content: Buffer, identity: AdoptedDesignerIdentity, sourceId: string, relativePath: string): AdoptedSemanticArtifactCapture {
  return { content, identity, witness: fileWitness(sourceId, relativePath, content) };
}

function fileSide(content: Buffer, identity: AdoptedDesignerIdentity, sourceId: string, relativePath: string): CapturedAdoptedRightsSide {
  return { kind: 'file', capture: capture(content, identity, sourceId, relativePath) };
}

function missingSide(sourceId: string, relativePath: string): CapturedAdoptedRightsSide {
  return { kind: 'missing', witness: { kind: 'file', sourceId, relativePath, expectedHash: MISSING_TARGET_HASH } };
}

function fileWitness(sourceId: string, relativePath: string, content: Buffer): MergeFileWitness {
  return { kind: 'file', sourceId, relativePath, expectedHash: hash(content) };
}

function hash(content: Buffer): string { return createHash('sha256').update(content).digest('hex'); }

let writerFixtureSequence = 0;

interface RightsWriterFixture {
  readonly targetRootPath: string;
  readonly sourceRootPath: string;
  readonly baseRootPath: string;
  readonly targetDescriptor: Buffer;
  readonly sourceDescriptor: Buffer;
  readonly recipe: CapturedAdoptedRightsRecipe;
  readonly row: ExtensionTransferRow;
}

async function createWriterFixture(options: {
  readonly baseRead: boolean;
  readonly sourceRightsMissing: boolean;
  readonly targetRightsPresent?: boolean;
  readonly targetDescriptorOverride?: Buffer;
}): Promise<RightsWriterFixture> {
  const outputRoot = path.resolve(process.cwd(), `.tmp-issue335-rights-writer-${process.pid}-${Date.now()}-${writerFixtureSequence++}`);
  const targetRootPath = path.join(outputRoot, 'target');
  const sourceRootPath = path.join(outputRoot, 'source');
  const baseRootPath = path.join(outputRoot, 'base');
  const targetDescriptor = options.targetDescriptorOverride
    ?? withComment(roleDescriptor(TARGET_UUID, true, options.targetRightsPresent ?? false), 'Original target');
  const sourceDescriptor = withComment(roleDescriptor(SOURCE_UUID, true, !options.sourceRightsMissing), 'Incoming source');
  const baseDescriptor = roleDescriptor(BASE_UUID, false, false);
  const baseRights = writerRightsXml(options.baseRead, false);
  const sourceRights = writerRightsXml(true, true);
  const configurationContents = new Map([
    ['target', Buffer.from('target configuration')],
    ['source', Buffer.from('source configuration')],
    ['base', Buffer.from('base configuration')],
  ]);

  await Promise.all([targetRootPath, sourceRootPath, baseRootPath].map((rootPath) => fs.mkdir(rootPath, { recursive: true })));
  await writeRelative(targetRootPath, 'Configuration.xml', configurationContents.get('target')!);
  await writeRelative(sourceRootPath, 'Configuration.xml', configurationContents.get('source')!);
  await writeRelative(baseRootPath, 'Configuration.xml', configurationContents.get('base')!);
  await writeRelative(targetRootPath, 'Roles/Sales.xml', targetDescriptor);
  await writeRelative(sourceRootPath, 'Roles/Sales.xml', sourceDescriptor);
  await writeRelative(baseRootPath, 'Roles/Sales.xml', baseDescriptor);
  await writeRelative(baseRootPath, 'Roles/Sales/Rights.xml', baseRights);
  if (options.targetRightsPresent) {
    await writeRelative(targetRootPath, 'Roles/Sales/Ext/Rights.xml', writerRightsXml(false, false));
  }
  if (!options.sourceRightsMissing) {
    await writeRelative(sourceRootPath, 'Roles/Sales/Ext/Rights.xml', sourceRights);
  }

  const targetRights: CapturedAdoptedRightsSide = options.targetRightsPresent
    ? fileSide(writerRightsXml(false, false), adoptedIdentity(TARGET_UUID), 'target', 'Roles/Sales/Ext/Rights.xml')
    : missingSide('target', 'Roles/Sales/Ext/Rights.xml');
  const sourceRightsSide: CapturedAdoptedRightsSide = options.sourceRightsMissing
    ? missingSide('source', 'Roles/Sales/Ext/Rights.xml')
    : fileSide(sourceRights, adoptedIdentity(SOURCE_UUID), 'source', 'Roles/Sales/Ext/Rights.xml');
  const configurationWitnesses = [...configurationContents].map(([sourceId, content]) => fileWitness(sourceId, 'Configuration.xml', content));
  const projected = projectCapturedAdoptedRightsPair({
    direction: 'adopted-to-adopted',
    formatVersion: '2.20',
    targetDescriptor: capture(targetDescriptor, adoptedIdentity(TARGET_UUID), 'target', 'Roles/Sales.xml'),
    sourceDescriptor: capture(sourceDescriptor, adoptedIdentity(SOURCE_UUID), 'source', 'Roles/Sales.xml'),
    baseDescriptor: capture(baseDescriptor, ownIdentity(), 'base', 'Roles/Sales.xml'),
    baseRights: capture(baseRights, ownIdentity(), 'base', 'Roles/Sales/Rights.xml'),
    targetRights,
    sourceRights: sourceRightsSide,
    configurationWitnesses,
    additionalBaseWitnesses: [],
  });
  if (!projected.ok) { throw new Error(projected.reason); }

  const targetObject = indexedObject('left', 'target', targetDescriptor);
  const sourceObject = indexedObject('right', 'source', sourceDescriptor);
  const targetRoot = metadataIndex(targetRootPath, 'target', 'left', targetObject);
  const sourceRoot = metadataIndex(sourceRootPath, 'source', 'right', sourceObject);
  const baseObject = indexedObject('left', 'base', baseDescriptor);
  const baseRoot = metadataIndex(baseRootPath, 'base', 'left', baseObject);
  return {
    targetRootPath,
    sourceRootPath,
    baseRootPath,
    targetDescriptor,
    sourceDescriptor,
    recipe: projected.recipe,
    row: {
      id: 'role:sales',
      qualifiedName: 'Role.Sales',
      status: 'changed',
      target: targetObject,
      incoming: sourceObject,
      targetRoot,
      incomingRoot: sourceRoot,
      targetBase: baseRoot,
      incomingBase: baseRoot,
      action: 'overlay-adopted',
      mergeable: true,
      sameProvenBase: true,
    },
  };
}

function indexedObject(side: 'left' | 'right', sourceId: string, descriptorContent: Buffer): ExtensionIndexedObject {
  return {
    side,
    sourceId,
    metadataType: 'Role',
    name: 'Sales',
    qualifiedName: 'Role.Sales',
    descriptorRelativePath: 'Roles/Sales.xml',
    descriptorRootTag: 'Role',
    descriptorContent,
    descriptorHash: hash(descriptorContent),
    sidecarFiles: [],
    supportedRootType: true,
    valid: true,
  };
}

function metadataIndex(rootPath: string, sourceId: string, side: 'left' | 'right', object: ExtensionIndexedObject): ExtensionMetadataIndex {
  const configurationContent = Buffer.from(`${sourceId} configuration`);
  return {
    rootPath,
    canonicalRootPath: rootPath,
    sourceId,
    side,
    rootKind: 'cfe',
    hasConfigurationXml: true,
    configurationContent,
    configurationHash: hash(configurationContent),
    formatVersion: '2.20',
    objects: [object],
    diagnostics: [],
    cfeMarkerSeen: true,
  };
}

function makeRoleRightsAdapterInput(fixture: RightsWriterFixture): AdapterCompareInput {
  const targetRightsPath = path.join(fixture.targetRootPath, fixture.recipe.targetRightsRelativePath);
  const sourceRightsPath = path.join(fixture.sourceRootPath, fixture.recipe.sourceRightsRelativePath);
  const targetDescriptorPath = path.join(fixture.targetRootPath, fixture.recipe.targetDescriptorRelativePath);
  const sourceDescriptorPath = path.join(fixture.sourceRootPath, fixture.recipe.sourceDescriptor.witness.relativePath);
  const session = CompareSession.create({
    sessionId: 'adopted-rights-writer-adapter',
    createdAt: '2026-10-31T10:00:00.000Z',
    sources: [
      { sourceId: 'target', side: 'left', kind: 'workspace', displayName: 'Target', rootUri: pathToFileURL(fixture.targetRootPath).toString(), writable: true },
      { sourceId: 'source', side: 'right', kind: 'file', displayName: 'Source', rootUri: pathToFileURL(fixture.sourceRootPath).toString(), writable: false },
    ],
  });
  session.registerSnapshot({
    snapshotId: 'adopted-rights-target', sourceId: 'target', snapshotRoot: 'file:///target', origin: 'file:///target',
    createdAt: '2026-10-31T10:00:00.000Z', retentionUntil: '2026-10-31T12:00:00.000Z', sourceRevision: 'target',
    readOnly: false, cleanupPolicy: 'manual', contentHash: 'target',
  });
  session.registerSnapshot({
    snapshotId: 'adopted-rights-source', sourceId: 'source', snapshotRoot: 'file:///source', origin: 'file:///source',
    createdAt: '2026-10-31T10:00:00.000Z', retentionUntil: '2026-10-31T12:00:00.000Z', sourceRevision: 'source',
    readOnly: true, cleanupPolicy: 'manual', contentHash: 'source',
  });
  const roleUnit = (objectId: string, descriptorPath: string) => ({
    objectId, qualifiedName: 'Role.Sales', metadataType: 'Role', descriptorPath, containerPath: path.join(path.dirname(descriptorPath), 'Sales'),
  });
  return {
    strategy: 'full',
    leftInventory: { rootPath: fixture.targetRootPath, objects: [], artifactsByObjectId: new Map() },
    rightInventory: { rootPath: fixture.sourceRootPath, objects: [], artifactsByObjectId: new Map() },
    match: { left: roleUnit('target-role', targetDescriptorPath), right: roleUnit('source-role', sourceDescriptorPath) },
    artifactPaths: { left: targetRightsPath, right: sourceRightsPath },
    semanticValidationContext: { availableMetadataReferences: ['Catalog.Products'] },
    session,
    snapshots: {
      left: fixture.recipe.initialLogicalTarget.toString('utf8'),
      right: fixture.recipe.initialLogicalSource.toString('utf8'),
    },
  };
}

function collectTreeNodes(nodes: readonly CompareTreeNode[]): CompareTreeNode[] {
  return nodes.flatMap((node) => [node, ...collectTreeNodes(node.children)]);
}

function makeRightsSelection(
  fixture: RightsWriterFixture,
  value: string,
  rightName = 'Read',
): ExtensionSemanticSelection & { readonly adoptedRights: CapturedAdoptedRightsRecipe } {
  const logicalTarget = fixture.recipe.initialLogicalTarget.toString('utf8');
  const valueElement = rightsValueElement(logicalTarget, 'Catalog.Products', rightName);
  const replacementXml = `<value>${value}</value>`;
  const targetUri = pathToFileURL(path.resolve(fixture.targetRootPath, fixture.recipe.targetRightsRelativePath)).toString();
  const sourceWitness = fixture.recipe.sourceRights.kind === 'file'
    ? fixture.recipe.sourceRights.capture.witness
    : fixture.recipe.sourceRights.witness;
  const patch: XmlPatchPayload = {
    kind: 'replaceNode',
    target: buildXmlAddress(targetUri, valueElement),
    expectedOldHash: hashXmlText(logicalTarget),
    newHash: hashXmlText(replacementXml),
    replacementXml,
    semanticKind: 'roleRightsXml',
    semanticContext: { availableMetadataReferences: ['Catalog.Products'] },
    sourceWitnesses: [sourceWitness],
  };
  return {
    nodeId: `role-rights-${rightName.toLowerCase()}`,
    rowId: fixture.row.id,
    kind: 'roleRightsXml',
    targetRelativePath: fixture.recipe.targetRightsRelativePath,
    sourceRelativePath: fixture.recipe.sourceRightsRelativePath,
    targetHash: fixture.recipe.targetRights.kind === 'file' ? fixture.recipe.targetRights.capture.witness.expectedHash : MISSING_TARGET_HASH,
    sourceHash: sourceWitness.expectedHash,
    candidateFactory: makeCandidateFactory(`role-rights-${rightName.toLowerCase()}`, targetUri, patch),
    adoptedRights: fixture.recipe,
  };
}

function makeRightsSelectionAtPath(
  fixture: RightsWriterFixture,
  targetRelativePath: string,
): ExtensionSemanticSelection & { readonly adoptedRights: CapturedAdoptedRightsRecipe } {
  const selection = makeRightsSelection(fixture, 'true');
  return {
    ...selection,
    targetRelativePath,
    candidateFactory: async () => {
      const result = await selection.candidateFactory();
      if (!result.ok || !result.candidate.xmlPatch) { return result; }
      const targetUri = pathToFileURL(path.resolve(fixture.targetRootPath, targetRelativePath)).toString();
      return {
        ok: true,
        candidate: {
          ...result.candidate,
          targetUri,
          xmlPatch: { ...result.candidate.xmlPatch, target: { ...result.candidate.xmlPatch.target, filePath: targetUri } },
        },
      };
    },
  };
}

function makeCommentSelection(fixture: RightsWriterFixture, comment: string): ExtensionSemanticSelection {
  const commentElement = namedDirectElement(parseXmlDocument(fixture.targetDescriptor.toString('utf8')).root, 'Role', 'Comment');
  const replacementXml = `<Comment>${comment}</Comment>`;
  const targetUri = pathToFileURL(path.resolve(fixture.targetRootPath, 'Roles/Sales.xml')).toString();
  const patch: XmlPatchPayload = {
    kind: 'replaceNode',
    target: buildXmlAddress(targetUri, commentElement),
    expectedOldHash: hashXmlText(fixture.targetDescriptor.toString('utf8')),
    newHash: hashXmlText(replacementXml),
    replacementXml,
    semanticKind: 'metadataXml',
  };
  return {
    nodeId: 'role-comment',
    rowId: fixture.row.id,
    kind: 'metadataXml',
    targetRelativePath: 'Roles/Sales.xml',
    sourceRelativePath: 'Roles/Sales.xml',
    targetHash: hash(fixture.targetDescriptor),
    sourceHash: hash(fixture.sourceDescriptor),
    candidateFactory: makeCandidateFactory('role-comment', targetUri, patch),
  };
}

function makeCandidateFactory(
  nodeId: string,
  targetUri: string,
  patch: XmlPatchPayload,
): ExtensionSemanticSelection['candidateFactory'] {
  const candidate: MergeCandidate = {
    kind: 'xmlNodeReplace',
    sourceId: 'source',
    snapshotId: 'rights-writer-test',
    nodeId,
    targetUri,
    xmlPatch: patch,
  };
  return async () => ({ ok: true, candidate });
}

function rightsValueElement(xml: string, objectName: string, rightName: string): XmlElement {
  const document = parseXmlDocument(xml);
  const object = elementChildren(document.root).find((element) => element.localName === 'object'
    && directText(element, 'name') === objectName);
  assert.ok(object, `Expected Rights object ${objectName}.`);
  const right = elementChildren(object!).find((element) => element.localName === 'right'
    && directText(element, 'name') === rightName);
  assert.ok(right, `Expected Rights right ${rightName}.`);
  const value = elementChildren(right!).find((element) => element.localName === 'value');
  assert.ok(value, `Expected Rights value ${rightName}.`);
  return value!;
}

function namedDirectElement(root: XmlElement, parentName: string, childName: string): XmlElement {
  const parent = elementChildren(root).find((element) => element.localName === parentName);
  assert.ok(parent, `Expected ${parentName}.`);
  const properties = elementChildren(parent!).find((element) => element.localName === 'Properties');
  assert.ok(properties, `Expected ${parentName}/Properties.`);
  const child = elementChildren(properties!).find((element) => element.localName === childName);
  assert.ok(child, `Expected ${parentName}/Properties/${childName}.`);
  return child!;
}

function directText(parent: XmlElement, name: string): string | undefined {
  const child = elementChildren(parent).find((element) => element.localName === name);
  return child ? textContent(child).trim() : undefined;
}

function withComment(xml: Buffer, comment: string): Buffer {
  return Buffer.from(xml.toString('utf8').replace('<Name>Sales</Name>', `<Name>Sales</Name><Comment>${comment}</Comment>`), 'utf8');
}

function writerRightsXml(read: boolean, write: boolean): Buffer {
  return Buffer.from(rightsXml(read).toString('utf8')
    .replace('</object>', `<right><name>Insert</name><value>${write}</value></right></object>`), 'utf8');
}

async function writeRelative(rootPath: string, relativePath: string, content: Buffer): Promise<void> {
  const filePath = path.join(rootPath, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

async function exists(filePath: string): Promise<boolean> {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function withPlatform<T>(platform: NodeJS.Platform, callback: () => T | Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try { return await callback(); }
  finally { Object.defineProperty(process, 'platform', original); }
}
