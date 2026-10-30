import * as assert from 'assert';
import { createHash } from 'crypto';

import {
  materializeAdoptedDesignerFormTarget,
  projectAdoptedDesignerFormPair,
  type AdoptedDesignerFormProjectionInput,
} from '../../../src/compareMerge/extensions/adoptedDesignerFormProjection';
import type { AdoptedDesignerIdentity } from '../../../src/compareMerge/extensions/adoptedDesignerProjection';

const BASE_UUID = '11111111-1111-4111-8111-111111111111';
const CFE_UUID = '22222222-2222-4222-8222-222222222222';
const SOURCE_CFE_UUID = '99999999-9999-4999-8999-999999999999';
const FORM_NS = 'http://v8.1c.ru/8.3/xcf/logform';

suite('Adopted Designer Form.xml projection (#335)', () => {
  test('validates both adopted BaseForms independently and restores the exact target snapshot', () => {
    const baseXml = form('<Button id="opaque-base-id" title="Current CF"/>');
    const targetSnapshot = '<Button id="opaque-base-id" title="Old target snapshot"/>';
    const sourceSnapshot = '<Button id="opaque-base-id" title="Old source snapshot"/>';
    const input = makeInput({
      direction: 'adopted-to-adopted',
      baseXml,
      targetXml: form('<Button id="opaque-base-id" title="Target main"/>', targetSnapshot),
      sourceXml: form('<Button id="opaque-base-id" title="Source main"/>', sourceSnapshot),
    });

    const projection = projectAdoptedDesignerFormPair(input);

    assert.strictEqual(projection.ok, true, projection.ok ? undefined : projection.reason);
    if (!projection.ok) { return; }
    assert.doesNotMatch(projection.targetXml.toString('utf8'), /<BaseForm/u);
    assert.doesNotMatch(projection.sourceXml.toString('utf8'), /<BaseForm/u);
    assert.match(projection.targetXml.toString('utf8'), /title="Target main"/u);
    assert.match(projection.sourceXml.toString('utf8'), /title="Source main"/u);

    const mergedLogicalTarget = Buffer.from(projection.targetXml.toString('utf8').replace('Target main', 'Selected target main'));
    const materialized = materializeAdoptedDesignerFormTarget({ ...input, mergedLogicalTarget });

    assert.strictEqual(materialized.ok, true, materialized.ok ? undefined : materialized.reason);
    if (!materialized.ok) { return; }
    const xml = materialized.content.toString('utf8');
    assert.match(xml, /title="Selected target main"/u);
    assert.strictEqual(
      xml.match(/<BaseForm[^>]*>[\s\S]*?<\/BaseForm>/u)?.[0],
      `<BaseForm version="2.20"><Items>${targetSnapshot}</Items></BaseForm>`,
      'materialization restores the target physical BaseForm subtree without taking the source snapshot',
    );
    assert.doesNotMatch(xml, /Old source snapshot/u);
    assert.ok(xml.indexOf('<BaseForm') > xml.indexOf('</Items>'));
    assert.ok(xml.trimEnd().endsWith('</BaseForm></Form>'));
    assert.deepStrictEqual(materialized.baseFormWitness, projection.baseFormWitness);
  });

  test('requires one valid final BaseForm on each adopted side', () => {
    const baseXml = form('<Button id="opaque-base-id" title="Current CF"/>');
    const validTarget = form('<Button id="opaque-base-id"/>', '<Button id="opaque-base-id" title="Target snapshot"/>');
    const validSource = form('<Button id="opaque-base-id"/>', '<Button id="opaque-base-id" title="Source snapshot"/>');
    const malformed = [
      form('<Button id="opaque-base-id"/>'),
      Buffer.from(validTarget.toString('utf8').replace('</Form>', '<BaseForm version="2.20"><Items><Button id="opaque-base-id"/></Items></BaseForm></Form>')),
      Buffer.from(validTarget.toString('utf8').replace('</BaseForm></Form>', '</BaseForm><Marker/></Form>')),
      Buffer.from(validTarget.toString('utf8').replace('<BaseForm version="2.20">', '<BaseForm version="2.19">')),
    ];

    for (const side of ['target', 'source'] as const) {
      for (const invalidBaseForm of malformed) {
        const input = makeInput({
          direction: 'adopted-to-adopted',
          baseXml,
          targetXml: side === 'target' ? invalidBaseForm : validTarget,
          sourceXml: side === 'source' ? invalidBaseForm : validSource,
        });
        const result = projectAdoptedDesignerFormPair(input);
        assert.strictEqual(result.ok, false, `${side} adopted BaseForm must satisfy the captured structure contract`);
        if (!result.ok) { assert.match(result.reason, /BaseForm/u); }
      }
    }

    const wrongAnchor = makeInput({ direction: 'adopted-to-adopted', baseXml, targetXml: validTarget, sourceXml: validSource });
    const anchorResult = projectAdoptedDesignerFormPair({
      ...wrongAnchor,
      sourceIdentity: { ...wrongAnchor.sourceIdentity, sourceUuid: SOURCE_CFE_UUID },
    });
    assert.strictEqual(anchorResult.ok, false);
    if (!anchorResult.ok) { assert.match(anchorResult.reason, /anchor/u); }
  });

  test('rejects an unknown runtime direction instead of treating it as adopted-to-adopted', () => {
    const input = makeInput({ direction: 'adopted-to-adopted' });
    const direction = 'unknown-direction' as unknown as AdoptedDesignerFormProjectionInput['direction'];

    const result = projectAdoptedDesignerFormPair({ ...input, direction });

    assert.strictEqual(result.ok, false);
    if (!result.ok) { assert.match(result.reason, /направлени/iu); }
  });

  test('projects the main tree only and carries the exact captured BaseForm witness', () => {
    const baseXml = form('<Button id="opaque-base-id" title="Current CF"/>');
    const input = makeInput({
      direction: 'cf-to-adopted',
      baseXml,
      targetXml: form('<Button id="opaque-base-id" title="CFE main"/>', '<Button id="opaque-base-id" title="Old base snapshot"/>'),
    });

    const result = projectAdoptedDesignerFormPair(input);

    assert.strictEqual(result.ok, true);
    if (!result.ok) { return; }
    assert.doesNotMatch(result.targetXml.toString('utf8'), /<BaseForm/u);
    assert.match(result.targetXml.toString('utf8'), /title="CFE main"/u);
    assert.deepStrictEqual(result.baseFormWitness, {
      sourceId: 'base-source',
      relativePath: 'Catalogs/Products/Forms/Main/Form.xml',
      expectedHash: createHash('sha256').update(baseXml).digest('hex'),
      kind: 'file',
    });
    assert.deepStrictEqual(result.issues, []);
  });

  test('materializes a CFE main-tree edit while retaining its exact own BaseForm subtree last', () => {
    const baseXml = form('<Button id="opaque-base-id" title="Current CF"/>');
    const targetXml = form('<Button id="opaque-base-id" title="CFE main"/>', '<Button id="opaque-base-id" title="Old base snapshot"/>');
    const input = makeInput({ direction: 'cf-to-adopted', baseXml, targetXml });
    const projected = projectAdoptedDesignerFormPair(input);
    assert.strictEqual(projected.ok, true);
    if (!projected.ok) { return; }
    const merged = Buffer.from(projected.targetXml.toString('utf8').replace('title="CFE main"', 'title="Selected value"'));

    const result = materializeAdoptedDesignerFormTarget({ ...input, mergedLogicalTarget: merged });

    assert.strictEqual(result.ok, true);
    if (!result.ok) { return; }
    const xml = result.content.toString('utf8');
    assert.match(xml, /title="Selected value"/u);
    assert.match(xml, /<BaseForm[^>]*>[\s\S]*Old base snapshot[\s\S]*<\/BaseForm>\s*<\/Form>/u);
    assert.ok(xml.indexOf('<BaseForm') > xml.indexOf('<Items>'));
    assert.strictEqual(result.baseFormWitness.expectedHash, createHash('sha256').update(baseXml).digest('hex'));
  });

  test('never copies BaseForm into a CF target when promoting adopted Form.xml', () => {
    const baseXml = form('<Button id="1000001" title="Current CF"/>');
    const input = makeInput({
      direction: 'adopted-to-cf',
      baseXml,
      targetXml: form('<Button id="1000001" title="CF target"/>'),
      sourceXml: form('<Button id="1000001" title="CFE main"/>', '<Button id="1000001" title="Old snapshot"/>'),
    });
    const projection = projectAdoptedDesignerFormPair(input);
    assert.strictEqual(projection.ok, true);
    if (!projection.ok) { return; }

    const result = materializeAdoptedDesignerFormTarget({ ...input, mergedLogicalTarget: projection.targetXml });

    assert.strictEqual(result.ok, true);
    if (!result.ok) { return; }
    assert.doesNotMatch(result.content.toString('utf8'), /<BaseForm/u);
  });

  test('reports semantic BaseForm identity mismatches without numeric ID heuristics', () => {
    const baseXml = form('<Button id="1"/><Field id="900000"/><Button id="x-new-id"/>');
    const targetXml = form('<Button id="1"/><Field id="900000"/><Button id="x-new-id"/>', '<Button id="1"/><DifferentControl id="900000"/><Button id="x-new-id"/>');
    const input = makeInput({ direction: 'cf-to-adopted', baseXml, targetXml });

    const result = projectAdoptedDesignerFormPair(input);

    assert.strictEqual(result.ok, true);
    if (!result.ok) { return; }
    assert.strictEqual(result.issues.length, 1);
    assert.strictEqual(result.issues[0]?.identityKey, 'id=900000');
    assert.match(result.issues[0]?.reason ?? '', /другого expanded element name/u);
  });

  test('treats a stale CFE BaseForm snapshot as a base change instead of requiring full content equality', () => {
    const currentBase = form('<Button id="new-current-id" title="Updated CF element"/>');
    const input = makeInput({
      direction: 'cf-to-adopted',
      baseXml: currentBase,
      targetXml: form('<Button id="old-target-id" title="CFE main"/>', '<Button id="old-target-id" title="Previously captured base"/>'),
    });

    const result = projectAdoptedDesignerFormPair(input);

    assert.strictEqual(result.ok, true);
    if (!result.ok) { return; }
    assert.deepStrictEqual(result.issues, []);
    assert.match(result.targetXml.toString('utf8'), /old-target-id/u);
    assert.doesNotMatch(result.targetXml.toString('utf8'), /Previously captured base/u);
  });

  test('scopes item IDs to ChildItems, Attributes, Commands, and Parameters', () => {
    const collections = '<ChildItems><Button id="shared-id" name="button"/></ChildItems><Attributes><Attribute id="shared-id" name="attribute"/></Attributes><Commands><Command id="shared-id" name="command"/></Commands><Parameters><Parameter id="shared-id" name="parameter"/></Parameters><ChildItems><Panel id="panel-id" name="panel"><ChildItems><Button id="nested-id" name="nestedButton"/></ChildItems></Panel></ChildItems>';
    const baseXml = form(collections);
    const duplicateWithinChildItems = collections.replace('<Button id="nested-id" name="nestedButton"/>', '<Button id="shared-id" name="nestedButton"/>');
    const input = makeInput({ direction: 'cf-to-adopted', baseXml, targetXml: form(duplicateWithinChildItems, collections), sourceXml: form(collections) });

    const result = projectAdoptedDesignerFormPair(input);

    assert.strictEqual(result.ok, true);
    if (!result.ok) { return; }
    assert.strictEqual(result.issues.length, 1);
    assert.strictEqual(result.issues[0]?.identityKey, 'id=shared-id');
  });

  test('does not count a foreign-namespace BaseForm lookalike as the captured snapshot', () => {
    const target = Buffer.from(form('<Button id="opaque-base-id"/>').toString('utf8')
      .replace('</Form>', '<vendor:BaseForm version="2.20"/></Form>')
      .replace(' xmlns="', ' xmlns:vendor="urn:vendor" xmlns="'));
    const result = projectAdoptedDesignerFormPair(makeInput({ direction: 'cf-to-adopted', targetXml: target }));
    assert.strictEqual(result.ok, false);
    if (!result.ok) { assert.match(result.reason, /BaseForm/u); }
  });

  test('rejects a stale base-file witness in both one-sided and two-sided adopted projection', () => {
    for (const direction of ['cf-to-adopted', 'adopted-to-adopted'] as const) {
      const input = makeInput({ direction, baseFormHash: '0'.repeat(64) });

      const result = projectAdoptedDesignerFormPair(input);

      assert.strictEqual(result.ok, false);
      if (!result.ok) { assert.match(result.reason, /hash|хеш/iu); }
    }
  });
});

