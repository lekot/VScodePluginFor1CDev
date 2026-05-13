import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import { XdtoAgentOperations } from '../../src/agent/agentXdtoOperations';

const BASE_PACKAGE = '\uFEFF<package xmlns="http://v8.1c.ru/8.1/xdto" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" targetNamespace="urn:left"><property name="Root" type="xs:string"/></package>';
const RIGHT_XSD = '\uFEFF<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:right"><xs:element name="Root" type="xs:int"/><xs:element name="Extra" type="xs:string"/></xs:schema>';

suite('XdtoAgentOperations', () => {
  let tmpRoot: string;
  let ops: XdtoAgentOperations;

  setup(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-xdto-'));
    writeConfigurationXml(tmpRoot);
    writeXdtoPackage(tmpRoot, 'BasePackage', BASE_PACKAGE);
    ops = new XdtoAgentOperations(tmpRoot);
  });

  teardown(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('listPackages returns package paths and target namespace', async () => {
    const result = await ops.listPackages();

    assert.strictEqual(result.success, true, result.error);
    assert.deepStrictEqual(result.data?.packages, [{
      name: 'BasePackage',
      metadataPath: path.join(tmpRoot, 'XDTOPackages', 'BasePackage.xml'),
      schemaPath: path.join(tmpRoot, 'XDTOPackages', 'BasePackage', 'Ext', 'Package.bin'),
      targetNamespace: 'urn:left',
    }]);
  });

  test('getPackage resolves by name and includes source on demand', async () => {
    const result = await ops.getPackage({ packageName: 'BasePackage', includeSource: true });

    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(result.data?.name, 'BasePackage');
    assert.strictEqual(result.data?.model.targetNamespace, 'urn:left');
    assert.ok(result.data?.source?.includes('targetNamespace="urn:left"'));
  });

  test('exportXsd returns inline source or writes outputPath', async () => {
    const inline = await ops.exportXsd({ packageName: 'BasePackage', includeSource: true });
    assert.strictEqual(inline.success, true, inline.error);
    assert.ok(inline.data?.xsd?.includes('<xs:schema'));
    assert.strictEqual(inline.data?.outputPath, undefined);

    const outputPath = path.join(tmpRoot, 'out', 'base.xsd');
    const written = await ops.exportXsd({ packageName: 'BasePackage', outputPath });
    assert.strictEqual(written.success, true, written.error);
    assert.strictEqual(written.data?.outputPath, outputPath);
    assert.strictEqual(written.data?.xsd, undefined);
    assert.ok(fs.readFileSync(outputPath, 'utf8').includes('<xs:schema'));
  });

  test('importXsd requires exactly one source and updates current Package.bin', async () => {
    const invalidMissing = await ops.importXsd({ packageName: 'BasePackage' });
    assert.strictEqual(invalidMissing.success, false);
    assert.ok(invalidMissing.error?.includes('inputPath') || invalidMissing.error?.includes('source'));

    const invalidBoth = await ops.importXsd({ packageName: 'BasePackage', inputPath: 'a.xsd', source: RIGHT_XSD });
    assert.strictEqual(invalidBoth.success, false);

    const result = await ops.importXsd({ packageName: 'BasePackage', source: RIGHT_XSD });
    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(result.data?.model.targetNamespace, 'urn:right');

    const source = fs.readFileSync(result.data!.schemaPath, 'utf8');
    assert.ok(source.includes('targetNamespace="urn:right"'));
    assert.ok(source.includes('type="xs:int"'));
  });

  test('createFromXsd sanitizes name, creates metadata/schema and registers Configuration.xml', async () => {
    const result = await ops.createFromXsd({ packageName: 'Bad:Name', source: RIGHT_XSD });

    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(result.data?.name, 'Bad_Name');
    assert.strictEqual(result.data?.model.targetNamespace, 'urn:right');
    assert.ok(fs.existsSync(path.join(tmpRoot, 'XDTOPackages', 'Bad_Name.xml')));
    assert.ok(fs.existsSync(path.join(tmpRoot, 'XDTOPackages', 'Bad_Name', 'Ext', 'Package.bin')));
    assert.ok(fs.readFileSync(path.join(tmpRoot, 'Configuration.xml'), 'utf8').includes('Bad_Name'));
  });

  test('compare returns stats and merge applies selected ids to Package.bin', async () => {
    const comparison = await ops.compare({ packageName: 'BasePackage', source: RIGHT_XSD, includeTree: true });
    assert.strictEqual(comparison.success, true, comparison.error);
    assert.ok((comparison.data?.stats.different ?? 0) > 0);
    assert.ok(comparison.data?.tree, 'includeTree=true should include compare tree');

    const compact = await ops.compare({ packageName: 'BasePackage', source: RIGHT_XSD });
    assert.strictEqual(compact.success, true, compact.error);
    assert.strictEqual(compact.data?.tree, undefined);

    const merged = await ops.merge({
      packageName: 'BasePackage',
      source: RIGHT_XSD,
      selectedIds: ['rootProperties:Root:type', 'rootProperties:Extra'],
    });
    assert.strictEqual(merged.success, true, merged.error);
    assert.strictEqual(merged.data?.model.rootProperties.find((p) => p.name === 'Root')?.type, 'xs:int');
    assert.ok(merged.data?.model.rootProperties.some((p) => p.name === 'Extra'));
    assert.ok(fs.readFileSync(merged.data!.schemaPath, 'utf8').includes('name="Extra"'));
  });
});

function writeXdtoPackage(configRoot: string, packageName: string, source: string): void {
  const packagesDir = path.join(configRoot, 'XDTOPackages');
  fs.mkdirSync(path.join(packagesDir, packageName, 'Ext'), { recursive: true });
  fs.writeFileSync(path.join(packagesDir, `${packageName}.xml`), metadataXml(packageName), 'utf8');
  fs.writeFileSync(path.join(packagesDir, packageName, 'Ext', 'Package.bin'), source, 'utf8');
}

function metadataXml(packageName: string): string {
  return `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses"><XDTOPackage name="${packageName}"/></MetaDataObject>`;
}

function writeConfigurationXml(configRoot: string): void {
  fs.writeFileSync(path.join(configRoot, 'Configuration.xml'), [
    '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses">',
    '  <Configuration>',
    '    <ChildObjects>',
    '      <XDTOPackage>BasePackage</XDTOPackage>',
    '    </ChildObjects>',
    '  </Configuration>',
    '</MetaDataObject>',
  ].join('\n'), 'utf8');
}
