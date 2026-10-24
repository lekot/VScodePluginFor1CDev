import '../helpers/vscodeStubRegister';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { getWebviewHtml } from '../../src/formEditor/formWebviewHtml';
import type { FormChildItem } from '../../src/formEditor/formModel';
import { createFormWebviewRuntimeFixture } from '../helpers/formWebviewRuntime';

function formItem(tag: string, id: string, properties: Record<string, unknown> = {}, childItems: FormChildItem[] = []): FormChildItem {
  return { tag, id, name: id, properties, childItems };
}

function renderItems(items: FormChildItem[]): ReturnType<typeof createFormWebviewRuntimeFixture> {
  const fixture = createFormWebviewRuntimeFixture();
  try {
    fixture.send({ type: 'formData', formModel: { childItemsRoot: items, attributes: [], commands: [], formEvents: [] } });
    return fixture;
  } catch (error) {
    fixture.close();
    throw error;
  }
}

/** Contract tests for 1CVIEWER-36 Block 3 phase B: layout meta parity (spacing, align, ChildItemsWidth, ThroughAlign) in embedded preview script/CSS. */
suite('form webview Block 3B — groups & alignment (1CVIEWER-36)', () => {
  let html: string;

  suiteSetup(() => {
    html = getWebviewHtml({} as vscode.Webview, vscode.ColorThemeKind.Dark);
  });

  test('CSS: ChildItemsWidth and ThroughAlign preview hooks', () => {
    assert.ok(html.includes('preview-ciwidth-equal'), 'equal width hook');
    assert.ok(html.includes('preview-ciwidth-leftwidest'), 'left widest hook');
    assert.ok(html.includes('preview-ciwidth-rightwidest'), 'right widest hook');
    assert.ok(html.includes('preview-throughalign-use'), 'through-align stretch hooks');
  });

  test('Pages root keeps the dedicated vertical shell and ignores group-only layout settings', () => {
    const fixture = renderItems([
      formItem('Pages', 'pages-root', {
        Orientation: 'Horizontal',
        HorizontalSpacing: 'Double',
        ChildItemsWidth: 'Equal',
        ThroughAlign: 'Use',
      }, [formItem('Page', 'page-one', {}, [formItem('Button', 'page-button')])]),
    ]);
    try {
      const outer = fixture.dom.window.document.querySelector<HTMLElement>('.preview-item[data-id="pages-root"] .preview-pages-outer');
      assert.ok(outer);
      assert.ok(outer.classList.contains('preview-container-pages-root'));
      assert.ok(outer.classList.contains('preview-children-vertical'));
      assert.ok(!outer.classList.contains('preview-ciwidth-equal'));
      assert.ok(!outer.classList.contains('preview-throughalign-use'));
      assert.strictEqual(outer.style.columnGap, '');
      assert.strictEqual(outer.style.alignItems, '');
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    } finally {
      fixture.close();
    }
  });

  test('orientation-aware Taxi spacing maps horizontal and vertical intervals onto the correct CSS axes', () => {
    const fixture = renderItems([
      formItem('UsualGroup', 'horizontal-group', {
        Orientation: 'Horizontal',
        HorizontalSpacing: 'Single',
        VerticalSpacing: 'Double',
        HorizontalAlign: 'Right',
        VerticalAlign: 'Top',
      }, [formItem('Button', 'first'), formItem('Button', 'second')]),
      formItem('UsualGroup', 'double-group', {
        Orientation: 'Horizontal',
        HorizontalSpacing: 'Double',
        VerticalSpacing: 'Single',
      }, [formItem('Button', 'third')]),
    ]);
    try {
      const horizontal = fixture.dom.window.document.querySelector<HTMLElement>('.preview-item[data-id="horizontal-group"] .preview-group-block');
      const double = fixture.dom.window.document.querySelector<HTMLElement>('.preview-item[data-id="double-group"] .preview-group-block');
      assert.ok(horizontal && double);
      assert.strictEqual(horizontal.style.columnGap, '10px');
      assert.strictEqual(horizontal.style.rowGap, '18px');
      assert.strictEqual(horizontal.style.justifyContent, 'flex-end');
      assert.strictEqual(horizontal.style.alignItems, 'flex-start');
      assert.strictEqual(double.style.columnGap, '20px');
      assert.strictEqual(double.style.rowGap, '9px');
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    } finally {
      fixture.close();
    }
  });

  test('ThroughAlign use stretches children on the cross axis while dont-use does not', () => {
    const fixture = renderItems([
      formItem('UsualGroup', 'stretch-group', { Orientation: 'Horizontal', ThroughAlign: 'Use' }, [formItem('Button', 'stretch-child')]),
      formItem('UsualGroup', 'non-stretch-group', { Orientation: 'Horizontal', ThroughAlign: 'Dont Use' }, [formItem('Button', 'non-stretch-child')]),
    ]);
    try {
      const document = fixture.dom.window.document;
      const stretch = document.querySelector<HTMLElement>('.preview-item[data-id="stretch-group"] .preview-group-block');
      const nonStretch = document.querySelector<HTMLElement>('.preview-item[data-id="non-stretch-group"] .preview-group-block');
      assert.ok(stretch && nonStretch);
      assert.strictEqual(stretch.style.alignItems, 'stretch');
      assert.ok(stretch.classList.contains('preview-throughalign-use'));
      assert.strictEqual(nonStretch.style.alignItems, '');
      assert.ok(!nonStretch.classList.contains('preview-throughalign-use'));
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    } finally {
      fixture.close();
    }
  });

  test('normalizes English and Russian child width and ThroughAlign values into preview classes', () => {
    const fixture = renderItems([
      formItem('UsualGroup', 'equal-group', { Orientation: 'Horizontal', 'ШиринаДочернихЭлементов': 'Равная' }, [formItem('Button', 'equal-child')]),
      formItem('UsualGroup', 'right-group', { Orientation: 'Horizontal', ChildItemsWidth: 'Right Widest', ThroughAlign: 'Да' }, [formItem('Button', 'right-child')]),
    ]);
    try {
      const document = fixture.dom.window.document;
      const equal = document.querySelector<HTMLElement>('.preview-item[data-id="equal-group"] .preview-group-block');
      const right = document.querySelector<HTMLElement>('.preview-item[data-id="right-group"] .preview-group-block');
      assert.ok(equal && right);
      assert.ok(equal.classList.contains('preview-ciwidth-equal'));
      assert.ok(right.classList.contains('preview-ciwidth-rightwidest'));
      assert.ok(right.classList.contains('preview-throughalign-use'));
      assert.strictEqual(right.style.alignItems, 'stretch');
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    } finally {
      fixture.close();
    }
  });

  test('Pages root uses its dedicated shell class in the generated preview DOM', () => {
    const fixture = renderItems([formItem('Pages', 'pages-shell', {}, [formItem('Page', 'shell-page', {}, [formItem('LabelField', 'shell-label')])])]);
    try {
      const outer = fixture.dom.window.document.querySelector('.preview-pages-outer.preview-container-pages-root');
      assert.ok(outer, 'Pages root shell is rendered with its dedicated class');
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    } finally {
      fixture.close();
    }
  });
});
