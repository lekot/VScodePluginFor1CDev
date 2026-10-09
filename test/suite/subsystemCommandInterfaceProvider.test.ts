import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import { SubsystemCommandInterfaceProvider } from '../../src/subsystemCommandInterfaceEditor/subsystemCommandInterfaceProvider';
import { configureConfigurationMutationGateway } from '../../src/services/configurationSession/configurationMutationGateway';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import {
  createFakeExtensionContext,
  createFakeWebviewPanel,
  patchCreateWebviewPanel,
} from '../helpers/rightsEditorTestHarness';

const XML_A = `<?xml version="1.0" encoding="UTF-8"?>
<CommandInterface xmlns="http://v8.1c.ru/8.3/xcf/extrnprops" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="2.17">
\t<CommandsVisibility>
\t\t<Command name="Catalog.Goods.StandardCommand.OpenList">
\t\t\t<Visibility>
\t\t\t\t<xr:Common>true</xr:Common>
\t\t\t</Visibility>
\t\t</Command>
\t</CommandsVisibility>
</CommandInterface>`;

const XML_B = `<?xml version="1.0" encoding="UTF-8"?>
<CommandInterface xmlns="http://v8.1c.ru/8.3/xcf/extrnprops" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="2.17">
\t<CommandsVisibility>
\t\t<Command name="Document.Orders.StandardCommand.OpenList">
\t\t\t<Visibility>
\t\t\t\t<xr:Common>true</xr:Common>
\t\t\t</Visibility>
\t\t</Command>
\t</CommandsVisibility>
</CommandInterface>`;

