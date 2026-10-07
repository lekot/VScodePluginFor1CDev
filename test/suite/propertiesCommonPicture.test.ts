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
