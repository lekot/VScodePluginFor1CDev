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
  createMinimalRightsDom as createMinimalRightsDomImpl,
  loadRightsXml as loadRightsXmlImpl,
  mergeRightsIntoDom,
  serializeRightsDomToXml as serializeRightsDomToXmlImpl,
} from '../../src/rolesEditor/rightsXmlEditWriter';
import { RolesRightsEditorProvider } from '../../src/rolesEditor/rolesRightsEditorProvider';
import { configureConfigurationMutationGateway } from '../../src/services/configurationSession/configurationMutationGateway';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import {
  createFakeExtensionContext,
  createFakeWebviewPanel,
  patchCreateWebviewPanel,
} from '../helpers/rightsEditorTestHarness';

const TEST_WRITE_VERSION = '2.20';
const createMinimalRightsDom = () => createMinimalRightsDomImpl(TEST_WRITE_VERSION);
const loadRightsXml = (rightsPath: string) => loadRightsXmlImpl(rightsPath, TEST_WRITE_VERSION);
const serializeRightsDomToXml = (dom: ReturnType<typeof createMinimalRightsDom>) =>
  serializeRightsDomToXmlImpl(dom, TEST_WRITE_VERSION);

/**
 * Windows: immediate `fs.rm(recursive)` after rights save sometimes throws ENOTEMPTY on a
 * nested dir (race / AV). Not a product bug — test harness retry.
 */
