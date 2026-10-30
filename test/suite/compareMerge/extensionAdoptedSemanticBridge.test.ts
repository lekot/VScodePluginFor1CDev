import * as assert from 'assert';
import { createHash } from 'crypto';

import {
  materializeExtensionAdoptedArtifact,
  projectExtensionAdoptedDescriptor,
  projectExtensionAdoptedForm,
  type AdoptedSemanticArtifactCapture,
} from '../../../src/compareMerge/extensions/extensionAdoptedSemanticBridge';
import type { AdoptedDesignerDirection, AdoptedDesignerIdentity } from '../../../src/compareMerge/extensions/adoptedDesignerProjection';
import { MISSING_TARGET_HASH, type MergeFileWitness } from '../../../src/compareMerge/merge/mergePreview';

const BASE_UUID = '11111111-1111-4111-8111-111111111111';
const CFE_UUID = '22222222-2222-4222-8222-222222222222';
const SOURCE_CFE_UUID = '99999999-9999-4999-8999-999999999999';
const FORM_NS = 'http://v8.1c.ru/8.3/xcf/logform';

suite('Extension adopted semantic bridge (#335)', () => {
  test('rejects an unknown runtime direction for descriptor and form bridge contracts', () => {
    const direction = 'unknown-direction' as unknown as AdoptedDesignerDirection;
    const baseIdentity: AdoptedDesignerIdentity = { ownership: 'own', type: 'Catalog', name: 'Products', uuid: BASE_UUID };
    const targetIdentity: AdoptedDesignerIdentity = { ownership: 'adopted', type: 'Catalog', name: 'Products', uuid: CFE_UUID, sourceUuid: BASE_UUID };
    const sourceIdentity: AdoptedDesignerIdentity = { ownership: 'adopted', type: 'Catalog', name: 'Products', uuid: SOURCE_CFE_UUID, sourceUuid: BASE_UUID };
    const target = capture(descriptor(CFE_UUID, 'Target', true), targetIdentity, 'target', 'Catalogs/Products.xml');
    const source = capture(descriptor(SOURCE_CFE_UUID, 'Source', true), sourceIdentity, 'source', 'Catalogs/Products.xml');
    const base = capture(descriptor(BASE_UUID, 'Base'), baseIdentity, 'base', 'Catalogs/Products.xml');

    const descriptorResult = projectExtensionAdoptedDescriptor({ direction, target, source, base, formatVersion: '2.20' });

    const baseFormIdentity: AdoptedDesignerIdentity = { ownership: 'own', type: 'Form', name: 'Main', uuid: BASE_UUID };
    const targetFormIdentity: AdoptedDesignerIdentity = { ownership: 'adopted', type: 'Form', name: 'Main', uuid: CFE_UUID, sourceUuid: BASE_UUID };
    const sourceFormIdentity: AdoptedDesignerIdentity = { ownership: 'adopted', type: 'Form', name: 'Main', uuid: SOURCE_CFE_UUID, sourceUuid: BASE_UUID };
    const targetForm = capture(formWithBase('<Button id="opaque-base-id"/>', '<Button id="opaque-base-id"/>'), targetFormIdentity, 'target', 'Catalogs/Products/Forms/Main/Ext/Form.xml');
    const sourceForm = capture(formWithBase('<Button id="opaque-base-id"/>', '<Button id="opaque-base-id"/>'), sourceFormIdentity, 'source', 'Catalogs/Products/Forms/Main/Ext/Form.xml');
    const baseForm = capture(form('<Button id="opaque-base-id"/>'), baseFormIdentity, 'base', 'Catalogs/Products/Forms/Main/Ext/Form.xml');

    const formResult = projectExtensionAdoptedForm({ direction, target: targetForm, source: sourceForm, baseForm, formatVersion: '2.20' });
    assert.strictEqual(descriptorResult.ok, false);
    if (!descriptorResult.ok) { assert.match(descriptorResult.reason, /Направление/u); }
    assert.strictEqual(formResult.ok, false);
    if (!formResult.ok) { assert.match(formResult.reason, /Направление/u); }
  });

  test('bridges two adopted descriptor captures over one base and preserves target physical identity', () => {
    const direction = 'adopted-to-adopted' as AdoptedDesignerDirection;
    const baseIdentity: AdoptedDesignerIdentity = { ownership: 'own', type: 'Catalog', name: 'Products', uuid: BASE_UUID };
    const targetIdentity: AdoptedDesignerIdentity = { ownership: 'adopted', type: 'Catalog', name: 'Products', uuid: CFE_UUID, sourceUuid: BASE_UUID };
    const sourceIdentity: AdoptedDesignerIdentity = { ownership: 'adopted', type: 'Catalog', name: 'Products', uuid: SOURCE_CFE_UUID, sourceUuid: BASE_UUID };
    const targetXml = Buffer.from(descriptor(CFE_UUID, 'Target overlay', true).toString('utf8').replace('name="CatalogRef"', 'name="TargetCatalogRef"'));
    const sourceXml = descriptor(SOURCE_CFE_UUID, 'Source overlay', true);
    const target = capture(targetXml, targetIdentity, 'target', 'Catalogs/Products.xml');
    const source = capture(sourceXml, sourceIdentity, 'source', 'Catalogs/Products.xml');
    const base = capture(descriptor(BASE_UUID, 'Base'), baseIdentity, 'base', 'Catalogs/Products.xml');

    const projection = projectExtensionAdoptedDescriptor({ direction, target, source, base, formatVersion: '2.20' });

    assert.strictEqual(projection.ok, true, projection.ok ? undefined : projection.reason);
    if (!projection.ok) { return; }
    assert.match(projection.targetXml.toString('utf8'), /Target overlay/u);
    assert.match(projection.sourceXml.toString('utf8'), /Source overlay/u);
    assert.deepStrictEqual(projection.requiredWitnesses, [target.witness, source.witness, base.witness]);
    const selected = Buffer.from(projection.targetXml.toString('utf8').replace('Target overlay', 'Selected target overlay'));

    const materialized = materializeExtensionAdoptedArtifact(projection.recipe, selected);

    assert.strictEqual(materialized.ok, true, materialized.ok ? undefined : materialized.reason);
    if (!materialized.ok) { return; }
    const xml = materialized.content.toString('utf8');
    assert.match(xml, new RegExp(`<Catalog uuid="${CFE_UUID}"`));
    assert.match(xml, new RegExp(`<ExtendedConfigurationObject>${BASE_UUID}<\/ExtendedConfigurationObject>`));
    assert.match(xml, /Selected target overlay/u);
    assert.match(xml, /<xr:GeneratedType name="TargetCatalogRef"/u);
    assert.doesNotMatch(xml, /Source overlay/u);
    assert.deepStrictEqual(materialized.requiredWitnesses, projection.requiredWitnesses);

    const wrongAnchor = projectExtensionAdoptedDescriptor({
      direction,
      target,
      source: { ...source, identity: { ...sourceIdentity, sourceUuid: SOURCE_CFE_UUID } },
      base,
      formatVersion: '2.20',
    });
    assert.strictEqual(wrongAnchor.ok, false);
  });

  test('validates each adopted Form BaseForm and restores the captured target BaseForm through the bridge', () => {
    const direction = 'adopted-to-adopted' as AdoptedDesignerDirection;
    const baseIdentity: AdoptedDesignerIdentity = { ownership: 'own', type: 'Form', name: 'Main', uuid: BASE_UUID };
    const targetIdentity: AdoptedDesignerIdentity = { ownership: 'adopted', type: 'Form', name: 'Main', uuid: CFE_UUID, sourceUuid: BASE_UUID };
    const sourceIdentity: AdoptedDesignerIdentity = { ownership: 'adopted', type: 'Form', name: 'Main', uuid: SOURCE_CFE_UUID, sourceUuid: BASE_UUID };
    const targetSnapshot = '<Button id="opaque-base-id" title="Old target snapshot"/>';
    const sourceSnapshot = '<Button id="opaque-base-id" title="Old source snapshot"/>';
    const target = capture(formWithBase('<Button id="opaque-base-id" title="Target main"/>', targetSnapshot), targetIdentity, 'target', 'Catalogs/Products/Forms/Main/Ext/Form.xml');
    const source = capture(formWithBase('<Button id="opaque-base-id" title="Source main"/>', sourceSnapshot), sourceIdentity, 'source', 'Catalogs/Products/Forms/Main/Ext/Form.xml');
    const baseForm = capture(form('<Button id="opaque-base-id" title="Base form"/>'), baseIdentity, 'base', 'Catalogs/Products/Forms/Main/Ext/Form.xml');

    const projection = projectExtensionAdoptedForm({ direction, target, source, baseForm, formatVersion: '2.20' });

    assert.strictEqual(projection.ok, true, projection.ok ? undefined : projection.reason);
    if (!projection.ok) { return; }
    assert.doesNotMatch(projection.targetXml.toString('utf8'), /<BaseForm/u);
    assert.doesNotMatch(projection.sourceXml.toString('utf8'), /<BaseForm/u);
    assert.match(projection.targetXml.toString('utf8'), /Target main/u);
    assert.match(projection.sourceXml.toString('utf8'), /Source main/u);
    const selected = Buffer.from(projection.targetXml.toString('utf8').replace('Target main', 'Selected target main'));

    const materialized = materializeExtensionAdoptedArtifact(projection.recipe, selected);

    assert.strictEqual(materialized.ok, true, materialized.ok ? undefined : materialized.reason);
    if (!materialized.ok) { return; }
    const xml = materialized.content.toString('utf8');
    assert.match(xml, /Selected target main/u);
    assert.match(xml, new RegExp(`<BaseForm version="2.20"><Items>${targetSnapshot}<\/Items><\/BaseForm><\/Form>$`));
    assert.doesNotMatch(xml, /Old source snapshot/u);
    assert.deepStrictEqual(materialized.requiredWitnesses, projection.requiredWitnesses);
  });

  test('rechecks captured descriptor hashes and carries proven base witnesses through selected materialization', () => {
    const baseIdentity: AdoptedDesignerIdentity = { ownership: 'own', type: 'Catalog', name: 'Products', uuid: BASE_UUID };
    const targetIdentity: AdoptedDesignerIdentity = { ownership: 'adopted', type: 'Catalog', name: 'Products', uuid: CFE_UUID, sourceUuid: BASE_UUID };
    const target = capture(descriptor(CFE_UUID, 'Target', true), targetIdentity, 'target', 'Catalogs/Products.xml');
    const source = capture(descriptor(BASE_UUID, 'Selected source'), baseIdentity, 'source', 'Catalogs/Products.xml');
    const base = capture(descriptor(BASE_UUID, 'Base'), baseIdentity, 'base', 'Catalogs/Products.xml');

    const projection = projectExtensionAdoptedDescriptor({
      direction: 'cf-to-adopted', target, source, base, formatVersion: '2.20',
    });

    assert.strictEqual(projection.ok, true, projection.ok ? undefined : projection.reason);
    if (!projection.ok) { return; }
    assert.strictEqual(projection.recipe.kind, 'adopted-descriptor');
    assert.deepStrictEqual(projection.requiredWitnesses.map(({ sourceId, relativePath }) => ({ sourceId, relativePath })), [
      { sourceId: 'target', relativePath: 'Catalogs/Products.xml' },
      { sourceId: 'source', relativePath: 'Catalogs/Products.xml' },
      { sourceId: 'base', relativePath: 'Catalogs/Products.xml' },
    ]);
    assert.deepStrictEqual(projection.requiredWitnesses, [target.witness, source.witness, base.witness], 'CAS witnesses retain captured physical hashes, not logical projection hashes');
    const selected = Buffer.from(projection.sourceXml.toString('utf8').replace('Selected source', 'Selected by merge'));

    const materialized = materializeExtensionAdoptedArtifact(projection.recipe, selected);

    assert.strictEqual(materialized.ok, true, materialized.ok ? undefined : materialized.reason);
    if (!materialized.ok) { return; }
    assert.match(materialized.content.toString('utf8'), new RegExp(`<Catalog uuid="${CFE_UUID}"`));
    assert.match(materialized.content.toString('utf8'), /<Comment(?:\s[^>]*)?>Selected by merge<\/Comment>/u);
    assert.deepStrictEqual(materialized.requiredWitnesses, projection.requiredWitnesses);

    const stale = projectExtensionAdoptedDescriptor({ direction: 'cf-to-adopted', target: { ...target, witness: { ...target.witness, expectedHash: '0'.repeat(64) } }, source, base, formatVersion: '2.20' });
    assert.strictEqual(stale.ok, false);
    if (!stale.ok) { assert.match(stale.reason, /SHA-256/u); }
  });

  test('projects a missing CF-to-CFE Form target from captured base and preserves its synthetic creation recipe', () => {
    const baseIdentity: AdoptedDesignerIdentity = { ownership: 'own', type: 'Form', name: 'Main', uuid: BASE_UUID };
    const targetIdentity: AdoptedDesignerIdentity = { ownership: 'adopted', type: 'Form', name: 'Main', uuid: CFE_UUID, sourceUuid: BASE_UUID };
    const baseXml = form('<Button id="base-button" title="Base"/>');
    const sourceXml = form('<Button id="base-button" title="Base"/><InputField id="new-field" name="NewField"/>');
    const registration = witness('target', 'Catalogs/Products.xml', Buffer.from('captured target owner registration'));
    const source = capture(sourceXml, baseIdentity, 'source', 'Catalogs/Products/Forms/Main/Ext/Form.xml');
    const base = capture(baseXml, baseIdentity, 'base', 'Catalogs/Products/Forms/Main/Ext/Form.xml');
    const missingTarget = {
      identity: targetIdentity,
      relativePath: 'Catalogs/Products/Forms/Main/Ext/Form.xml',
      targetWitness: {
        sourceId: 'target',
        relativePath: 'Catalogs/Products/Forms/Main/Ext/Form.xml',
        expectedHash: MISSING_TARGET_HASH,
        kind: 'file' as const,
      },
      registrationWitnesses: [registration],
    };

    const projection = projectExtensionAdoptedForm({
      direction: 'cf-to-adopted', source, baseForm: base, missingTarget, formatVersion: '2.20',
    });

    assert.strictEqual(projection.ok, true, projection.ok ? undefined : projection.reason);
    if (!projection.ok) { return; }
    assert.strictEqual(projection.recipe.kind, 'adopted-form');
    if (projection.recipe.kind !== 'adopted-form') { return; }
    assert.strictEqual(projection.recipe.targetWasMissing, true);
    assert.ok(!('witness' in projection.recipe.target), 'a synthesized Form target does not claim a captured physical-file witness');
    assert.deepStrictEqual(projection.recipe.targetCreation, missingTarget);
    assert.deepStrictEqual(projection.requiredWitnesses.map(({ sourceId, relativePath }) => ({ sourceId, relativePath })), [
      { sourceId: 'target', relativePath: 'Catalogs/Products/Forms/Main/Ext/Form.xml' },
      { sourceId: 'source', relativePath: 'Catalogs/Products/Forms/Main/Ext/Form.xml' },
      { sourceId: 'base', relativePath: 'Catalogs/Products/Forms/Main/Ext/Form.xml' },
      { sourceId: 'target', relativePath: 'Catalogs/Products.xml' },
    ]);
    assert.strictEqual(projection.requiredWitnesses[0]?.expectedHash, MISSING_TARGET_HASH, 'the missing destination is CAS guarded by the physical missing sentinel');
    assert.deepStrictEqual(projection.requiredWitnesses.slice(1), [source.witness, base.witness, registration], 'source, base, and registration witnesses retain their raw captured hashes');
    const selected = Buffer.from(projection.sourceXml.toString('utf8').replace('title="Base"', 'title="Selected main Form"'));

    const materialized = materializeExtensionAdoptedArtifact(projection.recipe, selected);

    assert.strictEqual(materialized.ok, true, materialized.ok ? undefined : materialized.reason);
    if (!materialized.ok) { return; }
    assert.match(materialized.content.toString('utf8'), /title="Selected main Form"/u);
    assert.match(materialized.content.toString('utf8'), /<BaseForm[^>]*>[\s\S]*title="Base"[\s\S]*<\/BaseForm>\s*<\/Form>/u);
    assert.deepStrictEqual(materialized.targetCreation, missingTarget);
    assert.deepStrictEqual(materialized.requiredWitnesses, projection.requiredWitnesses);

    for (const invalid of [
      { ...missingTarget, targetWitness: { ...missingTarget.targetWitness, expectedHash: witness('target', missingTarget.relativePath, Buffer.from('unexpected file')).expectedHash } },
      { ...missingTarget, targetWitness: { ...missingTarget.targetWitness, relativePath: 'Catalogs/Products/Forms/Other/Ext/Form.xml' } },
      { ...missingTarget, registrationWitnesses: [] },
      { ...missingTarget, registrationWitnesses: [witness('other-target', 'Catalogs/Products.xml', Buffer.from('registration from a different source'))] },
    ]) {
      const rejected = projectExtensionAdoptedForm({
        direction: 'cf-to-adopted', source, baseForm: base, missingTarget: invalid, formatVersion: '2.20',
      });
      assert.strictEqual(rejected.ok, false, 'a synthetic destination needs an exact missing-file CAS and captured registration');
    }
  });

  test('projects CommonForm Form.xml only when target, source, and base descriptor identities share that exact kind', () => {
    const baseIdentity: AdoptedDesignerIdentity = { ownership: 'own', type: 'CommonForm', name: 'SharedEditor', uuid: BASE_UUID };
    const targetIdentity: AdoptedDesignerIdentity = { ownership: 'adopted', type: 'CommonForm', name: 'SharedEditor', uuid: CFE_UUID, sourceUuid: BASE_UUID };
    const baseXml = form('<Button id="base-button" title="Base"/>');
    const sourceXml = form('<Button id="base-button" title="Selected common form"/>');
    const registration = witness('target', 'CommonForms/SharedEditor.xml', Buffer.from('captured common form descriptor registration'));
    const source = capture(sourceXml, baseIdentity, 'source', 'CommonForms/SharedEditor/Ext/Form.xml');
    const base = capture(baseXml, baseIdentity, 'base', 'CommonForms/SharedEditor/Ext/Form.xml');

    const projection = projectExtensionAdoptedForm({
      direction: 'cf-to-adopted', source, baseForm: base,
      missingTarget: {
        identity: targetIdentity,
        relativePath: 'CommonForms/SharedEditor/Ext/Form.xml',
        targetWitness: {
          sourceId: 'target',
          relativePath: 'CommonForms/SharedEditor/Ext/Form.xml',
          expectedHash: MISSING_TARGET_HASH,
          kind: 'file' as const,
        },
        registrationWitnesses: [registration],
      },
      formatVersion: '2.20',
    });

    assert.strictEqual(projection.ok, true, projection.ok ? undefined : projection.reason);
    if (!projection.ok) { return; }
    assert.strictEqual(projection.recipe.kind, 'adopted-form');
    assert.deepStrictEqual(projection.recipe.targetCreation?.identity, targetIdentity);
    const selected = Buffer.from(projection.sourceXml.toString('utf8').replace('Base', 'Selected common form'));

    const materialized = materializeExtensionAdoptedArtifact(projection.recipe, selected);

    assert.strictEqual(materialized.ok, true, materialized.ok ? undefined : materialized.reason);
    if (!materialized.ok) { return; }
    assert.match(materialized.content.toString('utf8'), /Selected common form/u);
    assert.match(materialized.content.toString('utf8'), /<BaseForm[^>]*>[\s\S]*Base[\s\S]*<\/BaseForm>/u);
    assert.deepStrictEqual(materialized.requiredWitnesses, projection.requiredWitnesses);
  });
});

