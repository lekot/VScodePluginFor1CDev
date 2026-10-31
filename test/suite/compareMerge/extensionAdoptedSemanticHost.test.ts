import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';

import {
  createExtensionAdoptedUuidSnapshot,
  materializeExtensionAdoptedPatchBatch,
  prepareExtensionAdoptedSemanticRow,
} from '../../../src/compareMerge/extensions/extensionAdoptedSemanticHost';
import { analyzeExtensionTransfers } from '../../../src/compareMerge/extensions/extensionTransfer';
import { createAdoptedDesignerTypeIdResolver } from '../../../src/compareMerge/extensions/adoptedDesignerTypeId';
import { parseCfeObjectIdentity } from '../../../src/extensionSupport/cfeProject/ownership';
import { buildXmlAddress, elementChildren, parseXmlDocument, type XmlElement } from '../../../src/compareMerge/xml/xmlDom';
import { hashXmlText } from '../../../src/compareMerge/xml/xmlPatch';
import { MISSING_TARGET_HASH, type XmlPatchPayload } from '../../../src/compareMerge/merge/mergePreview';
import type { ExtensionIndexedObject, ExtensionMetadataIndex } from '../../../src/compareMerge/extensions/extensionMetadataIndex';
import type { ExtensionTransferRow } from '../../../src/compareMerge/extensions/extensionTransfer';
import { writeDesignerConfiguration, type ExtensionCompareRootType } from '../../helpers/extensionCompareFixtures';

const MD = 'http://v8.1c.ru/8.3/MDClasses';
const XCF = 'http://v8.1c.ru/8.3/xcf';
const XR = 'http://v8.1c.ru/8.3/xcf/readable';
const FORM = 'http://v8.1c.ru/8.3/xcf/logform';
const BASE_UUID = '11111111-1111-4111-8111-111111111111';
const CFE_UUID = '22222222-2222-4222-8222-222222222222';
const BASE_FORM_UUID = '33333333-3333-4333-8333-333333333333';
const CFE_FORM_UUID = '44444444-4444-4444-8444-444444444444';
const LOCAL_CHILD_UUID = '55555555-5555-4555-8555-555555555555';
const CHILD_UUID = '66666666-6666-4666-8666-666666666666';
const TYPE_ID = '77777777-7777-4777-8777-777777777777';
const CONFIGURATION_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONFIGURATION_NAME = 'Adopted semantic host fixture';

