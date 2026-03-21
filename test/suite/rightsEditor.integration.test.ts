import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { RoleXmlParser } from '../../src/rolesEditor/roleXmlParser';
import { updateRight } from '../../src/rolesEditor/rightsUpdateUtils';
import {
  createMinimalRightsDom,
  loadRightsXml,
  mergeRightsIntoDom,
  serializeRightsDomToXml,
} from '../../src/rolesEditor/rightsXmlEditWriter';
import { RolesRightsEditorProvider } from '../../src/rolesEditor/rolesRightsEditorProvider';

suite('rightsEditor integration', () => {
  test('open -> edit -> save -> reopen roundtrip persists rights in XML model', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-rights-roundtrip-'));
    const roleDir = path.join(tmpRoot, 'Roles');
    const rolePath = path.join(roleDir, 'RoundtripRole.xml');
    try {
      await fs.promises.mkdir(roleDir, { recursive: true });
      const roleXml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Role xmlns="http://v8.1c.ru/8.3/MDClasses">',
        '  <Rights/>',
        '</Role>',
        '',
      ].join('\n');
      await fs.promises.writeFile(rolePath, roleXml, 'utf-8');

      const modelBefore = await RoleXmlParser.parseRoleXml(rolePath);
      const objectName = 'Catalog.Products';
      const update = updateRight(modelBefore, objectName, 'delete', true);
      assert.strictEqual(update.success, true, 'Right update should succeed before save');

      const rightsPath = path.join(roleDir, 'RoundtripRole', 'Ext', 'Rights.xml');
      await fs.promises.mkdir(path.dirname(rightsPath), { recursive: true });
      const dom = createMinimalRightsDom();
      mergeRightsIntoDom(dom, modelBefore.rights, { compactWrite: false });
      await fs.promises.writeFile(rightsPath, serializeRightsDomToXml(dom), 'utf-8');

      const modelAfter = await RoleXmlParser.parseRoleXml(rolePath);
      assert.ok(modelAfter.rights[objectName], 'Saved object rights should be loaded after reopen');
      assert.strictEqual(modelAfter.rights[objectName].delete, true, 'Edited delete right should survive roundtrip');
      assert.strictEqual(modelAfter.rights[objectName].read, true, 'Dependency right should survive roundtrip');
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('ui route (webview update + triggerSave) persists edited rights to Rights.xml', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-rights-ui-route-'));
    const roleDir = path.join(tmpRoot, 'Roles');
    const rolePath = path.join(roleDir, 'UiRole.xml');
    const rightsPath = path.join(roleDir, 'UiRole', 'Ext', 'Rights.xml');
    try {
      await fs.promises.mkdir(path.dirname(rightsPath), { recursive: true });
      await fs.promises.writeFile(
        rolePath,
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<Role xmlns="http://v8.1c.ru/8.3/MDClasses">',
          '  <Rights/>',
          '</Role>',
          '',
        ].join('\n'),
        'utf-8'
      );

      const initialDom = createMinimalRightsDom();
      await fs.promises.writeFile(rightsPath, serializeRightsDomToXml(initialDom), 'utf-8');

      const mockContext = {
        subscriptions: [] as vscode.Disposable[],
        extensionPath: '',
        extensionUri: vscode.Uri.file(''),
        globalState: {} as vscode.Memento,
        workspaceState: {} as vscode.Memento,
        secrets: {} as vscode.SecretStorage,
        storageUri: undefined,
        storagePath: undefined,
        globalStorageUri: vscode.Uri.file(''),
        globalStoragePath: '',
        logUri: vscode.Uri.file(''),
        logPath: '',
        extensionMode: vscode.ExtensionMode.Test,
        extension: {} as vscode.Extension<unknown>,
        environmentVariableCollection: {} as vscode.EnvironmentVariableCollection,
        languageModelAccessInformation: {} as vscode.LanguageModelAccessInformation,
        asAbsolutePath: (p: string) => p,
      } as vscode.ExtensionContext;

      const originalCreatePanel = vscode.window.createWebviewPanel;
      let onMessageHandler: ((message: unknown) => Promise<void>) | undefined;
      let panelDisposed = false;
      const fakePanel = {
        reveal: () => undefined,
        onDidDispose: () => ({ dispose: () => undefined }),
        webview: {
          html: '',
          onDidReceiveMessage: (cb: (message: unknown) => Promise<void>) => {
            onMessageHandler = cb;
            return { dispose: () => undefined };
          },
          postMessage: async () => true,
        },
        dispose: () => {
          panelDisposed = true;
        },
      } as unknown as vscode.WebviewPanel;

      const provider = new RolesRightsEditorProvider(mockContext);
      (vscode.window as unknown as { createWebviewPanel: typeof vscode.window.createWebviewPanel }).createWebviewPanel =
        (() => fakePanel) as typeof vscode.window.createWebviewPanel;

      try {
        await provider.show(rolePath, null);
        assert.ok(onMessageHandler, 'Webview message handler should be wired by show()');

        await onMessageHandler!({
          command: 'updateRight',
          data: {
            objectName: 'Catalog.Products',
            rightType: 'delete',
            value: true,
          },
        });

        await provider.triggerSave();
        assert.strictEqual(panelDisposed, true, 'Panel should be disposed after successful save');

        const modelAfter = await RoleXmlParser.parseRoleXml(rolePath);
        assert.ok(modelAfter.rights['Catalog.Products'], 'Edited object must exist after save');
        assert.strictEqual(modelAfter.rights['Catalog.Products'].delete, true, 'delete right should persist');
        assert.strictEqual(modelAfter.rights['Catalog.Products'].read, true, 'read dependency should persist');

        const savedDom = await loadRightsXml(rightsPath);
        const xml = serializeRightsDomToXml(savedDom);
        assert.ok(xml.includes('<name>Catalog.Products</name>'), 'Saved Rights.xml should contain edited object');
      } finally {
        (vscode.window as unknown as { createWebviewPanel: typeof vscode.window.createWebviewPanel }).createWebviewPanel =
          originalCreatePanel;
        provider.dispose();
      }
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