function descriptor(uuid: string, comment: string, adopted = false): Buffer {
  const markers = adopted
    ? `<ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>${BASE_UUID}</ExtendedConfigurationObject>`
    : '';
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="2.20"><Catalog uuid="${uuid}"><Properties><Name>Products</Name><Comment>${comment}</Comment>${markers}</Properties><InternalInfo><xr:GeneratedType name="CatalogRef" uuid="${BASE_UUID}"/></InternalInfo><ChildObjects/></Catalog></MetaDataObject>`, 'utf8');
}

function form(items: string): Buffer {
  return Buffer.from(`<Form xmlns="${FORM_NS}" version="2.20"><Items>${items}</Items></Form>`, 'utf8');
}

function formWithBase(items: string, baseItems: string): Buffer {
  return Buffer.from(`<Form xmlns="${FORM_NS}" version="2.20"><Items>${items}</Items><BaseForm version="2.20"><Items>${baseItems}</Items></BaseForm></Form>`, 'utf8');
}

function capture(content: Buffer, identity: AdoptedDesignerIdentity, sourceId: string, relativePath: string): AdoptedSemanticArtifactCapture {
  return { content, identity, witness: witness(sourceId, relativePath, content) };
}

function witness(sourceId: string, relativePath: string, content: Buffer): MergeFileWitness {
  return { kind: 'file', sourceId, relativePath, expectedHash: createHash('sha256').update(content).digest('hex') };
}
