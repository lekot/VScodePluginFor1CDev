import * as assert from 'assert';

import {
  materializeAdoptedDesignerRightsTarget,
  projectAdoptedDesignerRightsPair,
  type AdoptedDesignerRightsProjectionInput,
} from '../../../src/compareMerge/extensions/adoptedDesignerRightsProjection';
import type { AdoptedDesignerDirection } from '../../../src/compareMerge/extensions/adoptedDesignerProjection';
import { elementChildren, parseXmlDocument } from '../../../src/compareMerge/xml/xmlDom';
import { namespaceUriForName, normalizeQNameValue } from '../../../src/compareMerge/adapters/semanticXml/semanticXmlIdentity';

const NS = 'http://v8.1c.ru/8.2/roles';

suite('Adopted Designer Rights.xml projection (#335)', () => {
  test('projects borrowed and own sides in all three directions', () => {
    for (const direction of ['cf-to-adopted', 'adopted-to-cf', 'adopted-to-adopted'] as const) {
      const input = makeInput({ direction });
      const result = projectAdoptedDesignerRightsPair(input);

      assert.strictEqual(result.ok, true, `${direction}: ${result.ok ? '' : result.reason}`);
      if (!result.ok) { continue; }
      assert.ok(Buffer.isBuffer(result.targetXml));
      assert.ok(Buffer.isBuffer(result.sourceXml));
      assert.deepStrictEqual(result.issues, []);
    }
  });

  test('materializes the target according to each direction and marks only adopted targets Extended', () => {
    for (const direction of ['cf-to-adopted', 'adopted-to-cf', 'adopted-to-adopted'] as const) {
      const input = makeInput({ direction, targetRightsXml: rightsXml({ read: false }) });
      const projected = projectAdoptedDesignerRightsPair(input);
      assert.strictEqual(projected.ok, true, `${direction}: ${projected.ok ? '' : projected.reason}`);
      if (!projected.ok) { continue; }

      const materialized = materializeAdoptedDesignerRightsTarget({ ...input, mergedLogicalTarget: projected.targetXml });

      assert.strictEqual(materialized.ok, true, `${direction}: ${materialized.ok ? '' : materialized.reason}`);
      if (!materialized.ok) { continue; }
      assert.strictEqual(materialized.requiresRightsPropertyState, direction !== 'adopted-to-cf');
      if (direction === 'adopted-to-cf') {
        assert.deepStrictEqual(materialized.content, projected.targetXml,
          'an own target keeps the merged logical target unchanged and needs no Extended marker');
      }
    }
  });

  test('uses the captured base value when an adopted file omits a right', () => {
    const baseXml = rightsXml({ read: true, includeUpdate: false, defaultValue: true });
    const sourceXml = rightsXml({ read: false });
    const input = makeInput({
      direction: 'adopted-to-adopted',
      baseRightsXml: baseXml,
      targetRightsXml: rightsXml({ read: false }),
      sourceRightsXml: rightsXml({ read: true, includeRead: false }),
    });

    const result = projectAdoptedDesignerRightsPair(input);

    assert.strictEqual(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) { return; }
    assert.match(result.sourceXml.toString('utf8'), /<right><name>Read<\/name><value>true<\/value><\/right>/u,
      'an omitted adopted source right inherits the captured base value');
    assert.match(result.targetXml.toString('utf8'), /<right><name>Read<\/name><value>false<\/value><\/right>/u,
      'an explicit adopted deny remains explicit in the logical projection');
    assert.match(sourceXml.toString('utf8'), /<name>Read<\/name><value>false<\/value>/u,
      'projection does not mutate its input buffer');
  });

  test('uses a false base default for an omitted adopted right', () => {
    const baseRightsXml = rightsXml({ read: true, includeRead: false, defaultValue: false });
    const input = makeInput({
      direction: 'adopted-to-adopted',
      baseRightsXml,
      targetRightsXml: rightsXml({ read: true }),
      sourceRightsXml: rightsXml({ read: false, includeRead: false }),
    });

    const result = projectAdoptedDesignerRightsPair(input);

    assert.strictEqual(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) { return; }
    assert.match(result.sourceXml.toString('utf8'), /<setForNewObjects>false<\/setForNewObjects>/u);
    assert.doesNotMatch(result.sourceXml.toString('utf8'), /<right><name>Read<\/name>/u,
      'omission remains false under the captured false default without inventing an explicit deny');
    assert.ok(!result.issues.some((issue) => issue.scope === 'right' && issue.rightName === 'Read'));
  });

  test('resolves omitted object rights with the captured defaults in each supported format version', () => {
    for (const formatVersion of ['2.19', '2.20', '2.21']) {
      const versioned = (xml: Buffer) => Buffer.from(
        xml.toString('utf8').replace('version="2.20"', `version="${formatVersion}"`),
      );
      const baseRightsXml = versioned(rightsXml({ read: true, includeRead: false, defaultValue: false }));
      const input = {
        ...makeInput({
          direction: 'cf-to-adopted',
          baseRightsXml,
          targetRightsXml: versioned(rightsXml({ read: true, includeRead: false, defaultValue: true })),
          sourceRightsXml: versioned(rightsXml({ read: true })),
        }),
        formatVersion,
      };

      const result = projectAdoptedDesignerRightsPair(input);

      assert.strictEqual(result.ok, true, `${formatVersion}: ${result.ok ? '' : result.reason}`);
      if (!result.ok) { continue; }
      assert.doesNotMatch(result.targetXml.toString('utf8'), /<right><name>Read<\/name>/u,
        `${formatVersion}: omitted Read remains false under the captured base default`);
      assert.match(result.targetXml.toString('utf8'), /<setForNewObjects>false<\/setForNewObjects>/u);
      assert.ok(!result.issues.some((issue) => issue.scope === 'right' && issue.rightName === 'Read'), formatVersion);
    }
  });

  test('inherits the captured base document when an adopted side has no physical file', () => {
    const baseRightsXml = rightsXml({ read: true });
    const result = projectAdoptedDesignerRightsPair(makeInput({
      direction: 'adopted-to-adopted',
      baseRightsXml,
      targetRightsXml: undefined,
      sourceRightsXml: undefined,
    }));

    assert.strictEqual(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) { return; }
    assert.deepStrictEqual(result.targetXml, baseRightsXml);
    assert.deepStrictEqual(result.sourceXml, baseRightsXml);
  });

  test('fails closed when either own side has no physical Rights.xml', () => {
    const cases: readonly [AdoptedDesignerDirection, 'target' | 'source'][] = [
      ['cf-to-adopted', 'source'],
      ['adopted-to-cf', 'target'],
    ];
    for (const [direction, missingSide] of cases) {
      const input = makeInput({ direction });
      const result = projectAdoptedDesignerRightsPair({
        ...input,
        ...(missingSide === 'target' ? { targetRightsXml: undefined } : { sourceRightsXml: undefined }),
      });
      assert.strictEqual(result.ok, false, `${direction} must fail closed without its own file`);
      if (!result.ok) { assert.match(result.reason, /own|собствен|Rights\.xml/iu); }
    }
  });

  test('rejects an unknown runtime direction', () => {
    const input = makeInput({ direction: 'cf-to-adopted' });
    const invalid = { ...input, direction: 'unknown' as AdoptedDesignerDirection };

    const result = projectAdoptedDesignerRightsPair(invalid);

    assert.strictEqual(result.ok, false);
    if (!result.ok) { assert.match(result.reason, /направлени|direction/iu); }
  });

  test('fails closed for invalid buffers, malformed XML, and an unsupported Rights root', () => {
    const input = makeInput({ direction: 'cf-to-adopted' });
    const invalidBuffer = projectAdoptedDesignerRightsPair({
      ...input,
      baseRightsXml: 'not-a-buffer' as unknown as Buffer,
    });
    assert.strictEqual(invalidBuffer.ok, false);

    const malformedXml = projectAdoptedDesignerRightsPair({
      ...input,
      targetRightsXml: Buffer.from('<Rights><broken></Rights>'),
    });
    assert.strictEqual(malformedXml.ok, false);
    if (!malformedXml.ok) { assert.ok(malformedXml.issues.some((issue) => issue.scope === 'file')); }

    const foreignRoot = projectAdoptedDesignerRightsPair({
      ...input,
      targetRightsXml: Buffer.from('<Rights xmlns="urn:vendor" version="2.20"/>'),
    });
    assert.strictEqual(foreignRoot.ok, false);

    const projected = projectAdoptedDesignerRightsPair(input);
    assert.strictEqual(projected.ok, true);
    if (!projected.ok) { return; }
    const invalidMerged = materializeAdoptedDesignerRightsTarget({
      ...input,
      mergedLogicalTarget: Buffer.from('<Rights><broken></Rights>'),
    });
    assert.strictEqual(invalidMerged.ok, false);
  });

  test('rejects unsupported Rights versions while allowing explicit Rights 2.17 and 2.18 data', () => {
    const versioned = (xml: Buffer, formatVersion: string) => Buffer.from(
      xml.toString('utf8').replace(/version="2\.20"/gu, `version="${formatVersion}"`),
    );
    const explicitRights = rightsXml({
      read: false,
      defaultValue: false,
      attributesDefault: false,
      independentChildren: false,
    });
    const unknownVersion = '2.99';
    const unsupported = projectAdoptedDesignerRightsPair({
      ...makeInput({ direction: 'adopted-to-adopted' }),
      formatVersion: unknownVersion,
      baseRightsXml: versioned(explicitRights, unknownVersion),
      targetRightsXml: versioned(explicitRights, unknownVersion),
      sourceRightsXml: versioned(explicitRights, unknownVersion),
    });
    assert.strictEqual(unsupported.ok, false, 'unknown Rights semantics fail closed');

    for (const formatVersion of ['2.17', '2.18']) {
      const supportedXml = versioned(explicitRights, formatVersion);
      const supported = projectAdoptedDesignerRightsPair({
        ...makeInput({
          direction: 'adopted-to-adopted',
          baseRightsXml: supportedXml,
          targetRightsXml: supportedXml,
          sourceRightsXml: supportedXml,
        }),
        formatVersion,
      });
      assert.strictEqual(supported.ok, true, `${formatVersion}: ${supported.ok ? '' : supported.reason}`);
      if (supported.ok) { assert.deepStrictEqual(supported.issues, [], `${formatVersion}: explicit values are known`); }

      const omittedDefault = versioned(rightsXml({ read: false, includeRead: false }), formatVersion);
      const unresolved = projectAdoptedDesignerRightsPair({
        ...makeInput({
          direction: 'cf-to-adopted',
          baseRightsXml: omittedDefault,
          targetRightsXml: omittedDefault,
          sourceRightsXml: versioned(rightsXml({ read: false }), formatVersion),
        }),
        formatVersion,
      });
      assert.strictEqual(unresolved.ok, true, `${formatVersion}: known format remains projectable`);
      if (unresolved.ok) {
        assert.ok(unresolved.issues.some((issue) => issue.scope === 'right' && issue.rightName === 'Read'),
          `${formatVersion}: no omitted-right default is assumed`);
      }
    }
  });

  test('treats a namespaced version lookalike as a missing root version', () => {
    const rightsWithLookalikeVersion = Buffer.from(rightsXml({ read: true }).toString('utf8')
      .replace(' version="2.20"', ' xmlns:vendor="urn:vendor" vendor:version="2.20"'));
    const result = projectAdoptedDesignerRightsPair(makeInput({
      direction: 'cf-to-adopted',
      targetRightsXml: rightsWithLookalikeVersion,
    }));

    assert.strictEqual(result.ok, true, result.ok ? undefined : result.reason);
    if (result.ok) {
      assert.ok(result.issues.some((issue) => issue.scope === 'file'),
        'a vendor:version attribute cannot satisfy the Designer Rights version field');
    }
  });

  test('blocks omissions without supported default semantics or inherited policy', () => {
    const omittedBase = rightsXml({ read: true, includeRead: false });
    const ownWithRead = rightsXml({ read: true });
    const oldVersion = '2.18';
    const versioned = (xml: Buffer) => Buffer.from(
      xml.toString('utf8').replace(/version="2\.20"/gu, `version="${oldVersion}"`),
    );
    const oldVersionInput = {
      ...makeInput({ direction: 'cf-to-adopted' }),
      formatVersion: oldVersion,
      baseRightsXml: versioned(omittedBase),
      targetRightsXml: versioned(omittedBase),
      sourceRightsXml: versioned(ownWithRead),
    };
    const versionResult = projectAdoptedDesignerRightsPair(oldVersionInput);
    assert.strictEqual(versionResult.ok, true, versionResult.ok ? undefined : versionResult.reason);
    if (versionResult.ok) {
      assert.ok(versionResult.issues.some((issue) => issue.scope === 'right' && issue.rightName === 'Read'));
    }

    const missingPolicy = Buffer.from(omittedBase.toString('utf8')
      .replace('<setForNewObjects>true</setForNewObjects>', ''));
    const policyResult = projectAdoptedDesignerRightsPair({
      ...makeInput({ direction: 'cf-to-adopted' }),
      baseRightsXml: missingPolicy,
      targetRightsXml: missingPolicy,
      sourceRightsXml: ownWithRead,
    });
    assert.strictEqual(policyResult.ok, true, policyResult.ok ? undefined : policyResult.reason);
    if (policyResult.ok) {
      assert.ok(policyResult.issues.some((issue) => issue.scope === 'policy' && issue.policyName === 'setForNewObjects'));
      assert.ok(policyResult.issues.some((issue) => issue.scope === 'right' && issue.rightName === 'Read'));
    }
  });

  test('materializes allow and deny only when they differ from the base effective value', () => {
    for (const desired of [true, false]) {
      const baseRightsXml = rightsXml({ read: true });
      const targetRightsXml = rightsXml({ read: false });
      const input = makeInput({ direction: 'cf-to-adopted', baseRightsXml, targetRightsXml });
      const projected = projectAdoptedDesignerRightsPair(input);
      assert.strictEqual(projected.ok, true);
      if (!projected.ok) { continue; }
      const mergedLogicalTarget = Buffer.from(
        projected.targetXml.toString('utf8').replace(/(<name>Read<\/name><value>)(?:true|false)(<\/value>)/u, `$1${desired}$2`),
      );

      const materialized = materializeAdoptedDesignerRightsTarget({ ...input, mergedLogicalTarget });

      assert.strictEqual(materialized.ok, true, materialized.ok ? undefined : materialized.reason);
      if (!materialized.ok) { continue; }
      assert.strictEqual(materialized.requiresRightsPropertyState, true);
      if (desired === true) {
        assert.doesNotMatch(materialized.content.toString('utf8'), /<right><name>Read<\/name>/u,
          'desired base allow removes the explicit deny and returns to inheritance');
      } else {
        assert.match(materialized.content.toString('utf8'), /<right><name>Read<\/name><value>false<\/value><\/right>/u,
          'desired deny against a base allow stays an explicit boolean override');
      }
    }
  });

  test('creates a missing target override file with the captured base policy', () => {
    const baseRightsXml = rightsXml({ read: true, defaultValue: true, attributesDefault: false, independentChildren: true });
    const input = makeInput({ direction: 'cf-to-adopted', baseRightsXml, targetRightsXml: undefined });
    const projected = projectAdoptedDesignerRightsPair(input);
    assert.strictEqual(projected.ok, true, projected.ok ? undefined : projected.reason);
    if (!projected.ok) { return; }
    const mergedLogicalTarget = Buffer.from(
      projected.targetXml.toString('utf8').replace(/(<name>Read<\/name><value>)true(<\/value>)/u, '$1false$2'),
    );

    const result = materializeAdoptedDesignerRightsTarget({ ...input, mergedLogicalTarget });

    assert.strictEqual(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) { return; }
    const xml = result.content.toString('utf8');
    assert.strictEqual(result.requiresRightsPropertyState, true);
    assert.match(xml, /<setForNewObjects>true<\/setForNewObjects>/u);
    assert.match(xml, /<setForAttributesByDefault>false<\/setForAttributesByDefault>/u);
    assert.match(xml, /<independentRightsOfChildObjects>true<\/independentRightsOfChildObjects>/u);
    assert.match(xml, /<right><name>Read<\/name><value>false<\/value><\/right>/u);
  });

  test('does not copy inherited RLS or unknown content into a newly created target override', () => {
    const baseRightsXml = Buffer.from(rightsXml({ read: true }).toString('utf8')
      .replace('<Rights ', '<!--prolog-secret--><Rights ')
      .replace('version="2.20"', 'version="2.20" vendor="root-secret"')
      .replace('</object>', '<right><name>Update</name><value>true</value><restrictionByCondition><condition>secret</condition></restrictionByCondition></right></object>')
      .replace('</Rights>', '<restrictionTemplate><name>Products</name><template>secret-template</template></restrictionTemplate><vendor:extension xmlns:vendor="urn:vendor">opaque</vendor:extension></Rights><!--epilog-secret-->'));
    const input = makeInput({ direction: 'cf-to-adopted', baseRightsXml, targetRightsXml: undefined });
    const projected = projectAdoptedDesignerRightsPair(input);
    assert.strictEqual(projected.ok, true, projected.ok ? undefined : projected.reason);
    if (!projected.ok) { return; }
    const mergedLogicalTarget = Buffer.from(
      projected.targetXml.toString('utf8').replace('<name>Read</name><value>true</value>', '<name>Read</name><value>false</value>'),
    );

    const result = materializeAdoptedDesignerRightsTarget({ ...input, mergedLogicalTarget });

    assert.strictEqual(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) { return; }
    const xml = result.content.toString('utf8');
    assert.ok(xml.includes('<right><name>Read</name><value>false</value></right>'),
      'only the selected explicit override belongs in the new physical file');
    assert.ok(result.issues.some((issue) => issue.scope === 'right' && issue.rightName === 'Update'),
      'inherited RLS is reported as scoped and read-only');
    assert.doesNotMatch(xml, /<restrictionByCondition|<restrictionTemplate|vendor:extension|root-secret|prolog-secret|epilog-secret/u,
      'inherited RLS and unknown content stay in the logical comparison view');
  });

  test('keeps existing target RLS nodes byte-for-byte when an unrelated simple right changes', () => {
    const rls = '<right><name>Update</name><value>true</value><restrictionByCondition><condition>target-secret</condition></restrictionByCondition></right>';
    const targetRightsXml = rightsXml({ read: false, extra: rls });
    const input = makeInput({ direction: 'cf-to-adopted', targetRightsXml });
    const projected = projectAdoptedDesignerRightsPair(input);
    assert.strictEqual(projected.ok, true, projected.ok ? undefined : projected.reason);
    if (!projected.ok) { return; }
    const mergedLogicalTarget = Buffer.from(
      projected.targetXml.toString('utf8').replace('<name>Read</name><value>false</value>', '<name>Read</name><value>true</value>'),
    );

    const result = materializeAdoptedDesignerRightsTarget({ ...input, mergedLogicalTarget });

    assert.strictEqual(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) { return; }
    assert.ok(result.content.toString('utf8').includes(rls), 'the physical RLS node is untouched');
    assert.ok(result.issues.some((issue) => issue.scope === 'right' && issue.rightName === 'Update'));
  });

  test('preserves an unchanged explicit base-equal target override when another right changes', () => {
    const baseRightsXml = rightsXml({ read: true });
    const targetRightsXml = rightsXml({ read: true });
    const input = makeInput({ direction: 'cf-to-adopted', baseRightsXml, targetRightsXml });
    const projected = projectAdoptedDesignerRightsPair(input);
    assert.strictEqual(projected.ok, true, projected.ok ? undefined : projected.reason);
    if (!projected.ok) { return; }
    const mergedLogicalTarget = Buffer.from(
      projected.targetXml.toString('utf8').replace('<name>Update</name><value>false</value>', '<name>Update</name><value>true</value>'),
    );

    const result = materializeAdoptedDesignerRightsTarget({ ...input, mergedLogicalTarget });

    assert.strictEqual(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) { return; }
    assert.ok(result.content.toString('utf8').includes('<right><name>Read</name><value>true</value></right>'),
      'an unselected explicit override must keep its physical representation');
    assert.ok(result.content.toString('utf8').includes('<right><name>Update</name><value>true</value></right>'));
  });

  test('preserves target-only overrides and unknown untouched content on a no-op', () => {
    const targetRightsXml = rightsXml({ read: false, targetOnly: true, extra: '<!--keep-this-comment--><vendor:note xmlns:vendor="urn:vendor">opaque</vendor:note>' });
    const input = makeInput({ direction: 'cf-to-adopted', targetRightsXml });
    const projected = projectAdoptedDesignerRightsPair(input);
    assert.strictEqual(projected.ok, true, projected.ok ? undefined : projected.reason);
    if (!projected.ok) { return; }

    const result = materializeAdoptedDesignerRightsTarget({ ...input, mergedLogicalTarget: projected.targetXml });

    assert.strictEqual(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) { return; }
    assert.match(result.content.toString('utf8'), /<right><name>TargetOnly<\/name><value>true<\/value><\/right>/u);
    assert.match(result.content.toString('utf8'), /<!--keep-this-comment-->/u);
    assert.match(result.content.toString('utf8'), /<vendor:note xmlns:vendor="urn:vendor">opaque<\/vendor:note>/u);
  });

  test('removes a changed target-only override when its selected value returns to the base default', () => {
    const targetRightsXml = rightsXml({ read: true, targetOnly: false });
    const input = makeInput({ direction: 'cf-to-adopted', targetRightsXml });
    const projected = projectAdoptedDesignerRightsPair(input);
    assert.strictEqual(projected.ok, true, projected.ok ? undefined : projected.reason);
    if (!projected.ok) { return; }
    const mergedLogicalTarget = Buffer.from(
      projected.targetXml.toString('utf8').replace(/(<name>TargetOnly<\/name><value>)false(<\/value>)/u, '$1true$2'),
    );

    const result = materializeAdoptedDesignerRightsTarget({ ...input, mergedLogicalTarget });

    assert.strictEqual(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) { return; }
    assert.doesNotMatch(result.content.toString('utf8'), /<right><name>TargetOnly<\/name>/u);
  });

  test('keeps a deterministic no-op roundtrip in the target physical shape', () => {
    const targetRightsXml = rightsXml({ read: false, targetOnly: false, extra: '<!--stable-->' });
    const input = makeInput({ direction: 'cf-to-adopted', targetRightsXml });
    const projected = projectAdoptedDesignerRightsPair(input);
    assert.strictEqual(projected.ok, true, projected.ok ? undefined : projected.reason);
    if (!projected.ok) { return; }

    const first = materializeAdoptedDesignerRightsTarget({ ...input, mergedLogicalTarget: projected.targetXml });
    assert.strictEqual(first.ok, true, first.ok ? undefined : first.reason);
    if (!first.ok) { return; }
    const second = materializeAdoptedDesignerRightsTarget({ ...input, mergedLogicalTarget: projected.targetXml });
    assert.strictEqual(second.ok, true, second.ok ? undefined : second.reason);
    if (!second.ok) { return; }
    assert.deepStrictEqual(first.content, second.content);
  });

  test('returns scoped policy issues and preserves the target policy flags', () => {
    const targetRightsXml = rightsXml({ read: false, independentChildren: true });
    const input = makeInput({ direction: 'cf-to-adopted', targetRightsXml });
    const projected = projectAdoptedDesignerRightsPair(input);
    assert.strictEqual(projected.ok, true, projected.ok ? undefined : projected.reason);
    if (!projected.ok) { return; }
    const mergedLogicalTarget = Buffer.from(projected.targetXml.toString('utf8').replace('independentRightsOfChildObjects>false', 'independentRightsOfChildObjects>true'));

    const result = materializeAdoptedDesignerRightsTarget({ ...input, mergedLogicalTarget });

    assert.strictEqual(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) { return; }
    assert.ok(result.issues.some((issue) => issue.scope === 'policy' && issue.policyName === 'independentRightsOfChildObjects'));
    assert.match(result.content.toString('utf8'), /<independentRightsOfChildObjects>true<\/independentRightsOfChildObjects>/u);
  });

  test('reports mismatched file versions, malformed booleans, duplicates, RLS, and unresolved nested omissions', () => {
    const nestedName = 'Catalog.Products.Attribute.Color';
    const nestedBase = Buffer.from(rightsXml({ read: true }).toString('utf8').replace('Catalog.Products', nestedName));
    const cases: readonly { readonly xml: Buffer; readonly baseRightsXml?: Buffer; readonly expected: 'file' | 'right' }[] = [
      { xml: Buffer.from(rightsXml({ read: false }).toString('utf8').replace('version="2.20"', 'version="2.19"')), expected: 'file' },
      { xml: Buffer.from(rightsXml({ read: false }).toString('utf8').replace('<value>false</value>', '<value>TRUE</value>')), expected: 'right' },
      { xml: Buffer.from(rightsXml({ read: false }).toString('utf8').replace('</object>', '<right><name>Read</name><value>true</value></right></object>')), expected: 'right' },
      { xml: Buffer.from(rightsXml({ read: false }).toString('utf8').replace('<value>false</value>', '<value>false</value><restrictionByCondition/>')), expected: 'right' },
      {
        baseRightsXml: nestedBase,
        xml: Buffer.from(rightsXml({ read: false, attributesDefault: true }).toString('utf8').replace('Catalog.Products', nestedName)),
        expected: 'right',
      },
    ];

    for (const [index, item] of cases.entries()) {
      const result = projectAdoptedDesignerRightsPair(makeInput({
        direction: 'cf-to-adopted',
        ...(item.baseRightsXml ? { baseRightsXml: item.baseRightsXml } : {}),
        targetRightsXml: item.xml,
      }));
      assert.strictEqual(result.ok, true, `case ${index}: ${result.ok ? '' : result.reason}`);
      if (!result.ok) { continue; }
      assert.ok(result.issues.some((issue) => issue.scope === item.expected), `case ${index} should report ${item.expected}`);
    }
  });

  test('preserves inherited duplicate rights and duplicate RLS templates while reporting scoped issues', () => {
    const baseRightsXml = Buffer.from(rightsXml({ read: true }).toString('utf8')
      .replace('</object>', '<right><name>Read</name><value>false</value></right><vendor:opaque xmlns:vendor="urn:vendor">value</vendor:opaque><vendor:opaque xmlns:vendor="urn:vendor">value</vendor:opaque></object>')
      .replace('</Rights>', '<restrictionTemplate><name>Products</name><template>first</template></restrictionTemplate><restrictionTemplate><name>Products</name><template>second</template></restrictionTemplate><vendor:rootOpaque xmlns:vendor="urn:vendor">value</vendor:rootOpaque><vendor:rootOpaque xmlns:vendor="urn:vendor">value</vendor:rootOpaque></Rights>'));
    const targetRightsXml = rightsXml({ read: true, includeRead: false });

    const result = projectAdoptedDesignerRightsPair(makeInput({
      direction: 'cf-to-adopted',
      baseRightsXml,
      targetRightsXml,
    }));

    assert.strictEqual(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) { return; }
    const logical = result.targetXml.toString('utf8');
    assert.strictEqual((logical.match(/<right><name>Read<\/name>/gu) ?? []).length, 2,
      'both ambiguous inherited right records remain in the logical view');
    assert.strictEqual((logical.match(/<restrictionTemplate>/gu) ?? []).length, 2,
      'both ambiguous inherited RLS templates remain in the logical view');
    assert.strictEqual((logical.match(/<vendor:opaque/g) ?? []).length, 2,
      'duplicate unknown object nodes remain in the logical view');
    assert.strictEqual((logical.match(/<vendor:rootOpaque/g) ?? []).length, 2,
      'duplicate unknown root nodes remain in the logical view');
    assert.ok(result.issues.some((issue) => issue.scope === 'right' && issue.rightName === 'Read'));
    assert.ok(result.issues.some((issue) => issue.scope === 'file'));
  });

  test('preserves inherited namespace and QName bindings across aliases and target prefix collisions', () => {
    const scenarios = [
      {
        name: 'different source and target role aliases',
        base: `<b:Rights xmlns:b="${NS}" xmlns:u="urn:base" version="2.20"><b:setForNewObjects>true</b:setForNewObjects><b:object><b:name>Catalog.Products</b:name></b:object><b:restrictionTemplate><u:opaque type="u:OpaqueType">u:ElementType</u:opaque></b:restrictionTemplate></b:Rights>`,
        target: `<t:Rights xmlns:t="${NS}" xmlns:u="urn:target" version="2.20"><t:setForNewObjects>true</t:setForNewObjects><t:object><t:name>Catalog.Products</t:name></t:object></t:Rights>`,
        templateNamespace: NS,
        opaqueNamespace: 'urn:base',
        qnameNamespace: 'urn:base',
      },
      {
        name: 'target role prefix collides with a source opaque prefix',
        base: `<Rights xmlns="${NS}" xmlns:u="urn:base" version="2.20"><setForNewObjects>true</setForNewObjects><object><name>Catalog.Products</name></object><restrictionTemplate><u:opaque type="u:OpaqueType">u:ElementType</u:opaque></restrictionTemplate></Rights>`,
        target: `<u:Rights xmlns="${NS}" xmlns:u="${NS}" version="2.20"><setForNewObjects>true</setForNewObjects><object><name>Catalog.Products</name></object></u:Rights>`,
        templateNamespace: NS,
        opaqueNamespace: 'urn:base',
        qnameNamespace: 'urn:base',
      },
      {
        name: 'target default role namespace collides with source opaque default namespace',
        base: `<b:Rights xmlns:b="${NS}" xmlns="urn:base" xmlns:u="urn:base-types" version="2.20"><b:setForNewObjects>true</b:setForNewObjects><b:object><b:name>Catalog.Products</b:name></b:object><b:restrictionTemplate><opaque type="u:OpaqueType">u:ElementType</opaque></b:restrictionTemplate></b:Rights>`,
        target: `<Rights xmlns="${NS}" version="2.20"><setForNewObjects>true</setForNewObjects><object><name>Catalog.Products</name></object></Rights>`,
        templateNamespace: NS,
        opaqueNamespace: 'urn:base',
        qnameNamespace: 'urn:base-types',
      },
    ] as const;

    const observations: {
      readonly name: string;
      readonly templateNamespace?: string;
      readonly opaqueNamespace?: string;
      readonly attributeQName?: string;
      readonly textQName?: string;
      readonly reason?: string;
    }[] = [];
    for (const scenario of scenarios) {
      const result = projectAdoptedDesignerRightsPair(makeInput({
        direction: 'cf-to-adopted',
        baseRightsXml: Buffer.from(scenario.base),
        targetRightsXml: Buffer.from(scenario.target),
      }));

      if (!result.ok) {
        observations.push({ name: scenario.name, reason: result.reason });
        continue;
      }
      const logical = parseXmlDocument(result.targetXml.toString('utf8'));
      const template = elementChildren(logical.root).find((element) => element.localName === 'restrictionTemplate');
      if (!template) {
        observations.push({ name: scenario.name, reason: 'missing restrictionTemplate' });
        continue;
      }
      const opaque = elementChildren(template).find((element) => element.localName === 'opaque');
      if (!opaque) {
        observations.push({ name: scenario.name, reason: 'missing opaque node' });
        continue;
      }
      const typedQName = opaque.attributes.find((attribute) => attribute.localName === 'type')?.value;
      const typedText = opaque.children.find((child) => child.kind === 'text')?.text ?? '';
      observations.push({
        name: scenario.name,
        templateNamespace: namespaceUriForName(template),
        opaqueNamespace: namespaceUriForName(opaque),
        attributeQName: typedQName ? normalizeQNameValue(typedQName, opaque) : undefined,
        textQName: normalizeQNameValue(typedText, opaque),
      });
    }
    assert.deepStrictEqual(observations, scenarios.map((scenario) => ({
      name: scenario.name,
      templateNamespace: scenario.templateNamespace,
      opaqueNamespace: scenario.opaqueNamespace,
      attributeQName: `{${scenario.qnameNamespace}}OpaqueType`,
      textQName: `{${scenario.qnameNamespace}}ElementType`,
    })));
  });

  test('keeps a physical empty override file and Extended state after returning the last right to inheritance', () => {
    const baseRightsXml = rightsXml({ read: true });
    const targetRightsXml = rightsXml({ read: false });
    const input = makeInput({ direction: 'cf-to-adopted', baseRightsXml, targetRightsXml });
    const projected = projectAdoptedDesignerRightsPair(input);
    assert.strictEqual(projected.ok, true);
    if (!projected.ok) { return; }
    const mergedLogicalTarget = Buffer.from(
      projected.targetXml.toString('utf8').replace(/(<name>Read<\/name><value>)false(<\/value>)/u, '$1true$2'),
    );

    const result = materializeAdoptedDesignerRightsTarget({ ...input, mergedLogicalTarget });

    assert.strictEqual(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) { return; }
    assert.strictEqual(result.requiresRightsPropertyState, true);
    assert.match(result.content.toString('utf8'), /<Rights/u);
    assert.doesNotMatch(result.content.toString('utf8'), /<right><name>Read<\/name>/u);
  });
});

