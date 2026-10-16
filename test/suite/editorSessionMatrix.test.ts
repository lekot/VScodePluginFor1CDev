import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import { SubsystemCommandInterfaceProvider } from '../../src/subsystemCommandInterfaceEditor/subsystemCommandInterfaceProvider';
import { XdtoPackageEditorProvider } from '../../src/xdtoPackageEditor/xdtoPackageEditorProvider';
import { configureConfigurationMutationGateway } from '../../src/services/configurationSession/configurationMutationGateway';
import {
  registerEditorSessionStaleMatrix,
  type StatefulEditorSuiteAdapter,
} from '../helpers/editorSessionTestHarness';
import { createFakeExtensionContext } from '../helpers/rightsEditorTestHarness';

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

  registerEditorSessionStaleMatrix(ciAdapter);

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

  registerEditorSessionStaleMatrix(xdtoAdapter);
});
