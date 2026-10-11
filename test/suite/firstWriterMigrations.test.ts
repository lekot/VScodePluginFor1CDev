import * as assert from 'assert';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { cleanupTempDir, createTempDir } from '../helpers/testHelpers';
import {
  ConfigurationMutationEngine,
  setConfigurationMutationEngine,
  type SingleFileMutationIntent,
  type SingleFileTransform,
  type MutationReceipt,
} from '../../src/services/configurationSession/ConfigurationMutationEngine';
import { SubsystemCommandInterfaceProvider } from '../../src/subsystemCommandInterfaceEditor/subsystemCommandInterfaceProvider';
import { XMLWriter } from '../../src/utils/XMLWriter';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import {
  createFakeExtensionContext,
  createFakeWebviewPanel,
  patchCreateWebviewPanel,
} from '../helpers/rightsEditorTestHarness';

function createSampleConfigurationXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.17">
  <Configuration uuid="00000000-0000-0000-0000-000000000000">
    <Properties>
      <Name>TestConfig</Name>
    </Properties>
  </Configuration>
</MetaDataObject>`;
}

const SAMPLE_COMMAND_INTERFACE = `<?xml version="1.0" encoding="UTF-8"?>
<CommandInterface xmlns="http://v8.1c.ru/8.3/xcf/extrnprops" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="2.17">
\t<CommandsVisibility>
\t\t<Command name="Catalog.Goods.StandardCommand.OpenList">
\t\t\t<Visibility>
\t\t\t\t<xr:Common>true</xr:Common>
\t\t\t</Visibility>
\t\t</Command>
\t</CommandsVisibility>
</CommandInterface>`;

const SAMPLE_CATALOG_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.17">
  <Catalog uuid="11111111-1111-1111-1111-111111111111">
    <Properties>
      <Name>Goods</Name>
      <Comment>Old Comment</Comment>
    </Properties>
    <ChildObjects>
      <Attribute uuid="22222222-2222-2222-2222-222222222222">
        <Properties>
          <Name>Price</Name>
          <Comment>Old Price Comment</Comment>
        </Properties>
      </Attribute>
    </ChildObjects>
  </Catalog>
</MetaDataObject>`;

suite('First Writer Migrations to ConfigurationMutationEngine (#267 roadmap step 4)', () => {
  let tmpDir: string;
  let interceptedKinds: string[];
  let originalEngine: ConfigurationMutationEngine | undefined;

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-first-writers-');
    await fsp.writeFile(path.join(tmpDir, 'Configuration.xml'), createSampleConfigurationXml(), 'utf-8');
    interceptedKinds = [];

    // Track transforms executed via ConfigurationMutationEngine
    originalEngine = new ConfigurationMutationEngine();

    const spyEngine = new ConfigurationMutationEngine();
    const origTransform = spyEngine.transformFile.bind(spyEngine);
    spyEngine.transformFile = async <T>(
      target: any,
      intent: SingleFileMutationIntent,
      transform: SingleFileTransform<T>,
    ): Promise<MutationReceipt<T>> => {
      interceptedKinds.push(intent.kind);
      return origTransform(target, intent, transform);
    };

    setConfigurationMutationEngine(spyEngine);
  });

  teardown(async () => {
    setConfigurationMutationEngine(originalEngine);
    await cleanupTempDir(tmpDir);
  });

  test('SubsystemCommandInterfaceProvider routes save through ConfigurationMutationEngine', async () => {
    const dir = path.join(tmpDir, 'Subsystems', 'SubA', 'Ext');
    await fsp.mkdir(dir, { recursive: true });
    const ciPath = path.join(dir, 'CommandInterface.xml');
    await fsp.writeFile(ciPath, SAMPLE_COMMAND_INTERFACE, 'utf-8');

    const node: TreeNode = {
      id: 'Subsystems.SubA',
      name: 'SubA',
      type: MetadataType.Subsystem,
      filePath: path.join(tmpDir, 'Subsystems', 'SubA.xml'),
      properties: {},
    };

    const { panel } = createFakeWebviewPanel();
    const restore = patchCreateWebviewPanel(panel);
    const provider = new SubsystemCommandInterfaceProvider(createFakeExtensionContext());

    try {
      await provider.show(node, ciPath);
      await (provider as any).handleMessage({
        type: 'save',
        visibility: [{ commandName: 'Catalog.Goods.StandardCommand.OpenList', common: 'false' }],
        filePath: ciPath,
        generation: 1,
      });

      assert.ok(
        interceptedKinds.includes('subsystemCommandInterface.save'),
        `Expected 'subsystemCommandInterface.save' in intercepted kinds: ${JSON.stringify(interceptedKinds)}`
      );

      const updatedDisk = await fsp.readFile(ciPath, 'utf-8');
      assert.ok(updatedDisk.includes('false'), 'Updated visibility must be written to disk');
    } finally {
      restore();
      provider.dispose();
    }
  });

  test('XMLWriter.writeProperties routes through ConfigurationMutationEngine', async () => {
    const catalogPath = path.join(tmpDir, 'Catalogs', 'Goods.xml');
    await fsp.mkdir(path.dirname(catalogPath), { recursive: true });
    await fsp.writeFile(catalogPath, SAMPLE_CATALOG_XML, 'utf-8');

    await XMLWriter.writeProperties(catalogPath, {
      Name: 'Goods',
      Comment: 'New Comment via Engine',
    });

    assert.ok(
      interceptedKinds.includes('properties.save'),
      `Expected 'properties.save' in intercepted kinds: ${JSON.stringify(interceptedKinds)}`
    );

    const updatedDisk = await fsp.readFile(catalogPath, 'utf-8');
    assert.ok(updatedDisk.includes('New Comment via Engine'));
  });

  test('XMLWriter.writeNestedElementProperties routes through ConfigurationMutationEngine', async () => {
    const catalogPath = path.join(tmpDir, 'Catalogs', 'Goods.xml');
    await fsp.mkdir(path.dirname(catalogPath), { recursive: true });
    await fsp.writeFile(catalogPath, SAMPLE_CATALOG_XML, 'utf-8');

    await XMLWriter.writeNestedElementProperties(
      catalogPath,
      'Attribute',
      'Price',
      {
        Name: 'Price',
        Comment: 'New Price Comment via Engine',
      },
      ['Comment'],
    );

    assert.ok(
      interceptedKinds.includes('properties.saveNested'),
      `Expected 'properties.saveNested' in intercepted kinds: ${JSON.stringify(interceptedKinds)}`
    );

    const updatedDisk = await fsp.readFile(catalogPath, 'utf-8');
    assert.ok(updatedDisk.includes('New Price Comment via Engine'));
  });
});
