import '../helpers/vscodeStubRegister';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RolesRightsEditorProvider } from '../../src/rolesEditor/rolesRightsEditorProvider';
import { RoleXmlParser } from '../../src/rolesEditor/roleXmlParser';
import {
  createMinimalRightsDom,
  serializeRightsDomToXml,
} from '../../src/rolesEditor/rightsXmlEditWriter';
import {
  createFakeExtensionContext,
  createFakeWebviewPanel,
  patchCreateWebviewPanel,
} from '../helpers/rightsEditorTestHarness';
import type { ExtensionToWebviewMessage } from '../../src/rolesEditor/models/webviewMessage';

async function rmRf(dir: string): Promise<void> {
  const maxAttempts = 10;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 25 * (i + 1)));
    }
  }
}

suite('RolesEditor Lazy Loading & Staged Lifecycle (Issue #329)', () => {
  let tmpRoot: string;

  setup(async () => {
    tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-roles-lazy-'));
  });

  teardown(async () => {
    await rmRf(tmpRoot);
  });

  test('initial role rows are dispatched immediately without waiting for object details (Red phase)', async () => {
    // Setup test configuration: Configuration.xml, Catalogs, Documents, Role
    const rolePath = path.join(tmpRoot, 'src', 'Roles', 'Operator.xml');
    const rightsPath = path.join(tmpRoot, 'src', 'Roles', 'Operator', 'Ext', 'Rights.xml');
    await fs.promises.mkdir(path.dirname(rightsPath), { recursive: true });

    await fs.promises.writeFile(
      path.join(tmpRoot, 'Configuration.xml'),
      '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Configuration name="TestConfig"><Synonym><v8:content>Тестовая Конфигурация</v8:content></Synonym></Configuration></MetaDataObject>',
      'utf8'
    );
    await fs.promises.writeFile(
      rolePath,
      '<Role xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Properties><Name>Operator</Name></Properties><Rights/></Role>',
      'utf8'
    );

    const rightsXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Rights xmlns="http://v8.1c.ru/8.2/roles" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Rights" version="2.20">',
      '  <setForNewObjects>false</setForNewObjects>',
      '  <object>',
      '    <name>Catalog.Товары</name>',
      '    <right><name>Read</name><value>true</value></right>',
      '  </object>',
      '  <object>',
      '    <name>Document.ЗаказКлиента</name>',
      '    <right><name>Read</name><value>true</value></right>',
      '    <right><name>View</name><value>true</value></right>',
      '  </object>',
      '</Rights>',
    ].join('\n');
    await fs.promises.writeFile(rightsPath, rightsXml, 'utf8');

    const { panel, getPostedMessages } = createFakeWebviewPanel({ autoReplyFlushWith: '' });
    const restorePanel = patchCreateWebviewPanel(panel);
    const provider = new RolesRightsEditorProvider(createFakeExtensionContext());

    try {
      await provider.show(rolePath, tmpRoot);

      const posted = getPostedMessages();
      const objectsLoadedMessages = posted.filter(
        (m): m is Extract<ExtensionToWebviewMessage, { command: 'objectsLoaded' }> =>
          m.command === 'objectsLoaded'
      );

      assert.ok(
        objectsLoadedMessages.length >= 1,
        'Expected at least one objectsLoaded message to be posted'
      );

      // In the staged lifecycle, the initial message should have phase: 'initial' and deliver existing role rights
      const firstMessage = objectsLoadedMessages[0];
      assert.strictEqual(
        firstMessage.data.phase,
        'initial',
        'First objectsLoaded message must have phase: initial'
      );
      assert.ok(
        firstMessage.data.sessionId,
        'First objectsLoaded message must contain a valid sessionId'
      );

      const loadedFullNames = new Set(firstMessage.data.objects.map((o) => o.fullName));
      assert.ok(loadedFullNames.has('Configuration'), 'Initial table must contain Configuration root');
      assert.ok(loadedFullNames.has('Catalog.Товары'), 'Initial table must contain Catalog.Товары with rights');
      assert.ok(loadedFullNames.has('Document.ЗаказКлиента'), 'Initial table must contain Document.ЗаказКлиента with rights');
    } finally {
      restorePanel();
      provider.dispose();
    }
  });

  test('session switching cancels previous session and prevents stale result leakage (Red phase)', async () => {
    const role1Path = path.join(tmpRoot, 'src', 'Roles', 'Role1.xml');
    const role2Path = path.join(tmpRoot, 'src', 'Roles', 'Role2.xml');
    const rights1Path = path.join(tmpRoot, 'src', 'Roles', 'Role1', 'Ext', 'Rights.xml');
    const rights2Path = path.join(tmpRoot, 'src', 'Roles', 'Role2', 'Ext', 'Rights.xml');
    await fs.promises.mkdir(path.dirname(rights1Path), { recursive: true });
    await fs.promises.mkdir(path.dirname(rights2Path), { recursive: true });

    await fs.promises.writeFile(
      path.join(tmpRoot, 'Configuration.xml'),
      '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Configuration name="TestConfig"/></MetaDataObject>',
      'utf8'
    );
    await fs.promises.writeFile(
      role1Path,
      '<Role xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Properties><Name>Role1</Name></Properties><Rights/></Role>',
      'utf8'
    );
    await fs.promises.writeFile(
      role2Path,
      '<Role xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Properties><Name>Role2</Name></Properties><Rights/></Role>',
      'utf8'
    );
    await fs.promises.writeFile(
      rights1Path,
      '<Rights xmlns="http://v8.1c.ru/8.2/roles" version="2.20"><object><name>Catalog.OnlyInRole1</name><right><name>Read</name><value>true</value></right></object></Rights>',
      'utf8'
    );
    await fs.promises.writeFile(
      rights2Path,
      '<Rights xmlns="http://v8.1c.ru/8.2/roles" version="2.20"><object><name>Catalog.OnlyInRole2</name><right><name>Read</name><value>true</value></right></object></Rights>',
      'utf8'
    );

    const { panel, getPostedMessages } = createFakeWebviewPanel({ autoReplyFlushWith: '' });
    const restorePanel = patchCreateWebviewPanel(panel);
    const provider = new RolesRightsEditorProvider(createFakeExtensionContext());

    try {
      // Open Role 1
      await provider.show(role1Path, tmpRoot);
      const messagesAfterRole1 = [...getPostedMessages()];
      const role1SessionId = (messagesAfterRole1[0] as { data?: { sessionId?: string } })?.data?.sessionId;
      assert.ok(role1SessionId, 'Role 1 must have an allocated sessionId');

      // Now switch to Role 2
      await provider.show(role2Path, tmpRoot);
      const allMessages = getPostedMessages();
      const messagesForRole2 = allMessages.slice(messagesAfterRole1.length);
      assert.ok(messagesForRole2.length >= 1, 'Role 2 must produce webview messages');

      const role2SessionId = (messagesForRole2[0] as { data?: { sessionId?: string } })?.data?.sessionId;
      assert.ok(role2SessionId, 'Role 2 must have an allocated sessionId');
      assert.notStrictEqual(role1SessionId, role2SessionId, 'Each role open must allocate a new sessionId');

      // Ensure no messages posted for Role 2 carry the stale Role 1 sessionId
      for (const msg of messagesForRole2) {
        if ('data' in msg && msg.data && 'sessionId' in msg.data && msg.data.sessionId) {
          assert.strictEqual(
            msg.data.sessionId,
            role2SessionId,
            'Role 2 webview must never receive messages tagged with Role 1 sessionId'
          );
        }
      }
    } finally {
      restorePanel();
      provider.dispose();
    }
  });

  test('unloaded and unindexed rights survive edit and save of other rights (Red phase)', async () => {
    const rolePath = path.join(tmpRoot, 'src', 'Roles', 'ComplexRole.xml');
    const rightsPath = path.join(tmpRoot, 'src', 'Roles', 'ComplexRole', 'Ext', 'Rights.xml');
    await fs.promises.mkdir(path.dirname(rightsPath), { recursive: true });

    await fs.promises.writeFile(
      path.join(tmpRoot, 'Configuration.xml'),
      '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Configuration name="TestConfig"/></MetaDataObject>',
      'utf8'
    );
    await fs.promises.writeFile(
      rolePath,
      '<Role xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Properties><Name>ComplexRole</Name></Properties><Rights/></Role>',
      'utf8'
    );

    const rls = '<restrictionTemplate><condition>PRESERVE_RLS_CONDITION</condition></restrictionTemplate>';
    const rightsXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Rights xmlns="http://v8.1c.ru/8.2/roles" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Rights" version="2.20">',
      '  <setForNewObjects>false</setForNewObjects>',
      '  <object>',
      '    <name>Catalog.Товары</name>',
      '    <right><name>Read</name><value>true</value></right>',
      '  </object>',
      '  <object>',
      '    <name>Catalog.Товары.Attribute.Артикул</name>',
      '    <right><name>Edit</name><value>false</value></right>',
      '  </object>',
      '  <object>',
      '    <name>Catalog.АрхивныйОбъект</name>',
      '    <right><name>Read</name><value>true</value></right>',
      '    <right><name>InteractiveDelete</name><value>false</value></right>',
      '  </object>',
      `  ${rls}`,
      '</Rights>',
    ].join('\n');
    await fs.promises.writeFile(rightsPath, rightsXml, 'utf8');

    const { panel, getOnMessageHandler } = createFakeWebviewPanel({ autoReplyFlushWith: rls });
    const restorePanel = patchCreateWebviewPanel(panel);
    const provider = new RolesRightsEditorProvider(createFakeExtensionContext());

    try {
      await provider.show(rolePath, tmpRoot);
      const handler = getOnMessageHandler();
      assert.ok(handler, 'Message handler should be wired');

      // Edit an entirely different object right
      await handler({
        command: 'updateRight',
        data: { objectName: 'Catalog.Товары', rightType: 'view', value: true },
      });

      // Save rights
      await provider.triggerSave();

      const savedXml = await fs.promises.readFile(rightsPath, 'utf8');

      // Check preservation of unindexed and nested objects
      assert.ok(savedXml.includes('<name>Catalog.Товары.Attribute.Артикул</name>'), 'Nested attribute right must be preserved');
      assert.ok(savedXml.includes('<name>Catalog.АрхивныйОбъект</name>'), 'Unindexed object right must be preserved');
      assert.ok(savedXml.includes('<value>false</value>'), 'Explicit false right value must be preserved');
      assert.ok(savedXml.includes('PRESERVE_RLS_CONDITION'), 'RLS templates must be preserved');
      assert.ok(savedXml.includes('<name>View</name>'), 'Edited right must be persisted');
    } finally {
      restorePanel();
      provider.dispose();
    }
  });

  test('empty role produces usable table with configuration root and valid empty state', async () => {
    const rolePath = path.join(tmpRoot, 'src', 'Roles', 'EmptyRole.xml');
    const rightsPath = path.join(tmpRoot, 'src', 'Roles', 'EmptyRole', 'Ext', 'Rights.xml');
    await fs.promises.mkdir(path.dirname(rightsPath), { recursive: true });

    await fs.promises.writeFile(
      path.join(tmpRoot, 'Configuration.xml'),
      '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Configuration name="EmptyConfig"/></MetaDataObject>',
      'utf8'
    );
    await fs.promises.writeFile(
      rolePath,
      '<Role xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Properties><Name>EmptyRole</Name></Properties><Rights/></Role>',
      'utf8'
    );
    await fs.promises.writeFile(
      rightsPath,
      '<Rights xmlns="http://v8.1c.ru/8.2/roles" version="2.20"><setForNewObjects>false</setForNewObjects></Rights>',
      'utf8'
    );

    const { panel, getPostedMessages } = createFakeWebviewPanel({ autoReplyFlushWith: '' });
    const restorePanel = patchCreateWebviewPanel(panel);
    const provider = new RolesRightsEditorProvider(createFakeExtensionContext());

    try {
      await provider.show(rolePath, tmpRoot);

      const posted = getPostedMessages();
      const objectsLoaded = posted.filter((m) => m.command === 'objectsLoaded');
      assert.ok(objectsLoaded.length >= 1, 'Empty role must dispatch objectsLoaded message');

      const data = objectsLoaded[0].data as { objects: { fullName: string }[]; phase?: string };
      assert.strictEqual(data.phase, 'initial');
      assert.ok(data.objects.some((o) => o.fullName === 'Configuration'), 'Configuration root must always be present');
    } finally {
      restorePanel();
      provider.dispose();
    }
  });

  test('on-demand loadObjectAttributes loads attributes via session and posts loadObjectAttributesResult', async () => {
    const rolePath = path.join(tmpRoot, 'src', 'Roles', 'Operator.xml');
    const rightsPath = path.join(tmpRoot, 'src', 'Roles', 'Operator', 'Ext', 'Rights.xml');
    await fs.promises.mkdir(path.dirname(rightsPath), { recursive: true });
    await fs.promises.mkdir(path.join(tmpRoot, 'Catalogs'), { recursive: true });

    await fs.promises.writeFile(
      path.join(tmpRoot, 'Configuration.xml'),
      '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Configuration name="TestConfig"><ChildObjects><Catalog>Товары</Catalog></ChildObjects></Configuration></MetaDataObject>',
      'utf8'
    );
    await fs.promises.writeFile(
      path.join(tmpRoot, 'Catalogs', 'Товары.xml'),
      `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">
  <Catalog uuid="12345678-1234-1234-1234-123456789abc">
    <Properties>
      <Name>Товары</Name>
      <Synonym><v8:content>Товары</v8:content></Synonym>
    </Properties>
    <ChildObjects>
      <Attribute uuid="22345678-1234-1234-1234-123456789abc">
        <Properties>
          <Name>Артикул</Name>
          <Synonym><v8:content>Артикул</v8:content></Synonym>
        </Properties>
      </Attribute>
      <Attribute uuid="32345678-1234-1234-1234-123456789abc">
        <Properties>
          <Name>Штрихкод</Name>
          <Synonym><v8:content>Штрихкод</v8:content></Synonym>
        </Properties>
      </Attribute>
    </ChildObjects>
  </Catalog>
</MetaDataObject>`,
      'utf8'
    );
    await fs.promises.writeFile(
      rolePath,
      '<Role xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Properties><Name>Operator</Name></Properties><Rights/></Role>',
      'utf8'
    );
    await fs.promises.writeFile(
      rightsPath,
      '<Rights xmlns="http://v8.1c.ru/8.2/roles" version="2.20"><object><name>Catalog.Товары</name><right><name>Read</name><value>true</value></right></object></Rights>',
      'utf8'
    );

    const { panel, getPostedMessages, getOnMessageHandler } = createFakeWebviewPanel({ autoReplyFlushWith: '' });
    const restorePanel = patchCreateWebviewPanel(panel);
    const provider = new RolesRightsEditorProvider(createFakeExtensionContext());

    try {
      await provider.show(rolePath, tmpRoot);
      const handler = getOnMessageHandler();
      assert.ok(handler, 'Message handler should be wired');

      const postedBefore = getPostedMessages();
      const initialMsg = postedBefore.find((m) => m.command === 'objectsLoaded');
      const sessionId = (initialMsg as { data?: { sessionId?: string } })?.data?.sessionId;
      assert.ok(sessionId, 'Valid sessionId must be present');

      await handler({
        command: 'loadObjectAttributes',
        data: {
          sessionId,
          requestId: 'req-attrs-1',
          objectFullName: 'Catalog.Товары',
        },
      });

      const postedAfter = getPostedMessages();
      const resultMsg = postedAfter.find((m) => m.command === 'loadObjectAttributesResult');
      assert.ok(resultMsg, 'loadObjectAttributesResult must be posted');

      const data = resultMsg.data as {
        sessionId?: string;
        requestId?: string;
        objectFullName?: string;
        state?: string;
        attributes?: { fullName: string; name: string }[];
      };

      assert.strictEqual(data.sessionId, sessionId);
      assert.strictEqual(data.requestId, 'req-attrs-1');
      assert.strictEqual(data.objectFullName, 'Catalog.Товары');
      assert.strictEqual(data.state, 'loaded');
      assert.ok(Array.isArray(data.attributes));
      assert.strictEqual(data.attributes.length, 2);
      assert.strictEqual(data.attributes[0].name, 'Артикул');
      assert.strictEqual(data.attributes[1].name, 'Штрихкод');
      assert.strictEqual(data.attributes[0].fullName, 'Catalog.Товары.Attribute.Артикул');
    } finally {
      restorePanel();
      provider.dispose();
    }
  });

  test('background search scans candidate attributes and can be cancelled with cancelSearch', async () => {
    const rolePath = path.join(tmpRoot, 'src', 'Roles', 'Operator.xml');
    const rightsPath = path.join(tmpRoot, 'src', 'Roles', 'Operator', 'Ext', 'Rights.xml');
    await fs.promises.mkdir(path.dirname(rightsPath), { recursive: true });
    await fs.promises.mkdir(path.join(tmpRoot, 'Catalogs'), { recursive: true });

    await fs.promises.writeFile(
      path.join(tmpRoot, 'Configuration.xml'),
      '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Configuration name="TestConfig"><ChildObjects><Catalog>Товары</Catalog></ChildObjects></Configuration></MetaDataObject>',
      'utf8'
    );
    await fs.promises.writeFile(
      path.join(tmpRoot, 'Catalogs', 'Товары.xml'),
      `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">
  <Catalog uuid="12345678-1234-1234-1234-123456789abc">
    <Properties>
      <Name>Товары</Name>
      <Synonym><v8:content>Товары</v8:content></Synonym>
    </Properties>
    <ChildObjects>
      <Attribute uuid="22345678-1234-1234-1234-123456789abc">
        <Properties>
          <Name>Артикул</Name>
          <Synonym><v8:content>Артикул</v8:content></Synonym>
        </Properties>
      </Attribute>
    </ChildObjects>
  </Catalog>
</MetaDataObject>`,
      'utf8'
    );
    await fs.promises.writeFile(
      rolePath,
      '<Role xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Properties><Name>Operator</Name></Properties><Rights/></Role>',
      'utf8'
    );
    await fs.promises.writeFile(
      rightsPath,
      '<Rights xmlns="http://v8.1c.ru/8.2/roles" version="2.20"><object><name>Catalog.Товары</name><right><name>Read</name><value>true</value></right></object></Rights>',
      'utf8'
    );

    const { panel, getPostedMessages, getOnMessageHandler } = createFakeWebviewPanel({ autoReplyFlushWith: '' });
    const restorePanel = patchCreateWebviewPanel(panel);
    const provider = new RolesRightsEditorProvider(createFakeExtensionContext());

    try {
      await provider.show(rolePath, tmpRoot);
      const handler = getOnMessageHandler();
      assert.ok(handler, 'Message handler should be wired');

      const postedBefore = getPostedMessages();
      const initialMsg = postedBefore.find((m) => m.command === 'objectsLoaded');
      const sessionId = (initialMsg as { data?: { sessionId?: string } })?.data?.sessionId;
      assert.ok(sessionId, 'Valid sessionId must be present');

      await handler({
        command: 'search',
        data: {
          sessionId,
          queryId: 101,
          query: 'артикул',
        },
      });

      await new Promise((r) => setTimeout(r, 100));

      const postedAfter = getPostedMessages();
      const searchProgressMsgs = postedAfter.filter((m) => m.command === 'searchProgress');
      assert.ok(searchProgressMsgs.length >= 1, 'searchProgress message must be posted');

      await handler({
        command: 'cancelSearch',
        data: {
          sessionId,
          queryId: 101,
        },
      });

      await handler({
        command: 'search',
        data: {
          sessionId,
          queryId: 102,
          query: 'несуществующий',
        },
      });

      await new Promise((r) => setTimeout(r, 100));

      const finalMessages = getPostedMessages().filter((m) => m.command === 'searchProgress');
      const latest = finalMessages[finalMessages.length - 1];
      assert.ok(latest, 'Final searchProgress must exist');
    } finally {
      restorePanel();
      provider.dispose();
    }
  });

  test('tableRenderProgress handles firstTableReady and rowCount smoothly', async () => {
    const rolePath = path.join(tmpRoot, 'src', 'Roles', 'Operator.xml');
    const rightsPath = path.join(tmpRoot, 'src', 'Roles', 'Operator', 'Ext', 'Rights.xml');
    await fs.promises.mkdir(path.dirname(rightsPath), { recursive: true });

    await fs.promises.writeFile(
      path.join(tmpRoot, 'Configuration.xml'),
      '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Configuration name="TestConfig"/></MetaDataObject>',
      'utf8'
    );
    await fs.promises.writeFile(
      rolePath,
      '<Role xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Properties><Name>Operator</Name></Properties><Rights/></Role>',
      'utf8'
    );
    await fs.promises.writeFile(
      rightsPath,
      '<Rights xmlns="http://v8.1c.ru/8.2/roles" version="2.20"><setForNewObjects>false</setForNewObjects></Rights>',
      'utf8'
    );

    const { panel, getOnMessageHandler } = createFakeWebviewPanel({ autoReplyFlushWith: '' });
    const restorePanel = patchCreateWebviewPanel(panel);
    const provider = new RolesRightsEditorProvider(createFakeExtensionContext());

    try {
      await provider.show(rolePath, tmpRoot);
      const handler = getOnMessageHandler();
      assert.ok(handler, 'Message handler should be wired');

      await handler({
        command: 'tableRenderProgress',
        data: {
          sessionId: 'test-session',
          dataRevision: 1,
          firstTableReady: true,
          busy: false,
          rowCount: 10,
        },
      });

      await handler({
        command: 'tableRenderProgress',
        data: {
          sessionId: 'test-session',
          dataRevision: 1,
          busy: true,
          rowCount: 500,
        },
      });

      await handler({
        command: 'tableRenderProgress',
        data: {
          sessionId: 'test-session',
          dataRevision: 1,
          busy: false,
        },
      });
    } finally {
      restorePanel();
      provider.dispose();
    }
  });
});
