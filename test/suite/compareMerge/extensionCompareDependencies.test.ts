import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';

import {
  buildConfigurationCompare,
  type ConfigurationCompareInput,
  type ConfigurationCompareResult,
} from '../../../src/compareMerge/configurationCompareService';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import {
  createExtensionCompareTempRoot,
  pathExists,
  writeCompareBytes,
  writeDesignerConfiguration,
  type ExtensionCompareConfigurationFixture,
  type ExtensionCompareObjectFixture,
} from '../../helpers/extensionCompareFixtures';

const UUID = {
  target: '11111111-1111-4111-8111-111111111111',
  source: '22222222-2222-4222-8222-222222222222',
  objectA: '33333333-3333-4333-8333-333333333333',
  objectB: '44444444-4444-4444-8444-444444444444',
  dependencyEnum: '55555555-5555-4555-8555-555555555555',
  dependencyEnumValue: '66666666-6666-4666-8666-666666666666',
  registerKey: '77777777-7777-4777-8777-777777777777',
  registerManager: '88888888-8888-4888-8888-888888888888',
  filterAlias: '99999999-9999-4999-8999-999999999999',
} as const;

suite('Extension compare dependency validation (#336)', () => {
  test('requires an incoming dependency in the selected package, while accepting A plus B', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cf');
      const source = path.join(tempRoot, 'source-cfe');
      await writeDesignerConfiguration(target, { uuid: UUID.target });
      await writeDesignerConfiguration(source, {
        uuid: UUID.source,
        purpose: 'Customization',
        namePrefix: '',
        objects: [
          catalogObject('A', UUID.objectA, catalogReferenceToB()),
          catalogObject('B', UUID.objectB),
        ],
      });

      const compare = await openCompare(tempRoot, target, source);
      try {
        const aId = nodeIdForLabel(compare.result.projection.root, 'Catalog.A');
        const bId = nodeIdForLabel(compare.result.projection.root, 'Catalog.B');
        const onlyA = await compare.result.workspace.createPreviewForNodeIds([aId]);

        assert.strictEqual(
          onlyA.ok,
          false,
          `A's cfg:CatalogRef.B dependency is absent from the target and selected package: ${JSON.stringify(onlyA)}`,
        );
        assert.ok(onlyA.diagnostics.some((diagnostic) => diagnostic.blocking));
        assert.strictEqual(await pathExists(path.join(target, 'Catalogs', 'A.xml')), false);

        const packagePreview = await compare.result.workspace.createPreviewForNodeIds([aId, bId]);
        assert.strictEqual(packagePreview.ok, true, JSON.stringify(packagePreview));
        assert.ok(packagePreview.preview.items.length > 0, 'the explicitly selected dependency package creates one preview');
        assert.ok(packagePreview.preview.items.some((item) => item.label === 'Catalog.A'));
        assert.ok(packagePreview.preview.items.some((item) => item.label === 'Catalog.B'));
        assert.strictEqual(await pathExists(path.join(target, 'Catalogs', 'A.xml')), false, 'preview creation does not write targets');
        assert.strictEqual(await pathExists(path.join(target, 'Catalogs', 'B.xml')), false, 'preview creation does not write targets');
      } finally {
        compare.dispose();
      }
    });
  });

  test('blocks a missing untyped metadata dependency in the direct Rights/Object/Name structure', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cf');
      const source = path.join(tempRoot, 'source-cfe');
      const role: ExtensionCompareObjectFixture = {
        type: 'Role',
        name: 'Ext_Role',
        uuid: UUID.objectA,
        belonging: 'Own',
      };
      await writeDesignerConfiguration(target, { uuid: UUID.target });
      await writeDesignerConfiguration(source, {
        uuid: UUID.source,
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [role],
      });
      await writeCompareBytes(
        source,
        path.join('Roles', role.name, 'Ext', 'Rights.xml'),
        '<rights><object><name>Catalog.Missing</name></object></rights>',
      );

      const compare = await openCompare(tempRoot, target, source);
      try {
        const roleId = nodeIdForLabel(compare.result.projection.root, 'Role.Ext_Role');
        assert.ok(
          compare.result.workspace.listMergeableNodeIds().includes(roleId),
          'the Role row must reach dependency validation instead of failing the root-type gate',
        );
        const created = await compare.result.workspace.createPreviewForNodeIds([roleId]);
        assert.strictEqual(created.ok, false, `missing object in Rights.xml must block the role transfer: ${JSON.stringify(created)}`);
        const dependencyDiagnostic = created.diagnostics.find((diagnostic) => diagnostic.blocking);
        assert.ok(dependencyDiagnostic);
        assert.ok(dependencyDiagnostic.suggestedAction?.includes('Catalog.Missing'), JSON.stringify(dependencyDiagnostic));
        assert.ok(dependencyDiagnostic.suggestedAction?.includes('Roles/Ext_Role/Ext/Rights.xml'), JSON.stringify(dependencyDiagnostic));
        assert.strictEqual(await pathExists(path.join(target, 'Roles', 'Ext_Role.xml')), false);
      } finally {
        compare.dispose();
      }
    });
  });

  test('resolves Configuration.Name from Role Rights.xml against the target Configuration.Properties.Name', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cf');
      const source = path.join(tempRoot, 'source-cfe');
      const role: ExtensionCompareObjectFixture = {
        type: 'Role',
        name: 'Ext_Role',
        uuid: UUID.objectA,
        belonging: 'Own',
      };
      await writeDesignerConfiguration(target, { uuid: UUID.target, name: 'TargetConfiguration' });
      await writeDesignerConfiguration(source, {
        uuid: UUID.source,
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [role],
      });
      await writeCompareBytes(source, path.join('Roles', role.name, 'Ext', 'Rights.xml'),
        '<rights><object><name>Configuration.TargetConfiguration</name></object></rights>');

      const compare = await openCompare(tempRoot, target, source);
      try {
        const roleId = nodeIdForLabel(compare.result.projection.root, 'Role.Ext_Role');
        assert.ok(compare.result.workspace.listMergeableNodeIds().includes(roleId));
        const created = await compare.result.workspace.createPreviewForNodeIds([roleId]);
        assert.strictEqual(created.ok, true, `target Configuration.Name should satisfy the Role reference: ${JSON.stringify(created)}`);
        assert.ok(created.preview.items.length > 0);
      } finally {
        compare.dispose();
      }
    });
  });

  test('resolves Configuration.Name against the proven base when the target CFE has a different name', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cfe');
      const base = path.join(tempRoot, 'base-cf');
      const source = path.join(tempRoot, 'source-cfe');
      const role: ExtensionCompareObjectFixture = {
        type: 'Role',
        name: 'Ext_Role',
        uuid: UUID.objectA,
        belonging: 'Own',
      };
      await writeDesignerConfiguration(target, {
        uuid: UUID.target,
        name: 'TargetExtension',
        purpose: 'Customization',
        namePrefix: 'Ext_',
      });
      await writeDesignerConfiguration(base, { uuid: UUID.target, name: 'BaseConfiguration' });
      await writeDesignerConfiguration(source, {
        uuid: UUID.source,
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [role],
      });
      await writeCompareBytes(source, path.join('Roles', role.name, 'Ext', 'Rights.xml'),
        '<rights><object><name>Configuration.BaseConfiguration</name></object></rights>');

      const compare = await openCompare(tempRoot, target, source, { extensionBaseRoots: { left: base } });
      try {
        const roleId = nodeIdForLabel(compare.result.projection.root, 'Role.Ext_Role');
        assert.ok(compare.result.workspace.listMergeableNodeIds().includes(roleId));
        const created = await compare.result.workspace.createPreviewForNodeIds([roleId]);
        assert.strictEqual(created.ok, true, `proven base Configuration.Name should satisfy the Role reference: ${JSON.stringify(created)}`);
        assert.ok(created.preview.items.length > 0);
      } finally {
        compare.dispose();
      }
    });
  });

  test('blocks a foreign Configuration.Name from Role Rights.xml with a dependency diagnostic', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cf');
      const source = path.join(tempRoot, 'source-cfe');
      const role: ExtensionCompareObjectFixture = {
        type: 'Role',
        name: 'Ext_Role',
        uuid: UUID.objectA,
        belonging: 'Own',
      };
      await writeDesignerConfiguration(target, { uuid: UUID.target, name: 'TargetConfiguration' });
      await writeDesignerConfiguration(source, {
        uuid: UUID.source,
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [role],
      });
      await writeCompareBytes(source, path.join('Roles', role.name, 'Ext', 'Rights.xml'),
        '<rights><object><name>Configuration.ForeignConfiguration</name></object></rights>');

      const compare = await openCompare(tempRoot, target, source);
      try {
        const roleId = nodeIdForLabel(compare.result.projection.root, 'Role.Ext_Role');
        assert.ok(compare.result.workspace.listMergeableNodeIds().includes(roleId));
        const created = await compare.result.workspace.createPreviewForNodeIds([roleId]);
        assert.strictEqual(created.ok, false, `a foreign Configuration.Name must block the Role transfer: ${JSON.stringify(created)}`);
        const diagnostic = created.diagnostics.find((item) => item.blocking);
        assert.ok(diagnostic);
        assert.ok(diagnostic.suggestedAction?.includes('Configuration.ForeignConfiguration'), JSON.stringify(diagnostic));
        assert.ok(diagnostic.suggestedAction?.includes('Roles/Ext_Role/Ext/Rights.xml'), JSON.stringify(diagnostic));
        assert.ok(diagnostic.suggestedAction?.includes('отсутствует в target'), JSON.stringify(diagnostic));
      } finally {
        compare.dispose();
      }
    });
  });

  test('does not interpret arbitrary Name nodes or comments as Rights.xml dependencies', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cf');
      const source = path.join(tempRoot, 'source-cfe');
      const role: ExtensionCompareObjectFixture = {
        type: 'Role',
        name: 'Ext_Role',
        uuid: UUID.objectA,
        belonging: 'Own',
      };
      await writeDesignerConfiguration(target, { uuid: UUID.target, objects: [catalogObject('Real', UUID.objectB)] });
      await writeDesignerConfiguration(source, {
        uuid: UUID.source,
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [role],
      });
      await writeCompareBytes(
        source,
        path.join('Roles', role.name, 'Ext', 'Rights.xml'),
        '<rights><object><name>Catalog.Real</name><synonym><name>Configuration.NestedNoise</name></synonym></object><!-- Configuration.CommentOnly --></rights>',
      );
      await writeCompareBytes(source, path.join('Roles', role.name, 'Ext', 'Unrelated.xml'), '<Metadata><Name>Configuration.AlsoNotAReference</Name><Name>Catalog.AlsoNotAReference</Name></Metadata>');

      const compare = await openCompare(tempRoot, target, source);
      try {
        const roleId = nodeIdForLabel(compare.result.projection.root, 'Role.Ext_Role');
        const created = await compare.result.workspace.createPreviewForNodeIds([roleId]);
        assert.strictEqual(created.ok, true, `only direct Rights/Object/Name should count: ${JSON.stringify(created)}`);
        assert.ok(created.preview.items.length > 0);
      } finally {
        compare.dispose();
      }
    });
  });

  test('resolves generated register cfg suffixes and registry aliases to canonical dependency identities', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cf');
      const source = path.join(tempRoot, 'source-cfe');
      const holderKey = catalogObject('Ext_HolderKey', UUID.objectA);
      const holderValueManager = catalogObject('Ext_HolderValueManager', UUID.objectB);
      const holderValueKey = catalogObject('Ext_HolderValueKey', UUID.dependencyEnumValue);
      const holderAlias = catalogObject('Ext_HolderAlias', UUID.dependencyEnum);
      const keyDependency: ExtensionCompareObjectFixture = {
        type: 'InformationRegister', name: 'RecordKeyDependency', uuid: UUID.registerKey, belonging: 'Own',
      };
      const valueManagerDependency: ExtensionCompareObjectFixture = {
        type: 'Constant', name: 'ValueManagerDependency', uuid: UUID.registerManager, belonging: 'Own',
      };
      const valueKeyDependency: ExtensionCompareObjectFixture = {
        type: 'Constant', name: 'ValueKeyDependency', uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', belonging: 'Own',
      };
      const aliasDependency: ExtensionCompareObjectFixture = {
        type: 'FilterCriterion', name: 'AliasDependency', uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', belonging: 'Own',
      };
      await writeDesignerConfiguration(target, { uuid: UUID.target });
      await writeDesignerConfiguration(source, {
        uuid: UUID.source,
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [holderKey, holderValueManager, holderValueKey, holderAlias, keyDependency, valueManagerDependency, valueKeyDependency, aliasDependency],
      });
      await writeCompareBytes(source, 'Catalogs/Ext_HolderKey/Ext/References.xml', '<Metadata><Type>cfg:InformationRegisterRecordKey.RecordKeyDependency</Type></Metadata>');
      await writeCompareBytes(source, 'Catalogs/Ext_HolderValueManager/Ext/References.xml', '<Metadata><Type>cfg:ConstantValueManager.ValueManagerDependency</Type></Metadata>');
      await writeCompareBytes(source, 'Catalogs/Ext_HolderValueKey/Ext/References.xml', '<Metadata><Type>cfg:ConstantValueKey.ValueKeyDependency</Type></Metadata>');
      await writeCompareBytes(source, 'Catalogs/Ext_HolderAlias/Ext/References.xml', '<Metadata><Type>cfg:FilterCriteria.AliasDependency</Type></Metadata>');

      const compare = await openCompare(tempRoot, target, source);
      try {
        const cases = [
          { holder: holderKey, dependency: keyDependency, label: 'register RecordKey suffix' },
          { holder: holderValueManager, dependency: valueManagerDependency, label: 'Constant ValueManager suffix' },
          { holder: holderValueKey, dependency: valueKeyDependency, label: 'Constant ValueKey suffix' },
          { holder: holderAlias, dependency: aliasDependency, label: 'registry root-tag alias' },
        ];
        for (const scenario of cases) {
          const holderId = nodeIdForLabel(compare.result.projection.root, `Catalog.${scenario.holder.name}`);
          const dependencyDescriptor = scenario.dependency.type;
          const dependencyId = nodeIdForLabel(compare.result.projection.root, `${dependencyDescriptor}.${scenario.dependency.name}`);
          const holderOnly = await compare.result.workspace.createPreviewForNodeIds([holderId]);
          assert.strictEqual(holderOnly.ok, false, `${scenario.label} must resolve to an unselected dependency`);
          const selectedDependency = await compare.result.workspace.createPreviewForNodeIds([holderId, dependencyId]);
          assert.strictEqual(selectedDependency.ok, true, `${scenario.label} must resolve to its canonical object: ${JSON.stringify(selectedDependency)}`);
        }
      } finally {
        compare.dispose();
      }
    });
  });

  test('blocks an unresolved InformationRegister MDObjectRef captured in a nested XML sidecar', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cf');
      const source = path.join(tempRoot, 'source-cfe');
      await writeDesignerConfiguration(target, { uuid: UUID.target });
      await writeDesignerConfiguration(source, {
        uuid: UUID.source,
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [catalogObject('Ext_Holder', UUID.objectA)],
      });
      await writeCompareBytes(
        source,
        path.join('Catalogs', 'Ext_Holder', 'Forms', 'Nested', 'Form.xml'),
        '<?xml version="1.0" encoding="UTF-8"?><Form xmlns:xr="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><xr:Item xsi:type="xr:MDObjectRef">InformationRegister.Missing</xr:Item></Form>',
      );

      const compare = await openCompare(tempRoot, target, source);
      try {
        const holderId = nodeIdForLabel(compare.result.projection.root, 'Catalog.Ext_Holder');
        const created = await compare.result.workspace.createPreviewForNodeIds([holderId]);

        assert.strictEqual(
          created.ok,
          false,
          `the nested sidecar's known unsupported-root reference must fail closed: ${JSON.stringify(created)}`,
        );
        assert.ok(created.diagnostics.some((diagnostic) => diagnostic.blocking));
        assert.strictEqual(await pathExists(path.join(target, 'Catalogs', 'Ext_Holder.xml')), false);
        assert.strictEqual(await pathExists(path.join(target, 'Configuration.xml')), true);
      } finally {
        compare.dispose();
      }
    });
  });

  test('blocks an unresolved DesignTimeRef enum value in a nested form ChoiceParameters default value', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cf');
      const source = path.join(tempRoot, 'source-cfe');
      await writeDesignerConfiguration(target, { uuid: UUID.target });
      await writeDesignerConfiguration(source, {
        uuid: UUID.source,
        purpose: 'Customization',
        namePrefix: '',
        objects: [catalogObject('Holder', UUID.objectA)],
      });
      await writeCompareBytes(
        source,
        path.join('Catalogs', 'Holder', 'Forms', 'Nested', 'Form.xml'),
        choiceParameterForm('xr:DesignTimeRef', 'Enum.Dep.EnumValue.Value'),
      );

      const compare = await openCompare(tempRoot, target, source);
      try {
        const holderId = nodeIdForLabel(compare.result.projection.root, 'Catalog.Holder');
        const created = await compare.result.workspace.createPreviewForNodeIds([holderId]);

        assert.strictEqual(
          created.ok,
          false,
          `an unavailable xr:DesignTimeRef enum dependency must fail closed: ${JSON.stringify(created)}`,
        );
        assert.ok(created.diagnostics.some((diagnostic) => diagnostic.blocking));
        assert.strictEqual(await pathExists(path.join(target, 'Catalogs', 'Holder.xml')), false);
      } finally {
        compare.dispose();
      }
    });
  });

  test('accepts a DesignTimeRef enum value when Enum.Dep is selected with the dependent object', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cf');
      const source = path.join(tempRoot, 'source-cfe');
      await writeDesignerConfiguration(target, { uuid: UUID.target });
      await writeDesignerConfiguration(source, {
        uuid: UUID.source,
        purpose: 'Customization',
        namePrefix: '',
        objects: [
          catalogObject('Holder', UUID.objectA),
          rootEnum('Dep', UUID.dependencyEnum),
        ],
      });
      await writeCompareBytes(
        source,
        path.join('Catalogs', 'Holder', 'Forms', 'Nested', 'Form.xml'),
        choiceParameterForm('xr:DesignTimeRef', 'Enum.Dep.EnumValue.Value'),
      );

      const compare = await openCompare(tempRoot, target, source);
      try {
        const holderId = nodeIdForLabel(compare.result.projection.root, 'Catalog.Holder');
        const enumId = nodeIdForLabel(compare.result.projection.root, 'Enum.Dep');
        const packagePreview = await compare.result.workspace.createPreviewForNodeIds([holderId, enumId]);
        assert.strictEqual(packagePreview.ok, true, JSON.stringify(packagePreview));
        assert.ok(packagePreview.preview.items.some((item) => item.label === 'Catalog.Holder'));
        assert.ok(packagePreview.preview.items.some((item) => item.label === 'Enum.Dep'));
        assert.strictEqual(await pathExists(path.join(target, 'Catalogs', 'Holder.xml')), false);
        assert.strictEqual(await pathExists(path.join(target, 'Enums', 'Dep.xml')), false);
      } finally {
        compare.dispose();
      }
    });
  });

  test('requires a source Enum dependency to be selected when it is absent from the target', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cf');
      const source = path.join(tempRoot, 'source-cfe');
      await writeDesignerConfiguration(target, { uuid: UUID.target });
      await writeDesignerConfiguration(source, {
        uuid: UUID.source,
        purpose: 'Customization',
        namePrefix: '',
        objects: [
          catalogObject('Holder', UUID.objectA),
          rootEnum('Dep', UUID.dependencyEnum),
        ],
      });
      await writeCompareBytes(
        source,
        path.join('Catalogs', 'Holder', 'Forms', 'Nested', 'Form.xml'),
        choiceParameterForm('xr:DesignTimeRef', 'Enum.Dep.EnumValue.Value'),
      );

      const compare = await openCompare(tempRoot, target, source);
      try {
        const holderId = nodeIdForLabel(compare.result.projection.root, 'Catalog.Holder');
        const holderOnly = await compare.result.workspace.createPreviewForNodeIds([holderId]);

        assert.strictEqual(
          holderOnly.ok,
          false,
          `an unselected source enum is not part of the selected dependency package: ${JSON.stringify(holderOnly)}`,
        );
        assert.ok(holderOnly.diagnostics.some((diagnostic) => diagnostic.blocking));
        assert.strictEqual(await pathExists(path.join(target, 'Catalogs', 'Holder.xml')), false);
      } finally {
        compare.dispose();
      }
    });
  });

  test('does not treat an xs:string ChoiceParameters value shaped like an enum reference as a dependency', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cf');
      const source = path.join(tempRoot, 'source-cfe');
      await writeDesignerConfiguration(target, { uuid: UUID.target });
      await writeDesignerConfiguration(source, {
        uuid: UUID.source,
        purpose: 'Customization',
        namePrefix: '',
        objects: [catalogObject('Holder', UUID.objectA)],
      });
      await writeCompareBytes(
        source,
        path.join('Catalogs', 'Holder', 'Forms', 'Nested', 'Form.xml'),
        choiceParameterForm('xs:string', 'Enum.Missing'),
      );

      const compare = await openCompare(tempRoot, target, source);
      try {
        const holderId = nodeIdForLabel(compare.result.projection.root, 'Catalog.Holder');
        const created = await compare.result.workspace.createPreviewForNodeIds([holderId]);

        assert.strictEqual(
          created.ok,
          true,
          `plain string text must not be treated as a metadata reference: ${JSON.stringify(created)}`,
        );
        assert.ok(created.preview.items.length > 0);
        assert.strictEqual(await pathExists(path.join(target, 'Catalogs', 'Holder.xml')), false);
      } finally {
        compare.dispose();
      }
    });
  });

  test('does not interpret an ordinary Comment value as an XML metadata reference', async () => {
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cf');
      const source = path.join(tempRoot, 'source-cfe');
      await writeDesignerConfiguration(target, { uuid: UUID.target });
      await writeDesignerConfiguration(source, {
        uuid: UUID.source,
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [catalogObject('Ext_Comment', UUID.objectA, '<Comment>Catalog.Missing</Comment>')],
      });

      const compare = await openCompare(tempRoot, target, source);
      try {
        const commentId = nodeIdForLabel(compare.result.projection.root, 'Catalog.Ext_Comment');
        assert.ok(
          compare.result.workspace.listMergeableNodeIds().includes(commentId),
          'text in a Comment element must not block the otherwise supported row',
        );
        const created = await compare.result.workspace.createPreviewForNodeIds([commentId]);

        assert.strictEqual(
          created.ok,
          true,
          `plain text inside Comment is not a proven metadata reference: ${JSON.stringify(created)}`,
        );
        assert.ok(created.preview.items.length > 0);
        assert.strictEqual(await pathExists(path.join(target, 'Catalogs', 'Ext_Comment.xml')), false);
      } finally {
        compare.dispose();
      }
    });
  });

  test('accepts a selected object dependency already present in the target or its proven base', async () => {
    await withTempRoot(async (tempRoot) => {
      const scenarios: Array<{
        readonly name: string;
        readonly target: ExtensionCompareConfigurationFixture;
        readonly base?: ExtensionCompareConfigurationFixture;
      }> = [
        {
          name: 'target object',
          target: { uuid: UUID.target, objects: [catalogObject('B', UUID.objectB)] },
        },
        {
          name: 'proven base object',
          target: { uuid: UUID.target, purpose: 'Customization', namePrefix: 'Ext_' },
          base: { uuid: UUID.target, objects: [catalogObject('B', UUID.objectB)] },
        },
      ];

      for (const [index, scenario] of scenarios.entries()) {
        const caseRoot = path.join(tempRoot, `case-${index}`);
        const target = path.join(caseRoot, 'target');
        const source = path.join(caseRoot, 'source');
        const base = scenario.base ? path.join(caseRoot, 'base') : undefined;
        await writeDesignerConfiguration(target, scenario.target);
        await writeDesignerConfiguration(source, {
          uuid: UUID.source,
          purpose: 'Customization',
          namePrefix: 'Ext_',
          objects: [catalogObject('Ext_A', UUID.objectA, mdObjectReferenceToB())],
        });
        if (base && scenario.base) {
          await writeDesignerConfiguration(base, scenario.base);
        }

        const extensionBaseRoots = base
          ? { left: base }
          : undefined;
        const compare = await openCompare(tempRoot, target, source, { extensionBaseRoots });
        try {
          const aId = nodeIdForLabel(compare.result.projection.root, 'Catalog.Ext_A');
          const created = await compare.result.workspace.createPreviewForNodeIds([aId]);

          assert.strictEqual(created.ok, true, `${scenario.name}: ${JSON.stringify(created)}`);
          assert.ok(created.preview.items.length > 0);
          assert.strictEqual(await pathExists(path.join(target, 'Catalogs', 'Ext_A.xml')), false);
        } finally {
          compare.dispose();
        }
      }
    });
  });
});