function makeInput(
  overrides: {
    readonly direction?: AdoptedDesignerDirection;
    readonly baseRightsXml?: Buffer;
    readonly targetRightsXml?: Buffer;
    readonly sourceRightsXml?: Buffer;
  } = {},
): AdoptedDesignerRightsProjectionInput {
  const direction = overrides.direction ?? 'cf-to-adopted';
  const baseRightsXml = overrides.baseRightsXml ?? rightsXml({ read: true });
  const targetAdopted = direction !== 'adopted-to-cf';
  const sourceAdopted = direction !== 'cf-to-adopted';
  return {
    direction,
    formatVersion: '2.20',
    baseRightsXml,
    targetRightsXml: Object.prototype.hasOwnProperty.call(overrides, 'targetRightsXml')
      ? overrides.targetRightsXml
      : targetAdopted ? rightsXml({ read: true }) : rightsXml({ read: true }),
    sourceRightsXml: Object.prototype.hasOwnProperty.call(overrides, 'sourceRightsXml')
      ? overrides.sourceRightsXml
      : sourceAdopted ? rightsXml({ read: true }) : rightsXml({ read: true }),
  };
}

function rightsXml(options: {
  readonly read: boolean;
  readonly includeRead?: boolean;
  readonly includeUpdate?: boolean;
  readonly targetOnly?: boolean;
  readonly defaultValue?: boolean;
  readonly attributesDefault?: boolean;
  readonly independentChildren?: boolean;
  readonly extra?: string;
}): Buffer {
  const right = options.includeRead === false ? '' : `<right><name>Read</name><value>${options.read}</value></right>`;
  const update = options.includeUpdate === false ? '' : '<right><name>Update</name><value>false</value></right>';
  const targetOnly = options.targetOnly === undefined ? '' : `<right><name>TargetOnly</name><value>${options.targetOnly}</value></right>`;
  const xml = `<Rights xmlns="${NS}" version="2.20"><setForNewObjects>${options.defaultValue ?? true}</setForNewObjects><setForAttributesByDefault>${options.attributesDefault ?? false}</setForAttributesByDefault><independentRightsOfChildObjects>${options.independentChildren ?? false}</independentRightsOfChildObjects><object><name>Catalog.Products</name>${right}${update}${targetOnly}${options.extra ?? ''}</object></Rights>`;
  return Buffer.from(xml, 'utf8');
}
