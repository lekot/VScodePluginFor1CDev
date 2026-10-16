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
import { BoundedConcurrencyQueue } from '../../src/rolesEditor/rolesMetadataLoadSession';
import { FormatDetector, ConfigFormat } from '../../src/parsers/formatDetector';
import { MetadataParser } from '../../src/parsers/metadataParser';
import { MetadataType } from '../../src/models/treeNode';

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

  test('BoundedConcurrencyQueue rejects pending queued promises when cleared and avoids leaks (Finding 5)', async () => {
    const queue = new BoundedConcurrencyQueue(1);
    let task1Settled = false;
    let releaseTask1!: () => void;
    const task1Promise = new Promise<void>((resolve) => {
      releaseTask1 = resolve;
    });

    const run1 = queue.run(async () => {
      await task1Promise;
      task1Settled = true;
      return 'task1';
    });

    let task2Started = false;
    const run2 = queue.run(async () => {
      task2Started = true;
      return 'task2';
    });

    let task3Started = false;
    const run3 = queue.run(async () => {
      task3Started = true;
      return 'task3';
    });

    queue.clear();
    releaseTask1();
    await run1;
    assert.strictEqual(task1Settled, true);

    await assert.rejects(async () => await run2, /cleared|cancelled|disposed/i);
    await assert.rejects(async () => await run3, /cleared|cancelled|disposed/i);
    assert.strictEqual(task2Started, false, 'Cancelled task 2 must not run');
    assert.strictEqual(task3Started, false, 'Cancelled task 3 must not run');
  });

  test('attribute loading fails typed on parsing error, does not cache false-positive empty, and allows retry (Finding 4)', async () => {
    const rolePath = path.join(tmpRoot, 'src', 'Roles', 'Operator.xml');
    const rightsPath = path.join(tmpRoot, 'src', 'Roles', 'Operator', 'Ext', 'Rights.xml');
    await fs.promises.mkdir(path.dirname(rightsPath), { recursive: true });
    await fs.promises.mkdir(path.join(tmpRoot, 'Catalogs'), { recursive: true });

    await fs.promises.writeFile(
      path.join(tmpRoot, 'Configuration.xml'),
      '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Configuration name="TestConfig"><ChildObjects><Catalog>Broken</Catalog></ChildObjects></Configuration></MetaDataObject>',
      'utf8'
    );
    await fs.promises.writeFile(
      path.join(tmpRoot, 'Catalogs', 'Broken.xml'),
      '<MetaDataObject><Catalog><Properties><Name>Broken</Name></Properties><ChildObjects><Attribute>>>MALFORMED',
      'utf8'
    );
    await fs.promises.writeFile(
      rolePath,
      '<Role xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Properties><Name>Operator</Name></Properties><Rights/></Role>',
      'utf8'
    );
    await fs.promises.writeFile(
      rightsPath,
      '<Rights xmlns="http://v8.1c.ru/8.2/roles" version="2.20"><object><name>Catalog.Broken</name><right><name>Read</name><value>true</value></right></object></Rights>',
      'utf8'
    );

    const { panel, getPostedMessages, getOnMessageHandler } = createFakeWebviewPanel({ autoReplyFlushWith: '' });
    const restorePanel = patchCreateWebviewPanel(panel);
    const provider = new RolesRightsEditorProvider(createFakeExtensionContext());

    try {
      await provider.show(rolePath, tmpRoot);
      const handler = getOnMessageHandler();
      assert.ok(handler);

      const postedBefore = getPostedMessages();
      const initialMsg = postedBefore.find((m) => m.command === 'objectsLoaded');
      const sessionId = (initialMsg as { data?: { sessionId?: string } })?.data?.sessionId;
      assert.ok(sessionId);

      await handler({
        command: 'loadObjectAttributes',
        data: {
          sessionId,
          requestId: 'req-err-1',
          objectFullName: 'Catalog.Broken',
        },
      });

      const postedAfterError = getPostedMessages();
      const failureMsg = postedAfterError.find(
        (m) => m.command === 'loadObjectAttributesResult' && (m.data as { requestId?: string })?.requestId === 'req-err-1'
      );
      assert.ok(failureMsg, 'Must post loadObjectAttributesResult on error');
      const failureData = failureMsg.data as { state?: string; error?: string };
      assert.strictEqual(failureData.state, 'failed', 'State must be failed on XML or I/O error');
      assert.ok(failureData.error, 'Error message must be present');

      await fs.promises.writeFile(
        path.join(tmpRoot, 'Catalogs', 'Broken.xml'),
        `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">
  <Catalog uuid="11111111-1111-1111-1111-111111111111">
    <Properties><Name>Broken</Name></Properties>
    <ChildObjects>
      <Attribute uuid="22222222-2222-2222-2222-222222222222">
        <Properties><Name>FixedAttr</Name></Properties>
      </Attribute>
    </ChildObjects>
  </Catalog>
</MetaDataObject>`,
        'utf8'
      );

      await handler({
        command: 'loadObjectAttributes',
        data: {
          sessionId,
          requestId: 'req-retry-1',
          objectFullName: 'Catalog.Broken',
        },
      });

      const postedAfterRetry = getPostedMessages();
      const retryMsg = postedAfterRetry.find(
        (m) => m.command === 'loadObjectAttributesResult' && (m.data as { requestId?: string })?.requestId === 'req-retry-1'
      );
      assert.ok(retryMsg, 'Must post loadObjectAttributesResult on retry');
      const retryData = retryMsg.data as { state?: string; attributes?: unknown[] };
      assert.strictEqual(retryData.state, 'loaded', 'Retry must succeed');
      assert.strictEqual(retryData.attributes?.length, 1);
    } finally {
      restorePanel();
      provider.dispose();
    }
  });

  test('stale async format detection in show(A) does not overwrite active session B (Finding 1)', async () => {
    const rootA = path.join(tmpRoot, 'ConfigA');
    const rootB = path.join(tmpRoot, 'ConfigB');
    await fs.promises.mkdir(path.join(rootA, 'src', 'Roles', 'RoleA', 'Ext'), { recursive: true });
    await fs.promises.mkdir(path.join(rootB, 'src', 'Roles', 'RoleB', 'Ext'), { recursive: true });

    await fs.promises.writeFile(path.join(rootA, 'Configuration.xml'), '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Configuration name="ConfigA"/></MetaDataObject>', 'utf8');
    await fs.promises.writeFile(path.join(rootB, 'Configuration.xml'), '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Configuration name="ConfigB"/></MetaDataObject>', 'utf8');

    const roleAPath = path.join(rootA, 'src', 'Roles', 'RoleA.xml');
    const roleBPath = path.join(rootB, 'src', 'Roles', 'RoleB.xml');
    await fs.promises.writeFile(roleAPath, '<Role xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Properties><Name>RoleA</Name></Properties><Rights/></Role>', 'utf8');
    await fs.promises.writeFile(roleBPath, '<Role xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Properties><Name>RoleB</Name></Properties><Rights/></Role>', 'utf8');
    await fs.promises.writeFile(path.join(rootA, 'src', 'Roles', 'RoleA', 'Ext', 'Rights.xml'), '<Rights xmlns="http://v8.1c.ru/8.2/roles" version="2.20"/>', 'utf8');
    await fs.promises.writeFile(path.join(rootB, 'src', 'Roles', 'RoleB', 'Ext', 'Rights.xml'), '<Rights xmlns="http://v8.1c.ru/8.2/roles" version="2.20"/>', 'utf8');

    const { panel, getPostedMessages } = createFakeWebviewPanel({ autoReplyFlushWith: '' });
    const restorePanel = patchCreateWebviewPanel(panel);
    const provider = new RolesRightsEditorProvider(createFakeExtensionContext());

    const originalDetect = FormatDetector.detect;
    let releaseDetectA!: () => void;
    const detectABarrier = new Promise<void>((resolve) => {
      releaseDetectA = resolve;
    });

    try {
      (FormatDetector.detect as unknown as (p: string) => Promise<ConfigFormat>) = async (configPath: string) => {
        if (configPath === rootA) {
          await detectABarrier;
        }
        return ConfigFormat.Designer;
      };

      const showAPromise = provider.show(roleAPath, rootA);
      await new Promise((r) => setTimeout(r, 20));

      await provider.show(roleBPath, rootB);

      const messagesAfterB = getPostedMessages();
      const roleBMsg = messagesAfterB.find((m) => m.command === 'objectsLoaded');
      const sessionBId = (roleBMsg as { data?: { sessionId?: string } })?.data?.sessionId;
      assert.ok(sessionBId);

      releaseDetectA();
      await showAPromise;

      assert.strictEqual(
        (provider as unknown as { activeSessionId: string }).activeSessionId,
        sessionBId,
        'Active session must remain B after stale A completes'
      );
      assert.strictEqual(
        (provider as unknown as { currentLoadSession: { configPath: string } }).currentLoadSession?.configPath,
        rootB,
        'Active load session configPath must remain rootB'
      );
    } finally {
      releaseDetectA?.();
      (FormatDetector.detect as unknown as typeof FormatDetector.detect) = originalDetect;
      restorePanel();
      provider.dispose();
    }
  });

  test('repeated search scans cached attributes and delivers matchingObjectNames and complete for new queryId (Finding 2)', async () => {
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
    <Properties><Name>Товары</Name></Properties>
    <ChildObjects>
      <Attribute uuid="22345678-1234-1234-1234-123456789abc">
        <Properties><Name>Артикул</Name></Properties>
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
      assert.ok(handler);

      const postedBefore = getPostedMessages();
      const initialMsg = postedBefore.find((m) => m.command === 'objectsLoaded');
      const sessionId = (initialMsg as { data?: { sessionId?: string } })?.data?.sessionId;
      assert.ok(sessionId);

      // Search 1: mismatch
      await handler({
        command: 'search',
        data: { sessionId, queryId: 201, query: 'несуществующий' },
      });
      await new Promise((r) => setTimeout(r, 60));

      // Search 2: match for already cached attribute
      await handler({
        command: 'search',
        data: { sessionId, queryId: 202, query: 'артикул' },
      });
      await new Promise((r) => setTimeout(r, 60));

      const messages = getPostedMessages();
      const query202Progress = messages.filter(
        (m) => m.command === 'searchProgress' && (m.data as { queryId?: number })?.queryId === 202
      );
      assert.ok(query202Progress.length >= 1, 'Must emit searchProgress for query 202');
      const hasMatch = query202Progress.some((m) =>
        (m.data as { matchingObjectNames?: string[] })?.matchingObjectNames?.includes('Catalog.Товары')
      );
      assert.strictEqual(hasMatch, true, 'Query 202 must find Catalog.Товары even if already read into cache');

      const latest202 = query202Progress[query202Progress.length - 1];
      assert.strictEqual((latest202.data as { state?: string }).state, 'complete');

      // Search 3: empty result when all objects already loaded
      await handler({
        command: 'search',
        data: { sessionId, queryId: 203, query: 'снова_нет' },
      });
      await new Promise((r) => setTimeout(r, 60));

      const query203Progress = getPostedMessages().filter(
        (m) => m.command === 'searchProgress' && (m.data as { queryId?: number })?.queryId === 203
      );
      assert.ok(query203Progress.length >= 1, 'Query 203 must receive progress even when all objects are loaded');
      const latest203 = query203Progress[query203Progress.length - 1];
      assert.strictEqual((latest203.data as { state?: string }).state, 'complete');
    } finally {
      restorePanel();
      provider.dispose();
    }
  });

  test('search does not complete until type index finishes and includes merged index objects in search (Finding 3)', async () => {
    const rolePath = path.join(tmpRoot, 'src', 'Roles', 'Operator.xml');
    const rightsPath = path.join(tmpRoot, 'src', 'Roles', 'Operator', 'Ext', 'Rights.xml');
    await fs.promises.mkdir(path.dirname(rightsPath), { recursive: true });
    await fs.promises.mkdir(path.join(tmpRoot, 'Catalogs'), { recursive: true });

    await fs.promises.writeFile(
      path.join(tmpRoot, 'Configuration.xml'),
      '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Configuration name="TestConfig"><ChildObjects><Catalog>Existing</Catalog><Catalog>DelayedIndex</Catalog></ChildObjects></Configuration></MetaDataObject>',
      'utf8'
    );
    await fs.promises.writeFile(
      path.join(tmpRoot, 'Catalogs', 'Existing.xml'),
      '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Catalog uuid="11111111-1111-1111-1111-111111111111"><Properties><Name>Existing</Name></Properties></Catalog></MetaDataObject>',
      'utf8'
    );
    await fs.promises.writeFile(
      path.join(tmpRoot, 'Catalogs', 'DelayedIndex.xml'),
      `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">
  <Catalog uuid="22222222-2222-2222-2222-222222222222">
    <Properties><Name>DelayedIndex</Name></Properties>
    <ChildObjects>
      <Attribute uuid="33333333-3333-3333-3333-333333333333">
        <Properties><Name>UniqueTargetCode</Name></Properties>
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
    // Role only has rights on Existing initially
    await fs.promises.writeFile(
      rightsPath,
      '<Rights xmlns="http://v8.1c.ru/8.2/roles" version="2.20"><object><name>Catalog.Existing</name><right><name>Read</name><value>true</value></right></object></Rights>',
      'utf8'
    );

    const { panel, getPostedMessages, getOnMessageHandler } = createFakeWebviewPanel({ autoReplyFlushWith: '' });
    const restorePanel = patchCreateWebviewPanel(panel);
    const provider = new RolesRightsEditorProvider(createFakeExtensionContext());

    const originalParseTypeIndex = MetadataParser.parseTypeIndex;
    let releaseIndex!: () => void;
    const indexBarrier = new Promise<void>((resolve) => {
      releaseIndex = resolve;
    });

    try {
      (MetadataParser.parseTypeIndex as unknown as (c: string, t: string) => Promise<import('../../src/models/treeNode').TreeNode[]>) = async (c: string, t: string) => {
        if (t === 'Catalogs') {
          await indexBarrier;
          return [
            { id: 'Catalogs.Existing', name: 'Existing', type: MetadataType.Catalog, properties: {} },
            { id: 'Catalogs.DelayedIndex', name: 'DelayedIndex', type: MetadataType.Catalog, properties: {} },
          ];
        }
        return [];
      };

      await provider.show(rolePath, tmpRoot);
      const handler = getOnMessageHandler();
      assert.ok(handler);

      const postedBefore = getPostedMessages();
      const initialMsg = postedBefore.find((m) => m.command === 'objectsLoaded');
      const sessionId = (initialMsg as { data?: { sessionId?: string } })?.data?.sessionId;
      assert.ok(sessionId);

      // Start search for 'uniquetargetcode' before index completes
      await handler({
        command: 'search',
        data: { sessionId, queryId: 301, query: 'uniquetargetcode' },
      });

      await new Promise((r) => setTimeout(r, 40));

      // Verify complete is NOT sent prematurely while index is still building
      const messagesBeforeIndex = getPostedMessages();
      const completeBeforeIndex = messagesBeforeIndex.find(
        (m) => m.command === 'searchProgress' && (m.data as { queryId?: number; state?: string })?.queryId === 301 && (m.data as { state?: string })?.state === 'complete'
      );
      assert.strictEqual(
        completeBeforeIndex,
        undefined,
        'Search must NOT declare complete before type index completes'
      );

      // Release index so DelayedIndex is merged into allObjects
      releaseIndex();
      await new Promise((r) => setTimeout(r, 150));

      const messagesAfterIndex = getPostedMessages();
      const query301Messages = messagesAfterIndex.filter(
        (m) => m.command === 'searchProgress' && (m.data as { queryId?: number })?.queryId === 301
      );
      const hasMatch = query301Messages.some((m) =>
        (m.data as { matchingObjectNames?: string[] })?.matchingObjectNames?.includes('Catalog.DelayedIndex')
      );
      assert.strictEqual(hasMatch, true, 'Search must discover DelayedIndex after index merge');

      const latest301 = query301Messages[query301Messages.length - 1];
      assert.strictEqual((latest301.data as { state?: string }).state, 'complete');
    } finally {
      releaseIndex?.();
      (MetadataParser.parseTypeIndex as unknown as typeof MetadataParser.parseTypeIndex) = originalParseTypeIndex;
      restorePanel();
      provider.dispose();
    }
  });
});
