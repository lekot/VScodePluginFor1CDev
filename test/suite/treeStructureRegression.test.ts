import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { DesignerParser } from '../../src/parsers/designerParser';
import { MetadataType, TreeNode } from '../../src/models/treeNode';

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

    const dimensionsNode = children.find((c) => c.id.endsWith('.Dimensions'));
    assert.ok(dimensionsNode, 'Dimensions container must exist');
    assert.ok(
      dimensionsNode!.children && dimensionsNode!.children.length > 0,
      'Dimensions container must have children'
    );
    for (const dim of dimensionsNode!.children!) {
      assert.strictEqual(dim.type, MetadataType.Dimension, `"${dim.name}" must have type Dimension`);
    }

    const resourcesNode = children.find((c) => c.id.endsWith('.Resources'));
    assert.ok(resourcesNode, 'Resources container must exist');
    assert.ok(
      resourcesNode!.children && resourcesNode!.children.length > 0,
      'Resources container must have children'
    );
    for (const res of resourcesNode!.children!) {
      assert.strictEqual(res.type, MetadataType.Resource, `"${res.name}" must have type Resource`);
    }
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
