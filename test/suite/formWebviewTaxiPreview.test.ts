import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chromium } from 'playwright';
import { parseFormXml } from '../../src/formEditor/formXmlParser';
import { getWebviewHtml } from '../../src/formEditor/formWebviewHtml';
import { writeFormXml } from '../../src/formEditor/formXmlWriter';
import { getPreviewFieldCharacterWidth } from '../../src/formEditor/formPreviewLayout';

suite('Form editor Taxi style preview', () => {
  let html: string;

  suiteSetup(() => {
    html = getWebviewHtml({} as any);
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
    assert.ok(html.includes('function fitPreviewToWidth()'), 'fit-to-width behavior');
    assert.ok(html.includes('minmax(240px, 300px)'), 'the properties inspector has a visible grid column');
    assert.ok(html.includes('@media (max-width: 760px)'), 'narrow viewports arrange the inspector below the editing panes');
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
    assert.ok(html.includes('function getPreviewFieldCharacterWidth(dataPath, attributes)'), 'type-aware sizing helper');
    assert.ok(html.includes("inp.style.width = characterWidth + 'ch';"), 'rendered input receives resolved width');
    assert.ok(html.includes('datefractions') && html.includes('fractiondigits'), 'date fractions and numeric qualifiers are recognized');
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
    assert.ok(html.includes("vscode.postMessage({ type: 'selectElement', elementId: id, selectedIds: selectedIds.slice() });"));
    assert.ok(html.includes("vscode.postMessage({ type: 'openModule', procedureName: proc })"));
    assert.ok(html.includes('class="fe-command-icon"'), 'self-owned inline SVG icons are embedded');
    assert.ok(html.includes("getCommandIconSvg('search')"), 'search tree icon uses the local SVG set');
    assert.ok(!html.includes('href="http'), 'icons load no external resources');
    assert.ok(html.includes("script-src 'nonce-"));
    assert.ok(html.includes("style-src 'nonce-"));
    assert.ok(!html.includes('unsafe-inline'));
  });

  test('runs selection, event navigation, and fit control in a Chromium webview page', async function() {
    this.timeout(15000);
    const edgePath = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ].find(candidate => fs.existsSync(candidate));
    if (!edgePath) this.skip();

    const parsed = await parseFormXml(path.join(__dirname, '../fixtures/form-editor/FormTaxi.xml'));
    assert.ok(!('error' in parsed));
    if ('error' in parsed) return;

    const findElement = (items: typeof parsed.model.childItemsRoot): (typeof parsed.model.childItemsRoot)[number] | undefined => {
      for (const item of items) {
        if (item.id === 'field-date') return item;
        const nested = findElement(item.childItems);
        if (nested) return nested;
      }
      return undefined;
    };
    const dateField = findElement(parsed.model.childItemsRoot);
    assert.ok(dateField, 'date field exists in the nested fixture');
    const maliciousProcedure = 'Bad"><img src=x onerror=alert(1)>';
    dateField.events = { ...dateField.events, OnFocus: maliciousProcedure };

    const browser = await chromium.launch({ executablePath: edgePath, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const scriptNonce = html.match(/<script nonce="([^"]+)">/)?.[1];
      assert.ok(scriptNonce, 'webview script nonce exists');
      const scriptOpen = `<script nonce="${scriptNonce}">`;
      const bridge = 'Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {} } }); window.__postedMessages = []; window.acquireVsCodeApi = () => ({ postMessage: message => window.__postedMessages.push(message), getState: () => undefined, setState: () => undefined });';
      const testHtml = html.replace(scriptOpen, `${scriptOpen}${bridge}`);
      await page.setContent(testHtml, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => (globalThis as any).document.body.setAttribute('data-theme-mode', 'light'));
      await page.evaluate((formModel) => {
        (globalThis as any).dispatchEvent(new MessageEvent('message', { data: { type: 'formData', formModel } }));
      }, parsed.model);

      const dateInput = page.locator('input[data-data-path="BusinessDate"]');
      await dateInput.waitFor();
      const lightColors = await page.evaluate(() => {
        const document = (globalThis as any).document;
        const color = (selector: string, property: string) => {
          const element = document.querySelector(selector);
          return element ? (globalThis as any).getComputedStyle(element)[property] : 'MISSING ' + selector;
        };
        return {
          canvas: color('#preview-form', 'backgroundColor'),
          bodySurface: color('.preview-form-body', 'backgroundColor'),
          fontFamily: color('#preview-form', 'fontFamily'),
          fontSize: color('#preview-form', 'fontSize'),
          hostPanel: color('.zone-preview', 'backgroundColor'),
          pageCard: color('.preview-pages-panel-wrap', 'backgroundColor'),
          groupCard: color('.preview-group-block', 'backgroundColor'),
          label: color('.preview-field-label', 'color'),
          inputFrame: color('.preview-input-frame', 'backgroundColor'),
          inputFrameBorder: color('.preview-input-frame', 'borderColor'),
          button: color('.preview-button', 'backgroundImage'),
          buttonHeight: color('.preview-button', 'height'),
          checkbox: color('.preview-check', 'backgroundColor'),
          checkboxBorder: color('.preview-check', 'borderColor'),
          radio: color('.preview-radio-option input[type="radio"]', 'backgroundColor'),
          radioCheckedMark: (() => {
            const radio = document.querySelector('.preview-radio-option input[type="radio"]:checked');
            return radio ? (globalThis as any).getComputedStyle(radio, '::after').backgroundColor : 'MISSING radio mark';
          })(),
          commandbar: color('.preview-commandbar', 'backgroundColor'),
          tab: color('.preview-pages-tab[aria-selected="true"]', 'backgroundColor'),
        };
      });
      assert.strictEqual(lightColors.canvas, 'rgb(242, 242, 242)', 'light preview canvas follows Taxi gray');
      assert.strictEqual(lightColors.bodySurface, 'rgb(255, 255, 255)', 'the form client area is white');
      assert.strictEqual(lightColors.fontFamily, 'Arial, "Segoe UI", Tahoma, sans-serif', 'preview typography is independent of VS Code');
      assert.strictEqual(lightColors.fontSize, '12px', 'preview uses platform-sized text');
      assert.strictEqual(lightColors.label, 'rgb(77, 77, 77)', 'form captions use the fixed platform foreground');
      assert.strictEqual(lightColors.pageCard, 'rgb(255, 255, 255)', 'page area is a white card');
      assert.strictEqual(lightColors.groupCard, 'rgba(0, 0, 0, 0)', 'usual groups do not invent a card surface');
      assert.strictEqual(lightColors.inputFrame, 'rgb(255, 255, 255)', 'bound field frame has a white platform surface');
      assert.strictEqual(lightColors.inputFrameBorder, 'rgb(160, 160, 160)', 'bound field frame uses the Taxi border');
      assert.ok(lightColors.button.startsWith('linear-gradient('), 'command buttons use raised Taxi chrome');
      assert.strictEqual(lightColors.buttonHeight, '26px', 'command bar button follows the Taxi button height');
      assert.strictEqual(lightColors.checkbox, 'rgb(255, 255, 255)', 'checkbox uses a white platform control face');
      assert.strictEqual(lightColors.checkboxBorder, 'rgb(160, 160, 160)', 'checkbox uses the platform control border');
      assert.strictEqual(lightColors.radio, 'rgb(255, 255, 255)', 'radio buttons use a white platform control face');
      assert.strictEqual(lightColors.radioCheckedMark, 'rgb(0, 150, 70)', 'selected radio uses the Taxi green marker');
      assert.strictEqual(lightColors.commandbar, 'rgba(0, 0, 0, 0)', 'root command bar sits directly on the form surface');
      assert.strictEqual(lightColors.tab, 'rgb(255, 255, 255)', 'active page tab merges into the white page surface');
      await page.locator('.tree-icon-svg svg.fe-command-icon').waitFor();
      assert.ok(await page.locator('#tb-add svg.fe-command-icon, #tb-delete svg.fe-command-icon, #tb-save svg.fe-command-icon').count() >= 3);
      assert.strictEqual(await dateInput.getAttribute('data-character-width'), '10');
      assert.strictEqual(await dateInput.evaluate(input => (input as any).style.width), '10ch');
      await page.locator('#tb-add').click();
      await page.locator('#tb-save').click();
      await page.locator('.preview-item[data-id="field-date"]').click();
      const changeEventInput = page.locator('.event-method-input[data-event="OnChange"]');
      const focusEventInput = page.locator('.event-method-input[data-event="OnFocus"]');
      await changeEventInput.waitFor({ timeout: 2000 });
      assert.strictEqual(await changeEventInput.inputValue(), 'WhenDateChanges');
      assert.strictEqual(await focusEventInput.inputValue(), maliciousProcedure, 'procedure names render as literal input values');
      assert.strictEqual(await page.locator('#props-content img').count(), 0, 'procedure text cannot inject markup');
      await page.locator('.prop-row:has(input[data-event="OnChange"]) .btn-goto-proc').click();
      await page.locator('.prop-row:has(input[data-event="OnFocus"]) .btn-goto-proc').click();
      await changeEventInput.fill('UpdatedDateHandler');
      await changeEventInput.press('Tab');
      const messages = await page.evaluate(() => (globalThis as any).__postedMessages);
      assert.ok(messages.some((message: any) => message.type === 'addElement'));
      assert.ok(messages.some((message: any) => message.type === 'save'));
      assert.ok(messages.some((message: any) => message.type === 'selectElement' && message.elementId === 'field-date'));
      assert.ok(messages.some((message: any) => message.type === 'openModule' && message.procedureName === 'WhenDateChanges'));
      assert.ok(messages.some((message: any) => message.type === 'openModule' && message.procedureName === maliciousProcedure));
      assert.ok(messages.some((message: any) => message.type === 'propertyChange' && message.elementId === 'field-date' && message.section === 'events' && message.key === 'OnChange' && message.value === 'UpdatedDateHandler'));

      await page.locator('.preview-pages-tab').filter({ hasText: 'Строки' }).click();
      const tableColors = await page.locator('.preview-table-mock').evaluate(table => {
        const header = table.querySelector('th');
        const cell = table.querySelector('td');
        const getStyle = (globalThis as any).getComputedStyle;
        return {
          card: getStyle(table).backgroundColor,
          header: header ? getStyle(header).backgroundColor : '',
          cell: cell ? getStyle(cell).color : '',
          fontSize: getStyle(table).fontSize,
        };
      });
      assert.strictEqual(tableColors.card, 'rgb(255, 255, 255)', 'table is placed on a white card');
      assert.strictEqual(tableColors.header, 'rgb(242, 242, 242)', 'table header uses Taxi gray');

      await page.evaluate(() => (globalThis as any).document.body.setAttribute('data-theme-mode', 'dark'));
      const darkTableColors = await page.locator('.preview-table-mock').evaluate(table => {
        const header = table.querySelector('th');
        const cell = table.querySelector('td');
        const getStyle = (globalThis as any).getComputedStyle;
        return {
          card: getStyle(table).backgroundColor,
          header: header ? getStyle(header).backgroundColor : '',
          cell: cell ? getStyle(cell).color : '',
          fontSize: getStyle(table).fontSize,
        };
      });
      assert.deepStrictEqual(darkTableColors, tableColors, 'table chrome is independent of the host theme');
      await page.locator('.preview-pages-tab').filter({ hasText: 'Основное' }).click();
      const darkColors = await page.evaluate(() => {
        const document = (globalThis as any).document;
        return {
          canvas: (globalThis as any).getComputedStyle(document.querySelector('#preview-form')).backgroundColor,
          bodySurface: (globalThis as any).getComputedStyle(document.querySelector('.preview-form-body')).backgroundColor,
          inputFrame: (globalThis as any).getComputedStyle(document.querySelector('.preview-input-frame')).backgroundColor,
          button: (globalThis as any).getComputedStyle(document.querySelector('.preview-button')).backgroundImage,
          buttonHeight: (globalThis as any).getComputedStyle(document.querySelector('.preview-button')).height,
          checkbox: (globalThis as any).getComputedStyle(document.querySelector('.preview-check')).backgroundColor,
          checkboxBorder: (globalThis as any).getComputedStyle(document.querySelector('.preview-check')).borderColor,
          radio: (globalThis as any).getComputedStyle(document.querySelector('.preview-radio-option input[type="radio"]')).backgroundColor,
          radioCheckedMark: (globalThis as any).getComputedStyle(document.querySelector('.preview-radio-option input[type="radio"]:checked'), '::after').backgroundColor,
          label: (globalThis as any).getComputedStyle(document.querySelector('.preview-field-label')).color,
          commandbar: (globalThis as any).getComputedStyle(document.querySelector('.preview-commandbar')).backgroundColor,
          tab: (globalThis as any).getComputedStyle(document.querySelector('.preview-pages-tab[aria-selected="true"]')).backgroundColor,
          hostPanel: (globalThis as any).getComputedStyle(document.querySelector('.zone-preview')).backgroundColor,
        };
      });
      const { hostPanel: darkHostPanel, ...darkPlatformColors } = darkColors;
      assert.deepStrictEqual(darkPlatformColors, {
        canvas: lightColors.canvas,
        bodySurface: lightColors.bodySurface,
        inputFrame: lightColors.inputFrame,
        button: lightColors.button,
        buttonHeight: lightColors.buttonHeight,
        checkbox: lightColors.checkbox,
        checkboxBorder: lightColors.checkboxBorder,
        radio: lightColors.radio,
        radioCheckedMark: lightColors.radioCheckedMark,
        label: lightColors.label,
        commandbar: lightColors.commandbar,
        tab: lightColors.tab,
      }, 'the preview keeps the same Taxi chrome under VS Code dark mode');
      assert.notStrictEqual(darkHostPanel, lightColors.hostPanel, 'surrounding editor panel follows the host theme');
      const darkScreenshotPath = process.env.FORM_EDITOR_PREVIEW_DARK_SCREENSHOT_PATH;
      if (darkScreenshotPath) await page.locator('.zone-preview').screenshot({ path: darkScreenshotPath });
      await page.evaluate(() => (globalThis as any).document.body.setAttribute('data-theme-mode', 'light'));

      const screenshotPath = process.env.FORM_EDITOR_PREVIEW_SCREENSHOT_PATH;
      if (screenshotPath) {
        await changeEventInput.fill('WhenDateChanges');
        await changeEventInput.press('Tab');
        await focusEventInput.fill('WhenDateFocused');
        await focusEventInput.press('Tab');
        await page.evaluate(() => (globalThis as any).document.body.setAttribute('data-theme-mode', 'light'));
        await page.screenshot({ path: screenshotPath, fullPage: true });
      }

      const fitButton = page.locator('#tb-preview-fit');
      await page.evaluate(() => {
        const document = (globalThis as any).document;
        const wideContent = document.createElement('div');
        wideContent.style.width = '2200px';
        wideContent.textContent = 'overflow test';
        document.getElementById('preview-form')?.appendChild(wideContent);
      });
      assert.ok(await page.locator('#preview-form').evaluate(root => root.scrollWidth > root.clientWidth), 'fixture has overflowing preview content');
      await fitButton.click();
      assert.strictEqual(await fitButton.getAttribute('aria-pressed'), 'true');
      assert.ok(await page.locator('#preview-form').evaluate(root => root.classList.contains('preview-fit-width')));
      const fitScale = Number(await page.locator('#preview-form').getAttribute('data-fit-scale'));
      assert.ok(fitScale > 0 && fitScale < 1, `wide content should scale below 1, got ${fitScale}`);
      await fitButton.click();
      assert.strictEqual(await fitButton.getAttribute('aria-pressed'), 'false');
      assert.ok(!(await page.locator('#preview-form').evaluate(root => root.classList.contains('preview-fit-width'))));

      const splitterBox = await page.locator('#splitter-v').boundingBox();
      assert.ok(splitterBox, 'vertical splitter is available at desktop width');
      const treeWidthBeforeResize = (await page.locator('.zone-tree').boundingBox())?.width || 0;
      await page.mouse.move(splitterBox.x + splitterBox.width / 2, splitterBox.y + 100);
      await page.mouse.down();
      await page.mouse.move(splitterBox.x + splitterBox.width / 2 + 40, splitterBox.y + 100);
      await page.mouse.up();
      const treeWidthAfterResize = (await page.locator('.zone-tree').boundingBox())?.width || 0;
      assert.ok(treeWidthAfterResize > treeWidthBeforeResize + 20, 'tree splitter keeps working with the inspector visible');

      await page.setViewportSize({ width: 680, height: 900 });
      await changeEventInput.waitFor({ timeout: 2000 });
      const layoutBoxes = await page.evaluate(() => ['.zone-tree', '.zone-right-upper', '.zone-props', '.zone-preview'].map(selector => {
        const rect = (globalThis as any).document.querySelector(selector).getBoundingClientRect();
        return { selector, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      }));
      for (const box of layoutBoxes) {
        assert.ok(box.left >= -1 && box.right <= 681, `${box.selector} stays within the narrow viewport`);
      }
      for (let i = 0; i < layoutBoxes.length; i++) {
        for (let j = i + 1; j < layoutBoxes.length; j++) {
          const a = layoutBoxes[i];
          const b = layoutBoxes[j];
          const overlaps = a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
          assert.ok(!overlaps, `${a.selector} and ${b.selector} do not overlap at narrow width`);
        }
      }
    } finally {
      await browser.close();
    }
  });
});
