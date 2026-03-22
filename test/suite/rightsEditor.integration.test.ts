/**
 * Rights editor integration tests (Node `runCore`, fake webview).
 *
 * Axis 4 (VS Code / smoke): Full rights UI is webview-heavy; `test/runTest.js` and
 * `npm run test:smoke` (`test/suite/smoke`) focus on metadata tree, forms, and command
 * wiring — not the embedded rights webview. Activation + commands are already covered
 * in `test/suite/smoke/smoke.test.ts`; RLS flush behavior is asserted here under axis 1–3.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RoleXmlParser } from '../../src/rolesEditor/roleXmlParser';
import { updateRight } from '../../src/rolesEditor/rightsUpdateUtils';
import {
  createMinimalRightsDom,
  loadRightsXml,
  mergeRightsIntoDom,
  serializeRightsDomToXml,
} from '../../src/rolesEditor/rightsXmlEditWriter';
import { RolesRightsEditorProvider } from '../../src/rolesEditor/rolesRightsEditorProvider';
import {
  createFakeExtensionContext,
  createFakeWebviewPanel,
  patchCreateWebviewPanel,
} from '../helpers/rightsEditorTestHarness';

suite('rightsEditor integration', () => {
  suite('axis 1 — regression (full save path, no unnecessary RLS round-trip)', () => {
    test('webview save with restrictionTemplatesText does not send requestSavePayload', async () => {
      const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-rights-reg-save-'));
      const roleDir = path.join(tmpRoot, 'Roles');
      const rolePath = path.join(roleDir, 'RegRole.xml');
      const rightsPath = path.join(roleDir, 'RegRole', 'Ext', 'Rights.xml');
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

        const mockContext = createFakeExtensionContext();
        const { panel, getPostedMessages, getOnMessageHandler } = createFakeWebviewPanel();
        const restorePanel = patchCreateWebviewPanel(panel);
        const provider = new RolesRightsEditorProvider(mockContext);
        try {
          await provider.show(rolePath, null);
          const h = getOnMessageHandler();
          assert.ok(h, 'handler');
          await h({
            command: 'updateRight',
            data: { objectName: 'Catalog.Products', rightType: 'read', value: true },
          });
          const rlsFromWebview = '<restrictionTemplate>REGRESSION_BTN_SAVE</restrictionTemplate>';
          await h({
            command: 'save',
            data: { restrictionTemplatesText: rlsFromWebview },
          });
          const posted = getPostedMessages();
          assert.strictEqual(
            posted.filter((m) => m.command === 'requestSavePayload').length,
            0,
            'button-style save with restrictionTemplatesText must not ask webview for another payload'
          );
          const xml = await fs.promises.readFile(rightsPath, 'utf-8');
          assert.ok(xml.includes('REGRESSION_BTN_SAVE'), 'RLS from save message must be written');
        } finally {
          restorePanel();
          provider.dispose();
        }
      } finally {
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
      }
    });

    test('table-only edit with RLS already on disk: save message carries templates and skips flush', async () => {
      const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-rights-rls-model-'));
      const roleDir = path.join(tmpRoot, 'Roles');
      const rolePath = path.join(roleDir, 'ModelRlsRole.xml');
      const rightsPath = path.join(roleDir, 'ModelRlsRole', 'Ext', 'Rights.xml');
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
        let baseXml = serializeRightsDomToXml(createMinimalRightsDom());
        baseXml = baseXml.replace(
          /<\/(?:[a-zA-Z0-9_.]+:)?Rights\s*>/i,
          '<restrictionTemplate>ALREADY_IN_MODEL</restrictionTemplate>\n</Rights>'
        );
        await fs.promises.writeFile(rightsPath, baseXml, 'utf-8');

        const parsed = await RoleXmlParser.parseRoleXml(rolePath);
        const rlsForMessage = parsed.restrictionTemplatesText ?? '';
        assert.ok(rlsForMessage.includes('ALREADY_IN_MODEL'), 'Role model should load RLS from Rights.xml');

        const mockContext = createFakeExtensionContext();
        const { panel, getPostedMessages, getOnMessageHandler } = createFakeWebviewPanel();
        const restorePanel = patchCreateWebviewPanel(panel);
        const provider = new RolesRightsEditorProvider(mockContext);
        try {
          await provider.show(rolePath, null);
          const h = getOnMessageHandler();
          assert.ok(h);
          await h({
            command: 'updateRight',
            data: { objectName: 'Catalog.OnlyTable', rightType: 'read', value: true },
          });
          await h({
            command: 'save',
            data: { restrictionTemplatesText: rlsForMessage },
          });
          assert.strictEqual(
            getPostedMessages().filter((m) => m.command === 'requestSavePayload').length,
            0
          );
          const xml = await fs.promises.readFile(rightsPath, 'utf-8');
          assert.ok(xml.includes('ALREADY_IN_MODEL'));
          assert.ok(xml.includes('Catalog.OnlyTable'));
        } finally {
          restorePanel();
          provider.dispose();
        }
      } finally {
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
      }
    });
  });

  suite('axis 2 — progress / RLS flush (external save, edge cases)', () => {
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

        const mockContext = createFakeExtensionContext();
        const trackDisposed = { value: false };
        const { panel, getOnMessageHandler } = createFakeWebviewPanel({
          trackDisposed,
          autoReplyFlushWith: '',
        });
        const restorePanel = patchCreateWebviewPanel(panel);
        const provider = new RolesRightsEditorProvider(mockContext);
        try {
          await provider.show(rolePath, null);
          const h = getOnMessageHandler();
          assert.ok(h, 'Webview message handler should be wired by show()');

          await h({
            command: 'updateRight',
            data: {
              objectName: 'Catalog.Products',
              rightType: 'delete',
              value: true,
            },
          });

          await provider.triggerSave();
          assert.strictEqual(trackDisposed.value, true, 'Panel should be disposed after successful save');

          const modelAfter = await RoleXmlParser.parseRoleXml(rolePath);
          assert.ok(modelAfter.rights['Catalog.Products'], 'Edited object must exist after save');
          assert.strictEqual(modelAfter.rights['Catalog.Products'].delete, true, 'delete right should persist');
          assert.strictEqual(modelAfter.rights['Catalog.Products'].read, true, 'read dependency should persist');

          const savedDom = await loadRightsXml(rightsPath);
          const xml = serializeRightsDomToXml(savedDom);
          assert.ok(xml.includes('<name>Catalog.Products</name>'), 'Saved Rights.xml should contain edited object');
        } finally {
          restorePanel();
          provider.dispose();
        }
      } finally {
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
      }
    });

    test('triggerSave creates Ext directory and Rights.xml when only role file exists (EDT layout)', async () => {
      const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-rights-mkdir-ext-'));
      const roleDir = path.join(tmpRoot, 'Roles');
      const rolePath = path.join(roleDir, 'NewRole.xml');
      const rightsPath = path.join(roleDir, 'NewRole', 'Ext', 'Rights.xml');
      try {
        await fs.promises.mkdir(roleDir, { recursive: true });
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
        await assert.rejects(() => fs.promises.access(rightsPath));

        const mockContext = createFakeExtensionContext();
        const { panel, getOnMessageHandler } = createFakeWebviewPanel({
          autoReplyFlushWith: '',
        });
        const restorePanel = patchCreateWebviewPanel(panel);
        const provider = new RolesRightsEditorProvider(mockContext);
        try {
          await provider.show(rolePath, null);
          const h = getOnMessageHandler();
          assert.ok(h, 'Webview message handler should be wired by show()');
          await h({
            command: 'updateRight',
            data: { objectName: 'Catalog.X', rightType: 'read', value: true },
          });
          await provider.triggerSave();
          await fs.promises.access(rightsPath);
          const xml = await fs.promises.readFile(rightsPath, 'utf-8');
          assert.ok(xml.includes('<Rights'), 'Rights.xml should be written');
          assert.ok(xml.includes('<name>Catalog.X</name>'), 'Saved rights should contain object');
        } finally {
          restorePanel();
          provider.dispose();
        }
      } finally {
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
      }
    });

    test('triggerSave flushes RLS from webview into Rights.xml (EDT)', async () => {
      const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-rights-rls-flush-'));
      const roleDir = path.join(tmpRoot, 'Roles');
      const rolePath = path.join(roleDir, 'RlsRole.xml');
      const rightsPath = path.join(roleDir, 'RlsRole', 'Ext', 'Rights.xml');
      const rlsMarker = '<restrictionTemplate>RLS_FLUSH_TEST</restrictionTemplate>';
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

        const mockContext = createFakeExtensionContext();
        const { panel, getOnMessageHandler } = createFakeWebviewPanel({
          autoReplyFlushWith: rlsMarker,
        });
        const restorePanel = patchCreateWebviewPanel(panel);
        const provider = new RolesRightsEditorProvider(mockContext);
        try {
          await provider.show(rolePath, null);
          const h = getOnMessageHandler();
          assert.ok(h, 'Webview message handler should be wired by show()');
          await h({
            command: 'updateRight',
            data: { objectName: 'Catalog.Z', rightType: 'read', value: true },
          });
          await provider.triggerSave();

          const xml = await fs.promises.readFile(rightsPath, 'utf-8');
          assert.ok(
            xml.includes('RLS_FLUSH_TEST'),
            'Rights.xml should contain RLS text flushed before external save'
          );
        } finally {
          restorePanel();
          provider.dispose();
        }
      } finally {
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
      }
    });

    test('savePayload with wrong requestId is ignored; correct id still completes flush', async () => {
      const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-rights-wrong-req-'));
      const roleDir = path.join(tmpRoot, 'Roles');
      const rolePath = path.join(roleDir, 'WrongIdRole.xml');
      const rightsPath = path.join(roleDir, 'WrongIdRole', 'Ext', 'Rights.xml');
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
        await fs.promises.writeFile(rightsPath, serializeRightsDomToXml(createMinimalRightsDom()), 'utf-8');

        const mockContext = createFakeExtensionContext();
        const { panel, getOnMessageHandler } = createFakeWebviewPanel({
          onPostMessage: async (m) => {
            if (m.command !== 'requestSavePayload' || !m.data?.requestId) {
              return;
            }
            const h = getOnMessageHandler();
            if (!h) {
              return;
            }
            await h({
              command: 'savePayload',
              data: {
                requestId: '00000000-0000-0000-0000-000000000001',
                restrictionTemplatesText: '<restrictionTemplate>WRONG_UUID_PAYLOAD</restrictionTemplate>',
              },
            });
            await h({
              command: 'savePayload',
              data: {
                requestId: m.data.requestId,
                restrictionTemplatesText: '<restrictionTemplate>VALID_AFTER_BAD_UUID</restrictionTemplate>',
              },
            });
          },
        });
        const restorePanel = patchCreateWebviewPanel(panel);
        const provider = new RolesRightsEditorProvider(mockContext);
        try {
          await provider.show(rolePath, null);
          const h = getOnMessageHandler();
          assert.ok(h);
          await h({
            command: 'updateRight',
            data: { objectName: 'Catalog.W', rightType: 'read', value: true },
          });
          await provider.triggerSave();
          const xml = await fs.promises.readFile(rightsPath, 'utf-8');
          assert.ok(xml.includes('VALID_AFTER_BAD_UUID'));
          assert.ok(!xml.includes('WRONG_UUID_PAYLOAD'));
        } finally {
          restorePanel();
          provider.dispose();
        }
      } finally {
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
      }
    });

    test('empty restrictionTemplatesText from flush strips existing restrictionTemplate blocks', async () => {
      const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-rights-empty-rls-'));
      const roleDir = path.join(tmpRoot, 'Roles');
      const rolePath = path.join(roleDir, 'EmptyRlsRole.xml');
      const rightsPath = path.join(roleDir, 'EmptyRlsRole', 'Ext', 'Rights.xml');
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
        let xmlWithRls = serializeRightsDomToXml(createMinimalRightsDom());
        xmlWithRls = xmlWithRls.replace(
          /<\/(?:[a-zA-Z0-9_.]+:)?Rights\s*>/i,
          '<restrictionTemplate>TO_STRIP</restrictionTemplate>\n</Rights>'
        );
        await fs.promises.writeFile(rightsPath, xmlWithRls, 'utf-8');

        const mockContext = createFakeExtensionContext();
        const { panel, getOnMessageHandler } = createFakeWebviewPanel({
          autoReplyFlushWith: '',
        });
        const restorePanel = patchCreateWebviewPanel(panel);
        const provider = new RolesRightsEditorProvider(mockContext);
        try {
          await provider.show(rolePath, null);
          const h = getOnMessageHandler();
          assert.ok(h);
          await h({
            command: 'updateRight',
            data: { objectName: 'Catalog.E', rightType: 'read', value: true },
          });
          await provider.triggerSave();
          const out = await fs.promises.readFile(rightsPath, 'utf-8');
          assert.ok(!out.includes('TO_STRIP'), 'Empty flush should clear prior restrictionTemplate blocks');
        } finally {
          restorePanel();
          provider.dispose();
        }
      } finally {
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
      }
    });
  });

  suite('axis 3 — integration (dispose, concurrency, message routing)', () => {
    test('dispose rejects pending flush and clears pending save requests', async () => {
      const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-rights-dispose-'));
      const roleDir = path.join(tmpRoot, 'Roles');
      const rolePath = path.join(roleDir, 'DisposeRole.xml');
      const rightsPath = path.join(roleDir, 'DisposeRole', 'Ext', 'Rights.xml');
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
        await fs.promises.writeFile(rightsPath, serializeRightsDomToXml(createMinimalRightsDom()), 'utf-8');

        let unblock: (() => void) | undefined;
        const mockContext = createFakeExtensionContext();
        const { panel, getOnMessageHandler } = createFakeWebviewPanel({
          onPostMessage: async (m) => {
            if (m.command !== 'requestSavePayload' || !m.data?.requestId) {
              return;
            }
            await new Promise<void>((resolve) => {
              unblock = resolve;
            });
            const h = getOnMessageHandler();
            if (h) {
              await h({
                command: 'savePayload',
                data: { requestId: m.data.requestId, restrictionTemplatesText: '' },
              });
            }
          },
        });
        const restorePanel = patchCreateWebviewPanel(panel);
        const provider = new RolesRightsEditorProvider(mockContext);
        try {
          await provider.show(rolePath, null);
          const h = getOnMessageHandler();
          assert.ok(h);
          await h({
            command: 'updateRight',
            data: { objectName: 'Catalog.D', rightType: 'read', value: true },
          });
          const pSave = provider.triggerSave();
          await new Promise<void>((r) => setImmediate(r));
          assert.ok(unblock, 'flush should be waiting on synthetic barrier');
          provider.dispose();
          await pSave;
          const xmlAfter = await fs.promises.readFile(rightsPath, 'utf-8');
          assert.ok(
            !xmlAfter.includes('Catalog.D'),
            'handleSave catches flush failure: dispose rejects pending RLS read, save aborts before write'
          );
        } finally {
          restorePanel();
        }
      } finally {
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
      }
    });

    test('second triggerSave while first is awaiting flush does not issue a second requestSavePayload', async () => {
      const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-rights-dup-save-'));
      const roleDir = path.join(tmpRoot, 'Roles');
      const rolePath = path.join(roleDir, 'DupSaveRole.xml');
      const rightsPath = path.join(roleDir, 'DupSaveRole', 'Ext', 'Rights.xml');
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
        await fs.promises.writeFile(rightsPath, serializeRightsDomToXml(createMinimalRightsDom()), 'utf-8');

        let unblock: (() => void) | undefined;
        const mockContext = createFakeExtensionContext();
        const { panel, getPostedMessages, getOnMessageHandler } = createFakeWebviewPanel({
          onPostMessage: async (m) => {
            if (m.command !== 'requestSavePayload' || !m.data?.requestId) {
              return;
            }
            await new Promise<void>((resolve) => {
              unblock = resolve;
            });
            const h = getOnMessageHandler();
            if (h) {
              await h({
                command: 'savePayload',
                data: { requestId: m.data.requestId, restrictionTemplatesText: '' },
              });
            }
          },
        });
        const restorePanel = patchCreateWebviewPanel(panel);
        const provider = new RolesRightsEditorProvider(mockContext);
        try {
          await provider.show(rolePath, null);
          const h = getOnMessageHandler();
          assert.ok(h);
          await h({
            command: 'updateRight',
            data: { objectName: 'Catalog.Dup', rightType: 'read', value: true },
          });
          const p1 = provider.triggerSave();
          await new Promise<void>((r) => setImmediate(r));
          await provider.triggerSave();
          assert.strictEqual(
            getPostedMessages().filter((x) => x.command === 'requestSavePayload').length,
            1,
            'overlapping save should not start another RLS flush'
          );
          assert.ok(unblock);
          unblock!();
          await p1;
        } finally {
          restorePanel();
          provider.dispose();
        }
      } finally {
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
      }
    });

    test('savePayload webview command is handled (flush completes)', async () => {
      const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-rights-route-payload-'));
      const roleDir = path.join(tmpRoot, 'Roles');
      const rolePath = path.join(roleDir, 'RoutePayloadRole.xml');
      const rightsPath = path.join(roleDir, 'RoutePayloadRole', 'Ext', 'Rights.xml');
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
        await fs.promises.writeFile(rightsPath, serializeRightsDomToXml(createMinimalRightsDom()), 'utf-8');

        const mockContext = createFakeExtensionContext();
        const { panel, getOnMessageHandler } = createFakeWebviewPanel({
          autoReplyFlushWith: 'ROUTED',
        });
        const restorePanel = patchCreateWebviewPanel(panel);
        const provider = new RolesRightsEditorProvider(mockContext);
        try {
          await provider.show(rolePath, null);
          const h = getOnMessageHandler();
          assert.ok(h);
          await h({
            command: 'updateRight',
            data: { objectName: 'Catalog.R', rightType: 'read', value: true },
          });
          await provider.triggerSave();
          const xml = await fs.promises.readFile(rightsPath, 'utf-8');
          assert.ok(xml.includes('ROUTED'));
        } finally {
          restorePanel();
          provider.dispose();
        }
      } finally {
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
      }
    });
  });

});

