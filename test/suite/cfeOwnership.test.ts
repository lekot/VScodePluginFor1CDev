import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import {
  CfeOwnershipError,
  CfeOwnershipGuard,
  parseCfeObjectIdentity,
} from '../../src/extensionSupport/cfeProject';

const FIXTURES = path.join(__dirname, '../fixtures/cfe-ownership');

suite('CFE ownership', () => {
  test('parses own and adopted Designer XML fixtures for formats 2.17 through 2.21', () => {
    const cases: Array<{ readonly format: string; readonly file: string; readonly ownership: 'own' | 'adopted' }> = [
      { format: '2.17', file: 'own.xml', ownership: 'own' },
      { format: '2.18', file: 'adopted.xml', ownership: 'adopted' },
      { format: '2.19', file: 'own.xml', ownership: 'own' },
      { format: '2.20', file: 'adopted.xml', ownership: 'adopted' },
      { format: '2.21', file: 'own.xml', ownership: 'own' },
    ];

    for (const testCase of cases) {
      const xml = fs.readFileSync(path.join(FIXTURES, testCase.format, testCase.file), 'utf8');
      const identity = parseCfeObjectIdentity(xml, `Catalogs/${testCase.format}.xml`);
      assert.strictEqual(identity.ownership, testCase.ownership);
      assert.strictEqual(identity.type, 'Catalog');
      assert.strictEqual(identity.path, `Catalogs/${testCase.format}.xml`);
      assert.match(identity.uuid, /^[0-9a-f-]{36}$/iu);
      if (testCase.ownership === 'adopted') {
        assert.match(identity.sourceUuid!, /^[0-9a-f-]{36}$/iu);
      } else {
        assert.strictEqual(identity.sourceUuid, undefined);
      }
    }
  });

  test('rejects partial, unknown and zero-UUID ownership combinations', () => {
    const partial = fs.readFileSync(path.join(FIXTURES, 'invalid-partial.xml'), 'utf8');
    assertOwnershipInvalid(partial);
    assertOwnershipInvalid(objectXml('<ObjectBelonging>Own</ObjectBelonging><Name>Cfe_Unknown</Name>'));
    assertOwnershipInvalid(objectXml('<Name>Cfe_Partial</Name><ExtendedConfigurationObject>aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa</ExtendedConfigurationObject>'));
    assertOwnershipInvalid(objectXml('<ObjectBelonging>Adopted</ObjectBelonging><Name>Cfe_Zero</Name><ExtendedConfigurationObject>00000000-0000-0000-0000-000000000000</ExtendedConfigurationObject>'));
  });

  test('allows generic mutation only for own objects', () => {
    const guard = new CfeOwnershipGuard();
    const own = parseCfeObjectIdentity(objectXml('<Name>Cfe_Own</Name>'), 'Catalogs/Cfe_Own.xml');
    for (const operation of ['update', 'delete', 'rename'] as const) {
      assert.doesNotThrow(() => guard.assertGenericMutationAllowed(own, operation));
    }

    const adopted = parseCfeObjectIdentity(
      objectXml('<ObjectBelonging>Adopted</ObjectBelonging><Name>Cfe_Adopted</Name><ExtendedConfigurationObject>aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa</ExtendedConfigurationObject>'),
      'Catalogs/Cfe_Adopted.xml',
    );
    for (const operation of ['update', 'delete', 'rename'] as const) {
      assert.throws(
        () => guard.assertGenericMutationAllowed(adopted, operation),
        (error: unknown) => error instanceof CfeOwnershipError && error.code === 'CFE_ADOPTED_OPERATION_REQUIRED',
      );
    }
  });

  test('enforces NamePrefix and shared reserved-name validation for own creates', () => {
    const guard = new CfeOwnershipGuard();
    assert.doesNotThrow(() => guard.assertOwnCreateName('Cfe_Products', { namePrefix: 'Cfe_' }));
    assert.throws(
      () => guard.assertOwnCreateName('Products', { namePrefix: 'Cfe_' }),
      (error: unknown) => error instanceof CfeOwnershipError && error.code === 'CFE_OWNERSHIP_INVALID',
    );
    assert.throws(
      () => guard.assertOwnCreateName('Procedure', { namePrefix: '' }),
      (error: unknown) => error instanceof CfeOwnershipError && error.code === 'CFE_OWNERSHIP_INVALID',
    );
    assert.throws(
      () => guard.assertOwnCreateName('Cfe_Products', { namePrefix: '1Cfe_' }),
      (error: unknown) => error instanceof CfeOwnershipError && error.code === 'CFE_OWNERSHIP_INVALID',
    );
  });
});

function assertOwnershipInvalid(xml: string): void {
  assert.throws(
    () => parseCfeObjectIdentity(xml, 'Catalogs/Invalid.xml'),
    (error: unknown) => error instanceof CfeOwnershipError && error.code === 'CFE_OWNERSHIP_INVALID',
  );
}

function objectXml(properties: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><MetaDataObject version="2.21"><Catalog uuid="11111111-1111-4111-8111-111111111111"><Properties>${properties}</Properties></Catalog></MetaDataObject>`;
}
