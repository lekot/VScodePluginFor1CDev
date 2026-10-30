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
const FORM_NS = 'http://v8.1c.ru/8.3/xcf/logform';

suite('Adopted Designer Form.xml projection (#335)', () => {
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

  test('rejects a stale base-file witness before producing a logical projection', () => {
    const input = makeInput({ baseFormHash: '0'.repeat(64) });

    const result = projectAdoptedDesignerFormPair(input);

    assert.strictEqual(result.ok, false);
    if (!result.ok) { assert.match(result.reason, /hash|хеш/iu); }
  });
});

function makeInput(overrides: Partial<AdoptedDesignerFormProjectionInput> & { readonly direction?: AdoptedDesignerFormProjectionInput['direction'] } = {}): AdoptedDesignerFormProjectionInput {
  const baseXml = overrides.baseXml ?? form('<Button id="opaque-base-id" title="Current CF"/>');
  const baseIdentity: AdoptedDesignerIdentity = { ownership: 'own', type: 'Form', name: 'Main', uuid: BASE_UUID };
  const targetIdentity: AdoptedDesignerIdentity = overrides.direction === 'adopted-to-cf'
    ? baseIdentity
    : { ownership: 'adopted', type: 'Form', name: 'Main', uuid: CFE_UUID, sourceUuid: BASE_UUID };
  const sourceIdentity: AdoptedDesignerIdentity = overrides.direction === 'adopted-to-cf'
    ? { ownership: 'adopted', type: 'Form', name: 'Main', uuid: CFE_UUID, sourceUuid: BASE_UUID }
    : baseIdentity;
  return {
    direction: overrides.direction ?? 'cf-to-adopted',
    targetXml: overrides.targetXml ?? form('<Button id="opaque-base-id" title="CFE main"/>', '<Button id="opaque-base-id" title="Old base snapshot"/>'),
    sourceXml: overrides.sourceXml ?? form('<Button id="opaque-base-id" title="Source CF"/>'),
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