suite('Extension adopted semantic host seam (#335)', () => {
  test('proves adopted-to-adopted granular semantics across separately captured exact bases', async () => withRoots(async (roots) => {
    const sourceBasePath = path.join(roots.parent, 'source-base');
    await fs.mkdir(sourceBasePath, { recursive: true });
    const baseXml = descriptor({ uuid: BASE_UUID, comment: 'Base value' });
    const targetXml = descriptor({ uuid: CFE_UUID, ownership: 'adopted', sourceUuid: BASE_UUID, comment: 'Target override' });
    const sourceXml = descriptor({ uuid: LOCAL_CHILD_UUID, ownership: 'adopted', sourceUuid: BASE_UUID, comment: 'Source override' });
    const targetObject = await indexedObject(roots.target, 'left', 'Catalog', 'Products', 'Catalogs/Products.xml', targetXml);
    const sourceObject = await indexedObject(roots.source, 'right', 'Catalog', 'Products', 'Catalogs/Products.xml', sourceXml);
    const targetBaseObject = await indexedObject(roots.base, 'left', 'Catalog', 'Products', 'Catalogs/Products.xml', baseXml);
    const sourceBaseObject = await indexedObject(sourceBasePath, 'right', 'Catalog', 'Products', 'Catalogs/Products.xml', baseXml);
    const targetRoot = await rootIndex(roots.target, 'target', 'left', 'cfe', [targetObject]);
    const sourceRoot = await rootIndex(roots.source, 'source', 'right', 'cfe', [sourceObject]);
    const targetBase = await rootIndex(roots.base, 'target-base', 'left', 'cf', [targetBaseObject]);
    const sourceBase = await rootIndex(sourceBasePath, 'source-base', 'right', 'cf', [sourceBaseObject]);
    const analysis = await analyzeExtensionTransfers({
      target: targetRoot,
      incoming: sourceRoot,
      targetBase,
      incomingBase: sourceBase,
      targetBaseIsIncoming: false,
      incomingBaseIsTarget: false,
    });
    const row = analysis.rows[0];
    assert.ok(row);
    if (!row) { return; }
    assert.strictEqual(row.sameProvenBase, true, 'the analyzer recognizes the exact common base');
    assert.strictEqual(String(row.semanticAction), 'adopted-cfe-semantic', 'granular semantics have a separate action from whole-row copy');

    const uuidSnapshot = await createExtensionAdoptedUuidSnapshot({ targetRoot, incomingRoot: sourceRoot });
    const prepared = await prepareExtensionAdoptedSemanticRow({ row, targetRoot, incomingRoot: sourceRoot, uuidSnapshot });

    assert.strictEqual(prepared.applicable, true);
    if (!prepared.applicable) { return; }
    assert.strictEqual(String(prepared.direction), 'adopted-to-adopted');
    assert.deepStrictEqual(prepared.blockers, []);
    const artifact = prepared.artifacts.find((item) => item.kind === 'metadataXml');
    assert.ok(artifact?.recipe.kind === 'adopted-descriptor');
    if (!artifact || artifact.recipe.kind !== 'adopted-descriptor') { return; }
    assert.strictEqual(String(artifact.recipe.direction), 'adopted-to-adopted');
    const baseDescriptorWitnessSources = [...artifact.dependencyWitnesses, ...artifact.recipe.requiredWitnesses]
        .filter((witness) => witness.relativePath === targetBaseObject.descriptorRelativePath
          || witness.relativePath === sourceBaseObject.descriptorRelativePath)
        .map((witness) => witness.sourceId);
    assert.ok(baseDescriptorWitnessSources.includes('target-base') && baseDescriptorWitnessSources.includes('source-base'),
      'both base descriptor paths remain raw execution witnesses');
  }));

  test('blocks only nested Form projection when separately captured base Form descriptor or body differs', async () => withRoots(async (roots) => {
    const sourceBasePath = path.join(roots.parent, 'source-base');
    await fs.mkdir(sourceBasePath, { recursive: true });
    for (const mismatch of ['descriptor', 'body'] as const) {
      const baseFormDescriptor = formDescriptor({ uuid: BASE_FORM_UUID });
      const otherBaseFormDescriptor = mismatch === 'descriptor'
        ? Buffer.from(baseFormDescriptor.toString('utf8').replace('</Properties>', '<Comment>Different descriptor</Comment></Properties>'), 'utf8')
        : Buffer.from(baseFormDescriptor);
      const baseFormBody = formXml('Base form');
      const otherBaseFormBody = mismatch === 'body' ? formXml('Different base body') : Buffer.from(baseFormBody);
      const targetObject = await indexedObject(roots.target, 'left', 'Catalog', 'Products', 'Catalogs/Products.xml',
        descriptor({ uuid: CFE_UUID, ownership: 'adopted', sourceUuid: BASE_UUID, forms: ['Main'] }), [
          { relativePath: 'Catalogs/Products/Forms/Main.xml', content: formDescriptor({ uuid: CFE_FORM_UUID, ownership: 'adopted', sourceUuid: BASE_FORM_UUID }) },
          { relativePath: 'Catalogs/Products/Forms/Main/Ext/Form.xml', content: formXml('Target form') },
        ]);
      const sourceObject = await indexedObject(roots.source, 'right', 'Catalog', 'Products', 'Catalogs/Products.xml',
        descriptor({ uuid: LOCAL_CHILD_UUID, ownership: 'adopted', sourceUuid: BASE_UUID, forms: ['Main'] }), [
          { relativePath: 'Catalogs/Products/Forms/Main.xml', content: formDescriptor({ uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ownership: 'adopted', sourceUuid: BASE_FORM_UUID }) },
          { relativePath: 'Catalogs/Products/Forms/Main/Ext/Form.xml', content: formXml('Source form') },
        ]);
      const targetBaseObject = await indexedObject(roots.base, 'left', 'Catalog', 'Products', 'Catalogs/Products.xml',
        descriptor({ uuid: BASE_UUID, forms: ['Main'] }), [
          { relativePath: 'Catalogs/Products/Forms/Main.xml', content: baseFormDescriptor },
          { relativePath: 'Catalogs/Products/Forms/Main/Ext/Form.xml', content: baseFormBody },
        ]);
      const sourceBaseObject = await indexedObject(sourceBasePath, 'right', 'Catalog', 'Products', 'Catalogs/Products.xml',
        descriptor({ uuid: BASE_UUID, forms: ['Main'] }), [
          { relativePath: 'Catalogs/Products/Forms/Main.xml', content: otherBaseFormDescriptor },
          { relativePath: 'Catalogs/Products/Forms/Main/Ext/Form.xml', content: otherBaseFormBody },
        ]);
      const targetRoot = await rootIndex(roots.target, 'target', 'left', 'cfe', [targetObject]);
      const sourceRoot = await rootIndex(roots.source, 'source', 'right', 'cfe', [sourceObject]);
      const targetBase = await rootIndex(roots.base, 'target-base', 'left', 'cf', [targetBaseObject]);
      const sourceBase = await rootIndex(sourceBasePath, 'source-base', 'right', 'cf', [sourceBaseObject]);
      const analysis = await analyzeExtensionTransfers({
        target: targetRoot,
        incoming: sourceRoot,
        targetBase,
        incomingBase: sourceBase,
        targetBaseIsIncoming: false,
        incomingBaseIsTarget: false,
      });
      const row = analysis.rows[0];
      assert.strictEqual(row?.sameProvenBase, true, `${mismatch}: root and owner descriptors still prove a common CF base`);
      assert.strictEqual(row?.semanticAction, 'adopted-cfe-semantic');
      const uuidSnapshot = await createExtensionAdoptedUuidSnapshot({ targetRoot, incomingRoot: sourceRoot });

      const prepared = await prepareExtensionAdoptedSemanticRow({ row: row!, targetRoot, incomingRoot: sourceRoot, uuidSnapshot });

      assert.strictEqual(prepared.applicable, true);
      if (!prepared.applicable) { continue; }
      assert.ok(prepared.artifacts.some((artifact) => artifact.kind === 'metadataXml'), `${mismatch}: root descriptor remains granular`);
      assert.strictEqual(prepared.artifacts.some((artifact) => artifact.kind === 'formXml'), false,
        `${mismatch}: no Form recipe may use a base whose nested identity bytes differ`);
      assert.ok(prepared.blockers.some((blocker) => blocker.kind === 'formXml'
        && /nested Form descriptor\/body hashes различаются/u.test(blocker.reason)),
      `${mismatch}: nested difference remains a scoped Form blocker: ${JSON.stringify(prepared.blockers)}`);
    }
  }));

  test('uses compare-global child UUID allocation and encodes selected CF-to-CFE child edits with raw witnesses', async () => withRoots(async (roots) => {
    const baseXml = descriptor({ uuid: BASE_UUID, comment: 'Base root', children: [dimension('Base child')] });
    const sourceXml = descriptor({ uuid: BASE_UUID, comment: 'Source root', children: [dimension('Updated child')] });
    const targetXml = descriptor({ uuid: CFE_UUID, comment: 'Target root', ownership: 'adopted', sourceUuid: BASE_UUID, children: [] });
    const targetObject = await indexedObject(roots.target, 'left', 'Catalog', 'Products', 'Catalogs/Products.xml', targetXml);
    const sourceObject = await indexedObject(roots.source, 'right', 'Catalog', 'Products', 'Catalogs/Products.xml', sourceXml);
    const baseObject = await indexedObject(roots.base, 'left', 'Catalog', 'Products', 'Catalogs/Products.xml', baseXml);
    const targetRoot = await rootIndex(roots.target, 'target', 'left', 'cfe', [targetObject]);
    const sourceRoot = await rootIndex(roots.source, 'source', 'right', 'cf', [sourceObject]);
    const baseRoot = await rootIndex(roots.base, 'base', 'left', 'cf', [baseObject]);
    const row = transferRow({
      targetRoot, incomingRoot: sourceRoot, target: targetObject, incoming: sourceObject,
      targetBase: baseRoot, targetBaseIsIncoming: true, action: 'overlay-adopted',
    });
    let allocations = 0;
    const uuids = await createExtensionAdoptedUuidSnapshot({ targetRoot, incomingRoot: sourceRoot, allocateUuid: () => { allocations += 1; return LOCAL_CHILD_UUID; } });

    const prepared = await prepareExtensionAdoptedSemanticRow({ row, targetRoot, incomingRoot: sourceRoot, uuidSnapshot: uuids });

    assert.strictEqual(prepared.applicable, true);
    if (!prepared.applicable) { return; }
    assert.deepStrictEqual(prepared.blockers, []);
    const artifact = prepared.artifacts.find((item) => item.kind === 'metadataXml');
    assert.ok(artifact);
    if (!artifact) { return; }
    assert.strictEqual(allocations, 1);
    assert.strictEqual(uuids.childUuidByAnchor.size, 1);
    assert.ok(artifact.recipe.kind === 'adopted-descriptor');
    assert.deepStrictEqual(artifact.recipe.adoptedChildUuidByAnchor, uuids.childUuidByAnchor);
    assert.strictEqual(artifact.targetHash, targetObject.descriptorHash);
    assert.strictEqual(artifact.sourceHash, sourceObject.descriptorHash);
    assert.ok(artifact.recipe.requiredWitnesses.some((witness) => witness.sourceId === 'base' && witness.expectedHash === baseObject.descriptorHash));

    const targetDocument = parseXmlDocument(artifact.recipe.initialLogicalTarget.toString('utf8'));
    const targetDimension = descendant(targetDocument.root, 'Dimension');
    const childComment = targetDimension && descendant(targetDimension, 'Comment');
    assert.ok(targetDimension && childComment, 'the logical target exposes the inherited child while its physical overlay is absent');
    if (!childComment) { return; }
    const dependencyRelativePath = 'Catalogs/Products/Ext/ObjectModule.bsl';
    const dependencyContent = Buffer.from('Procedure SelectedDependency(); EndProcedure', 'utf8');
    await fs.mkdir(path.dirname(path.join(roots.source, dependencyRelativePath)), { recursive: true });
    await fs.writeFile(path.join(roots.source, dependencyRelativePath), dependencyContent);
    const uri = pathToFileURL(artifact.targetFilePath).toString();
    const patch: XmlPatchPayload = {
      kind: 'replaceNode',
      target: buildXmlAddress(uri, childComment),
      semanticKind: 'metadataXml',
      expectedOldHash: hashXmlText(artifact.recipe.initialLogicalTarget.toString('utf8')),
      newHash: hash(Buffer.from('<Comment>Selected child</Comment>')),
      replacementXml: '<Comment>Selected child</Comment>',
      sourceWitnesses: [{
        sourceId: 'target',
        relativePath: artifact.targetRelativePath,
        expectedHash: hash(artifact.recipe.initialLogicalTarget),
        kind: 'file',
      }, {
        sourceId: 'source',
        relativePath: dependencyRelativePath,
        expectedHash: hash(dependencyContent),
        kind: 'file',
      }],
    };
    const result = materializeExtensionAdoptedPatchBatch({ artifact, targetRelativePath: artifact.targetRelativePath, patches: [patch] });

    assert.strictEqual(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok || !result.changed) { return; }
    const physical = result.write.content.toString('utf8');
    assert.match(physical, new RegExp(`<Catalog uuid="${CFE_UUID}"`));
    assert.match(physical, new RegExp(`<Dimension uuid="${LOCAL_CHILD_UUID}"`));
    assert.match(physical, new RegExp(`<ExtendedConfigurationObject>${CHILD_UUID}</ExtendedConfigurationObject>`));
    assert.match(physical, /<Comment(?:\s[^>]*)?>Selected child<\/Comment>/u);
    assert.match(physical, /<xr:GeneratedType name="DimensionRef" category="Ref"><xr:TypeId>[^<]+<\/xr:TypeId><\/xr:GeneratedType>/u);
    assert.strictEqual(result.expectedTargetHash, targetObject.descriptorHash);
    assert.ok(result.write.sourceWitnesses.some((witness) => witness.sourceId === 'base' && witness.expectedHash === baseObject.descriptorHash));
    assert.ok(result.write.sourceWitnesses.every((witness) => witness.expectedHash === MISSING_TARGET_HASH || /^[\da-f]{64}$/iu.test(witness.expectedHash)));
    assert.ok(result.write.sourceWitnesses.some((witness) => witness.sourceId === 'target'
      && witness.relativePath === artifact.targetRelativePath && witness.expectedHash === artifact.targetHash));
    assert.ok(!result.write.sourceWitnesses.some((witness) => witness.sourceId === 'target'
      && witness.relativePath === artifact.targetRelativePath && witness.expectedHash === hash(artifact.recipe.initialLogicalTarget)),
    'logical snapshot hashes must be translated to the captured raw target hash');
    assert.ok(result.write.sourceWitnesses.some((witness) => witness.sourceId === 'source'
      && witness.relativePath === dependencyRelativePath && witness.expectedHash === hash(dependencyContent)),
    'supplemental physical dependency witnesses from selected patches must be preserved');

    const repeated = await prepareExtensionAdoptedSemanticRow({ row, targetRoot, incomingRoot: sourceRoot, uuidSnapshot: uuids });
    assert.strictEqual(repeated.applicable, true);
    if (repeated.applicable) {
      const repeatedRecipe = repeated.artifacts.find((item) => item.kind === 'metadataXml')?.recipe;
      assert.ok(repeatedRecipe?.kind === 'adopted-descriptor');
      if (repeatedRecipe?.kind === 'adopted-descriptor') {
        assert.deepStrictEqual(repeatedRecipe.adoptedChildUuidByAnchor, artifact.recipe.kind === 'adopted-descriptor' ? artifact.recipe.adoptedChildUuidByAnchor : undefined);
      }
    }
    assert.strictEqual(allocations, 1, 'a shared snapshot reuses one allocation across repeated row projection');
  }));

  test('rejects UUID allocation collisions against the captured target registry without retaining partial allocations', async () => withRoots(async (roots) => {
    const secondChildUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const baseXml = descriptor({ uuid: BASE_UUID, children: [
      dimension('First child'),
      dimension('Second child').replace(CHILD_UUID, secondChildUuid).replace('Lines', 'Lines2'),
    ] });
    const targetXml = descriptor({ uuid: CFE_UUID, ownership: 'adopted', sourceUuid: BASE_UUID, children: [] });
    const sourceXml = descriptor({ uuid: BASE_UUID, children: [dimension('Source child')] });
    const targetObject = await indexedObject(roots.target, 'left', 'Catalog', 'Products', 'Catalogs/Products.xml', targetXml);
    const collisionUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const collisionXml = descriptor({ uuid: collisionUuid, name: 'Collision' });
    const collision = await indexedObject(roots.target, 'left', 'Catalog', 'Collision', 'Catalogs/Collision.xml', collisionXml);
    const sourceObject = await indexedObject(roots.source, 'right', 'Catalog', 'Products', 'Catalogs/Products.xml', sourceXml);
    const baseObject = await indexedObject(roots.base, 'left', 'Catalog', 'Products', 'Catalogs/Products.xml', baseXml);
    const targetRoot = await rootIndex(roots.target, 'target', 'left', 'cfe', [targetObject, collision]);
    const sourceRoot = await rootIndex(roots.source, 'source', 'right', 'cf', [sourceObject]);
    const baseRoot = await rootIndex(roots.base, 'base', 'left', 'cf', [baseObject]);
    const row = transferRow({ targetRoot, incomingRoot: sourceRoot, target: targetObject, incoming: sourceObject, targetBase: baseRoot, targetBaseIsIncoming: true, action: 'overlay-adopted' });
    let allocations = 0;
    const uuids = await createExtensionAdoptedUuidSnapshot({ targetRoot, incomingRoot: sourceRoot, allocateUuid: () => {
      allocations += 1;
      return allocations === 1 ? LOCAL_CHILD_UUID : collisionUuid;
    } });
    const reservedBefore = new Set(uuids.reservedTargetUuids);

    const prepared = await prepareExtensionAdoptedSemanticRow({ row, targetRoot, incomingRoot: sourceRoot, uuidSnapshot: uuids });

    assert.strictEqual(prepared.applicable, true);
    if (!prepared.applicable) { return; }
    assert.ok(prepared.blockers.some((blocker) => /уже существует|конфликт/u.test(blocker.reason)));
    assert.strictEqual(prepared.artifacts.some((artifact) => artifact.kind === 'metadataXml'), false);
    assert.strictEqual(allocations, 2);
    assert.strictEqual(uuids.childUuidByAnchor.size, 0, 'a failed batch must not leave a partially allocated anchor map');
    assert.deepStrictEqual(uuids.reservedTargetUuids, reservedBefore, 'a failed batch must not pollute the snapshot registry');
  }));

  test('deduplicates byte-distinct same-owner TypeId captures only when their GeneratedType maps agree', async () => withRoots(async (roots) => {
    const targetXml = descriptor({ uuid: BASE_UUID, comment: 'Base target' });
    const sourceXml = descriptor({ uuid: CFE_UUID, ownership: 'adopted', sourceUuid: BASE_UUID, comment: 'Overlay' });
    const baseXml = descriptor({ uuid: BASE_UUID, comment: 'Base target' });
    const targetObject = await indexedObject(roots.target, 'left', 'Catalog', 'Products', 'Catalogs/Products.xml', targetXml);
    const incomingAdopted = await indexedObject(roots.source, 'right', 'Catalog', 'Products', 'Catalogs/Products.xml', sourceXml);
    const sourceOwnCopyXml = descriptor({ uuid: BASE_UUID, comment: 'Byte-distinct own descriptor' });
    const sourceOwnCopy = await indexedObject(roots.source, 'right', 'Catalog', 'Products', 'Catalogs/Products-copy.xml', sourceOwnCopyXml);
    const baseObject = await indexedObject(roots.base, 'left', 'Catalog', 'Products', 'Catalogs/Products.xml', baseXml);
    const targetRoot = await rootIndex(roots.target, 'target', 'left', 'cf', [targetObject]);
    const sourceRoot = await rootIndex(roots.source, 'source', 'right', 'cfe', [incomingAdopted, sourceOwnCopy]);
    const baseRoot = await rootIndex(roots.base, 'base', 'left', 'cf', [baseObject]);
    const row = transferRow({ targetRoot, incomingRoot: sourceRoot, target: targetObject, incoming: incomingAdopted, incomingBase: baseRoot, incomingBaseIsTarget: true, action: 'adopted-to-cf-overlay' });
    const uuids = await createExtensionAdoptedUuidSnapshot({ targetRoot, incomingRoot: sourceRoot });

    const prepared = await prepareExtensionAdoptedSemanticRow({ row, targetRoot, incomingRoot: sourceRoot, uuidSnapshot: uuids });

    assert.strictEqual(prepared.applicable, true);
    if (!prepared.applicable) { return; }
    const artifact = prepared.artifacts.find((item) => item.kind === 'metadataXml');
    assert.ok(artifact?.recipe.kind === 'adopted-descriptor');
    if (!artifact || artifact.recipe.kind !== 'adopted-descriptor') { return; }
    assert.strictEqual(artifact.recipe.typeIdReferenceDescriptors.length, 1, 'same owner, same identity, and same explicit TypeId→QName map are one resolver context');
    assert.strictEqual(artifact.recipe.typeIdReferenceDescriptors[0]?.provenance, 'proven-base');

    const conflictingXml = descriptor({ uuid: BASE_UUID, generatedName: 'CatalogObject.Products', generatedCategory: 'Object' });
    const conflictCopy = await indexedObject(roots.source, 'right', 'Catalog', 'Products', 'Catalogs/Products-copy.xml', conflictingXml);
    const conflictingRoot = await rootIndex(roots.source, 'source', 'right', 'cfe', [incomingAdopted, conflictCopy]);
    const conflictingRow = transferRow({ targetRoot, incomingRoot: conflictingRoot, target: targetObject, incoming: incomingAdopted, incomingBase: baseRoot, incomingBaseIsTarget: true, action: 'adopted-to-cf-overlay' });
    const conflictPrepared = await prepareExtensionAdoptedSemanticRow({ row: conflictingRow, targetRoot, incomingRoot: conflictingRoot, uuidSnapshot: uuids });
    assert.strictEqual(conflictPrepared.applicable, true);
    if (!conflictPrepared.applicable) { return; }
    const conflictArtifact = conflictPrepared.artifacts.find((item) => item.kind === 'metadataXml');
    assert.ok(conflictArtifact?.recipe.kind === 'adopted-descriptor');
    if (!conflictArtifact || conflictArtifact.recipe.kind !== 'adopted-descriptor') { return; }
    assert.strictEqual(conflictArtifact.recipe.typeIdReferenceDescriptors.length, 2, 'different GeneratedType maps must stay visible to the ambiguity guard');
    const resolver = createAdoptedDesignerTypeIdResolver('2.20', conflictArtifact.recipe.typeIdReferenceDescriptors);
    assert.match(resolver.resolve(TYPE_ID).reason ?? '', /неоднознач/u);
  }));

  test('projects a missing registered CFE Form.xml from captured base bytes and preserves missing-target CAS in the write', async () => withRoots(async (roots) => {
    const targetOwnerXml = descriptor({ uuid: CFE_UUID, ownership: 'adopted', sourceUuid: BASE_UUID, forms: ['Main'] });
    const sourceOwnerXml = descriptor({ uuid: BASE_UUID, forms: ['Main'] });
    const baseOwnerXml = descriptor({ uuid: BASE_UUID, forms: ['Main'] });
    const targetOwner = await indexedObject(roots.target, 'left', 'Catalog', 'Products', 'Catalogs/Products.xml', targetOwnerXml, [
      { relativePath: 'Catalogs/Products/Forms/Main.xml', content: formDescriptor({ uuid: CFE_FORM_UUID, ownership: 'adopted', sourceUuid: BASE_FORM_UUID }) },
    ]);
    const sourceOwner = await indexedObject(roots.source, 'right', 'Catalog', 'Products', 'Catalogs/Products.xml', sourceOwnerXml, [
      { relativePath: 'Catalogs/Products/Forms/Main.xml', content: formDescriptor({ uuid: BASE_FORM_UUID }) },
      { relativePath: 'Catalogs/Products/Forms/Main/Ext/Form.xml', content: formXml('Source CF title') },
    ]);
    const baseOwner = await indexedObject(roots.base, 'left', 'Catalog', 'Products', 'Catalogs/Products.xml', baseOwnerXml, [
      { relativePath: 'Catalogs/Products/Forms/Main.xml', content: formDescriptor({ uuid: BASE_FORM_UUID }) },
      { relativePath: 'Catalogs/Products/Forms/Main/Ext/Form.xml', content: formXml('Captured base title') },
    ]);
    const targetRoot = await rootIndex(roots.target, 'target', 'left', 'cfe', [targetOwner]);
    const sourceRoot = await rootIndex(roots.source, 'source', 'right', 'cf', [sourceOwner]);
    const baseRoot = await rootIndex(roots.base, 'base', 'left', 'cf', [baseOwner]);
    const row = transferRow({ targetRoot, incomingRoot: sourceRoot, target: targetOwner, incoming: sourceOwner, targetBase: baseRoot, targetBaseIsIncoming: true, action: 'overlay-adopted' });
    const uuids = await createExtensionAdoptedUuidSnapshot({ targetRoot, incomingRoot: sourceRoot });

    const prepared = await prepareExtensionAdoptedSemanticRow({ row, targetRoot, incomingRoot: sourceRoot, uuidSnapshot: uuids });

    assert.strictEqual(prepared.applicable, true);
    if (!prepared.applicable) { return; }
    assert.deepStrictEqual(prepared.blockers, []);
    const artifact = prepared.artifacts.find((item) => item.kind === 'formXml');
    assert.ok(artifact?.recipe.kind === 'adopted-form');
    if (!artifact || artifact.recipe.kind !== 'adopted-form') { return; }
    assert.strictEqual(artifact.targetHash, MISSING_TARGET_HASH);
    assert.ok(artifact.recipe.targetWasMissing);
    assert.ok(artifact.targetXml.toString('utf8').includes('Captured base title'));
    assert.ok(artifact.recipe.requiredWitnesses.some((witness) => witness.sourceId === 'target' && witness.relativePath === artifact.targetRelativePath && witness.expectedHash === MISSING_TARGET_HASH));

    const logicalTarget = parseXmlDocument(artifact.recipe.initialLogicalTarget.toString('utf8'));
    const title = descendant(logicalTarget.root, 'Title');
    assert.ok(title);
    if (!title) { return; }
    const patch = replaceElementPatch(artifact, title, '<Title>Selected Form title</Title>');
    const result = materializeExtensionAdoptedPatchBatch({ artifact, targetRelativePath: artifact.targetRelativePath, patches: [patch] });

    assert.strictEqual(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok || !result.changed) { return; }
    assert.strictEqual(result.expectedTargetHash, MISSING_TARGET_HASH);
    assert.ok(result.write.sourceWitnesses.some((witness) => witness.relativePath === artifact.targetRelativePath && witness.expectedHash === MISSING_TARGET_HASH));
    assert.match(result.write.content.toString('utf8'), /Selected Form title/u);
    const output = result.write.content.toString('utf8');
    assert.ok(output.indexOf('<BaseForm') > output.indexOf('<Parameters/>'));
    assert.ok(output.indexOf('Captured base title') > output.indexOf('<BaseForm'));
    assert.ok(output.indexOf('</BaseForm>') < output.lastIndexOf('</Form>'));

    const wrongPath = materializeExtensionAdoptedPatchBatch({ artifact, targetRelativePath: 'Catalogs/Products/Forms/Other/Ext/Form.xml', patches: [patch] });
    assert.strictEqual(wrongPath.ok, false);
  }));

  test('blocks new Form bodies when registration or descriptor witnesses are absent and rejects foreign patch paths', async () => withRoots(async (roots) => {
    const targetXml = descriptor({ uuid: CFE_UUID, ownership: 'adopted', sourceUuid: BASE_UUID });
    const sourceXml = descriptor({ uuid: BASE_UUID });
    const targetObject = await indexedObject(roots.target, 'left', 'Catalog', 'Products', 'Catalogs/Products.xml', targetXml);
    const sourceObject = await indexedObject(roots.source, 'right', 'Catalog', 'Products', 'Catalogs/Products.xml', sourceXml);
    const baseObject = await indexedObject(roots.base, 'left', 'Catalog', 'Products', 'Catalogs/Products.xml', sourceXml);
    const targetRoot = await rootIndex(roots.target, 'target', 'left', 'cfe', [targetObject]);
    const sourceRoot = await rootIndex(roots.source, 'source', 'right', 'cf', [sourceObject]);
    const baseRoot = await rootIndex(roots.base, 'base', 'left', 'cf', [baseObject]);
    const row = transferRow({ targetRoot, incomingRoot: sourceRoot, target: targetObject, incoming: sourceObject, targetBase: baseRoot, targetBaseIsIncoming: true, action: 'overlay-adopted' });
    const uuidSnapshot = await createExtensionAdoptedUuidSnapshot({ targetRoot, incomingRoot: sourceRoot });
    const prepared = await prepareExtensionAdoptedSemanticRow({ row, targetRoot, incomingRoot: sourceRoot, uuidSnapshot });
    assert.strictEqual(prepared.applicable, true);
    if (!prepared.applicable) { return; }
    assert.ok(prepared.blockers.every((blocker) => blocker.kind !== 'metadataXml'));
    assert.strictEqual(prepared.artifacts.some((artifact) => artifact.kind === 'formXml'), false);

    const bodyRoots = await makeRootDirectories();
    try {
      const sourceFormOwner = await indexedObject(bodyRoots.source, 'right', 'Catalog', 'Products', 'Catalogs/Products.xml', descriptor({ uuid: BASE_UUID, forms: ['Main'] }), [
        { relativePath: 'Catalogs/Products/Forms/Main.xml', content: formDescriptor({ uuid: BASE_FORM_UUID }) },
        { relativePath: 'Catalogs/Products/Forms/Main/Ext/Form.xml', content: formXml('source') },
      ]);
      const baseFormOwner = await indexedObject(bodyRoots.base, 'left', 'Catalog', 'Products', 'Catalogs/Products.xml', descriptor({ uuid: BASE_UUID, forms: ['Main'] }), [
        { relativePath: 'Catalogs/Products/Forms/Main.xml', content: formDescriptor({ uuid: BASE_FORM_UUID }) },
        { relativePath: 'Catalogs/Products/Forms/Main/Ext/Form.xml', content: formXml('base') },
      ]);
      const noRegistrationTarget = await indexedObject(bodyRoots.target, 'left', 'Catalog', 'Products', 'Catalogs/Products.xml', descriptor({ uuid: CFE_UUID, ownership: 'adopted', sourceUuid: BASE_UUID }));
      const t = await rootIndex(bodyRoots.target, 'target', 'left', 'cfe', [noRegistrationTarget]);
      const s = await rootIndex(bodyRoots.source, 'source', 'right', 'cf', [sourceFormOwner]);
      const b = await rootIndex(bodyRoots.base, 'base', 'left', 'cf', [baseFormOwner]);
      const r = transferRow({ targetRoot: t, incomingRoot: s, target: noRegistrationTarget, incoming: sourceFormOwner, targetBase: b, targetBaseIsIncoming: true, action: 'overlay-adopted' });
      const uuidSnapshot = await createExtensionAdoptedUuidSnapshot({ targetRoot: t, incomingRoot: s });
      const withoutFormRegistration = await prepareExtensionAdoptedSemanticRow({ row: r, targetRoot: t, incomingRoot: s, uuidSnapshot });
      assert.strictEqual(withoutFormRegistration.applicable, true);
      if (withoutFormRegistration.applicable) {
        assert.ok(withoutFormRegistration.blockers.some((blocker) => blocker.kind === 'formXml' && /зарегистрированного Form-дескриптора/u.test(blocker.reason)));
      }
    } finally {
      await fs.rm(bodyRoots.parent, { recursive: true, force: true });
    }
  }));
});