function catalogObject(name: string, uuid: string, propertiesXml = ''): ExtensionCompareObjectFixture {
  return { type: 'Catalog', name, uuid, belonging: 'Own', propertiesXml };
}

function catalogReferenceToB(): string {
  return '<Attributes xmlns:v8="http://v8.1c.ru/8.1/data/core"><Attribute name="Dependency" id="1"><Type><v8:Type>cfg:CatalogRef.B</v8:Type></Type></Attribute></Attributes>';
}

function mdObjectReferenceToB(): string {
  return '<xr:Item xmlns:xr="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="xr:MDObjectRef">Catalog.B</xr:Item>';
}

function rootEnum(name: string, uuid: string): ExtensionCompareObjectFixture {
  return {
    type: 'Enum',
    name,
    uuid,
    belonging: 'Own',
    childObjectsXml: `<EnumValue uuid="${UUID.dependencyEnumValue}"><Properties><Name>Value</Name></Properties></EnumValue>`,
  };
}

function choiceParameterForm(valueType: 'xr:DesignTimeRef' | 'xs:string', value: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="2.20">
  <ChildItems>
    <InputField name="Input" id="1">
      <ChoiceParameters>
        <v8:Parameter>
          <v8:Name>DefaultValue</v8:Name>
          <v8:Value xsi:type="${valueType}">${value}</v8:Value>
        </v8:Parameter>
      </ChoiceParameters>
    </InputField>
  </ChildItems>
</Form>`;
}

async function openCompare(
  tempRoot: string,
  leftRootPath: string,
  rightRootPath: string,
  options: Pick<ConfigurationCompareInput, 'extensionBaseRoots'> = {},
): Promise<{ result: ConfigurationCompareResult; dispose(): void }> {
  const result = await buildConfigurationCompare({
    leftRootPath,
    rightRootPath,
    backupRootPath: path.join(tempRoot, 'backups'),
    extensionBaseRoots: options.extensionBaseRoots,
  });
  let disposed = false;
  return {
    result,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      result.workspace.dispose();
    },
  };
}

async function withTempRoot<T>(callback: (tempRoot: string) => Promise<T>): Promise<T> {
  const tempRoot = await createExtensionCompareTempRoot('issue336-compare-dependencies-');
  try {
    return await callback(tempRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function nodeIdForLabel(root: CompareTreeNode, label: string): string {
  const matches = collectNodes(root).filter((node) => node.label === label);
  assert.strictEqual(matches.length, 1, `Expected one row ${label}, got ${matches.length}`);
  return matches[0]!.id;
}

function collectNodes(root: CompareTreeNode): CompareTreeNode[] {
  return [root, ...root.children.flatMap(collectNodes)];
}