type TestAdoptedDirection = AdoptedDesignerFormProjectionInput['direction'] | 'adopted-to-adopted';

function makeInput(overrides: Omit<Partial<AdoptedDesignerFormProjectionInput>, 'direction'> & { readonly direction?: TestAdoptedDirection } = {}): AdoptedDesignerFormProjectionInput {
  const baseXml = overrides.baseXml ?? form('<Button id="opaque-base-id" title="Current CF"/>');
  const baseIdentity: AdoptedDesignerIdentity = { ownership: 'own', type: 'Form', name: 'Main', uuid: BASE_UUID };
  const targetIdentity: AdoptedDesignerIdentity = overrides.direction === 'adopted-to-cf'
    ? baseIdentity
    : { ownership: 'adopted', type: 'Form', name: 'Main', uuid: CFE_UUID, sourceUuid: BASE_UUID };
  const sourceIdentity: AdoptedDesignerIdentity = overrides.direction !== 'cf-to-adopted'
    ? { ownership: 'adopted', type: 'Form', name: 'Main', uuid: overrides.direction === 'adopted-to-adopted' ? SOURCE_CFE_UUID : CFE_UUID, sourceUuid: BASE_UUID }
    : baseIdentity;
  const targetAdopted = overrides.direction !== 'adopted-to-cf';
  const sourceAdopted = overrides.direction !== 'cf-to-adopted';
  return {
    direction: (overrides.direction ?? 'cf-to-adopted') as AdoptedDesignerFormProjectionInput['direction'],
    targetXml: overrides.targetXml ?? form('<Button id="opaque-base-id" title="CFE main"/>', targetAdopted ? '<Button id="opaque-base-id" title="Old base snapshot"/>' : undefined),
    sourceXml: overrides.sourceXml ?? form('<Button id="opaque-base-id" title="Source CF"/>', sourceAdopted ? '<Button id="opaque-base-id" title="Old source snapshot"/>' : undefined),
    baseXml,
    targetIdentity,
    sourceIdentity,
    baseIdentity,
    baseFormSourceId: overrides.baseFormSourceId ?? 'base-source',
    baseFormRelativePath: overrides.baseFormRelativePath ?? 'Catalogs/Products/Forms/Main/Form.xml',
    baseFormHash: overrides.baseFormHash ?? createHash('sha256').update(baseXml).digest('hex'),
    formatVersion: overrides.formatVersion ?? '2.20',
  };
}

function form(mainItem: string, baseFormItem?: string): Buffer {
  const base = baseFormItem === undefined ? '' : `<BaseForm version="2.20"><Items>${baseFormItem}</Items></BaseForm>`;
  return Buffer.from(`<Form xmlns="${FORM_NS}" version="2.20"><Items>${mainItem}</Items>${base}</Form>`, 'utf8');
}
