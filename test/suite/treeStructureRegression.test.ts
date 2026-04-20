import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { DesignerParser } from '../../src/parsers/designerParser';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import { ensureR6PlaceholdersForInstanceNode } from '../../src/utils/treeNormalization';
import { ConfigFormat } from '../../src/parsers/formatDetector';

const uhConf = path.resolve(__dirname, '../../..', 'FormatSamples', 'uh');

function collectDescendants(node: TreeNode): TreeNode[] {
  const result: TreeNode[] = [];
  const queue = [...(node.children ?? [])];
  while (queue.length > 0) {
    const n = queue.shift()!;
    result.push(n);
    if (n.children) {
      queue.push(...n.children);
    }
  }
  return result;
}

suite('Tree structure regression', function () {
  this.timeout(10_000);

  test('Subsystems — no module nodes under subsystem children', async function () {
    if (!fs.existsSync(uhConf)) {
      this.skip();
    }

    // Build a TreeNode for an existing Designer-format subsystem that has an Ext folder.
    const subsystemFilePath = path.join(uhConf, 'Subsystems', 'Администрирование.xml');
    const subsystemNode: TreeNode = {
      id: 'Subsystems.Администрирование',
      name: 'Администрирование',
      type: MetadataType.Subsystem,
      properties: {},
      filePath: subsystemFilePath,
    };

    const children = await DesignerParser.loadChildrenForElement(
      uhConf,
      'Subsystems',
      'Администрирование',
      subsystemNode
    );

    // Walk all descendants, none should be flagged as a module.
    const allNodes: TreeNode[] = [];
    const queue = [...children];
    while (queue.length > 0) {
      const n = queue.shift()!;
      allNodes.push(n);
      if (n.children) {
        queue.push(...n.children);
      }
    }

    const moduleNodes = allNodes.filter((n) => (n.properties as { isModule?: boolean }).isModule === true);
    assert.strictEqual(
      moduleNodes.length,
      0,
      `Subsystem should have no module nodes, found: ${moduleNodes.map((n) => n.name).join(', ')}`
    );
  });

  test('Enum with values has EnumValues container named "Значения" with EnumValue children', async function () {
    if (!fs.existsSync(uhConf)) {
      this.skip();
    }

    // ВажностьПроблемыУчета.xml has 5 EnumValue entries
    const children = await DesignerParser.loadChildrenForElement(
      uhConf,
      'Enums',
      'ВажностьПроблемыУчета'
    );

    const valuesContainer = children.find((c) => c.name === 'Значения');
    assert.ok(valuesContainer, 'EnumValues container "Значения" must exist');
    assert.strictEqual(valuesContainer!.type, MetadataType.EnumValue, 'Container type must be EnumValue');
    assert.ok(
      valuesContainer!.children && valuesContainer!.children.length > 0,
      'EnumValues container must have children'
    );

    for (const child of valuesContainer!.children!) {
      assert.strictEqual(child.type, MetadataType.EnumValue, `Child "${child.name}" must have type EnumValue`);
    }
  });

  test('InformationRegister has Dimensions and Resources containers', async function () {
    if (!fs.existsSync(uhConf)) {
      this.skip();
    }

    // ABCXYZКлассификацияКлиентов has both Dimension and Resource entries
    const children = await DesignerParser.loadChildrenForElement(
      uhConf,
      'InformationRegisters',
      'ABCXYZКлассификацияКлиентов'
    );

    const dimensionsNode = children.find((c) => c.id === 'Dimensions');
    assert.ok(dimensionsNode, 'Dimensions container must exist');
    assert.ok(
      dimensionsNode!.children && dimensionsNode!.children.length > 0,
      'Dimensions container must have children'
    );
    for (const dim of dimensionsNode!.children!) {
      assert.strictEqual(dim.type, MetadataType.Dimension, `"${dim.name}" must have type Dimension`);
    }

    const resourcesNode = children.find((c) => c.id === 'Resources');
    assert.ok(resourcesNode, 'Resources container must exist');
    assert.ok(
      resourcesNode!.children && resourcesNode!.children.length > 0,
      'Resources container must have children'
    );
    for (const res of resourcesNode!.children!) {
      assert.strictEqual(res.type, MetadataType.Resource, `"${res.name}" must have type Resource`);
    }
  });

  test('Enum instance gets EnumValues R6 placeholder (end-to-end via treeNormalization)', async function () {
    if (!fs.existsSync(uhConf)) {
      this.skip();
    }

    // Simulate what happens in tree: shallow Enum instance → ensureR6PlaceholdersForInstanceNode → placeholder added
    const enumsTypeNode: TreeNode = {
      id: 'Enums',
      name: 'Перечисления',
      type: MetadataType.Enum,
      properties: {},
      children: [],
    };
    const enumInstance: TreeNode = {
      id: 'Enums.ВажностьПроблемыУчета',
      name: 'ВажностьПроблемыУчета',
      type: MetadataType.Enum,
      properties: {},
      filePath: path.join(uhConf, 'Enums', 'ВажностьПроблемыУчета.xml'),
      parent: enumsTypeNode,
      children: [],
    };

    ensureR6PlaceholdersForInstanceNode(enumInstance, { format: ConfigFormat.Designer, configPath: uhConf });

    const enumValuesPlaceholder = enumInstance.children?.find((c) => c.id === 'EnumValues');
    assert.ok(enumValuesPlaceholder, 'EnumValues R6 placeholder must be added to Enum instance');
    assert.strictEqual(enumValuesPlaceholder!.name, 'Значения');
    assert.strictEqual(
      (enumValuesPlaceholder!.properties as { _lazy?: boolean })._lazy,
      true,
      'EnumValues placeholder must be marked lazy for on-expand loading'
    );
  });

  test('InformationRegister instance gets Dimensions/Resources R6 placeholders (end-to-end)', async function () {
    if (!fs.existsSync(uhConf)) {
      this.skip();
    }

    const typeNode: TreeNode = {
      id: 'InformationRegisters',
      name: 'Регистры сведений',
      type: MetadataType.InformationRegister,
      properties: {},
      children: [],
    };
    const instance: TreeNode = {
      id: 'InformationRegisters.ABCXYZКлассификацияКлиентов',
      name: 'ABCXYZКлассификацияКлиентов',
      type: MetadataType.InformationRegister,
      properties: {},
      filePath: path.join(uhConf, 'InformationRegisters', 'ABCXYZКлассификацияКлиентов.xml'),
      parent: typeNode,
      children: [],
    };

    ensureR6PlaceholdersForInstanceNode(instance, { format: ConfigFormat.Designer, configPath: uhConf });

    const dimensions = instance.children?.find((c) => c.id === 'Dimensions');
    const resources = instance.children?.find((c) => c.id === 'Resources');
    assert.ok(dimensions, 'Dimensions placeholder must be added');
    assert.ok(resources, 'Resources placeholder must be added');
    assert.strictEqual((dimensions!.properties as { _lazy?: boolean })._lazy, true);
    assert.strictEqual((resources!.properties as { _lazy?: boolean })._lazy, true);
  });

  test('Catalog instance gets PredefinedData R6 placeholder (end-to-end)', async function () {
    if (!fs.existsSync(uhConf)) {
      this.skip();
    }

    const typeNode: TreeNode = {
      id: 'Catalogs',
      name: 'Справочники',
      type: MetadataType.Catalog,
      properties: {},
      children: [],
    };
    const instance: TreeNode = {
      id: 'Catalogs.Валюты',
      name: 'Валюты',
      type: MetadataType.Catalog,
      properties: {},
      filePath: path.join(uhConf, 'Catalogs', 'Валюты.xml'),
      parent: typeNode,
      children: [],
    };

    ensureR6PlaceholdersForInstanceNode(instance, { format: ConfigFormat.Designer, configPath: uhConf });

    const predefined = instance.children?.find((c) => c.id === 'PredefinedData');
    assert.ok(predefined, 'PredefinedData placeholder must be added to Catalog instance (even when file is absent)');
    assert.strictEqual(predefined!.name, 'Предопределённые');
    assert.strictEqual((predefined!.properties as { _lazy?: boolean })._lazy, true);
  });

  test('parsePredefinedData via loadChildrenForElement returns container (empty or populated)', async function () {
    if (!fs.existsSync(uhConf)) {
      this.skip();
    }

    // АлгоритмыОпределенияБазовойДаты has Ext/Predefined.xml with items
    const children = await DesignerParser.loadChildrenForElement(
      uhConf,
      'Catalogs',
      'АлгоритмыОпределенияБазовойДаты'
    );

    const container = children.find((c) => c.id === 'PredefinedData');
    assert.ok(container, 'PredefinedData container must be in loadChildrenForElement result');
    assert.strictEqual(container!.name, 'Предопределённые');
    // Валюты has no Predefined.xml so this one has items (different catalog chosen)
    assert.ok(
      container!.children && container!.children.length > 0,
      'АлгоритмыОпределенияБазовойДаты has predefined items — container should be non-empty'
    );
  });

  test('PredefinedData container is empty for catalog without Predefined.xml', async function () {
    if (!fs.existsSync(uhConf)) {
      this.skip();
    }

    // Валюты has no Ext/Predefined.xml
    const children = await DesignerParser.loadChildrenForElement(uhConf, 'Catalogs', 'Валюты');
    const container = children.find((c) => c.id === 'PredefinedData');
    assert.ok(container, 'PredefinedData container must be present even without Predefined.xml');
    assert.strictEqual(container!.children?.length ?? 0, 0, 'Container should be empty for Валюты');
  });

  test('CommonModule has no Attribute-type children', async function () {
    if (!fs.existsSync(uhConf)) {
      this.skip();
    }

    const children = await DesignerParser.loadChildrenForElement(
      uhConf,
      'CommonModules',
      'CRMЛокализация'
    );

    const descendants = collectDescendants({ id: '', name: '', type: MetadataType.CommonModule, properties: {}, children });
    const attributeNodes = descendants.filter((n) => n.type === MetadataType.Attribute);
    assert.strictEqual(
      attributeNodes.length,
      0,
      `CommonModule must not have Attribute children, found: ${attributeNodes.map((n) => n.name).join(', ')}`
    );
  });
});