async function withRoots(run: (roots: { parent: string; target: string; source: string; base: string }) => Promise<void>): Promise<void> {
  const roots = await makeRootDirectories();
  try { await run(roots); }
  finally { await fs.rm(roots.parent, { recursive: true, force: true }); }
}

async function makeRootDirectories(): Promise<{ parent: string; target: string; source: string; base: string }> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'issue335-adopted-host-'));
  const roots = { parent, target: path.join(parent, 'target'), source: path.join(parent, 'source'), base: path.join(parent, 'base') };
  await Promise.all([roots.target, roots.source, roots.base].map((root) => fs.mkdir(root, { recursive: true })));
  return roots;
}

async function indexedObject(
  rootPath: string,
  side: 'left' | 'right',
  metadataType: string,
  name: string,
  descriptorRelativePath: string,
  descriptorContent: Buffer,
  sidecarContents: readonly { relativePath: string; content: Buffer }[] = [],
): Promise<ExtensionIndexedObject> {
  const descriptorPath = path.join(rootPath, descriptorRelativePath);
  await fs.mkdir(path.dirname(descriptorPath), { recursive: true });
  await fs.writeFile(descriptorPath, descriptorContent);
  const sidecarFiles = [] as ExtensionIndexedObject['sidecarFiles'][number][];
  for (const file of sidecarContents) {
    const filePath = path.join(rootPath, file.relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, file.content);
    sidecarFiles.push({ relativePath: file.relativePath, hash: hash(file.content), content: Buffer.from(file.content) });
  }
  const identity = parseCfeObjectIdentity(descriptorContent.toString('utf8'), descriptorRelativePath);
  return {
    side,
    sourceId: path.basename(rootPath),
    metadataType,
    name,
    qualifiedName: `${metadataType}.${name}`,
    descriptorRelativePath,
    sidecarRelativePath: descriptorRelativePath.slice(0, -'.xml'.length),
    identity,
    descriptorContent: Buffer.from(descriptorContent),
    descriptorHash: hash(descriptorContent),
    sidecarFiles,
    supportedRootType: true,
    valid: true,
  };
}

