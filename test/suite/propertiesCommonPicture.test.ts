import * as assert from 'assert';
import { TreeNode, MetadataType } from '../../src/models/treeNode';
import {
  renderPicturePreviewCard,
  renderStyleItemPreview,
  getWebviewContent,
} from '../../src/providers/propertiesWebviewContent';
import type { ResolvedPicture } from '../../src/services/picture/commonPictureResolver';

suite('Properties Webview - CommonPicture and StyleItem Preview', () => {
  test('renderPicturePreviewCard renders image, format badge, and filename', () => {
    const pic: ResolvedPicture = {
      success: true,
      dataUri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      mimeType: 'image/png',
      format: 'PNG',
      resolvedFilePath: 'C:/reps/conf/CommonPictures/Logo/Ext/Picture/Picture.png',
    };

    const html = renderPicturePreviewCard(pic);
    assert.ok(html.includes('class="picture-preview-card"'), 'must include card class');
    assert.ok(html.includes('<img'), 'must include img tag');
    assert.ok(html.includes('data:image/png;base64,'), 'must include data uri');
    assert.ok(html.includes('PNG'), 'must include format badge');
    assert.ok(html.includes('Picture.png'), 'must include filename');
    assert.ok(html.includes('data-file-path='), 'must include open-file button or attribute');
  });

  test('renderPicturePreviewCard renders ZIP details when image is bundled in archive', () => {
    const pic: ResolvedPicture = {
      success: true,
      dataUri: 'data:image/svg+xml;utf8,<svg></svg>',
      mimeType: 'image/svg+xml',
      format: 'SVG',
      isZip: true,
      entryName: 'icon.svg',
      resolvedFilePath: 'C:/reps/conf/CommonPictures/Multi/Ext/Picture/Picture.zip',
    };

    const html = renderPicturePreviewCard(pic);
    assert.ok(html.includes('SVG'), 'must include format SVG');
    assert.ok(html.includes('icon.svg'), 'must include zip entry name');
    assert.ok(html.includes('ZIP'), 'must mention ZIP bundle');
  });

  test('renderPicturePreviewCard renders fallback when picture resolution fails', () => {
    const pic: ResolvedPicture = {
      success: false,
      error: 'Файл изображения не найден',
    };

    const html = renderPicturePreviewCard(pic);
    assert.ok(html.includes('picture-preview-card'));
    assert.ok(html.includes('Файл изображения не найден') || html.includes('не найдено'));
  });

  test('renderStyleItemPreview renders hex color swatch for StyleItem with Color', () => {
    const node: TreeNode = {
      id: 'StyleItems.АктуальнаяПодпискаЦвет',
      name: 'АктуальнаяПодпискаЦвет',
      type: MetadataType.StyleItem,
      properties: {
        Name: 'АктуальнаяПодпискаЦвет',
        Type: 'Color',
        Value: '#009646',
      },
    };

    const html = renderStyleItemPreview(node);
    assert.ok(html.includes('style-item-preview'), 'must include style-item-preview container');
    assert.ok(html.includes('#009646'), 'must display hex code');
    assert.ok(html.includes('background-color: #009646') || html.includes('background: #009646'), 'must set background style');
  });

  test('renderStyleItemPreview renders named style color reference', () => {
    const node: TreeNode = {
      id: 'StyleItems.Фон',
      name: 'Фон',
      type: MetadataType.StyleItem,
      properties: {
        Name: 'Фон',
        Type: 'Color',
        Value: 'style:FieldAlternativeBackColor',
      },
    };

    const html = renderStyleItemPreview(node);
    assert.ok(html.includes('style:FieldAlternativeBackColor'));
    assert.ok(html.includes('style-item-preview'));
  });

  test('renderStyleItemPreview renders typography sample for StyleItem with Font', () => {
    const node: TreeNode = {
      id: 'StyleItems.ВажныйШрифт',
      name: 'ВажныйШрифт',
      type: MetadataType.StyleItem,
      properties: {
        Name: 'ВажныйШрифт',
        Type: 'Font',
        Value: 'ref="style:NormalTextFont" bold="true" italic="false"',
      },
    };

    const html = renderStyleItemPreview(node);
    assert.ok(html.includes('style-item-preview'));
    assert.ok(html.includes('font-weight: bold') || html.includes('bold'));
    assert.ok(html.includes('Пример') || html.includes('Текст') || html.includes('Sample'));
  });

  // Finding 1 (Review #175): XSS / CSS injection sanitization
  test('Finding 1: renderStyleItemPreview sanitizes malicious web: color breakout and event handlers', () => {
    const node: TreeNode = {
      id: 'StyleItems.MaliciousColor',
      name: 'MaliciousColor',
      type: MetadataType.StyleItem,
      properties: {
        Name: 'MaliciousColor',
        Type: 'Color',
        Value: 'web:red;" onmouseover="alert(1)',
      },
    };

    const html = renderStyleItemPreview(node);
    assert.ok(!/<[^>]+onmouseover/i.test(html), 'must not contain injected onmouseover attribute on any HTML element');
    assert.ok(!/<[^>]+style="[^"]*red;\s*"/i.test(html), 'must not break style attribute');
    assert.ok(html.includes('background-color: var(--vscode-editor-foreground)'), 'must fall back to safe background');
  });

  test('Finding 1 (Broad): renderStyleItemPreview rejects invalid or dangerous color values', () => {
    const maliciousValues = [
      'web:javascript:alert(1)',
      'web:red; background: url(http://attacker.com/evil.png)',
      'web:expression(alert(1))',
      '#FF0000; display: none',
    ];

    for (const val of maliciousValues) {
      const node: TreeNode = {
        id: 'StyleItems.Malicious',
        name: 'Malicious',
        type: MetadataType.StyleItem,
        properties: {
          Name: 'Malicious',
          Type: 'Color',
          Value: val,
        },
      };

      const html = renderStyleItemPreview(node);
      assert.ok(!/<[^>]+javascript:/i.test(html), `must not contain javascript in attribute for value ${val}`);
      assert.ok(!/<[^>]+style="[^"]*url\(/i.test(html), `must not contain url() in style attribute for value ${val}`);
      assert.ok(!/<[^>]+style="[^"]*expression\(/i.test(html), `must not contain expression() in style attribute for value ${val}`);
      assert.ok(!/<[^>]+style="[^"]*display:\s*none/i.test(html), `must not contain injected CSS in style attribute for value ${val}`);
      assert.ok(html.includes('background-color: var(--vscode-editor-foreground)'), `must fall back to safe color for ${val}`);
    }
  });

  // Finding 2 (Review #175): XML-parser object extraction for Color and Font
  test('Finding 2: renderStyleItemPreview extracts Color from XML parser object with #text', () => {
    const node: TreeNode = {
      id: 'StyleItems.ParsedColor',
      name: 'ParsedColor',
      type: MetadataType.StyleItem,
      properties: {
        Name: 'ParsedColor',
        Type: 'Color',
        Value: {
          '#text': 'web:Red',
          '@_xsi:type': 'v8ui:Color',
        },
      },
    };

    const html = renderStyleItemPreview(node);
    assert.ok(!html.includes('{"#text"'), 'must not render raw JSON in webview');
    assert.ok(html.includes('web:Red'), 'must render display value web:Red');
    assert.ok(html.includes('background-color: Red') || html.includes('background-color: red'), 'must apply background-color Red');
  });

  test('Finding 2: renderStyleItemPreview extracts style reference Color from object', () => {
    const node: TreeNode = {
      id: 'StyleItems.ParsedStyleRef',
      name: 'ParsedStyleRef',
      type: MetadataType.StyleItem,
      properties: {
        Name: 'ParsedStyleRef',
        Type: 'Color',
        Value: {
          '#text': 'style:FieldAlternativeBackColor',
          '@_xsi:type': 'v8ui:Color',
        },
      },
    };

    const html = renderStyleItemPreview(node);
    assert.ok(!html.includes('{"#text"'), 'must not render raw JSON');
    assert.ok(html.includes('style:FieldAlternativeBackColor'), 'must display style reference value');
  });

  test('Finding 2: renderStyleItemPreview extracts Font from XML parser object attributes', () => {
    const node: TreeNode = {
      id: 'StyleItems.ParsedFont',
      name: 'ParsedFont',
      type: MetadataType.StyleItem,
      properties: {
        Name: 'ParsedFont',
        Type: 'Font',
        Value: {
          '@_xsi:type': 'v8ui:Font',
          '@_faceName': 'Arial',
          '@_height': '12',
          '@_bold': 'true',
          '@_italic': 'false',
          '@_underline': 'true',
        },
      },
    };

    const html = renderStyleItemPreview(node);
    assert.ok(!html.includes('{"@_xsi:type"'), 'must not display raw JSON string');
    assert.ok(html.includes('font-family: Arial'), 'must apply Arial font-family');
    assert.ok(html.includes('font-weight: bold'), 'must apply bold font-weight');
    assert.ok(html.includes('text-decoration: underline'), 'must apply underline');
  });

  test('Finding 2: renderStyleItemPreview extracts Font from nested v8:Font object', () => {
    const node: TreeNode = {
      id: 'StyleItems.NestedFont',
      name: 'NestedFont',
      type: MetadataType.StyleItem,
      properties: {
        Name: 'NestedFont',
        Type: 'Font',
        Value: {
          'v8:Font': {
            '@_faceName': 'Courier New',
            '@_height': '10',
            '@_bold': 'false',
            '@_italic': 'true',
          },
          '@_xsi:type': 'v8ui:Font',
        },
      },
    };

    const html = renderStyleItemPreview(node);
    assert.ok(!html.includes('{"v8:Font"'), 'must not display raw JSON string');
    assert.ok(html.includes('font-family: Courier New'), 'must apply Courier New');
    assert.ok(html.includes('font-style: italic'), 'must apply italic font-style');
  });

  test('getWebviewContent includes picture preview card for CommonPicture node', () => {
    const node: TreeNode = {
      id: 'CommonPictures.Logo',
      name: 'Logo',
      type: MetadataType.CommonPicture,
      properties: {
        Name: 'Logo',
        Synonym: 'Логотип',
      },
      filePath: 'C:/reps/conf/CommonPictures/Logo.xml',
    };

    const pic: ResolvedPicture = {
      success: true,
      dataUri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      mimeType: 'image/png',
      format: 'PNG',
      resolvedFilePath: 'C:/reps/conf/CommonPictures/Logo/Ext/Picture/Picture.png',
    };

    const html = getWebviewContent(node, { picture: pic });
    assert.ok(html.includes('picture-preview-card'), 'webview content must include picture-preview-card');
    assert.ok(html.includes('<img'), 'webview content must include img');
  });

  test('getWebviewContent includes style preview for StyleItem node', () => {
    const node: TreeNode = {
      id: 'StyleItems.TestColor',
      name: 'TestColor',
      type: MetadataType.StyleItem,
      properties: {
        Name: 'TestColor',
        Type: 'Color',
        Value: '#FF5500',
      },
      filePath: 'C:/reps/conf/StyleItems/TestColor.xml',
    };

    const html = getWebviewContent(node);
    assert.ok(html.includes('style-item-preview'), 'webview content must include style-item-preview');
    assert.ok(html.includes('#FF5500'));
  });
});
