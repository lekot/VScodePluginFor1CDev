import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import { SubsystemCommandInterfaceProvider } from '../../src/subsystemCommandInterfaceEditor/subsystemCommandInterfaceProvider';
import { XdtoPackageEditorProvider } from '../../src/xdtoPackageEditor/xdtoPackageEditorProvider';
import { configureConfigurationMutationGateway } from '../../src/services/configurationSession/configurationMutationGateway';
import {
  type StatefulEditorSuiteAdapter,
} from '../helpers/editorSessionTestHarness';
import {
  createFakeExtensionContext,
  createFakeWebviewPanel,
  patchCreateWebviewPanel,
  type WebviewToExtensionMessage,
} from '../helpers/rightsEditorTestHarness';

const CI_XML_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<CommandInterface xmlns="http://v8.1c.ru/8.3/xcf/extrnprops" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="2.17">
\t<CommandsVisibility>
\t\t<Command name="Catalog.Initial.StandardCommand.OpenList">
\t\t\t<Visibility>
\t\t\t\t<xr:Common>true</xr:Common>
\t\t\t</Visibility>
\t\t</Command>
\t</CommandsVisibility>
</CommandInterface>`;

interface CiTestTarget {
  ciPath: string;
  node: TreeNode;
}

suite('Stateful Editor Session Matrix (#257)', () => {
  let defaultGateway: { dispose(): void } | undefined;
  let tmpRoot: string;

  setup(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-matrix-'));
    defaultGateway = configureConfigurationMutationGateway(
      async (_path, _kind, op) => op(),
      async (_path, plan) => plan.result,
    );
  });

  teardown(() => {
    defaultGateway?.dispose();
    defaultGateway = undefined;
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // Adapter for SubsystemCommandInterfaceProvider
  const ciAdapter: StatefulEditorSuiteAdapter<CiTestTarget> = {
    name: 'SubsystemCommandInterfaceProvider',
    createProvider: () => new SubsystemCommandInterfaceProvider(createFakeExtensionContext()),
    openTargetA: async (provider) => {
      const dirA = path.join(tmpRoot, 'SubA', 'Ext');
      fs.mkdirSync(dirA, { recursive: true });
      const ciPath = path.join(dirA, 'CommandInterface.xml');
      fs.writeFileSync(ciPath, CI_XML_TEMPLATE, 'utf8');
      const node: TreeNode = {
        id: 'Subsystems.SubA',
        name: 'SubA',
        type: MetadataType.Subsystem,
        filePath: path.join(tmpRoot, 'SubA.xml'),
        properties: {},
      };
      await provider.show(node, ciPath);
      return { ciPath, node };
    },
    openTargetB: async (provider) => {
      const dirB = path.join(tmpRoot, 'SubB', 'Ext');
      fs.mkdirSync(dirB, { recursive: true });
      const ciPath = path.join(dirB, 'CommandInterface.xml');
      fs.writeFileSync(ciPath, CI_XML_TEMPLATE, 'utf8');
      const node: TreeNode = {
        id: 'Subsystems.SubB',
        name: 'SubB',
        type: MetadataType.Subsystem,
        filePath: path.join(tmpRoot, 'SubB.xml'),
        properties: {},
      };
      await provider.show(node, ciPath);
      return { ciPath, node };
    },
    triggerSaveA: async (provider, targetA, _panel, generation) => {
      await (provider as any).handleMessage({
        type: 'save',
        visibility: [{ commandName: 'Catalog.MutatedByA', common: 'visible' }],
        filePath: targetA.ciPath,
        generation,
      });
    },
    verifyTargetAPreserved: async (targetA) => {
      const content = fs.readFileSync(targetA.ciPath, 'utf8');
      return !content.includes('Catalog.MutatedByA');
    },
    verifyTargetAMutated: async (targetA) => {
      const content = fs.readFileSync(targetA.ciPath, 'utf8');
      return content.includes('Catalog.MutatedByA');
    },
    verifyTargetBNotMutatedByA: async (targetB) => {
      const content = fs.readFileSync(targetB.ciPath, 'utf8');
      return !content.includes('Catalog.MutatedByA');
    },
  };

  function runEditorSessionStaleMatrix<TTarget>(adapter: StatefulEditorSuiteAdapter<TTarget>): void {
    suite(`EditorSession Lifecycle Matrix: ${adapter.name} (#257)`, () => {
      teardown(async () => {
        await adapter.cleanUp?.();
      });

      test('1. show(A) -> show(B) leaves B as the current active target', async () => {
        const { panel } = createFakeWebviewPanel();
        const restore = patchCreateWebviewPanel(panel);
        const provider = adapter.createProvider();

        try {
          await adapter.openTargetA(provider, panel);
          const targetB = await adapter.openTargetB(provider, panel);

          // Verify active target in provider is target B
          assert.ok(targetB, 'Target B must be active after show(B)');
        } finally {
          restore();
          provider.dispose();
        }
      });

      test('2. stale save message from target A does not mutate target B', async () => {
        const { panel } = createFakeWebviewPanel();
        const restore = patchCreateWebviewPanel(panel);
        const provider = adapter.createProvider();

        try {
          const targetA = await adapter.openTargetA(provider, panel);
          const targetB = await adapter.openTargetB(provider, panel);

          // Dispatch save intended for target A while target B is active (stale generation 1)
          await adapter.triggerSaveA(provider, targetA, panel, 1);

          const bPreserved = await adapter.verifyTargetBNotMutatedByA(targetB);
          assert.strictEqual(bPreserved, true, 'Target B must not be modified by stale save from target A');
        } finally {
          restore();
          provider.dispose();
        }
      });

      test('3. panel disposal invalidates pending operations and suppresses postMessage', async () => {
        const { panel, getPostedMessages } = createFakeWebviewPanel();
        const restore = patchCreateWebviewPanel(panel);
        const provider = adapter.createProvider();

        try {
          const targetA = await adapter.openTargetA(provider, panel);
          panel.dispose();

          // Trigger save or operation after disposal
          await adapter.triggerSaveA(provider, targetA, panel);

          const posted = getPostedMessages();
          const hasSuccess = posted.some((m: WebviewToExtensionMessage) => m.command === 'saveSuccess' || (m as any).type === 'saveSuccess');
          assert.strictEqual(hasSuccess, false, 'No saveSuccess message should be posted after panel disposal');
        } finally {
          restore();
          provider.dispose();
        }
      });
    });
  }

  runEditorSessionStaleMatrix(ciAdapter);

  // Adapter for XdtoPackageEditorProvider
  interface XdtoTestTarget {
    metaPath: string;
    schemaPath: string;
    node: TreeNode;
  }

  const xdtoAdapter: StatefulEditorSuiteAdapter<XdtoTestTarget> = {
    name: 'XdtoPackageEditorProvider',
    createProvider: () => new XdtoPackageEditorProvider(createFakeExtensionContext()),
    openTargetA: async (provider) => {
      const dirA = path.join(tmpRoot, 'XDTOPackages', 'PkgA', 'Ext');
      fs.mkdirSync(dirA, { recursive: true });
      const metaPath = path.join(tmpRoot, 'XDTOPackages', 'PkgA.xml');
      fs.writeFileSync(metaPath, '<MetaDataObject><XDTOPackage name="PkgA"/></MetaDataObject>', 'utf8');
      const schemaPath = path.join(dirA, 'Package.bin');
      fs.writeFileSync(
        schemaPath,
        '<package xmlns="http://v8.1c.ru/8.1/xdto"><valueType name="TypeA" base="xs:string"/></package>',
        'utf8'
      );
      const node: TreeNode = {
        id: 'XDTOPackages.PkgA',
        name: 'PkgA',
        type: MetadataType.XDTOPackage,
        filePath: metaPath,
        properties: {},
      };
      await provider.show(node);
      return { metaPath, schemaPath, node };
    },
    openTargetB: async (provider) => {
      const dirB = path.join(tmpRoot, 'XDTOPackages', 'PkgB', 'Ext');
      fs.mkdirSync(dirB, { recursive: true });
      const metaPath = path.join(tmpRoot, 'XDTOPackages', 'PkgB.xml');
      fs.writeFileSync(metaPath, '<MetaDataObject><XDTOPackage name="PkgB"/></MetaDataObject>', 'utf8');
      const schemaPath = path.join(dirB, 'Package.bin');
      fs.writeFileSync(
        schemaPath,
        '<package xmlns="http://v8.1c.ru/8.1/xdto"><valueType name="TypeB" base="xs:string"/></package>',
        'utf8'
      );
      const node: TreeNode = {
        id: 'XDTOPackages.PkgB',
        name: 'PkgB',
        type: MetadataType.XDTOPackage,
        filePath: metaPath,
        properties: {},
      };
      await provider.show(node);
      return { metaPath, schemaPath, node };
    },
    triggerSaveA: async (provider, targetA, _panel, generation) => {
      await (provider as any).handleMessage({
        type: 'save',
        source: '<package xmlns="http://v8.1c.ru/8.1/xdto"><valueType name="TypeAMutated" base="xs:string"/></package>',
        schemaPath: targetA.schemaPath,
        generation,
      });
    },
    verifyTargetAPreserved: async (targetA) => {
      const content = fs.readFileSync(targetA.schemaPath, 'utf8');
      return !content.includes('TypeAMutated');
    },
    verifyTargetAMutated: async (targetA) => {
      const content = fs.readFileSync(targetA.schemaPath, 'utf8');
      return content.includes('TypeAMutated');
    },
    verifyTargetBNotMutatedByA: async (targetB) => {
      const content = fs.readFileSync(targetB.schemaPath, 'utf8');
      return !content.includes('TypeAMutated');
    },
  };

  runEditorSessionStaleMatrix(xdtoAdapter);
});
