import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { substituteDesignerTemplate } from '../../src/services/designerTemplateSubstitutor';
import {
  getDesignerTemplateXml,
  initDesignerTemplateRepository,
} from '../../src/services/designerTemplateRepository';

suite('Designer template services', () => {
  test('substituteDesignerTemplate replaces all placeholders and escapes XML entities', () => {
    const template = '<Root><id>{uuid}</id><n>{Name}</n><s>{Synonym_ru}</s></Root>';

    const out = substituteDesignerTemplate(template, {
      uuid: 'u&<>"\'',
      Name: 'N<name>',
      Synonym_ru: 'RU & text',
    });

    assert.ok(out.includes('<id>u&amp;&lt;&gt;&quot;&apos;</id>'));
    assert.ok(out.includes('<n>N&lt;name&gt;</n>'));
    assert.ok(out.includes('<s>RU &amp; text</s>'));
  });

  test('substituteDesignerTemplate replaces repeated placeholders everywhere', () => {
    const template = '{Name}-{Name}-{uuid}-{Synonym_ru}-{uuid}';
    const out = substituteDesignerTemplate(template, {
      uuid: 'id',
      Name: 'Object',
      Synonym_ru: 'Синоним',
    });
    assert.strictEqual(out, 'Object-Object-id-Синоним-id');
  });

  test('getDesignerTemplateXml returns null when repository is not initialized', async () => {
    const content = await getDesignerTemplateXml('Catalog');
    assert.strictEqual(content, null);
  });

  test('getDesignerTemplateXml reads template from extension resource path', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '1cviewer-template-'));
    try {
      const resourcesRoot = path.join(tmp, 'resources', 'designerTemplates', 'Designer');
      fs.mkdirSync(resourcesRoot, { recursive: true });
      const filePath = path.join(resourcesRoot, 'Catalog.xml');
      fs.writeFileSync(filePath, '<CatalogTemplate>ok</CatalogTemplate>', 'utf-8');

      initDesignerTemplateRepository({
        asAbsolutePath: (relativePath: string) => path.join(tmp, relativePath),
      } as any);

      const content = await getDesignerTemplateXml('Catalog');
      assert.strictEqual(content, '<CatalogTemplate>ok</CatalogTemplate>');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('getDesignerTemplateXml returns null when template file is missing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '1cviewer-template-miss-'));
    try {
      initDesignerTemplateRepository({
        asAbsolutePath: (relativePath: string) => path.join(tmp, relativePath),
      } as any);

      const content = await getDesignerTemplateXml('Document');
      assert.strictEqual(content, null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
