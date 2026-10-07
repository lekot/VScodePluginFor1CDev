import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveXdtoPackageSchemaPath } from '../../src/xdtoPackageEditor/xdtoPackagePaths';
import { buildXdtoPackageSkeleton } from '../../src/xdtoPackageEditor/xdtoPackageFiles';
import {
  XdtoPackageEditorProvider,
  parseAndValidateXdtoSourceForSave,
  serializeAndValidateXdtoModelForSave,
} from '../../src/xdtoPackageEditor/xdtoPackageEditorProvider';
import type { XdtoPackageModel } from '../../src/types/xdtoPackage';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import {
  createFakeExtensionContext,
  createFakeWebviewPanel,
  patchCreateWebviewPanel,
} from '../helpers/rightsEditorTestHarness';

suite('XdtoPackageEditorProvider (pure helpers)', () => {
  test('resolves Designer Package.bin path from flat metadata XML', () => {
    const metadataPath = path.join('C:', 'cfg', 'XDTOPackages', 'Exchange.xml');
    const result = resolveXdtoPackageSchemaPath(metadataPath, 'Exchange');
    assert.strictEqual(
      result,
      path.join('C:', 'cfg', 'XDTOPackages', 'Exchange', 'Ext', 'Package.bin')
    );
  });

  test('prefers existing Package.bin over legacy Package.xdto', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdto-path-'));
    try {
      const metadataPath = path.join(root, 'XDTOPackages', 'Exchange.xml');
      const extPath = path.join(root, 'XDTOPackages', 'Exchange', 'Ext');
      fs.mkdirSync(extPath, { recursive: true });
      fs.writeFileSync(path.join(extPath, 'Package.xdto'), '<package/>', 'utf8');
      fs.writeFileSync(path.join(extPath, 'Package.bin'), '<package/>', 'utf8');

      assert.strictEqual(
        resolveXdtoPackageSchemaPath(metadataPath, 'Exchange'),
        path.join(extPath, 'Package.bin')
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('builds 1C package skeleton without empty targetNamespace', () => {
    const skeleton = buildXdtoPackageSkeleton('');

    assert.ok(skeleton.includes('<package xmlns="http://v8.1c.ru/8.1/xdto"'));
    assert.ok(!skeleton.includes('targetNamespace=""'));
  });

  test('serializes structured save model to package XML and parsed model without empty targetNamespace', () => {
    const model: XdtoPackageModel = {
      imports: [],
      valueTypes: [{ name: 'BoolFlag', baseType: 'xs:boolean', facets: [], properties: [], attributes: [], raw: {}, unknownNodes: [] }],
      objectTypes: [],
      rootProperties: [{ name: 'Flag', type: 'BoolFlag', raw: {}, unknownNodes: [] }],
      diagnostics: [],
      unknownNodes: [],
    };

    const result = serializeAndValidateXdtoModelForSave(model);

    assert.strictEqual(result.ok, true);
    assert.ok(result.source.includes('<package xmlns="http://v8.1c.ru/8.1/xdto"'));
    assert.ok(result.source.includes('<valueType name="BoolFlag" base="xs:boolean"/>'));
    assert.ok(result.source.includes('<property name="Flag" type="BoolFlag"/>'));
    assert.ok(!result.source.includes('targetNamespace=""'));
    assert.strictEqual(result.model.valueTypes[0]?.name, 'BoolFlag');
    assert.strictEqual(result.model.rootProperties[0]?.name, 'Flag');
  });

  test('returns source with parsed model for raw source save', () => {
    const source = '\uFEFF<package xmlns="http://v8.1c.ru/8.1/xdto"><valueType name="Amount" base="xs:decimal"/></package>';

    const result = parseAndValidateXdtoSourceForSave(source);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.source, source);
    assert.strictEqual(result.model.valueTypes[0]?.name, 'Amount');
  });

  test('rejects model save when serialized source fails XML validation', () => {
    const model: XdtoPackageModel = {
      imports: [],
      valueTypes: [],
      objectTypes: [],
      rootProperties: [],
      diagnostics: [],
      rawRoot: { '@_xmlns:bad prefix': 'urn:bad' },
      unknownNodes: [],
    };

    const result = serializeAndValidateXdtoModelForSave(model);

    assert.strictEqual(result.ok, false);
    assert.ok(result.message.length > 0);
  });

  test('rejects malformed raw source save', () => {
    const result = parseAndValidateXdtoSourceForSave('<package><valueType></package>');

    assert.strictEqual(result.ok, false);
    assert.ok(result.message.length > 0);
  });

  suite('XdtoPackageEditorProvider session isolation (#196)', () => {
    test('late saveSuccess of package A does not update webview after package B is shown', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdto-iso-'));
      try {
        fs.writeFileSync(
          path.join(root, 'Configuration.xml'),
          '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Configuration uuid="00000000-0000-0000-0000-000000000000"><Properties><Name>TestConfig</Name></Properties></Configuration></MetaDataObject>',
          'utf8'
        );
        const metaPathA = path.join(root, 'XDTOPackages', 'PackageA.xml');
        const extPathA = path.join(root, 'XDTOPackages', 'PackageA', 'Ext');
        fs.mkdirSync(extPathA, { recursive: true });
        const sourceA = '<package xmlns="http://v8.1c.ru/8.1/xdto"><valueType name="TypeA" base="xs:string"/></package>';
        fs.writeFileSync(metaPathA, '<MetaDataObject><XDTOPackage name="PackageA"/></MetaDataObject>', 'utf8');
        fs.writeFileSync(path.join(extPathA, 'Package.bin'), sourceA, 'utf8');

        const metaPathB = path.join(root, 'XDTOPackages', 'PackageB.xml');
        const extPathB = path.join(root, 'XDTOPackages', 'PackageB', 'Ext');
        fs.mkdirSync(extPathB, { recursive: true });
        const sourceB = '<package xmlns="http://v8.1c.ru/8.1/xdto"><valueType name="TypeB" base="xs:string"/></package>';
        fs.writeFileSync(metaPathB, '<MetaDataObject><XDTOPackage name="PackageB"/></MetaDataObject>', 'utf8');
        fs.writeFileSync(path.join(extPathB, 'Package.bin'), sourceB, 'utf8');

        const nodeA: TreeNode = {
          id: 'XDTOPackages.PackageA',
          name: 'PackageA',
          type: MetadataType.XDTOPackage,
          filePath: metaPathA,
          properties: {},
        };
        const nodeB: TreeNode = {
          id: 'XDTOPackages.PackageB',
          name: 'PackageB',
          type: MetadataType.XDTOPackage,
          filePath: metaPathB,
          properties: {},
        };

        const { panel, getPostedMessages } = createFakeWebviewPanel();
        const restore = patchCreateWebviewPanel(panel);
        const provider = new XdtoPackageEditorProvider(createFakeExtensionContext());

        try {
          await provider.show(nodeA);
          assert.ok(panel.title.includes('PackageA'));

          // Trigger save of package A
          const updatedSourceA = '<package xmlns="http://v8.1c.ru/8.1/xdto"><valueType name="TypeAUpdated" base="xs:string"/></package>';
          const saveAPromise = (provider as any).handleMessage({ type: 'save', source: updatedSourceA });

          // Switch editor to Package B while save A is in progress
          await provider.show(nodeB);
          assert.ok(panel.title.includes('PackageB'));

          await saveAPromise;

          // Messages posted to webview must NOT deliver TypeAUpdated saveSuccess to PackageB's webview
          const saveSuccessMessages = getPostedMessages().filter((m: any) => m.type === 'saveSuccess');
          const hasStaleSaveSuccess = saveSuccessMessages.some((m: any) =>
            m.model?.valueTypes?.some((vt: any) => vt.name === 'TypeAUpdated')
          );
          assert.strictEqual(
            hasStaleSaveSuccess,
            false,
            'Late saveSuccess from PackageA must not be delivered when PackageB is active'
          );
        } finally {
          restore();
          provider.dispose();
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