async function rmRfTestDir(dir: string): Promise<void> {
  const maxAttempts = 12;
  let last: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      last = e;
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        return;
      }
      await new Promise((r) => setTimeout(r, 25 * (i + 1)));
    }
  }
  throw last;
}

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
          await provider.show(rolePath, tmpRoot);
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
        await rmRfTestDir(tmpRoot);
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
          await provider.show(rolePath, tmpRoot);
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
        await rmRfTestDir(tmpRoot);
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
        await rmRfTestDir(tmpRoot);
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
          await provider.show(rolePath, tmpRoot);
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
        await rmRfTestDir(tmpRoot);
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
          path.join(tmpRoot, 'Configuration.xml'),
          '<MetaDataObject version="2.20"><Configuration><ChildObjects/></Configuration></MetaDataObject>',
          'utf8'
        );
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
          await provider.show(rolePath, tmpRoot);
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
        await rmRfTestDir(tmpRoot);
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
          await provider.show(rolePath, tmpRoot);
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
        await rmRfTestDir(tmpRoot);
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
          await provider.show(rolePath, tmpRoot);
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
        await rmRfTestDir(tmpRoot);
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
          await provider.show(rolePath, tmpRoot);
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
        await rmRfTestDir(tmpRoot);
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
          await provider.show(rolePath, tmpRoot);
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
        await rmRfTestDir(tmpRoot);
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
          await provider.show(rolePath, tmpRoot);
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
        await rmRfTestDir(tmpRoot);
      }
    });

    test('open without config path blocks save and does not write Rights.xml', async () => {
      const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-rights-nocfg-'));
      const roleDir = path.join(tmpRoot, 'Roles');
      const rolePath = path.join(roleDir, 'NoCfg.xml');
      const rightsPath = path.join(roleDir, 'NoCfg', 'Ext', 'Rights.xml');
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
        const { panel, getPostedMessages, getOnMessageHandler } = createFakeWebviewPanel();
        const restorePanel = patchCreateWebviewPanel(panel);
        const provider = new RolesRightsEditorProvider(mockContext);
        try {
          await provider.show(rolePath, null);
          const h = getOnMessageHandler();
          assert.ok(h);
          await h({
            command: 'save',
            data: { restrictionTemplatesText: '' },
          });
          await assert.rejects(() => fs.promises.access(rightsPath));
          const posted = getPostedMessages();
          assert.ok(
            posted.some((m) => m.command === 'saveError'),
            'save without config should surface saveError to webview'
          );
        } finally {
          restorePanel();
          provider.dispose();
        }
      } finally {
        await rmRfTestDir(tmpRoot);
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
          await provider.show(rolePath, tmpRoot);
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
        await rmRfTestDir(tmpRoot);
      }
    });
  });

  suite('axis 5 — session isolation and updateIfOpen concurrency (#177, #178)', () => {
    test('#178: stale RoleXmlParser result does not overwrite currentRoleModel or save target', async () => {
      const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-rights-race-178-'));
      try {
        const rolesDir = path.join(tmpRoot, 'Roles');
        const roleDirA = path.join(rolesDir, 'RoleA');
        const roleDirB = path.join(rolesDir, 'RoleB');
        await fs.promises.mkdir(path.join(roleDirA, 'Ext'), { recursive: true });
        await fs.promises.mkdir(path.join(roleDirB, 'Ext'), { recursive: true });
        await fs.promises.mkdir(path.join(tmpRoot, 'Catalogs'), { recursive: true });

        const configXml = [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">',
          '  <Configuration uuid="00000000-0000-0000-0000-000000000000">',
          '    <Properties><Name>RaceTestConfig</Name></Properties>',
          '    <ChildObjects><Catalog>Goods</Catalog><Role>RoleA</Role><Role>RoleB</Role></ChildObjects>',
          '  </Configuration>',
          '</MetaDataObject>',
        ].join('\n');
        await fs.promises.writeFile(path.join(tmpRoot, 'Configuration.xml'), configXml, 'utf-8');

        const rolePathA = path.join(rolesDir, 'RoleA.xml');
        const rolePathB = path.join(rolesDir, 'RoleB.xml');
        const makeRoleXml = (name: string) => [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<Role xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">',
          `  <Properties><Name>${name}</Name></Properties>`,
          '  <Rights/>',
          '</Role>',
        ].join('\n');
        await fs.promises.writeFile(rolePathA, makeRoleXml('RoleA'), 'utf-8');
        await fs.promises.writeFile(rolePathB, makeRoleXml('RoleB'), 'utf-8');

        const rightsPathA = path.join(roleDirA, 'Ext', 'Rights.xml');
        const rightsPathB = path.join(roleDirB, 'Ext', 'Rights.xml');
        await fs.promises.writeFile(rightsPathA, serializeRightsDomToXml(createMinimalRightsDom()), 'utf-8');
        await fs.promises.writeFile(rightsPathB, serializeRightsDomToXml(createMinimalRightsDom()), 'utf-8');

        const originalParseRoleXml = RoleXmlParser.parseRoleXml;
        let resolveRoleAParser!: () => void;
        const roleADeferred = new Promise<void>((resolve) => {
          resolveRoleAParser = resolve;
        });

        RoleXmlParser.parseRoleXml = async function (filePath: string) {
          if (filePath.includes('RoleA')) {
            await roleADeferred;
          }
          return originalParseRoleXml.call(this, filePath);
        };

        const mockContext = createFakeExtensionContext();
        const { panel, getOnMessageHandler } = createFakeWebviewPanel();
        const restorePanel = patchCreateWebviewPanel(panel);
        const provider = new RolesRightsEditorProvider(mockContext);
        const priv = provider as unknown as Record<string, any>;

        try {
          const showAPromise = provider.show(rolePathA, tmpRoot);
          const showBPromise = provider.show(rolePathB, tmpRoot);

          await showBPromise;
          assert.strictEqual(priv.currentRoleModel?.name, 'RoleB');
          assert.strictEqual(panel.title, 'Rights: RoleB');

          // Release slow RoleA parse
          resolveRoleAParser();
          await showAPromise;

          // RoleA MUST NOT overwrite RoleB
          assert.strictEqual(
            priv.currentRoleModel?.name,
            'RoleB',
            'Stale RoleA parse must not overwrite currentRoleModel of RoleB',
          );
          assert.strictEqual(panel.title, 'Rights: RoleB');

          const h = getOnMessageHandler();
          assert.ok(h);
          await h({
            command: 'updateRight',
            data: { objectName: 'Catalog.Goods', rightType: 'read', value: true },
          });
          await h({
            command: 'save',
            data: { restrictionTemplatesText: '' },
          });

          const contentA = await fs.promises.readFile(rightsPathA, 'utf-8');
          const contentB = await fs.promises.readFile(rightsPathB, 'utf-8');
          assert.ok(!contentA.includes('Catalog.Goods'), 'RoleA must not be modified by RoleB save');
          assert.ok(contentB.includes('Catalog.Goods'), 'RoleB must receive the modified right');
        } finally {
          RoleXmlParser.parseRoleXml = originalParseRoleXml;
          restorePanel();
          provider.dispose();
        }
      } finally {
        await rmRfTestDir(tmpRoot);
      }
    });

    test('#177: updateIfOpen resolves configuration root and keeps saving enabled', async () => {
      const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-rights-updateifopen-177-'));
      try {
        const rolesDir = path.join(tmpRoot, 'Roles');
        const roleDirA = path.join(rolesDir, 'RoleA');
        const roleDirB = path.join(rolesDir, 'RoleB');
        await fs.promises.mkdir(path.join(roleDirA, 'Ext'), { recursive: true });
        await fs.promises.mkdir(path.join(roleDirB, 'Ext'), { recursive: true });
        await fs.promises.mkdir(path.join(tmpRoot, 'Catalogs'), { recursive: true });

        const configXml = [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">',
          '  <Configuration uuid="00000000-0000-0000-0000-000000000000">',
          '    <Properties><Name>UpdateIfOpenConfig</Name></Properties>',
          '    <ChildObjects><Catalog>Goods</Catalog><Role>RoleA</Role><Role>RoleB</Role></ChildObjects>',
          '  </Configuration>',
          '</MetaDataObject>',
        ].join('\n');
        await fs.promises.writeFile(path.join(tmpRoot, 'Configuration.xml'), configXml, 'utf-8');

        const rolePathA = path.join(rolesDir, 'RoleA.xml');
        const rolePathB = path.join(rolesDir, 'RoleB.xml');
        const makeRoleXml = (name: string) => [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<Role xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">',
          `  <Properties><Name>${name}</Name></Properties>`,
          '  <Rights/>',
          '</Role>',
        ].join('\n');
        await fs.promises.writeFile(rolePathA, makeRoleXml('RoleA'), 'utf-8');
        await fs.promises.writeFile(rolePathB, makeRoleXml('RoleB'), 'utf-8');

        const rightsPathA = path.join(roleDirA, 'Ext', 'Rights.xml');
        const rightsPathB = path.join(roleDirB, 'Ext', 'Rights.xml');
        await fs.promises.writeFile(rightsPathA, serializeRightsDomToXml(createMinimalRightsDom()), 'utf-8');
        await fs.promises.writeFile(rightsPathB, serializeRightsDomToXml(createMinimalRightsDom()), 'utf-8');

        const mockContext = createFakeExtensionContext();
        const { panel, getPostedMessages } = createFakeWebviewPanel();
        const restorePanel = patchCreateWebviewPanel(panel);
        const provider = new RolesRightsEditorProvider(mockContext);
        const priv = provider as unknown as Record<string, any>;

        try {
          // Open editor for RoleA
          await provider.show(rolePathA, tmpRoot);
          assert.strictEqual(priv.saveDisabledNoConfig, false);
          assert.strictEqual(priv.configurationRootPath, tmpRoot);
          assert.ok(priv.allObjects.length > 0);

          // Simulate tree selection switch to RoleB
          const nodeB: TreeNode = {
            id: 'Roles.RoleB',
            name: 'RoleB',
            type: MetadataType.Role,
            filePath: rolePathB,
            properties: {},
          };

          await provider.updateIfOpen(nodeB);

          // RoleB must maintain configPath and not switch to read-only
          assert.strictEqual(priv.saveDisabledNoConfig, false, 'Save must remain enabled after updateIfOpen');
          assert.strictEqual(priv.configurationRootPath, tmpRoot, 'Configuration root must be resolved');
          assert.ok(priv.allObjects.length > 0, 'Metadata objects must be loaded for RoleB');
          assert.strictEqual(priv.currentRoleModel?.name, 'RoleB');

          // Trigger save - no saveDisabled error
          const msgCountBefore = getPostedMessages().length;
          await priv.handleSave({ command: 'save', data: { restrictionTemplatesText: '' } });
          const newMessages = getPostedMessages().slice(msgCountBefore);
          const saveErrorMsg = newMessages.find(
            (m) => m.command === 'saveError' && String(m.data?.message).includes('Save is disabled'),
          );
          assert.strictEqual(saveErrorMsg, undefined, 'Must not emit saveDisabled error');
        } finally {
          restorePanel();
          provider.dispose();
        }
      } finally {
        await rmRfTestDir(tmpRoot);
      }
    });

    test('updateIfOpen switches to read-only when role is standalone without configuration root', async () => {
      const standaloneDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-rights-standalone-'));
      try {
        const rolePath = path.join(standaloneDir, 'StandaloneRole.xml');
        const rightsPath = path.join(standaloneDir, 'Ext', 'Rights.xml');
        await fs.promises.mkdir(path.join(standaloneDir, 'Ext'), { recursive: true });
        await fs.promises.writeFile(
          rolePath,
          [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<Role xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">',
            '  <Properties><Name>StandaloneRole</Name></Properties>',
            '  <Rights/>',
            '</Role>',
          ].join('\n'),
          'utf-8',
        );
        await fs.promises.writeFile(rightsPath, serializeRightsDomToXml(createMinimalRightsDom()), 'utf-8');

        const mockContext = createFakeExtensionContext();
        const { panel } = createFakeWebviewPanel();
        const restorePanel = patchCreateWebviewPanel(panel);
        const provider = new RolesRightsEditorProvider(mockContext);
        const priv = provider as unknown as Record<string, any>;

        try {
          const standaloneNode: TreeNode = {
            id: 'Roles.StandaloneRole',
            name: 'StandaloneRole',
            type: MetadataType.Role,
            filePath: rolePath,
            properties: {},
          };

          // Initially show standalone role
          await provider.show(rolePath, undefined);
          assert.strictEqual(priv.saveDisabledNoConfig, true);
          assert.strictEqual(priv.configurationRootPath, undefined);

          // updateIfOpen on standalone node should remain read-only safely
          await provider.updateIfOpen(standaloneNode);
          assert.strictEqual(priv.saveDisabledNoConfig, true);
          assert.strictEqual(priv.configurationRootPath, undefined);
        } finally {
          restorePanel();
          provider.dispose();
        }
      } finally {
        await rmRfTestDir(standaloneDir);
      }
    });

    test('#206: handleSave routes rights write through runConfigurationMutation gateway', async () => {
      const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-rights-gw-'));
      const intercepted: { path: string; kind: string }[] = [];
      const gateway = configureConfigurationMutationGateway(
        async (resourcePath, kind, op) => {
          intercepted.push({ path: resourcePath, kind });
          return op();
        },
        async (_p, plan) => plan.result,
      );

      try {
        const rolesDir = path.join(tmpRoot, 'Roles');
        const roleDir = path.join(rolesDir, 'TestRole');
        await fs.promises.mkdir(path.join(roleDir, 'Ext'), { recursive: true });
        await fs.promises.writeFile(
          path.join(tmpRoot, 'Configuration.xml'),
          '<?xml version="1.0" encoding="UTF-8"?><Configuration xmlns="http://v8.1c.ru/8.3/MDClasses"/>',
          'utf-8',
        );
        const rolePath = path.join(rolesDir, 'TestRole.xml');
        await fs.promises.writeFile(
          rolePath,
          [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<Role xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">',
            '  <Properties><Name>TestRole</Name></Properties>',
            '  <Rights/>',
            '</Role>',
          ].join('\n'),
          'utf-8',
        );
        const rightsPath = path.join(roleDir, 'Ext', 'Rights.xml');
        await fs.promises.writeFile(rightsPath, serializeRightsDomToXml(createMinimalRightsDom()), 'utf-8');

        const mockContext = createFakeExtensionContext();
        const { panel } = createFakeWebviewPanel();
        const restorePanel = patchCreateWebviewPanel(panel);
        const provider = new RolesRightsEditorProvider(mockContext);
        const priv = provider as unknown as Record<string, any>;

        try {
          await provider.show(rolePath, tmpRoot);
          await priv.handleSave({ command: 'save', data: { restrictionTemplatesText: '' } });

          assert.strictEqual(intercepted.length, 1, 'handleSave must be intercepted by gateway');
          assert.strictEqual(intercepted[0].path, rightsPath);
          assert.strictEqual(intercepted[0].kind, 'rolesRights.save');
        } finally {
          restorePanel();
          provider.dispose();
        }
      } finally {
        gateway.dispose();
        await rmRfTestDir(tmpRoot);
      }
    });

    test('handleSave fails closed and prevents overwriting when Rights.xml was modified concurrently post-open (#206, PR #225 review comment 2)', async () => {
      const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-rights-cas-'));
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
        await fs.promises.writeFile(
          path.join(tmpRoot, 'Configuration.xml'),
          '<?xml version="1.0" encoding="UTF-8"?><Configuration xmlns="http://v8.1c.ru/8.3/MDClasses"/>',
          'utf-8',
        );
        const rolesDir = path.join(tmpRoot, 'Roles');
        const roleDir = path.join(rolesDir, 'TestRole');
        await fs.promises.mkdir(path.join(roleDir, 'Ext'), { recursive: true });
        const rolePath = path.join(rolesDir, 'TestRole.xml');
        await fs.promises.writeFile(
          rolePath,
          [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<Role xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">',
            '  <Properties><Name>TestRole</Name></Properties>',
            '  <Rights/>',
            '</Role>',
          ].join('\n'),
          'utf-8',
        );
        const rightsPath = path.join(roleDir, 'Ext', 'Rights.xml');
        await fs.promises.writeFile(rightsPath, serializeRightsDomToXml(createMinimalRightsDom()), 'utf-8');

        const mockContext = createFakeExtensionContext();
        const { panel } = createFakeWebviewPanel();
        const restorePanel = patchCreateWebviewPanel(panel);
        const provider = new RolesRightsEditorProvider(mockContext);
        const priv = provider as unknown as Record<string, any>;

        try {
          await provider.show(rolePath, tmpRoot);

          // Simulate concurrent modification on disk before save
          const concurrentContent = serializeRightsDomToXml(createMinimalRightsDom()) + '\n<!-- concurrent change -->';
          await fs.promises.writeFile(rightsPath, concurrentContent, 'utf-8');

          let errorCaught = false;
          try {
            await priv.handleSave({ command: 'save', data: { restrictionTemplatesText: '' } });
          } catch {
            errorCaught = true;
          }

          // Rights.xml MUST NOT be overwritten with stale pre-concurrent content!
          const onDisk = await fs.promises.readFile(rightsPath, 'utf-8');
          assert.strictEqual(onDisk, concurrentContent, 'Concurrent modification on disk must be preserved');
          assert.strictEqual(errorCaught, true, 'handleSave must fail closed on stale hash conflict');
        } finally {
          restorePanel();
          provider.dispose();
        }
      } finally {
        gateway.dispose();
        await rmRfTestDir(tmpRoot);
      }
    });

    test('handleSave fails closed and prevents overwriting when Rights.xml was created concurrently post-open (#206, PR #225 review comment 2)', async () => {
      const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-rights-create-cas-'));
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
        await fs.promises.writeFile(
          path.join(tmpRoot, 'Configuration.xml'),
          '<?xml version="1.0" encoding="UTF-8"?><Configuration xmlns="http://v8.1c.ru/8.3/MDClasses"/>',
          'utf-8',
        );
        const rolesDir = path.join(tmpRoot, 'Roles');
        const roleDir = path.join(rolesDir, 'TestRole');
        const rolePath = path.join(rolesDir, 'TestRole.xml');
        await fs.promises.mkdir(rolesDir, { recursive: true });
        await fs.promises.writeFile(
          rolePath,
          [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<Role xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">',
            '  <Properties><Name>TestRole</Name></Properties>',
            '  <Rights/>',
            '</Role>',
          ].join('\n'),
          'utf-8',
        );
        const rightsPath = path.join(roleDir, 'Ext', 'Rights.xml');

        const mockContext = createFakeExtensionContext();
        const { panel } = createFakeWebviewPanel();
        const restorePanel = patchCreateWebviewPanel(panel);
        const provider = new RolesRightsEditorProvider(mockContext);
        const priv = provider as unknown as Record<string, any>;

        try {
          await provider.show(rolePath, tmpRoot);

          // Simulate concurrent creation on disk before save
          await fs.promises.mkdir(path.dirname(rightsPath), { recursive: true });
          const concurrentContent = serializeRightsDomToXml(createMinimalRightsDom()) + '\n<!-- concurrent creation -->';
          await fs.promises.writeFile(rightsPath, concurrentContent, 'utf-8');

          let errorCaught = false;
          try {
            await priv.handleSave({ command: 'save', data: { restrictionTemplatesText: '' } });
          } catch {
            errorCaught = true;
          }

          // Rights.xml MUST NOT be overwritten with new content!
          const onDisk = await fs.promises.readFile(rightsPath, 'utf-8');
          assert.strictEqual(onDisk, concurrentContent, 'Concurrently created file on disk must be preserved');
          assert.strictEqual(errorCaught, true, 'handleSave must fail closed on missing->created conflict');
        } finally {
          restorePanel();
          provider.dispose();
        }
      } finally {
        gateway.dispose();
        await rmRfTestDir(tmpRoot);
      }
    });

    test('handleSave does not leave partial Rights.xml on disk when write fails during creation (#206, PR #225 review comment 4230106700)', async () => {
      const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-rights-write-fail-'));
      const gateway = configureConfigurationMutationGateway(
        async (targetPath, kind, operation) => operation(),
        async () => { throw new Error('Not implemented'); },
      );

      try {
        await fs.promises.writeFile(
          path.join(tmpRoot, 'Configuration.xml'),
          '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Configuration name="TestConfig"/></MetaDataObject>',
          'utf-8',
        );
        const rolesDir = path.join(tmpRoot, 'Roles');
        const roleDir = path.join(rolesDir, 'TestRole');
        const rolePath = path.join(rolesDir, 'TestRole.xml');
        await fs.promises.mkdir(rolesDir, { recursive: true });
        await fs.promises.writeFile(
          rolePath,
          [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<Role xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">',
            '  <Properties><Name>TestRole</Name></Properties>',
            '  <Rights/>',
            '</Role>',
          ].join('\n'),
          'utf-8',
        );
        const rightsPath = path.join(roleDir, 'Ext', 'Rights.xml');

        const mockContext = createFakeExtensionContext();
        const { panel } = createFakeWebviewPanel();
        const restorePanel = patchCreateWebviewPanel(panel);
        const provider = new RolesRightsEditorProvider(mockContext);
        const priv = provider as unknown as Record<string, any>;

        try {
          await provider.show(rolePath, tmpRoot);

          // Mock open to simulate write failure after file creation
          const origOpen = fs.promises.open;
          (fs.promises as any).open = async (...args: any[]) => {
            const handle = await origOpen.apply(fs.promises, args as any);
            handle.writeFile = async () => {
              throw new Error('ENOSPC: no space left on device');
            };
            return handle;
          };

          let errorCaught = false;
          try {
            await priv.handleSave({ command: 'save', data: { restrictionTemplatesText: '' } });
          } catch (err: any) {
            errorCaught = true;
            assert.ok(String(err).includes('ENOSPC'));
          } finally {
            (fs.promises as any).open = origOpen;
          }

          assert.strictEqual(errorCaught, true, 'Save must fail when write throws ENOSPC');
          assert.strictEqual(fs.existsSync(rightsPath), false, 'Partial Rights.xml must not be left on disk after write failure');
        } finally {
          restorePanel();
          provider.dispose();
        }
      } finally {
        gateway.dispose();
        await rmRfTestDir(tmpRoot);
      }
    });

    test('handleSave cleans up direct Rights.xml if fallback write fails (#206, PR #225 review comment 4230106700)', async () => {
      const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-rights-fallback-fail-'));
      const gateway = configureConfigurationMutationGateway(
        async (targetPath, kind, operation) => operation(),
        async () => { throw new Error('Not implemented'); },
      );

      try {
        await fs.promises.writeFile(
          path.join(tmpRoot, 'Configuration.xml'),
          '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Configuration name="TestConfig"/></MetaDataObject>',
          'utf-8',
        );
        const rolesDir = path.join(tmpRoot, 'Roles');
        const roleDir = path.join(rolesDir, 'TestRole');
        const rolePath = path.join(rolesDir, 'TestRole.xml');
        await fs.promises.mkdir(rolesDir, { recursive: true });
        await fs.promises.writeFile(
          rolePath,
          [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<Role xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">',
            '  <Properties><Name>TestRole</Name></Properties>',
            '  <Rights/>',
            '</Role>',
          ].join('\n'),
          'utf-8',
        );
        const rightsPath = path.join(roleDir, 'Ext', 'Rights.xml');

        const mockContext = createFakeExtensionContext();
        const { panel } = createFakeWebviewPanel();
        const restorePanel = patchCreateWebviewPanel(panel);
        const provider = new RolesRightsEditorProvider(mockContext);
        const priv = provider as unknown as Record<string, any>;

        try {
          await provider.show(rolePath, tmpRoot);

          // Force link to fail so it falls back to direct open, then fail the direct write
          const origLink = fs.promises.link;
          const origOpen = fs.promises.open;
          let openCalls = 0;

          (fs.promises as any).link = async () => {
            const err = new Error('ENOSYS: function not implemented');
            (err as any).code = 'ENOSYS';
            throw err;
          };

          (fs.promises as any).open = async (...args: any[]) => {
            openCalls++;
            const handle = await origOpen.apply(fs.promises, args as any);
            if (openCalls === 2) {
              // Direct target handle
              handle.writeFile = async () => {
                throw new Error('EIO: input/output error');
              };
            }
            return handle;
          };

          let errorCaught = false;
          try {
            await priv.handleSave({ command: 'save', data: { restrictionTemplatesText: '' } });
          } catch (err: any) {
            errorCaught = true;
            assert.ok(String(err).includes('EIO'));
          } finally {
            (fs.promises as any).link = origLink;
            (fs.promises as any).open = origOpen;
          }

          assert.strictEqual(errorCaught, true, 'Save must fail when fallback direct write throws EIO');
          assert.strictEqual(fs.existsSync(rightsPath), false, 'Fallback target Rights.xml must be unlinked on failure');
        } finally {
          restorePanel();
          provider.dispose();
        }
      } finally {
        gateway.dispose();
        await rmRfTestDir(tmpRoot);
      }
    });

    test('handleSave preserves role A model and hash when editor switches to role B while queued in gateway (PR #225 review comment 6085700956)', async () => {
      const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-rights-queue-race-'));
      let releaseGateA: (() => void) | undefined;
      const gateAPromise = new Promise<void>((resolve) => {
        releaseGateA = resolve;
      });
      let gateAEntered: (() => void) | undefined;
      const gateAEnteredPromise = new Promise<void>((resolve) => {
        gateAEntered = resolve;
      });

      const gateway = configureConfigurationMutationGateway(
        async (resourcePath, kind, op) => {
          if (resourcePath.includes('RoleA')) {
            gateAEntered?.();
            await gateAPromise;
          }
          return op();
        },
        async (_p, plan) => plan.result,
      );

      try {
        await fs.promises.writeFile(
          path.join(tmpRoot, 'Configuration.xml'),
          '<?xml version="1.0" encoding="UTF-8"?><Configuration xmlns="http://v8.1c.ru/8.3/MDClasses"/>',
          'utf-8',
        );
        const rolesDir = path.join(tmpRoot, 'Roles');
        const roleDirA = path.join(rolesDir, 'RoleA');
        const roleDirB = path.join(rolesDir, 'RoleB');
        await fs.promises.mkdir(path.join(roleDirA, 'Ext'), { recursive: true });
        await fs.promises.mkdir(path.join(roleDirB, 'Ext'), { recursive: true });

        const rolePathA = path.join(rolesDir, 'RoleA.xml');
        const rolePathB = path.join(rolesDir, 'RoleB.xml');
        await fs.promises.writeFile(
          rolePathA,
          [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<Role xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">',
            '  <Properties><Name>RoleA</Name></Properties>',
            '  <Rights/>',
            '</Role>',
          ].join('\n'),
          'utf-8',
        );
        await fs.promises.writeFile(
          rolePathB,
          [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<Role xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">',
            '  <Properties><Name>RoleB</Name></Properties>',
            '  <Rights/>',
            '</Role>',
          ].join('\n'),
          'utf-8',
        );

        const rightsPathA = path.join(roleDirA, 'Ext', 'Rights.xml');
        const rightsPathB = path.join(roleDirB, 'Ext', 'Rights.xml');
        await fs.promises.writeFile(rightsPathA, serializeRightsDomToXml(createMinimalRightsDom()), 'utf-8');
        await fs.promises.writeFile(rightsPathB, serializeRightsDomToXml(createMinimalRightsDom()), 'utf-8');

        const mockContext = createFakeExtensionContext();
        const { panel } = createFakeWebviewPanel();
        const restorePanel = patchCreateWebviewPanel(panel);
        const provider = new RolesRightsEditorProvider(mockContext);
        const priv = provider as unknown as Record<string, any>;

        try {
          await provider.show(rolePathA, tmpRoot);
          updateRight(priv.currentRoleModel, 'Catalog.Goods', 'read', true);

          const savePromiseA = priv.handleSave({ command: 'save', data: { restrictionTemplatesText: '' } });
          await gateAEnteredPromise;

          // While Role A is waiting in gateway, switch editor to Role B
          await provider.show(rolePathB, tmpRoot);
          updateRight(priv.currentRoleModel, 'Document.Orders', 'read', true);

          // Release Role A's save
          releaseGateA!();
          await savePromiseA;

          // Role A's Rights.xml must contain Catalog.Goods and MUST NOT contain Document.Orders
          const contentA = await fs.promises.readFile(rightsPathA, 'utf-8');
          assert.ok(contentA.includes('Catalog.Goods'), 'Role A must keep Catalog.Goods');
          assert.ok(!contentA.includes('Document.Orders'), 'Role A must not contain Document.Orders');

          // Role B's panel must NOT be disposed by Role A's save completion
          assert.strictEqual(provider.isOpen(), true, 'Role B panel must remain open');

          // Now save Role B; it must succeed without spurious conflict
          await priv.handleSave({ command: 'save', data: { restrictionTemplatesText: '' } });
          const contentB = await fs.promises.readFile(rightsPathB, 'utf-8');
          assert.ok(contentB.includes('Document.Orders'), 'Role B must keep Document.Orders');
          assert.ok(!contentB.includes('Catalog.Goods'), 'Role B must not contain Catalog.Goods');
        } finally {
          restorePanel();
          provider.dispose();
        }
      } finally {
        gateway.dispose();
        await rmRfTestDir(tmpRoot);
      }
    });
  });
});