async function rootIndex(rootPath: string, sourceId: string, side: 'left' | 'right', rootKind: 'cf' | 'cfe', objects: ExtensionIndexedObject[]): Promise<ExtensionMetadataIndex> {
  await writeDesignerConfiguration(rootPath, {
    uuid: CONFIGURATION_UUID,
    name: CONFIGURATION_NAME,
    registrations: [...new Map(objects.map((object) => [object.qualifiedName, {
      type: object.metadataType as ExtensionCompareRootType,
      name: object.name,
    }])).values()],
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
    configurationName: CONFIGURATION_NAME,
    ...(rootKind === 'cfe' ? { objectBelonging: 'Adopted', purpose: 'Customization', namePrefix: 'Ext_' } : {}),
    objects,
    diagnostics: [],
    cfeMarkerSeen: rootKind === 'cfe',
  };
}

async function namespaceConfiguration(rootPath: string): Promise<void> {
  const configurationPath = path.join(rootPath, 'Configuration.xml');
  const content = await fs.readFile(configurationPath, 'utf8');
  if (!content.includes(`xmlns="${MD}"`)) {
    await fs.writeFile(configurationPath, content.replace('<MetaDataObject ', `<MetaDataObject xmlns="${MD}" `), 'utf8');
  }
}

function transferRow(input: {
  targetRoot: ExtensionMetadataIndex;
  incomingRoot: ExtensionMetadataIndex;
  target: ExtensionIndexedObject;
  incoming: ExtensionIndexedObject;
  targetBase?: ExtensionMetadataIndex;
  incomingBase?: ExtensionMetadataIndex;
  targetBaseIsIncoming?: boolean;
  incomingBaseIsTarget?: boolean;
  action: 'overlay-adopted' | 'adopted-to-cf-overlay';
}): ExtensionTransferRow {
  return {
    id: `${input.target.identity?.type}:${input.target.identity?.name}`,
    qualifiedName: input.target.qualifiedName,
    status: 'changed',
    target: input.target,
    incoming: input.incoming,
    targetRoot: input.targetRoot,
    incomingRoot: input.incomingRoot,
    action: input.action,
    mergeable: true,
    targetBase: input.targetBase,
    incomingBase: input.incomingBase,
    targetBaseIsIncoming: input.targetBaseIsIncoming,
    incomingBaseIsTarget: input.incomingBaseIsTarget,
  };
}

function descriptor(input: {
  uuid: string;
  name?: string;
  comment?: string;
  ownership?: 'own' | 'adopted';
  sourceUuid?: string;
  children?: readonly string[];
  forms?: readonly string[];
  generatedName?: string;
  generatedCategory?: string;
}): Buffer {
  const name = input.name ?? 'Products';
  const ownership = input.ownership === 'adopted'
    ? `<ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>${input.sourceUuid}</ExtendedConfigurationObject>`
    : '';
  const generatedName = input.generatedName ?? 'CatalogRef.Products';
  const generatedCategory = input.generatedCategory ?? 'Ref';
  const childObjects = [...(input.children ?? []), ...(input.forms ?? []).map((formName) => `<Form>${formName}</Form>`)].join('');
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="${MD}" xmlns:xcf="${XCF}" xmlns:xr="${XR}" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xs="http://www.w3.org/2001/XMLSchema" version="2.20"><Catalog uuid="${input.uuid}"><Properties><Name>${name}</Name><Comment>${input.comment ?? 'Comment'}</Comment>${ownership}</Properties><InternalInfo><xr:GeneratedType name="${generatedName}" category="${generatedCategory}"><xr:TypeId>${TYPE_ID}</xr:TypeId></xr:GeneratedType></InternalInfo><ChildObjects>${childObjects}</ChildObjects></Catalog></MetaDataObject>`, 'utf8');
}

function dimension(comment: string): string {
  return `<Dimension uuid="${CHILD_UUID}"><Properties><Name>Lines</Name><Comment>${comment}</Comment><Type><v8:Type>xs:string</v8:Type><v8:StringQualifiers><v8:Length>10</v8:Length><v8:AllowedLength>Variable</v8:AllowedLength></v8:StringQualifiers></Type></Properties><InternalInfo><xr:GeneratedType name="DimensionRef" category="Ref"><xr:TypeId>${'88888888-8888-4888-8888-888888888888'}</xr:TypeId></xr:GeneratedType></InternalInfo></Dimension>`;
}

function formDescriptor(input: { uuid: string; ownership?: 'own' | 'adopted'; sourceUuid?: string }): Buffer {
  const ownership = input.ownership === 'adopted'
    ? `<ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>${input.sourceUuid}</ExtendedConfigurationObject>`
    : '';
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="${MD}" xmlns:xcf="${XCF}" xmlns:xr="${XR}" version="2.20"><Form uuid="${input.uuid}"><Properties><Name>Main</Name>${ownership}</Properties><InternalInfo><xr:GeneratedType name="FormRef.Main" category="Ref"><xr:TypeId>${'99999999-9999-4999-8999-999999999999'}</xr:TypeId></xr:GeneratedType></InternalInfo></Form></MetaDataObject>`, 'utf8');
}

