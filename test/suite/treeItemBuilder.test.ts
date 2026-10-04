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
  test('base Configuration with boundCount>0, massDeployment:false has a stable base context token', () => {
    const node = makeNode({ type: MetadataType.Configuration });
    const item = buildTreeItem(node, makeOptions({ bindingDeco: makeDeco(1, false) }));
    assert.strictEqual(item.contextValue, 'Configuration cfeBaseConfiguration bindingBound deployOne');
  });

  test('Configuration with boundCount>0, massDeployment:true → contextValue = "Configuration bindingBound deployMany"', () => {
    const node = makeNode({ type: MetadataType.Configuration });
    const item = buildTreeItem(node, makeOptions({ bindingDeco: makeDeco(2, true) }));
    assert.strictEqual(item.contextValue, 'Configuration cfeBaseConfiguration bindingBound deployMany');
  });

  test('base Configuration without bindingDeco has the base context token', () => {
    const node = makeNode({ type: MetadataType.Configuration });
    const item = buildTreeItem(node, makeOptions({}));
    assert.strictEqual(item.contextValue, 'Configuration cfeBaseConfiguration');
  });

  test('CFE Configuration has no base context token', () => {
    const node = makeNode({ type: MetadataType.Configuration, properties: { extensionPurpose: 'Customization' } });
    const item = buildTreeItem(node, makeOptions({}));
    assert.strictEqual(item.contextValue, 'Configuration cfeExtensionConfiguration');
    assert.ok(!item.contextValue?.includes('cfeBaseConfiguration'));
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

  test('DataProcessor and Report root items with files expose the external-artifact context token', () => {
    for (const type of [MetadataType.DataProcessor, MetadataType.Report]) {
      const node = makeNode({ type, filePath: `C:\\repo\\${type}.xml` });
      const item = buildTreeItem(node, makeOptions({}));
      assert.ok(item.contextValue?.split(/\s+/).includes('externalArtifactSource'));
    }
  });

  test('adopted extension objects do not expose the external-artifact action', () => {
    const item = buildTreeItem(makeNode({
      type: MetadataType.DataProcessor,
      filePath: 'C:\\repo\\Borrowed.xml',
      properties: { objectBelonging: 'Adopted', extendedConfigurationObject: 'uuid' },
    }), makeOptions({}));
    assert.ok(!item.contextValue?.split(/\s+/).includes('externalArtifactSource'));
  });

  test('own metadata objects under any extension ancestor marker hide the export action', () => {
    const extensionAncestors = [
      makeNode({ type: MetadataType.Configuration, properties: { isExtension: true } }),
      makeNode({ type: MetadataType.Extension }),
    ];

    for (const extensionRoot of extensionAncestors) {
      const item = buildTreeItem(makeNode({
        type: MetadataType.Report,
        filePath: 'C:\\repo\\Extension\\Reports\\Own.xml',
        parent: extensionRoot,
      }), makeOptions({}));
      assert.ok(!item.contextValue?.split(/\s+/).includes('externalArtifactSource'));
    }
  });

  test('own metadata objects under a CFE do not expose the external-artifact action', () => {
    const extensionRoot = makeNode({
      type: MetadataType.Configuration,
      properties: { extensionPurpose: 'Customization' },
    });
    const metadataFolder = makeNode({
      type: MetadataType.Unknown,
      parent: extensionRoot,
    });
    const item = buildTreeItem(makeNode({
      type: MetadataType.DataProcessor,
      filePath: 'C:\\repo\\Extension\\Configuration\\DataProcessors\\Own.xml',
      parent: metadataFolder,
    }), makeOptions({}));

    assert.ok(!item.contextValue?.split(/\s+/).includes('externalArtifactSource'));
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
  test('ConfigurationPackage uses CfFile context and file resource uri', () => {
    const filePath = 'C:\\repo\\FormatSamples\\cf\\1Cv8.cf';
    const node = makeNode({
      type: MetadataType.ConfigurationPackage,
      id: 'cf:C:\\repo\\FormatSamples\\cf\\1Cv8.cf',
      name: '1Cv8.cf',
      filePath,
    });
    const item = buildTreeItem(node, makeOptions({}));

    assert.strictEqual(item.contextValue, 'CfFile');
    assert.strictEqual(item.resourceUri?.fsPath, filePath);
    assert.strictEqual((item.iconPath as { id?: string }).id, 'archive');
  });
});
