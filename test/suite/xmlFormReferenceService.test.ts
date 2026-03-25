import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  addDesignerFormReferenceInParsed,
  removeDesignerFormFromOwnerInParsed,
} from '../../src/utils/xml/xmlFormReferenceService';
import { XMLWriter } from '../../src/utils/XMLWriter';
import { createTempDir, cleanupTempDir } from '../helpers/testHelpers';

suite('xmlFormReferenceService (parsed transforms)', () => {
  test('addDesignerFormReferenceInParsed appends Form to empty ChildObjects', () => {
    const parsed = {
      MetaDataObject: {
        Catalog: {
          Properties: { Name: 'Cat' },
          ChildObjects: '',
        },
      },
    };
    const state = { changed: false };
    const out = addDesignerFormReferenceInParsed(parsed, 'MyForm', state) as typeof parsed;
    assert.strictEqual(state.changed, true);
    const co = out.MetaDataObject.Catalog.ChildObjects as unknown as Record<string, unknown>;
    assert.strictEqual(co.Form, 'MyForm');
  });

  test('addDesignerFormReferenceInParsed is idempotent for same form name', () => {
    const parsed = {
      MetaDataObject: {
        Catalog: {
          Properties: { Name: 'Cat' },
          ChildObjects: { Form: 'MyForm' },
        },
      },
    };
    const state = { changed: false };
    addDesignerFormReferenceInParsed(parsed, 'MyForm', state);
    assert.strictEqual(state.changed, false);
  });

  test('addDesignerFormReferenceInParsed appends second form as array', () => {
    const parsed = {
      MetaDataObject: {
        Catalog: {
          Properties: { Name: 'Cat' },
          ChildObjects: { Form: 'A' },
        },
      },
    };
    const state = { changed: false };
    const out = addDesignerFormReferenceInParsed(parsed, 'B', state) as typeof parsed;
    assert.strictEqual(state.changed, true);
    const co = out.MetaDataObject.Catalog.ChildObjects as unknown as Record<string, unknown>;
    assert.deepStrictEqual(co.Form, ['A', 'B']);
  });

  test('removeDesignerFormFromOwnerInParsed removes Form entry and clears DefaultObjectForm suffix', () => {
    const parsed = {
      MetaDataObject: {
        Catalog: {
          Properties: {
            Name: 'Cat',
            DefaultObjectForm: 'Catalog.Cat.Form.MyForm',
          },
          ChildObjects: { Form: ['A', 'MyForm'] },
        },
      },
    };
    const state = { changed: false };
    const out = removeDesignerFormFromOwnerInParsed(parsed, 'MyForm', state) as typeof parsed;
    assert.strictEqual(state.changed, true);
    const cat = out.MetaDataObject.Catalog;
    const props = cat.Properties as Record<string, unknown>;
    assert.strictEqual(props.DefaultObjectForm, '');
    const co = cat.ChildObjects as unknown as Record<string, unknown>;
    assert.strictEqual(co.Form, 'A');
  });

  test('removeDesignerFormFromOwnerInParsed does not clear DefaultObjectForm for a different form', () => {
    const parsed = {
      MetaDataObject: {
        Catalog: {
          Properties: {
            Name: 'Cat',
            DefaultObjectForm: 'Catalog.Cat.Form.OtherForm',
          },
          ChildObjects: { Form: 'MyForm' },
        },
      },
    };
    const state = { changed: false };
    const out = removeDesignerFormFromOwnerInParsed(parsed, 'MyForm', state) as typeof parsed;
    assert.strictEqual(state.changed, true);
    const props = out.MetaDataObject.Catalog.Properties as Record<string, unknown>;
    assert.strictEqual(props.DefaultObjectForm, 'Catalog.Cat.Form.OtherForm');
  });
});

suite('XMLWriter Designer form references (file + I/O guards)', () => {
  let tmp: string;

  setup(async () => {
    tmp = await createTempDir('1c-formref-');
  });

  teardown(async () => {
    await cleanupTempDir(tmp);
  });

  test('addDesignerFormReferenceToOwnerMetadata writes Form into ChildObjects', async () => {
    const src = path.join(
      __dirname,
      '../fixtures/designer-config/Catalogs/CatalogEmptyFolder/CatalogEmptyFolder.xml'
    );
    const dest = path.join(tmp, 'Cat.xml');
    await fs.promises.copyFile(src, dest);
    await XMLWriter.addDesignerFormReferenceToOwnerMetadata(dest, 'TestForm');
    const xml = await fs.promises.readFile(dest, 'utf-8');
    assert.ok(xml.includes('<Form>TestForm</Form>'), xml);
  });

  test('addNestedElement throws File not found for missing path', async () => {
    const p = path.join(tmp, 'missing-object.xml');
    await assert.rejects(() => XMLWriter.addNestedElement(p, 'Attribute', 'X'), /File not found/);
  });

  test('addNestedElement throws on invalid XML content', async () => {
    const p = path.join(tmp, 'bad.xml');
    await fs.promises.writeFile(p, '<<<not-xml', 'utf-8');
    await assert.rejects(() => XMLWriter.addNestedElement(p, 'Attribute', 'X'), /Invalid XML structure/);
  });
});