function formXml(title: string): Buffer {
  return Buffer.from(`<Form xmlns="${FORM}" version="2.20"><AutoCommandBar name="ФормаКоманднаяПанель" id="-1"><Autofill>false</Autofill></AutoCommandBar><ChildItems><InputField name="Field" id="1"><Title>${title}</Title></InputField><Button name="Anchor" id="2"/></ChildItems><Attributes/><Commands/><Parameters/></Form>`, 'utf8');
}

function replaceElementPatch(artifact: { kind: 'metadataXml' | 'formXml'; targetFilePath: string; recipe: { initialLogicalTarget: Buffer } }, element: XmlElement, replacementXml: string): XmlPatchPayload {
  const source = artifact.recipe.initialLogicalTarget.toString('utf8');
  const uri = pathToFileURL(artifact.targetFilePath).toString();
  return {
    kind: 'replaceNode',
    target: buildXmlAddress(uri, element),
    replacementXml,
    expectedOldHash: hashXmlText(source),
    newHash: hash(Buffer.from(replacementXml)),
    semanticKind: artifact.kind,
  };
}

function descendant(root: XmlElement, name: string): XmlElement | undefined {
  if (root.localName === name) { return root; }
  for (const child of elementChildren(root)) {
    const match = descendant(child, name);
    if (match) { return match; }
  }
  return undefined;
}

function hash(value: Buffer): string { return createHash('sha256').update(value).digest('hex'); }
