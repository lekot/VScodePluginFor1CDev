import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { resolveTemplatePreviewTargetPath } from '../../src/commands/resolveTemplatePreviewTargetPath';
import { MetadataType } from '../../src/models/treeNode';

suite('resolveTemplatePreviewTargetPath', () => {
  let tmpRoot: string;

  setup(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), '1cv-tpl-prev-'));
  });

  teardown(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  test('empty path returns empty', async () => {
    assert.strictEqual(await resolveTemplatePreviewTargetPath('', MetadataType.Template), '');
  });

  test('Templates/<name>.xml → .../<name>/Ext/Template.xml when body exists', async () => {
    const body = path.join(tmpRoot, 'Templates', 'MyTpl', 'Ext', 'Template.xml');
    await fs.mkdir(path.dirname(body), { recursive: true });
    await fs.writeFile(body, '<mxl/>', 'utf8');

    const desc = path.join(tmpRoot, 'Templates', 'MyTpl.xml');
    const resolved = await resolveTemplatePreviewTargetPath(desc, MetadataType.Template);
    assert.strictEqual(resolved, path.normalize(body));
  });

  test('Templates/<name>.xml → .../<name>/Template.xml when body exists without Ext (issue-style layout)', async () => {
    const body = path.join(tmpRoot, 'Templates', 'MaketTemplate', 'Template.xml');
    await fs.mkdir(path.dirname(body), { recursive: true });
    await fs.writeFile(body, '<mxl/>', 'utf8');

    const desc = path.join(tmpRoot, 'Templates', 'MaketTemplate.xml');
    const resolved = await resolveTemplatePreviewTargetPath(desc, MetadataType.Template);
    assert.strictEqual(resolved, path.normalize(body));
  });

  test('Templates/<name>/Template.xml → .../<name>/Ext/Template.xml when body exists', async () => {
    const body = path.join(tmpRoot, 'Templates', 'MyTpl', 'Ext', 'Template.xml');
    await fs.mkdir(path.dirname(body), { recursive: true });
    await fs.writeFile(body, '<mxl/>', 'utf8');

    const desc = path.join(tmpRoot, 'Templates', 'MyTpl', 'Template.xml');
    const resolved = await resolveTemplatePreviewTargetPath(desc, MetadataType.Template);
    assert.strictEqual(resolved, path.normalize(body));
  });

  test('Templates/Template.xml (root-level descriptor) → Templates/Template/Ext/Template.xml when body exists', async () => {
    const body = path.join(tmpRoot, 'Templates', 'Template', 'Ext', 'Template.xml');
    await fs.mkdir(path.dirname(body), { recursive: true });
    await fs.writeFile(body, '<mxl/>', 'utf8');

    const desc = path.join(tmpRoot, 'Templates', 'Template.xml');
    const resolved = await resolveTemplatePreviewTargetPath(desc, MetadataType.Template);
    assert.strictEqual(resolved, path.normalize(body));
  });

  test('CommonTemplates/CommonTemplate.xml (root-level descriptor) → CommonTemplates/CommonTemplate/Ext/CommonTemplate.xml when body exists', async () => {
    const body = path.join(tmpRoot, 'CommonTemplates', 'CommonTemplate', 'Ext', 'CommonTemplate.xml');
    await fs.mkdir(path.dirname(body), { recursive: true });
    await fs.writeFile(body, '<mxl/>', 'utf8');

    const desc = path.join(tmpRoot, 'CommonTemplates', 'CommonTemplate.xml');
    const resolved = await resolveTemplatePreviewTargetPath(desc, MetadataType.CommonTemplate);
    assert.strictEqual(resolved, path.normalize(body));
  });

  test('CommonTemplates/<name>.xml → .../<name>/Ext/CommonTemplate.xml when body exists', async () => {
    const body = path.join(tmpRoot, 'CommonTemplates', 'Shared', 'Ext', 'CommonTemplate.xml');
    await fs.mkdir(path.dirname(body), { recursive: true });
    await fs.writeFile(body, '<mxl/>', 'utf8');

    const desc = path.join(tmpRoot, 'CommonTemplates', 'Shared.xml');
    const resolved = await resolveTemplatePreviewTargetPath(desc, MetadataType.CommonTemplate);
    assert.strictEqual(resolved, path.normalize(body));
  });

  test('CommonTemplates/<name>.xml → .../<name>/Ext/Template.xml when only Designer-style body exists', async () => {
    const body = path.join(tmpRoot, 'CommonTemplates', 'Shared', 'Ext', 'Template.xml');
    await fs.mkdir(path.dirname(body), { recursive: true });
    await fs.writeFile(body, '<mxl/>', 'utf8');

    const desc = path.join(tmpRoot, 'CommonTemplates', 'Shared.xml');
    const resolved = await resolveTemplatePreviewTargetPath(desc, MetadataType.CommonTemplate);
    assert.strictEqual(resolved, path.normalize(body));
  });

  test('returns original path when no Ext body exists', async () => {
    const desc = path.join(tmpRoot, 'Templates', 'OnlyDesc.xml');
    await fs.mkdir(path.dirname(desc), { recursive: true });
    await fs.writeFile(desc, '<meta/>', 'utf8');

    const resolved = await resolveTemplatePreviewTargetPath(desc, MetadataType.Template);
    assert.strictEqual(resolved, path.normalize(desc));
  });

  test('already points at Ext/Template.xml → unchanged', async () => {
    const body = path.join(tmpRoot, 'Templates', 'T', 'Ext', 'Template.xml');
    await fs.mkdir(path.dirname(body), { recursive: true });
    await fs.writeFile(body, '<mxl/>', 'utf8');

    const resolved = await resolveTemplatePreviewTargetPath(body, MetadataType.Template);
    assert.strictEqual(resolved, path.normalize(body));
  });
});
