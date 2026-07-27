import * as assert from 'assert';
import { createHash } from 'crypto';
import {
  ParentConfigurationsCodec,
  type SupportTokenPatch,
} from '../../src/support/parentConfigurationsCodec';
import { SupportMutationError } from '../../src/support/supportTypes';
import {
  SUPPORT_TEST_CONFIGURATION_ID,
  SUPPORT_UUIDS,
  buildParentConfigurations,
  parseReadyDocument,
  syntheticSupplier,
} from './supportTestFixtures';

suite('ParentConfigurationsCodec', () => {
  test('parses revision 6 exactly, preserves source bytes and decodes quoted strings/BOM', () => {
    const bytes = buildParentConfigurations({
      bom: true,
      separator: ', \r\n',
      suppliers: [syntheticSupplier({
        vendor: 'Vendor, "Quoted"',
        name: 'Parent "A"',
      })],
    });
    const document = parseReadyDocument(bytes);
    assert.deepStrictEqual(Buffer.from(document.bytes), bytes);
    assert.notStrictEqual(document.bytes, document.bytes, 'bytes getter must return defensive copies');
    assert.strictEqual(document.state.kind, 'ready');
    if (document.state.kind !== 'ready') {
      return;
    }
    const snapshot = document.state.snapshot;
    assert.strictEqual(snapshot.formatRevision, '6');
    assert.strictEqual(snapshot.generationId, createHash('sha256').update(bytes).digest('hex'));
    assert.strictEqual(snapshot.globalEditability, 'enabled');
    assert.strictEqual(snapshot.configurationMode, 'locked');
    assert.deepStrictEqual(snapshot.supplierConfigurations, [{
      supplierConfigurationId: SUPPORT_UUIDS.supplierA,
      blockEditability: 'enabled',
      version: '1.0',
      vendor: 'Vendor, "Quoted"',
      name: 'Parent "A"',
    }]);
  });

  test('maps exact 0/1/2 object tokens to effective modes without coercion', () => {
    const document = parseReadyDocument(buildParentConfigurations({
      suppliers: [syntheticSupplier({
        objects: [
          {
            mode: '0',
            localUuid: SUPPORT_UUIDS.objectA,
            vendorUuid: SUPPORT_UUIDS.vendorA,
          },
          {
            mode: '1',
            localUuid: SUPPORT_UUIDS.objectB,
            vendorUuid: SUPPORT_UUIDS.vendorB,
          },
          {
            mode: '2',
            localUuid: SUPPORT_UUIDS.objectC,
            vendorUuid: SUPPORT_UUIDS.vendorC,
          },
        ],
      })],
    }));
    assert.strictEqual(document.state.kind, 'ready');
    if (document.state.kind !== 'ready') {
      return;
    }
    const modes = document.state.snapshot.objectModes;
    assert.deepStrictEqual(
      {
        a: modes.get(SUPPORT_UUIDS.objectA),
        b: modes.get(SUPPORT_UUIDS.objectB),
        c: modes.get(SUPPORT_UUIDS.objectC),
      },
      {
        a: {
          objectId: SUPPORT_UUIDS.objectA,
          locked: true,
          effectiveMode: 'notEditable',
          sources: [{
            supplierConfigurationId: SUPPORT_UUIDS.supplierA,
            rawMode: 'notEditable',
          }],
        },
        b: {
          objectId: SUPPORT_UUIDS.objectB,
          locked: false,
          effectiveMode: 'editableWithSupport',
          sources: [{
            supplierConfigurationId: SUPPORT_UUIDS.supplierA,
            rawMode: 'editableWithSupport',
          }],
        },
        c: {
          objectId: SUPPORT_UUIDS.objectC,
          locked: false,
          effectiveMode: 'removedFromSupport',
          sources: [{
            supplierConfigurationId: SUPPORT_UUIDS.supplierA,
            rawMode: 'removedFromSupport',
          }],
        },
      },
    );
    assert.strictEqual(document.state.snapshot.configurationMode, 'mixed');
  });

  test('global and supplier block flags participate in effective locking', () => {
    const global = parseReadyDocument(buildParentConfigurations({
      globalFlag: '1',
      suppliers: [syntheticSupplier({
        objects: [{
          mode: '2',
          localUuid: SUPPORT_UUIDS.objectA,
          vendorUuid: SUPPORT_UUIDS.vendorA,
        }],
      })],
    }));
    const supplier = parseReadyDocument(buildParentConfigurations({
      suppliers: [syntheticSupplier({
        blockFlag: '1',
        objects: [{
          mode: '1',
          localUuid: SUPPORT_UUIDS.objectA,
          vendorUuid: SUPPORT_UUIDS.vendorA,
        }],
      })],
    }));
    assert.strictEqual(global.state.kind, 'ready');
    assert.strictEqual(supplier.state.kind, 'ready');
    if (global.state.kind === 'ready' && supplier.state.kind === 'ready') {
      assert.strictEqual(global.state.snapshot.objectModes.get(SUPPORT_UUIDS.objectA)?.locked, true);
      assert.strictEqual(supplier.state.snapshot.objectModes.get(SUPPORT_UUIDS.objectA)?.locked, true);
    }
  });

  test('plans exact one-byte patches for every supplier source and changes no unrelated byte', () => {
    const beforeBytes = buildParentConfigurations({
      suppliers: [
        syntheticSupplier({
          objects: [
            {
              mode: '0',
              localUuid: SUPPORT_UUIDS.objectA,
              vendorUuid: SUPPORT_UUIDS.vendorA,
            },
            {
              mode: '1',
              localUuid: SUPPORT_UUIDS.objectB,
              vendorUuid: SUPPORT_UUIDS.vendorB,
            },
          ],
        }),
        syntheticSupplier({
          supplierId: SUPPORT_UUIDS.supplierB,
          parentId: SUPPORT_UUIDS.parentB,
          name: 'Second Parent',
          objects: [{
            mode: '1',
            localUuid: SUPPORT_UUIDS.objectA,
            vendorUuid: SUPPORT_UUIDS.vendorC,
          }],
        }),
      ],
    });
    const document = parseReadyDocument(beforeBytes);
    assert.strictEqual(document.state.kind, 'ready');
    if (document.state.kind !== 'ready') {
      return;
    }
    const plan = ParentConfigurationsCodec.planObjectMode(document, {
      configurationId: SUPPORT_TEST_CONFIGURATION_ID,
      objectId: SUPPORT_UUIDS.objectA.toUpperCase(),
      targetMode: 'removedFromSupport',
      expectedGenerationId: document.state.snapshot.generationId,
    });
    assert.strictEqual(plan.patches.length, 2);
    assert.ok(plan.patches.every((patch) =>
      patch.kind === 'objectMode'
      && patch.objectId === SUPPORT_UUIDS.objectA
      && patch.after === '2'));
    assertExactPatchDiff(beforeBytes, Buffer.from(plan.afterDocument.bytes), plan.patches);
    assert.strictEqual(
      plan.after.objectModes.get(SUPPORT_UUIDS.objectA)?.effectiveMode,
      'removedFromSupport',
    );
    assert.deepStrictEqual(
      plan.after.objectModes.get(SUPPORT_UUIDS.objectB),
      plan.before.objectModes.get(SUPPORT_UUIDS.objectB),
    );
    assert.deepStrictEqual(Buffer.from(document.bytes), beforeBytes, 'planning must not mutate input');
  });

  test('no-op target produces zero patches and identical generation', () => {
    const document = parseReadyDocument(buildParentConfigurations({
      suppliers: [syntheticSupplier({
        objects: [{
          mode: '2',
          localUuid: SUPPORT_UUIDS.objectA,
          vendorUuid: SUPPORT_UUIDS.vendorA,
        }],
      })],
    }));
    assert.strictEqual(document.state.kind, 'ready');
    if (document.state.kind !== 'ready') {
      return;
    }
    const plan = ParentConfigurationsCodec.planObjectMode(document, {
      configurationId: SUPPORT_TEST_CONFIGURATION_ID,
      objectId: SUPPORT_UUIDS.objectA,
      targetMode: 'removedFromSupport',
      expectedGenerationId: document.state.snapshot.generationId,
    });
    assert.deepStrictEqual(plan.patches, []);
    assert.strictEqual(plan.after.generationId, plan.before.generationId);
    assert.deepStrictEqual(Buffer.from(plan.afterDocument.bytes), Buffer.from(document.bytes));
  });

  test('rejects stale/configuration mismatch, absent UUID and hidden object rules with typed errors', () => {
    const editable = parseReadyDocument(buildParentConfigurations());
    const locked = parseReadyDocument(buildParentConfigurations({ globalFlag: '1' }));
    assert.strictEqual(editable.state.kind, 'ready');
    assert.strictEqual(locked.state.kind, 'ready');
    if (editable.state.kind !== 'ready' || locked.state.kind !== 'ready') {
      return;
    }
    const editableGenerationId = editable.state.snapshot.generationId;
    const lockedGenerationId = locked.state.snapshot.generationId;
    assertMutationError(() => ParentConfigurationsCodec.planObjectMode(editable, {
      configurationId: SUPPORT_TEST_CONFIGURATION_ID,
      objectId: SUPPORT_UUIDS.objectA,
      targetMode: 'editableWithSupport',
      expectedGenerationId: 'stale',
    }), 'SUPPORT_STALE_GENERATION');
    assertMutationError(() => ParentConfigurationsCodec.planObjectMode(editable, {
      configurationId: 'other' as typeof SUPPORT_TEST_CONFIGURATION_ID,
      objectId: SUPPORT_UUIDS.objectA,
      targetMode: 'editableWithSupport',
      expectedGenerationId: editableGenerationId,
    }), 'SUPPORT_STALE_GENERATION');
    assertMutationError(() => ParentConfigurationsCodec.planObjectMode(editable, {
      configurationId: SUPPORT_TEST_CONFIGURATION_ID,
      objectId: '77777777-7777-4777-8777-777777777777',
      targetMode: 'editableWithSupport',
      expectedGenerationId: editableGenerationId,
    }), 'SUPPORT_OBJECT_NOT_FOUND');
    assertMutationError(() => ParentConfigurationsCodec.planObjectMode(locked, {
      configurationId: SUPPORT_TEST_CONFIGURATION_ID,
      objectId: SUPPORT_UUIDS.objectA,
      targetMode: 'editableWithSupport',
      expectedGenerationId: lockedGenerationId,
    }), 'SUPPORT_GLOBAL_EDITING_DISABLED');
  });

  test('rejects duplicate supplier, local UUID and vendor UUID deterministically', () => {
    const cases = [
      buildParentConfigurations({
        suppliers: [
          syntheticSupplier(),
          syntheticSupplier({ parentId: SUPPORT_UUIDS.parentB }),
        ],
      }),
      buildParentConfigurations({
        suppliers: [syntheticSupplier({
          objects: [
            {
              mode: '0',
              localUuid: SUPPORT_UUIDS.objectA,
              vendorUuid: SUPPORT_UUIDS.vendorA,
            },
            {
              mode: '1',
              localUuid: SUPPORT_UUIDS.objectA,
              vendorUuid: SUPPORT_UUIDS.vendorB,
            },
          ],
        })],
      }),
      buildParentConfigurations({
        suppliers: [syntheticSupplier({
          objects: [
            {
              mode: '0',
              localUuid: SUPPORT_UUIDS.objectA,
              vendorUuid: SUPPORT_UUIDS.vendorA,
            },
            {
              mode: '1',
              localUuid: SUPPORT_UUIDS.objectB,
              vendorUuid: SUPPORT_UUIDS.vendorA,
            },
          ],
        })],
      }),
    ];
    for (const bytes of cases) {
      assertUnknown(bytes, 'SUPPORT_FILE_INVALID', /Duplicate/i);
    }
  });

  test('unknown flags, malformed UUIDs and unsupported revision fail closed', () => {
    const cases: Array<[Buffer, 'SUPPORT_FILE_INVALID' | 'SUPPORT_FORMAT_UNSUPPORTED', RegExp]> = [
      [buildParentConfigurations({ revision: '7' }), 'SUPPORT_FORMAT_UNSUPPORTED', /revision: 7/],
      [buildParentConfigurations({ globalFlag: '2' }), 'SUPPORT_FILE_INVALID', /global flag/],
      [buildParentConfigurations({
        suppliers: [syntheticSupplier({ blockFlag: '2' })],
      }), 'SUPPORT_FILE_INVALID', /supplier block flag/],
      [buildParentConfigurations({
        suppliers: [syntheticSupplier({
          objects: [{
            mode: '1',
            secondaryFlag: '1',
            localUuid: SUPPORT_UUIDS.objectA,
            vendorUuid: SUPPORT_UUIDS.vendorA,
          }],
        })],
      }), 'SUPPORT_FILE_INVALID', /secondary object flag/],
      [buildParentConfigurations({
        suppliers: [syntheticSupplier({
          objects: [{
            mode: '9' as '0',
            localUuid: SUPPORT_UUIDS.objectA,
            vendorUuid: SUPPORT_UUIDS.vendorA,
          }],
        })],
      }), 'SUPPORT_FILE_INVALID', /support mode/],
      [buildParentConfigurations({
        suppliers: [syntheticSupplier({ footer: ['0', '2'] })],
      }), 'SUPPORT_FILE_INVALID', /supplier footer/],
      [buildParentConfigurations({
        tail: ['0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '2'],
      }), 'SUPPORT_FILE_INVALID', /tail/],
      [buildParentConfigurations({
        suppliers: [syntheticSupplier({ supplierId: 'not-a-uuid' })],
      }), 'SUPPORT_FILE_INVALID', /supplier configuration UUID/],
    ];
    for (const [bytes, code, diagnostic] of cases) {
      assertUnknown(bytes, code, diagnostic);
    }
  });

  test('truncated headers/blocks/tuples/footers and framing errors fail closed', () => {
    const valid = buildParentConfigurations().toString('utf8');
    const tokens = valid.slice(1, -1).split(',');
    const cases: Array<[Buffer, RegExp]> = [
      [Buffer.from('{6,0}', 'utf8'), /header is truncated/],
      [Buffer.from(`{${tokens.slice(0, 8).join(',')}}`, 'utf8'), /Supplier block 0 is truncated/],
      [Buffer.from(`{${tokens.slice(0, 12).join(',')}}`, 'utf8'), /Object tuple 0 is truncated/],
      [Buffer.from(`{${tokens.slice(0, 15).join(',')}}`, 'utf8'), /footer is truncated/],
      [buildParentConfigurations({ tail: ['0'] }), /tail \(1 tokens\)/],
      [Buffer.from(valid.slice(0, -1), 'utf8'), /closing brace is missing/],
      [Buffer.from(`${valid}x`, 'utf8'), /Unexpected bytes/],
      [Buffer.from(valid.slice(1), 'utf8'), /opening brace is missing/],
    ];
    for (const [bytes, diagnostic] of cases) {
      assertUnknown(bytes, 'SUPPORT_FILE_INVALID', diagnostic);
    }
  });
});

function assertExactPatchDiff(
  before: Buffer,
  after: Buffer,
  patches: readonly SupportTokenPatch[],
): void {
  assert.strictEqual(after.length, before.length);
  const expectedOffsets = patches.map((patch) => patch.start).sort((a, b) => a - b);
  const actualOffsets: number[] = [];
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] !== after[index]) {
      actualOffsets.push(index);
    }
  }
  assert.deepStrictEqual(actualOffsets, expectedOffsets);
  for (const patch of patches) {
    assert.strictEqual(patch.end - patch.start, 1);
    assert.strictEqual(String.fromCharCode(before[patch.start]!), patch.before);
    assert.strictEqual(String.fromCharCode(after[patch.start]!), patch.after);
  }
}

function assertUnknown(
  bytes: Uint8Array,
  errorCode: 'SUPPORT_FILE_INVALID' | 'SUPPORT_FORMAT_UNSUPPORTED',
  diagnostic: RegExp,
): void {
  const document = ParentConfigurationsCodec.parse(bytes, {
    configurationId: SUPPORT_TEST_CONFIGURATION_ID,
    filePath: 'C:/synthetic/Ext/ParentConfigurations.bin',
  });
  assert.strictEqual(document.state.kind, 'unknown');
  if (document.state.kind !== 'unknown') {
    return;
  }
  assert.strictEqual(document.state.errorCode, errorCode);
  assert.match(document.state.diagnostics.join(' '), diagnostic);
}

function assertMutationError(operation: () => unknown, code: SupportMutationError['code']): void {
  assert.throws(operation, (error: unknown) =>
    error instanceof SupportMutationError && error.code === code);
}
