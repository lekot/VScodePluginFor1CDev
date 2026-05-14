import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import { MetadataParser } from '../../src/parsers/metadataParser';
import { ConfigFormat, FormatDetector } from '../../src/parsers/formatDetector';
import { DesignerParser } from '../../src/parsers/designerParser';
import { EdtParser } from '../../src/parsers/edtParser';
import {
  isTabularSectionColumnsContainer,
  TABULAR_SECTION_COLUMNS_PLACEHOLDER_TYPE,
} from '../../src/utils/treeNormalization';

suite('MetadataParser edge branches', () => {
  test('parseStructureOnly throws for invalid path and unknown format', async () => {
    const originalValid = FormatDetector.isValidConfigurationPath;
    const originalDetect = FormatDetector.detect;
    try {
      (FormatDetector.isValidConfigurationPath as unknown as (p: string) => Promise<boolean>) = async () => false;
      await assert.rejects(() => MetadataParser.parseStructureOnly('x'), /Invalid configuration path/);

      (FormatDetector.isValidConfigurationPath as unknown as (p: string) => Promise<boolean>) = async () => true;
      (FormatDetector.detect as unknown as (p: string) => Promise<ConfigFormat>) = async () => ConfigFormat.Unknown;
      await assert.rejects(() => MetadataParser.parseStructureOnly('x'), /Unknown configuration format/);
    } finally {
      (FormatDetector.isValidConfigurationPath as unknown as typeof FormatDetector.isValidConfigurationPath) = originalValid;
      (FormatDetector.detect as unknown as typeof FormatDetector.detect) = originalDetect;
    }
  });

  test('parseTypeContents routes by format and returns empty for unsupported', async () => {
    const originalDetect = FormatDetector.detect;
    const originalDesigner = DesignerParser.parseTypeContents;
    const originalEdt = EdtParser.parseTypeContents;
    try {
      (DesignerParser.parseTypeContents as unknown as (a: string, b: string) => Promise<TreeNode[]>) = async () => [{ id: 'd', name: 'D', type: MetadataType.Catalog, properties: {} }];
      (EdtParser.parseTypeContents as unknown as (a: string, b: string) => Promise<TreeNode[]>) = async () => [{ id: 'e', name: 'E', type: MetadataType.Document, properties: {} }];

      (FormatDetector.detect as unknown as (p: string) => Promise<ConfigFormat>) = async () => ConfigFormat.Designer;
      assert.strictEqual((await MetadataParser.parseTypeContents('cfg', 'Catalogs'))[0].id, 'd');

      (FormatDetector.detect as unknown as (p: string) => Promise<ConfigFormat>) = async () => ConfigFormat.EDT;
      assert.strictEqual((await MetadataParser.parseTypeContents('cfg', 'Documents'))[0].id, 'e');

      (FormatDetector.detect as unknown as (p: string) => Promise<ConfigFormat>) = async () => ConfigFormat.Unknown;
      assert.deepStrictEqual(await MetadataParser.parseTypeContents('cfg', 'Any'), []);
    } finally {
      (FormatDetector.detect as unknown as typeof FormatDetector.detect) = originalDetect;
      (DesignerParser.parseTypeContents as unknown as typeof DesignerParser.parseTypeContents) = originalDesigner;
      (EdtParser.parseTypeContents as unknown as typeof EdtParser.parseTypeContents) = originalEdt;
    }
  });

  test('parseTypeContents uses provided format without detecting again', async () => {
    const originalDetect = FormatDetector.detect;
    const originalDesigner = DesignerParser.parseTypeContents;
    try {
      (FormatDetector.detect as unknown as (p: string) => Promise<ConfigFormat>) = async () => {
        throw new Error('detect should not run');
      };
      (DesignerParser.parseTypeContents as unknown as (a: string, b: string) => Promise<TreeNode[]>) = async () => [
        { id: 'cached-format', name: 'D', type: MetadataType.Catalog, properties: {} },
      ];

      const children = await MetadataParser.parseTypeContents('cfg', 'Catalogs', {
        format: ConfigFormat.Designer,
        bypassCache: true,
      });

      assert.strictEqual(children[0].id, 'cached-format');
    } finally {
      (FormatDetector.detect as unknown as typeof FormatDetector.detect) = originalDetect;
      (DesignerParser.parseTypeContents as unknown as typeof DesignerParser.parseTypeContents) = originalDesigner;
    }
  });

  test('parseTypeContents reuses disk cache for unchanged type folders', async () => {
    const configPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-type-cache-cfg-'));
    const storagePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-type-cache-store-'));
    await fs.promises.mkdir(path.join(configPath, 'Catalogs'), { recursive: true });
    await fs.promises.writeFile(path.join(configPath, 'Catalogs', 'Goods.xml'), '<MetaDataObject/>', 'utf-8');

    const originalDetect = FormatDetector.detect;
    const originalDesigner = DesignerParser.parseTypeContents;
    let parseCount = 0;
    try {
      MetadataParser.setTypeContentsCacheStoragePath(storagePath);
      (FormatDetector.detect as unknown as (p: string) => Promise<ConfigFormat>) = async () => ConfigFormat.Designer;
      (DesignerParser.parseTypeContents as unknown as (a: string, b: string) => Promise<TreeNode[]>) = async () => {
        parseCount += 1;
        return [{ id: 'Catalogs.Goods', name: 'Goods', type: MetadataType.Catalog, properties: {} }];
      };

      const first = await MetadataParser.parseTypeContents(configPath, 'Catalogs');
      const second = await MetadataParser.parseTypeContents(configPath, 'Catalogs');

      assert.strictEqual(first[0].id, 'Catalogs.Goods');
      assert.strictEqual(second[0].id, 'Catalogs.Goods');
      assert.strictEqual(parseCount, 1);
    } finally {
      MetadataParser.setTypeContentsCacheStoragePath(null);
      (FormatDetector.detect as unknown as typeof FormatDetector.detect) = originalDetect;
      (DesignerParser.parseTypeContents as unknown as typeof DesignerParser.parseTypeContents) = originalDesigner;
      await fs.promises.rm(configPath, { recursive: true, force: true });
      await fs.promises.rm(storagePath, { recursive: true, force: true });
    }
  });

  test('parseTypeContents joins concurrent requests for the same type folder', async () => {
    const configPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-type-cache-inflight-cfg-'));
    const storagePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-type-cache-inflight-store-'));
    await fs.promises.mkdir(path.join(configPath, 'Catalogs'), { recursive: true });
    await fs.promises.writeFile(path.join(configPath, 'Catalogs', 'Goods.xml'), '<MetaDataObject/>', 'utf-8');

    const originalDetect = FormatDetector.detect;
    const originalDesigner = DesignerParser.parseTypeContents;
    let parseCount = 0;
    let releaseParse!: () => void;
    const parseBarrier = new Promise<void>((resolve) => {
      releaseParse = resolve;
    });
    try {
      MetadataParser.setTypeContentsCacheStoragePath(storagePath);
      (FormatDetector.detect as unknown as (p: string) => Promise<ConfigFormat>) = async () => ConfigFormat.Designer;
      (DesignerParser.parseTypeContents as unknown as (a: string, b: string) => Promise<TreeNode[]>) = async () => {
        parseCount += 1;
        await parseBarrier;
        return [{ id: 'Catalogs.Goods', name: 'Goods', type: MetadataType.Catalog, properties: {} }];
      };

      const first = MetadataParser.parseTypeContents(configPath, 'Catalogs');
      while (parseCount === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      const second = MetadataParser.parseTypeContents(configPath, 'Catalogs');
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      releaseParse();

      const [firstChildren, secondChildren] = await Promise.all([first, second]);

      assert.strictEqual(firstChildren[0].id, 'Catalogs.Goods');
      assert.strictEqual(secondChildren[0].id, 'Catalogs.Goods');
      assert.strictEqual(parseCount, 1, 'concurrent callers must share one parse operation');
    } finally {
      releaseParse?.();
      MetadataParser.setTypeContentsCacheStoragePath(null);
      (FormatDetector.detect as unknown as typeof FormatDetector.detect) = originalDetect;
      (DesignerParser.parseTypeContents as unknown as typeof DesignerParser.parseTypeContents) = originalDesigner;
      await fs.promises.rm(configPath, { recursive: true, force: true });
      await fs.promises.rm(storagePath, { recursive: true, force: true });
    }
  });

  test('loadElementChildren covers R6 placeholder branch and generic branch', async () => {
    const originalDesignerLoad = DesignerParser.loadChildrenForElement;
    const originalEdtLoad = EdtParser.loadChildrenForElement;
    try {
      (DesignerParser.loadChildrenForElement as unknown as (...args: unknown[]) => Promise<TreeNode[]>) = async () => [
        {
          id: 'Attributes',
          name: 'Attributes',
          type: MetadataType.Attribute,
          properties: {},
          children: [{ id: 'a', name: 'A', type: MetadataType.Attribute, properties: {} }],
        },
      ];
      (EdtParser.loadChildrenForElement as unknown as (...args: unknown[]) => Promise<TreeNode[]>) = async () => [
        { id: 'x', name: 'X', type: MetadataType.Form, properties: {} },
      ];

      const typeNode: TreeNode = { id: 'Catalogs', name: 'Catalogs', type: MetadataType.Catalog, properties: {}, children: [] };
      const parentObject: TreeNode = { id: 'Catalog.Prod', name: 'Prod', type: MetadataType.Catalog, properties: {}, parent: typeNode, children: [] };
      const sectionPlaceholder: TreeNode = { id: 'Attributes', name: 'Attributes', type: MetadataType.Attribute, properties: {}, parent: parentObject, children: [] };

      const r6Children = await MetadataParser.loadElementChildren('cfg', ConfigFormat.Designer, sectionPlaceholder);
      assert.strictEqual(r6Children.length, 1);
      assert.strictEqual(r6Children[0].parent, sectionPlaceholder);

      const regularElement: TreeNode = { id: 'Catalogs.Product', name: 'Product', type: MetadataType.Catalog, properties: {} };
      const regularChildren = await MetadataParser.loadElementChildren('cfg', ConfigFormat.EDT, regularElement);
      assert.strictEqual(regularChildren[0].id, 'x');

      const unknownChildren = await MetadataParser.loadElementChildren('cfg', ConfigFormat.Unknown, regularElement);
      assert.deepStrictEqual(unknownChildren, []);
    } finally {
      (DesignerParser.loadChildrenForElement as unknown as typeof DesignerParser.loadChildrenForElement) = originalDesignerLoad;
      (EdtParser.loadChildrenForElement as unknown as typeof EdtParser.loadChildrenForElement) = originalEdtLoad;
    }
  });

  test('loadElementChildren generic branch adds Реквизиты placeholder for empty tabular section (lazy load)', async () => {
    const originalDesignerLoad = DesignerParser.loadChildrenForElement;
    const originalEdtLoad = EdtParser.loadChildrenForElement;
    try {
      (DesignerParser.loadChildrenForElement as unknown as (...args: unknown[]) => Promise<TreeNode[]>) = async () => [];
      (EdtParser.loadChildrenForElement as unknown as (...args: unknown[]) => Promise<TreeNode[]>) = async () => [];

      const tabularSectionsFolder: TreeNode = {
        id: 'TabularSections',
        name: 'Табличные части',
        type: MetadataType.TabularSection,
        properties: {},
        children: [],
      };
      const tsInstance: TreeNode = {
        id: 'TabularSections.EmptySection',
        name: 'EmptySection',
        type: MetadataType.TabularSection,
        properties: { _lazy: true },
        parent: tabularSectionsFolder,
        filePath: 'C:\\cfg\\Catalogs\\Cat\\TabularSections\\EmptySection\\EmptySection.xml',
      };

      for (const fmt of [ConfigFormat.Designer, ConfigFormat.EDT] as const) {
        const children = await MetadataParser.loadElementChildren('cfg', fmt, tsInstance);
        assert.strictEqual(children.length, 1, fmt);
        const col = children[0];
        assert.strictEqual(col.name, 'Реквизиты', fmt);
        assert.strictEqual(col.id, 'TabularSections.EmptySection.Attributes', fmt);
        assert.ok(isTabularSectionColumnsContainer(col), fmt);
        assert.strictEqual(
          (col.properties as Record<string, unknown>).type,
          TABULAR_SECTION_COLUMNS_PLACEHOLDER_TYPE,
          fmt
        );
        assert.strictEqual(col.parent, tsInstance, fmt);
        assert.strictEqual((col.properties as Record<string, unknown>)._lazy, true, fmt);
      }
    } finally {
      (DesignerParser.loadChildrenForElement as unknown as typeof DesignerParser.loadChildrenForElement) = originalDesignerLoad;
      (EdtParser.loadChildrenForElement as unknown as typeof EdtParser.loadChildrenForElement) = originalEdtLoad;
    }
  });

  test('parse handles unsupported format and wraps non-Error throwables', async () => {
    const originalValid = FormatDetector.isValidConfigurationPath;
    const originalDetect = FormatDetector.detect;
    try {
      (FormatDetector.isValidConfigurationPath as unknown as (p: string) => Promise<boolean>) = async () => true;
      (FormatDetector.detect as unknown as (p: string) => Promise<ConfigFormat>) = async () => 999 as unknown as ConfigFormat;
      await assert.rejects(() => MetadataParser.parse('cfg'), /Failed to parse metadata: Unsupported configuration format/);

      (FormatDetector.detect as unknown as (p: string) => Promise<ConfigFormat>) = async () => {
        throw 'plain-string-error';
      };
      await assert.rejects(() => MetadataParser.parse('cfg'), /Failed to parse metadata: plain-string-error/);
    } finally {
      (FormatDetector.isValidConfigurationPath as unknown as typeof FormatDetector.isValidConfigurationPath) = originalValid;
      (FormatDetector.detect as unknown as typeof FormatDetector.detect) = originalDetect;
    }
  });

  test('parseFromWorkspace returns null on thrown error after finding path', async () => {
    const originalFind = FormatDetector.findConfigurationRoot;
    const originalParse = MetadataParser.parse;
    try {
      (FormatDetector.findConfigurationRoot as unknown as (p: string) => Promise<string | null>) = async () => 'cfg';
      (MetadataParser.parse as unknown as (p: string) => Promise<TreeNode>) = async () => {
        throw new Error('boom');
      };

      const result = await MetadataParser.parseFromWorkspace('workspace');
      assert.strictEqual(result, null);
    } finally {
      (FormatDetector.findConfigurationRoot as unknown as typeof FormatDetector.findConfigurationRoot) = originalFind;
      (MetadataParser.parse as unknown as typeof MetadataParser.parse) = originalParse;
    }
  });
});
