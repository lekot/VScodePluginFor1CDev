import * as assert from 'assert';
import { buildTreeItem } from '../../src/providers/treeItemBuilder';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import type { ConfigurationBindingDecoration } from '../../src/bindings/bindingDecorationTypes';

function makeNode(overrides: Partial<TreeNode> & { type: MetadataType; id?: string; name?: string }): TreeNode {
  return {
    id: overrides.id ?? overrides.type,
    name: overrides.name ?? overrides.type,
    type: overrides.type,
    properties: overrides.properties ?? {},
    children: overrides.children ?? [],
    parent: overrides.parent,
    filePath: overrides.filePath,
  };
}

function makeOptions(overrides: {
  bindingDeco?: ConfigurationBindingDecoration;
  isExtensionInfobaseBindingRoot?: boolean;
}): Parameters<typeof buildTreeItem>[1] {
  return {
    hasChildren: false,
    bindingDeco: overrides.bindingDeco,
    isExtensionInfobaseBindingRoot: overrides.isExtensionInfobaseBindingRoot ?? false,
    rawSearchQuery: '',
    isRegex: false,
    nodeMatchesSearch: false,
    configDirPath: null,
  };
}

function makeDeco(boundCount: number, massDeployment: boolean): ConfigurationBindingDecoration {
  return {
    boundCount,
    massDeployment,
    namesPreview: '',
  };
}

suite('buildTreeItem (#80 — bindingBound context value)', () => {
  test('Configuration with boundCount>0, massDeployment:false → contextValue = "Configuration bindingBound deployOne"', () => {
    const node = makeNode({ type: MetadataType.Configuration });
    const item = buildTreeItem(node, makeOptions({ bindingDeco: makeDeco(1, false) }));
    assert.strictEqual(item.contextValue, 'Configuration bindingBound deployOne');
  });

  test('Configuration with boundCount>0, massDeployment:true → contextValue = "Configuration bindingBound deployMany"', () => {
    const node = makeNode({ type: MetadataType.Configuration });
    const item = buildTreeItem(node, makeOptions({ bindingDeco: makeDeco(2, true) }));
    assert.strictEqual(item.contextValue, 'Configuration bindingBound deployMany');
  });

  test('Configuration without bindingDeco → contextValue = "Configuration"', () => {
    const node = makeNode({ type: MetadataType.Configuration });
    const item = buildTreeItem(node, makeOptions({}));
    assert.strictEqual(item.contextValue, 'Configuration');
  });

  test('Catalog (child node) with bindingDeco.boundCount>0 → contextValue = "Catalog bindingBound"', () => {
    const node = makeNode({ type: MetadataType.Catalog });
    const item = buildTreeItem(node, makeOptions({ bindingDeco: makeDeco(1, false) }));
    assert.strictEqual(item.contextValue, 'Catalog bindingBound');
  });

  test('Catalog.Adopted with bindingDeco → contextValue = "Catalog.Adopted bindingBound"', () => {
    const node = makeNode({
      type: MetadataType.Catalog,
      properties: { objectBelonging: 'Adopted' },
    });
    const item = buildTreeItem(node, makeOptions({ bindingDeco: makeDeco(1, false) }));
    assert.strictEqual(item.contextValue, 'Catalog.Adopted bindingBound');
  });

  test('Forms folder (id="Forms") with bindingDeco.boundCount>0 → contextValue = "Forms bindingBound"', () => {
    const node = makeNode({ type: MetadataType.Form, id: 'Forms', name: 'Forms' });
    const item = buildTreeItem(node, makeOptions({ bindingDeco: makeDeco(1, false) }));
    assert.strictEqual(item.contextValue, 'Forms bindingBound');
  });

  test('Extension extensionBindingRoot with boundCount>0, massDeployment:false → contextValue = "Extension extensionBindingRoot bindingBound deployOne"', () => {
    const node = makeNode({ type: MetadataType.Extension });
    const item = buildTreeItem(node, makeOptions({ isExtensionInfobaseBindingRoot: true, bindingDeco: makeDeco(1, false) }));
    assert.strictEqual(item.contextValue, 'Extension extensionBindingRoot bindingBound deployOne');
  });

  test('Extension extensionBindingRoot with boundCount>0, massDeployment:true → contextValue = "Extension extensionBindingRoot bindingBound deployMany"', () => {
    const node = makeNode({ type: MetadataType.Extension });
    const item = buildTreeItem(node, makeOptions({ isExtensionInfobaseBindingRoot: true, bindingDeco: makeDeco(2, true) }));
    assert.strictEqual(item.contextValue, 'Extension extensionBindingRoot bindingBound deployMany');
  });
});