suite('SubsystemCommandInterfaceProvider (#210)', () => {
  let defaultGateway: { dispose(): void } | undefined;

  setup(() => {
    defaultGateway = configureConfigurationMutationGateway(
      async (_path, _kind, op) => op(),
      async (_path, plan) => plan.result,
    );
  });

  teardown(() => {
    defaultGateway?.dispose();
    defaultGateway = undefined;
  });

  test('stale save message from subsystem A does not overwrite subsystem B', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-iso-'));
    try {
      const dirA = path.join(root, 'Subsystems', 'SubA', 'Ext');
      const dirB = path.join(root, 'Subsystems', 'SubB', 'Ext');
      fs.mkdirSync(dirA, { recursive: true });
      fs.mkdirSync(dirB, { recursive: true });
      const ciPathA = path.join(dirA, 'CommandInterface.xml');
      const ciPathB = path.join(dirB, 'CommandInterface.xml');
      fs.writeFileSync(ciPathA, XML_A, 'utf8');
      fs.writeFileSync(ciPathB, XML_B, 'utf8');

      const nodeA: TreeNode = {
        id: 'Subsystems.SubA',
        name: 'SubA',
        type: MetadataType.Subsystem,
        filePath: path.join(root, 'Subsystems', 'SubA.xml'),
        properties: {},
      };
      const nodeB: TreeNode = {
        id: 'Subsystems.SubB',
        name: 'SubB',
        type: MetadataType.Subsystem,
        filePath: path.join(root, 'Subsystems', 'SubB.xml'),
        properties: {},
      };

      const { panel, getPostedMessages } = createFakeWebviewPanel();
      const restore = patchCreateWebviewPanel(panel);
      const provider = new SubsystemCommandInterfaceProvider(createFakeExtensionContext());

      try {
        await provider.show(nodeA, ciPathA);
        await provider.show(nodeB, ciPathB);

        // Stale save from Subsystem A webview
        await (provider as any).handleMessage({
          type: 'save',
          visibility: [{ commandName: 'Catalog.HackedFromA', common: 'visible' }],
          filePath: ciPathA,
          generation: 1,
        });

        const contentB = fs.readFileSync(ciPathB, 'utf8');
        assert.ok(
          !contentB.includes('Catalog.HackedFromA'),
          'Subsystem B must not be overwritten by stale save from Subsystem A'
        );
        assert.ok(contentB.includes('Document.Orders'), 'Subsystem B content must be preserved');

        // Valid save for active Subsystem B
        await (provider as any).handleMessage({
          type: 'save',
          visibility: [{ commandName: 'Document.Orders.StandardCommand.OpenList', common: 'hidden' }],
          filePath: ciPathB,
          generation: 2,
        });

        const savedB = fs.readFileSync(ciPathB, 'utf8');
        assert.ok(savedB.includes('Document.Orders.StandardCommand.OpenList'));
        const msgs = getPostedMessages();
        const successMsg = msgs.find(
          (m: any) => m.type === 'saveSuccess' && m.filePath === ciPathB && m.generation === 2
        );
        assert.ok(successMsg, 'Expected saveSuccess message for active subsystem B');
      } finally {
        restore();
        provider.dispose();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('stale generation with same filePath is discarded', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-iso-gen-'));
    try {
      const dir = path.join(root, 'Subsystems', 'SubA', 'Ext');
      fs.mkdirSync(dir, { recursive: true });
      const ciPath = path.join(dir, 'CommandInterface.xml');
      fs.writeFileSync(ciPath, XML_A, 'utf8');

      const node: TreeNode = {
        id: 'Subsystems.SubA',
        name: 'SubA',
        type: MetadataType.Subsystem,
        filePath: path.join(root, 'Subsystems', 'SubA.xml'),
        properties: {},
      };

      const { panel } = createFakeWebviewPanel();
      const restore = patchCreateWebviewPanel(panel);
      const provider = new SubsystemCommandInterfaceProvider(createFakeExtensionContext());

      try {
        await provider.show(node, ciPath);
        // re-open to bump generation
        await provider.show(node, ciPath);

        // Stale generation 1
        await (provider as any).handleMessage({
          type: 'save',
          visibility: [{ commandName: 'Catalog.StaleEntry', common: 'visible' }],
          filePath: ciPath,
          generation: 1,
        });

        const content = fs.readFileSync(ciPath, 'utf8');
        assert.ok(!content.includes('Catalog.StaleEntry'), 'Stale generation must be discarded');
      } finally {
        restore();
        provider.dispose();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('#206: save routes through runConfigurationMutation gateway', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-gateway-'));
    const intercepted: { path: string; kind: string }[] = [];
    const gateway = configureConfigurationMutationGateway(
      async (resourcePath, kind, op) => {
        intercepted.push({ path: resourcePath, kind });
        return op();
      },
      async (_p, plan) => plan.result,
    );

    try {
      const dir = path.join(root, 'Subsystems', 'SubA', 'Ext');
      fs.mkdirSync(dir, { recursive: true });
      const ciPath = path.join(dir, 'CommandInterface.xml');
      fs.writeFileSync(ciPath, XML_A, 'utf8');

      const node: TreeNode = {
        id: 'Subsystems.SubA',
        name: 'SubA',
        type: MetadataType.Subsystem,
        filePath: path.join(root, 'Subsystems', 'SubA.xml'),
        properties: {},
      };

      const { panel } = createFakeWebviewPanel();
      const restore = patchCreateWebviewPanel(panel);
      const provider = new SubsystemCommandInterfaceProvider(createFakeExtensionContext());

      try {
        await provider.show(node, ciPath);
        await (provider as any).handleMessage({
          type: 'save',
          visibility: [{ commandName: 'Catalog.Goods.StandardCommand.OpenList', common: 'visible' }],
          filePath: ciPath,
          generation: 1,
        });

        assert.strictEqual(intercepted.length, 1, 'Save must be intercepted by configurationMutationGateway');
        assert.strictEqual(intercepted[0].path, ciPath);
        assert.strictEqual(intercepted[0].kind, 'subsystemCommandInterface.save');
      } finally {
        restore();
        provider.dispose();
      }
    } finally {
      gateway.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('handleSave fails closed and prevents overwriting when CommandInterface.xml was modified concurrently post-open (#206, PR #225 review comment 2)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), '1c-test-ci-cas-'));
    const ciPath = path.join(root, 'Subsystems', 'SubA', 'Ext', 'CommandInterface.xml');
    fs.mkdirSync(path.dirname(ciPath), { recursive: true });
    fs.writeFileSync(ciPath, XML_A, 'utf8');

    const intercepted: Array<{ path: string; kind: string }> = [];
    const gateway = configureConfigurationMutationGateway(
      async (targetPath, kind, operation) => {
        intercepted.push({ path: targetPath, kind });
        return operation();
      },
      async () => {
        throw new Error('Not implemented');
      },
    );

    try {
      const node: TreeNode = {
        id: 'Subsystems.SubA',
        name: 'SubA',
        type: MetadataType.Subsystem,
        filePath: path.join(root, 'Subsystems', 'SubA.xml'),
        properties: {},
      };

      const { panel } = createFakeWebviewPanel();
      const restore = patchCreateWebviewPanel(panel);
      const provider = new SubsystemCommandInterfaceProvider(createFakeExtensionContext());

      try {
        await provider.show(node, ciPath);

        // Simulate concurrent modification on disk before save
        fs.writeFileSync(ciPath, XML_B, 'utf8');

        let errorCaught = false;
        try {
          await (provider as any).handleMessage({
            type: 'save',
            visibility: [{ commandName: 'Catalog.Goods.StandardCommand.OpenList', common: 'visible' }],
            filePath: ciPath,
            generation: 1,
          });
        } catch {
          errorCaught = true;
        }

        // Concurrent changes must NOT be overwritten!
        const onDisk = fs.readFileSync(ciPath, 'utf8');
        assert.strictEqual(onDisk, XML_B, 'Concurrent modification on disk must be preserved');
        assert.strictEqual(errorCaught, true, 'handleSave must fail closed on stale hash conflict');
      } finally {
        restore();
        provider.dispose();
      }
    } finally {
      gateway.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

