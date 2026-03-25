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

  test('substituteDesignerTemplate clears RegisteredDocuments when RecorderDocumentRef omitted', () => {
    const template = `<RegisteredDocuments>
        <xr:Item xsi:type="xr:MDObjectRef">{RecorderDocumentRef}</xr:Item>
      </RegisteredDocuments>`;
    const out = substituteDesignerTemplate(template, {
      uuid: 'u',
      Name: 'J',
      Synonym_ru: 's',
    });
    assert.ok(out.includes('<RegisteredDocuments/>'));
    assert.ok(!out.includes('{RecorderDocumentRef}'));
  });

  test('substituteDesignerTemplate replaces optional uuidDim and uuidResource', () => {
    const template = '<R d="{uuidDim}" r="{uuidResource}">{uuid}</R>';
    const out = substituteDesignerTemplate(template, {
      uuid: 'u',
      Name: 'N',
      Synonym_ru: 'S',
      uuidDim: 'dim&1',
      uuidResource: 'res<2',
    });
    assert.ok(out.includes('d="dim&amp;1"'));
    assert.ok(out.includes('r="res&lt;2"'));
  });

  test('substituteDesignerTemplate replaces RecorderDocumentRef when provided', () => {
    const template = '<Ref>{RecorderDocumentRef}</Ref>';
    const out = substituteDesignerTemplate(template, {
      uuid: 'u',
      Name: 'N',
      Synonym_ru: 'S',
      RecorderDocumentRef: 'Document.Тест',
    });
    assert.ok(out.includes('Document.Тест'));
    assert.ok(!out.includes('{RecorderDocumentRef}'));
  });

  test('substituteDesignerTemplate trims RecorderDocumentRef before substitution', () => {
    const template = '<Ref>{RecorderDocumentRef}</Ref>';
    const out = substituteDesignerTemplate(template, {
      uuid: 'u',
      Name: 'N',
      Synonym_ru: 'S',
      RecorderDocumentRef: '  Document.X  ',
    });
    assert.ok(out.includes('Document.X'));
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
