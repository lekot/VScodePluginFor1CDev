import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseFormXml } from '../../src/formEditor/formXmlParser';
import { getWebviewHtml } from '../../src/formEditor/formWebviewHtml';
import { writeFormXml } from '../../src/formEditor/formXmlWriter';
import { getPreviewFieldCharacterWidth } from '../../src/formEditor/formPreviewLayout';
import { installDirectConfigurationMutationEngineForTests } from '../helpers/directConfigurationMutationEngine';
import { createFormWebviewRuntimeFixture } from '../helpers/formWebviewRuntime';

suite('Form editor Taxi style preview', () => {
  let html: string;
  let restoreMutationEngine: (() => void) | undefined;

  suiteSetup(() => {
    restoreMutationEngine = installDirectConfigurationMutationEngineForTests();
    html = getWebviewHtml({} as any);
  });

  suiteTeardown(() => {
    restoreMutationEngine?.();
    restoreMutationEngine = undefined;
  });

  test('parses a representative nested Pages, group, command bar, table, and typed attributes fixture', async () => {
    const result = await parseFormXml(path.join(__dirname, '../fixtures/form-editor/FormTaxi.xml'));
    assert.ok(!('error' in result), 'fixture parses');
    if ('error' in result) return;

    const pages = result.model.childItemsRoot.find(item => item.tag === 'Pages');
    assert.ok(pages);
    assert.deepStrictEqual(pages.childItems.filter(item => item.tag === 'Page').map(item => item.name), ['Main', 'Lines']);
    assert.ok(pages.childItems[0].childItems.some(item => item.tag === 'UsualGroup'));
    assert.ok(pages.childItems[1].childItems.some(item => item.tag === 'Table'));
    assert.strictEqual(result.model.autoCommandBar?.tag, 'AutoCommandBar');
    assert.strictEqual(result.model.attributes.length, 6);
    assert.deepStrictEqual(result.model.attributes.map(attribute => attribute.name), ['Customer', 'BusinessDate', 'StartTime', 'CreatedAt', 'Enabled', 'Amount']);
    assert.deepStrictEqual(result.model.attributes.map(attribute => attribute.id), ['attr-customer', 'attr-date', 'attr-time', 'attr-datetime', 'attr-boolean', 'attr-number']);
    assert.ok(result.model.childItemsRoot[0].childItems[0].childItems[0].childItems.some(item => item.tag === 'CheckBoxField'));
    assert.ok(result.model.childItemsRoot[0].childItems[0].childItems[0].childItems.some(item => item.tag === 'RadioButtonField'));
  });

  test('preserves typed form attributes through the XML writer round-trip', async () => {
    const fixture = path.join(__dirname, '../fixtures/form-editor/FormTaxi.xml');
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'form-taxi-preview-'));
    const tempFile = path.join(tempRoot, 'Form.xml');
    try {
      await fs.promises.copyFile(fixture, tempFile);
      const parsed = await parseFormXml(tempFile);
      assert.ok(!('error' in parsed), 'fixture parses before write');
      if ('error' in parsed) return;

      const original = parsed.model.attributes.map(attribute => ({ name: attribute.name, type: attribute.properties['Type'] }));
      assert.strictEqual(original.length, 6, 'attribute names must be read from their XML wrapper attributes');
      await writeFormXml(tempFile, parsed.model);
      const afterWrite = await parseFormXml(tempFile);
      assert.ok(!('error' in afterWrite), 'round-tripped fixture parses');
      if ('error' in afterWrite) return;
      assert.deepStrictEqual(
        afterWrite.model.attributes.map(attribute => ({ name: attribute.name, type: attribute.properties['Type'] })),
        original
      );
    } finally {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('uses Taxi preview spacing and a toolbar fit-to-width control', () => {
    assert.ok(html.includes('--preview-horizontal-gap: 8px'), 'horizontal Taxi spacing');
    assert.ok(html.includes('--preview-vertical-gap: 9px'), 'vertical Taxi spacing');
    assert.ok(html.includes('--preview-control-gap: 5px'), 'control spacing');
    assert.ok(html.includes('id="tb-preview-fit"'), 'fit-to-width toolbar button');
    assert.ok(html.includes('minmax(240px, 300px)'), 'the properties inspector has a visible grid column');
    assert.ok(html.includes('@media (max-width: 760px)'), 'narrow viewports arrange the inspector below the editing panes');

    const fixture = createFormWebviewRuntimeFixture();
    try {
      fixture.send({
        type: 'formData',
        formModel: {
          childItemsRoot: [{ tag: 'InputField', id: 'field', name: 'Field', properties: {}, childItems: [] }],
          attributes: [],
          commands: [],
          formEvents: [],
        },
      });
      const button = fixture.dom.window.document.getElementById('tb-preview-fit');
      const form = fixture.dom.window.document.getElementById('preview-form');
      assert.ok(button && form);
      button.dispatchEvent(new fixture.dom.window.MouseEvent('click', { bubbles: true }));
      assert.strictEqual(button.getAttribute('aria-pressed'), 'true');
      assert.ok(form.classList.contains('preview-fit-width'));
      button.dispatchEvent(new fixture.dom.window.MouseEvent('click', { bubbles: true }));
      assert.strictEqual(button.getAttribute('aria-pressed'), 'false');
      assert.ok(!form.classList.contains('preview-fit-width'));
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    } finally {
      fixture.close();
    }
  });

  test('defines a fixed light 1C form surface inside the VS Code themed editor', () => {
    assert.ok(html.includes('--preview-canvas-background: #f2f2f2'), 'preview window uses the Taxi gray canvas');
    assert.ok(html.includes('--preview-card-background: #ffffff'), 'light preview uses white cards');
    assert.ok(html.includes("--preview-canvas-background: #111827") === false, 'host dark mode must not recolor the preview');
    assert.ok(html.includes("#preview-form { ") && html.includes("font-family: Arial, 'Segoe UI', Tahoma, sans-serif"), 'form surface uses the platform-like font stack');
    assert.ok(html.includes('font-size: 12px') && html.includes('background: #f2f2f2'), 'form surface uses fixed 1C typography and canvas');
    assert.ok(html.includes('.preview-pages-panel-wrap {') && html.includes('background: var(--preview-card-background)'), 'page content is a card');
    assert.ok(html.includes('.preview-input {') && html.includes('background: var(--preview-control-background)'), 'bound controls use preview styling');
    assert.ok(html.includes('.preview-table-mock th {') && html.includes('var(--preview-table-header-background)'), 'table headers use preview styling');
    assert.ok(html.includes('.preview-button {') && html.includes('linear-gradient(180deg, #ffffff'), 'buttons use native-looking raised chrome');
  });

  test('sizes bound fields from their DataPath attribute type and numeric qualifiers', () => {
    assert.strictEqual(getPreviewFieldCharacterWidth('TimeValue', [{ name: 'TimeValue', properties: { Type: { DateFractions: 'Time' } } }]), 8);
    assert.strictEqual(getPreviewFieldCharacterWidth('Amount', [{ name: 'Amount', properties: { Type: { Type: 'Number', Digits: '12', FractionDigits: '2' } } }]), 12);
  });

  test('maps DataPath to reference, date, time, datetime, boolean, and qualified number widths', async () => {
    const result = await parseFormXml(path.join(__dirname, '../fixtures/form-editor/FormTaxi.xml'));
    assert.ok(!('error' in result));
    if ('error' in result) return;
    const width = (pathName: string): number => getPreviewFieldCharacterWidth(pathName, result.model.attributes);

    assert.strictEqual(width('Customer'), 15);
    assert.strictEqual(width('BusinessDate'), 10);
    assert.strictEqual(width('StartTime'), 8);
    assert.strictEqual(width('CreatedAt'), 22);
    assert.strictEqual(width('Enabled'), 10);
    assert.strictEqual(width('Amount'), 12);
    assert.strictEqual(width('Form.Customer'), 15, 'qualified paths still resolve by leaf attribute name');
    assert.strictEqual(width('MissingAttribute'), 15, 'unknown types keep the compact default width');
  });

  test('keeps preview selection, event navigation, and secure webview transport hooks', () => {
    assert.ok(html.includes("script-src 'nonce-"));
    assert.ok(html.includes("style-src 'nonce-"));
    assert.ok(!html.includes('unsafe-inline'));

    const fixture = createFormWebviewRuntimeFixture();
    try {
      fixture.send({
        type: 'formData',
        modulePath: '/workspace/Forms/Ext/Module.bsl',
        formModel: {
          childItemsRoot: [{
            tag: 'InputField', id: 'field', name: 'Field', properties: {}, childItems: [], events: { OnChange: 'OnFieldChange' },
          }],
          attributes: [],
          commands: [],
          formEvents: [],
        },
      });
      const document = fixture.dom.window.document;
      const scripts = Array.from(document.querySelectorAll('script[src], link[href]'));
      assert.deepStrictEqual(scripts, [], 'browser runtime loads no external script or style resources');
      assert.ok(document.querySelector('.fe-command-icon'), 'self-owned inline SVG icons are embedded');
      const treeItem = document.querySelector<HTMLElement>('#tree-root .tree-node[data-id="field"]');
      assert.ok(treeItem);
      treeItem.dispatchEvent(new fixture.dom.window.MouseEvent('click', { bubbles: true }));
      assert.deepStrictEqual(fixture.messages.find((message) => message.type === 'selectElement')?.selectedIds, ['field']);
      const goto = document.querySelector<HTMLButtonElement>('#props-content .btn-goto-proc');
      assert.ok(goto);
      goto.dispatchEvent(new fixture.dom.window.MouseEvent('click', { bubbles: true }));
      assert.deepStrictEqual(
        fixture.messages.find((message) => message.type === 'openModule'),
        { type: 'openModule', procedureName: 'OnFieldChange' },
      );
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    } finally {
      fixture.close();
    }
  });
});
