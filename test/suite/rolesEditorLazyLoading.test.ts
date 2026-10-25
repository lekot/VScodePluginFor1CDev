import '../helpers/vscodeStubRegister';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
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
import { DesignerParser } from '../../src/parsers/designerParser';
import { loadAttributeRowsForObject } from '../../src/rolesEditor/metadataLoader';
import { TreeNode, MetadataType } from '../../src/models/treeNode';

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

  test('cached attribute search match delivers loadObjectAttributesResult so webview has attributes (Finding 1)', async () => {
    const rolePath = path.join(tmpRoot, 'src', 'Roles', 'Operator.xml');
    const rightsPath = path.join(tmpRoot, 'src', 'Roles', 'Operator', 'Ext', 'Rights.xml');
    await fs.promises.mkdir(path.dirname(rightsPath), { recursive: true });
    await fs.promises.mkdir(path.join(tmpRoot, 'Catalogs'), { recursive: true });

    await fs.promises.writeFile(
      path.join(tmpRoot, 'Configuration.xml'),
      '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Configuration name="TestConfig"><ChildObjects><Catalog>CachedCatalog</Catalog></ChildObjects></Configuration></MetaDataObject>',
      'utf8'
    );
    await fs.promises.writeFile(
      path.join(tmpRoot, 'Catalogs', 'CachedCatalog.xml'),
      `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">
  <Catalog uuid="11111111-2222-3333-4444-555555555555">
    <Properties><Name>CachedCatalog</Name></Properties>
    <ChildObjects>
      <Attribute uuid="22222222-3333-4444-5555-666666666666">
        <Properties><Name>SpecialMatchField</Name></Properties>
      </Attribute>
      <Attribute uuid="33333333-4444-5555-6666-777777777777">
        <Properties><Name>OtherField</Name></Properties>
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
      '<Rights xmlns="http://v8.1c.ru/8.2/roles" version="2.20"><object><name>Catalog.CachedCatalog</name><right><name>Read</name><value>true</value></right></object></Rights>',
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

      // Explicitly load attributes first (e.g. user expanded row or previous request)
      await handler({
        command: 'loadObjectAttributes',
        data: {
          sessionId,
          requestId: 'req-manual-1',
          objectFullName: 'Catalog.CachedCatalog',
        },
      });

      // Confirm attributes loaded initially
      const loadResultMsg = getPostedMessages().find(
        (m) => m.command === 'loadObjectAttributesResult' && (m.data as { requestId?: string })?.requestId === 'req-manual-1'
      );
      assert.ok(loadResultMsg, 'CachedCatalog attributes must be loaded initially');

      // Now run search for 'specialmatch'
      await handler({
        command: 'search',
        data: { sessionId, queryId: 401, query: 'specialmatch' },
      });

      await new Promise((r) => setTimeout(r, 60));

      const messages = getPostedMessages();
      // Must post searchProgress with matchingObjectNames
      const progressMsgs = messages.filter(
        (m) => m.command === 'searchProgress' && (m.data as { queryId?: number })?.queryId === 401
      );
      assert.ok(progressMsgs.length >= 1, 'Must post searchProgress for cached search');
      const matching = progressMsgs.some(
        (m) => (m.data as { matchingObjectNames?: string[] })?.matchingObjectNames?.includes('Catalog.CachedCatalog')
      );
      assert.strictEqual(matching, true, 'searchProgress must identify Catalog.CachedCatalog as matching');

      // Finding 1 assertion:
      // Webview MUST receive loadObjectAttributesResult for CachedCatalog so it can populate target.attributes and display rows!
      const cachedAttrDeliveries = messages.filter(
        (m) =>
          m.command === 'loadObjectAttributesResult' &&
          (m.data as { objectFullName?: string })?.objectFullName === 'Catalog.CachedCatalog' &&
          (m.data as { requestId?: string })?.requestId !== 'req-manual-1'
      );
      assert.ok(
        cachedAttrDeliveries.length >= 1,
        'Webview MUST receive loadObjectAttributesResult for cached search matches'
      );
      const cachedDelivery = cachedAttrDeliveries[0].data as {
        state: string;
        attributes: Array<{ name: string }>;
      };
      assert.strictEqual(cachedDelivery.state, 'loaded');
      assert.ok(
        cachedDelivery.attributes.some((a) => a.name === 'SpecialMatchField'),
        'Delivered cached attributes must contain SpecialMatchField'
      );
    } finally {
      restorePanel();
      provider.dispose();
    }
  });

  test('access() failure in loadChildrenForElement propagates typed error instead of empty branch (Finding 2)', async () => {
    const originalAccess = fs.promises.access;
    try {
      const parentNode: TreeNode = {
        id: 'Catalogs.ForbiddenCatalog',
        name: 'ForbiddenCatalog',
        type: MetadataType.Catalog,
        properties: {},
        parent: { id: 'Catalogs', name: 'Catalogs', type: MetadataType.Catalog, properties: {} },
      };

      // Injected access failure (e.g. EACCES permission denied)
      const eaccesErr = new Error('EACCES: permission denied, access Catalogs\\ForbiddenCatalog.xml');
      (eaccesErr as NodeJS.ErrnoException).code = 'EACCES';

      (fs.promises.access as unknown as (p: fs.PathLike) => Promise<void>) = async (p: fs.PathLike) => {
        if (typeof p === 'string' && p.includes('ForbiddenCatalog.xml')) {
          throw eaccesErr;
        }
        return originalAccess(p);
      };

      // 1. loadChildrenForElement must record _parseError on element
      await DesignerParser.loadChildrenForElement(
        tmpRoot,
        'Catalogs',
        'ForbiddenCatalog',
        parentNode
      );
      assert.ok(
        parentNode.properties._parseError,
        'DesignerParser.loadChildrenForElement must set element.properties._parseError on access error'
      );
      assert.strictEqual(
        (parentNode.properties._parseError as NodeJS.ErrnoException).code,
        'EACCES'
      );

      // 2. MetadataParser.loadElementChildren on Attributes must reject, not return empty []
      const attributesSection: TreeNode = {
        id: 'Attributes',
        name: 'Attributes',
        type: MetadataType.Attribute,
        properties: {},
        parent: parentNode,
      };

      await assert.rejects(
        async () => {
          await MetadataParser.loadElementChildren(tmpRoot, ConfigFormat.Designer, attributesSection);
        },
        (err: unknown) => {
          return (err as NodeJS.ErrnoException)?.code === 'EACCES';
        },
        'loadElementChildren must reject with EACCES rather than returning empty []'
      );

      // 3. loadAttributeRowsForObject must reject rather than returning []
      await assert.rejects(
        async () => {
          await loadAttributeRowsForObject(tmpRoot, ConfigFormat.Designer, 'Catalog.ForbiddenCatalog', {});
        },
        (err: unknown) => {
          return (err as NodeJS.ErrnoException)?.code === 'EACCES';
        },
        'loadAttributeRowsForObject must propagate access failure'
      );
    } finally {
      fs.promises.access = originalAccess;
    }
  });

  test('repairing malformed XML clears _parseError and allows successful retry on same TreeNode (Finding 3)', async () => {
    const catalogsDir = path.join(tmpRoot, 'Catalogs');
    await fs.promises.mkdir(catalogsDir, { recursive: true });
    const catalogXmlPath = path.join(catalogsDir, 'RepairableCatalog.xml');

    // 1. Write malformed XML
    await fs.promises.writeFile(catalogXmlPath, '<MetaDataObject><Catalog><UnclosedTag></Catalog></MetaDataObject>', 'utf8');

    const parentNode: TreeNode = {
      id: 'Catalogs.RepairableCatalog',
      name: 'RepairableCatalog',
      type: MetadataType.Catalog,
      properties: {},
      parent: { id: 'Catalogs', name: 'Catalogs', type: MetadataType.Catalog, properties: {} },
    };

    const attributesSection: TreeNode = {
      id: 'Attributes',
      name: 'Attributes',
      type: MetadataType.Attribute,
      properties: {},
      parent: parentNode,
    };

    // First attempt: should fail and set parentNode.properties._parseError
    await assert.rejects(
      async () => {
        await MetadataParser.loadElementChildren(tmpRoot, ConfigFormat.Designer, attributesSection);
      },
      /Invalid XML/,
      'First attempt with malformed XML must throw Invalid XML error'
    );
    assert.ok(parentNode.properties._parseError, 'parentNode must hold _parseError after first failure');

    // 2. Repair XML with valid content containing an attribute
    const validXml = `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">
  <Catalog uuid="12345678-1234-1234-1234-123456789abc">
    <Properties><Name>RepairableCatalog</Name></Properties>
    <ChildObjects>
      <Attribute uuid="abcdef12-1234-1234-1234-123456789abc">
        <Properties><Name>RepairedAttribute</Name></Properties>
      </Attribute>
    </ChildObjects>
  </Catalog>
</MetaDataObject>`;
    await fs.promises.writeFile(catalogXmlPath, validXml, 'utf8');

    // 3. Retry on the EXACT same parentNode instance: must succeed and clear _parseError
    const children = await MetadataParser.loadElementChildren(
      tmpRoot,
      ConfigFormat.Designer,
      attributesSection
    );

    assert.strictEqual(
      parentNode.properties._parseError,
      undefined,
      'parentNode.properties._parseError must be cleared on successful retry'
    );
    assert.strictEqual(children.length, 1, 'Must return 1 attribute child after repair');
    assert.strictEqual(children[0].name, 'RepairedAttribute');
  });

  test('subsequent search retries failed objects and declares incomplete while failed objects remain in scope (Finding 4)', async () => {
    const rolePath = path.join(tmpRoot, 'src', 'Roles', 'Operator.xml');
    const rightsPath = path.join(tmpRoot, 'src', 'Roles', 'Operator', 'Ext', 'Rights.xml');
    await fs.promises.mkdir(path.dirname(rightsPath), { recursive: true });
    await fs.promises.mkdir(path.join(tmpRoot, 'Catalogs'), { recursive: true });

    await fs.promises.writeFile(
      path.join(tmpRoot, 'Configuration.xml'),
      '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Configuration name="TestConfig"><ChildObjects><Catalog>FlakyCatalog</Catalog><Catalog>StableCatalog</Catalog></ChildObjects></Configuration></MetaDataObject>',
      'utf8'
    );
    await fs.promises.writeFile(
      path.join(tmpRoot, 'Catalogs', 'StableCatalog.xml'),
      `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">
  <Catalog uuid="11111111-1111-1111-1111-111111111111">
    <Properties><Name>StableCatalog</Name></Properties>
    <ChildObjects>
      <Attribute uuid="22222222-2222-2222-2222-222222222222">
        <Properties><Name>CommonField</Name></Properties>
      </Attribute>
    </ChildObjects>
  </Catalog>
</MetaDataObject>`,
      'utf8'
    );
    await fs.promises.writeFile(
      path.join(tmpRoot, 'Catalogs', 'FlakyCatalog.xml'),
      `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">
  <Catalog uuid="99999999-9999-9999-9999-999999999999">
    <Properties><Name>FlakyCatalog</Name></Properties>
    <ChildObjects>
      <Attribute uuid="88888888-8888-8888-8888-888888888888">
        <Properties><Name>CommonField</Name></Properties>
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
      '<Rights xmlns="http://v8.1c.ru/8.2/roles" version="2.20"><object><name>Catalog.StableCatalog</name><right><name>Read</name><value>true</value></right></object></Rights>',
      'utf8'
    );

    const { panel, getPostedMessages, getOnMessageHandler } = createFakeWebviewPanel({ autoReplyFlushWith: '' });
    const restorePanel = patchCreateWebviewPanel(panel);
    const provider = new RolesRightsEditorProvider(createFakeExtensionContext());

    // Initially FlakyCatalog XML is locked / throws error
    let flakyShouldFail = true;
    let flakyLoadAttempts = 0;
    const originalAccess = fs.promises.access;

    try {
      (fs.promises.access as unknown as (p: fs.PathLike) => Promise<void>) = async (p: fs.PathLike) => {
        if (typeof p === 'string' && p.includes('FlakyCatalog.xml')) {
          flakyLoadAttempts++;
          if (flakyShouldFail) {
            const err = new Error('EACCES: FlakyCatalog locked');
            (err as NodeJS.ErrnoException).code = 'EACCES';
            throw err;
          }
        }
        return originalAccess(p);
      };

      await provider.show(rolePath, tmpRoot);
      const handler = getOnMessageHandler();
      assert.ok(handler);

      const postedBefore = getPostedMessages();
      const initialMsg = postedBefore.find((m) => m.command === 'objectsLoaded');
      const sessionId = (initialMsg as { data?: { sessionId?: string } })?.data?.sessionId;
      assert.ok(sessionId);

      // Search 1: Query 501. FlakyCatalog fails.
      await handler({
        command: 'search',
        data: { sessionId, queryId: 501, query: 'commonfield' },
      });

      await new Promise((r) => setTimeout(r, 60));

      const query501Progress = getPostedMessages().filter(
        (m) => m.command === 'searchProgress' && (m.data as { queryId?: number })?.queryId === 501
      );
      assert.ok(query501Progress.length >= 1);
      const latest501 = query501Progress[query501Progress.length - 1];
      assert.strictEqual((latest501.data as { state?: string }).state, 'incomplete');
      const attemptsAfter501 = flakyLoadAttempts;
      assert.ok(attemptsAfter501 >= 1, 'Must have attempted to load FlakyCatalog in query 501');

      // Search 2: Query 502. FlakyCatalog is still failing.
      // It must be RETRIED in query 502, and query 502 must end in 'incomplete', NOT 'complete'!
      await handler({
        command: 'search',
        data: { sessionId, queryId: 502, query: 'commonfield' },
      });

      await new Promise((r) => setTimeout(r, 60));

      assert.ok(
        flakyLoadAttempts > attemptsAfter501,
        'Search 502 must retry loading failed object FlakyCatalog'
      );
      const query502Progress = getPostedMessages().filter(
        (m) => m.command === 'searchProgress' && (m.data as { queryId?: number })?.queryId === 502
      );
      const latest502 = query502Progress[query502Progress.length - 1];
      assert.strictEqual(
        (latest502.data as { state?: string }).state,
        'incomplete',
        'Search 502 must declare incomplete because FlakyCatalog is still failed'
      );

      // Now create valid FlakyCatalog XML and allow access
      flakyShouldFail = false;
      await fs.promises.writeFile(
        path.join(tmpRoot, 'Catalogs', 'FlakyCatalog.xml'),
        `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">
  <Catalog uuid="99999999-9999-9999-9999-999999999999">
    <Properties><Name>FlakyCatalog</Name></Properties>
    <ChildObjects>
      <Attribute uuid="88888888-8888-8888-8888-888888888888">
        <Properties><Name>CommonField</Name></Properties>
      </Attribute>
    </ChildObjects>
  </Catalog>
</MetaDataObject>`,
        'utf8'
      );

      // Search 3: Query 503. FlakyCatalog succeeds on retry!
      await handler({
        command: 'search',
        data: { sessionId, queryId: 503, query: 'commonfield' },
      });

      await new Promise((r) => setTimeout(r, 60));

      const query503Progress = getPostedMessages().filter(
        (m) => m.command === 'searchProgress' && (m.data as { queryId?: number })?.queryId === 503
      );
      const latest503 = query503Progress[query503Progress.length - 1];
      assert.strictEqual(
        (latest503.data as { state?: string }).state,
        'complete',
        'Search 503 must succeed completely after FlakyCatalog was repaired and reloaded'
      );
      const matches503 = (latest503.data as { matchingObjectNames?: string[] })?.matchingObjectNames ?? [];
      assert.ok(matches503.includes('Catalog.FlakyCatalog'), 'FlakyCatalog must match in search 503');
      assert.ok(matches503.includes('Catalog.StableCatalog'), 'StableCatalog must match in search 503');
    } finally {
      fs.promises.access = originalAccess;
      restorePanel();
      provider.dispose();
    }
  });

  test('webview table row projection maintains uniqueness and preserves assigned attributes across initial -> index merge -> expand -> collapse -> search lifecycle (Round 3 finding)', () => {
    const htmlPath = path.resolve(__dirname, '../../../src/rolesEditor/rolesEditorWebview.html');
    let html = fs.readFileSync(htmlPath, 'utf8');

    const roleData = {
      name: 'Operator',
      filePath: 'src/Roles/Operator.xml',
      rights: JSON.parse('{"Catalog.Items.Attribute.Beta":{"Read":true,"View":true},"Catalog.Items":{"Read":true},"__proto__":{"Read":false},"constructor":{"Read":false},"toString":{"Read":false},"hasOwnProperty":{"Read":false},"Catalog.Neighbor":{"Read":false}}'),
      uiRights: [
        { key: 'Read', label: 'Read', xmlName: 'Read', applicableTo: ['Catalog', 'Attribute'], dependencies: ['__proto__'], clearedBy: [] },
        { key: 'View', label: 'View', xmlName: 'View', applicableTo: ['Catalog', 'Attribute'], dependencies: [], clearedBy: [] },
        { key: '__proto__', label: '__proto__', xmlName: '__proto__', applicableTo: ['Catalog'], dependencies: [], clearedBy: [] },
      ],
    };

    const initialObjects = [
      { fullName: 'Configuration', type: 'Configuration', name: 'Config', rowKind: 'configurationRoot' },
      { fullName: 'Catalog.Items', type: 'Catalog', name: 'Items', rowKind: 'object', attributesState: 'unloaded' },
      { fullName: 'Catalog.Items.Attribute.Beta', type: 'Attribute', name: 'Beta', rowKind: 'attribute', parentLabel: 'Items (Catalog)' },
    ];

    html = html.replace(
      /\s*\/\/ Request initial data\s*vscode\.postMessage\(\s*\{\s*command:\s*'ready'\s*\}\s*\)\s*;/,
      ` roleData = JSON.parse(${JSON.stringify(JSON.stringify(roleData))});
        allObjects = ${JSON.stringify(initialObjects)};
        tableInitialLoading = false;
        filterState = { showAll: false, searchQuery: '', typeFilter: '' };
        currentSessionId = 'session-1';
        currentDataRevision = 1;
        beginRightsEditorSession();`
    );

    const scriptMatch = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, 'script tag must exist in rolesEditorWebview.html');
    let scriptContent = scriptMatch[1];
    scriptContent = scriptContent.replace(/\}\)\(\);\s*$/, `window.__rolesTestState = function () {
        return {
          allObjects: allObjects,
          rights: roleData.rights,
          prototypeState: Object.prototype.displayName === undefined &&
            Object.prototype.hasRights === undefined &&
            Object.displayName === undefined &&
            Object.prototype.toString.displayName === undefined &&
            Object.prototype.hasOwnProperty.displayName === undefined,
          rightsPrototypeIsNull: Object.getPrototypeOf(roleData.rights) === null,
          protoRightsPrototypeIsNull: Object.prototype.hasOwnProperty.call(roleData.rights, '__proto__') &&
            Object.getPrototypeOf(roleData.rights['__proto__']) === null,
          resetFilters: function () {
            filterState.searchQuery = '';
            filterState.typeFilter = '';
            renderTable();
          }
        };
      };
      })();`);

    class MockElement {
      public tagName: string;
      public children: MockElement[] = [];
      public cells: MockElement[] = [];
      public options: MockElement[] = [];
      public style: { [key: string]: unknown } = {};
      public dataset: { [key: string]: string } = {};
      public textContent: string = '';
      public _innerHTML: string = '';
      public title: string = '';
      public value: string = '';
      public checked: boolean = false;
      public disabled: boolean = false;
      public listeners: { [event: string]: ((e: unknown) => void)[] } = {};

      constructor(tagName = 'div') {
        this.tagName = tagName;
      }
      get innerHTML(): string { return this._innerHTML; }
      set innerHTML(val: string) {
        this._innerHTML = val;
        if (!val) {
          this.children = [];
          this.cells = [];
        }
      }
      addEventListener(event: string, fn: (e: unknown) => void): void {
        this.listeners[event] = this.listeners[event] || [];
        this.listeners[event].push(fn);
      }
      dispatchEvent(event: { type: string; target?: unknown }): void {
        const list = this.listeners[event.type] || [];
        for (const fn of list) fn(event);
      }
      appendChild(child: MockElement): MockElement {
        this.children.push(child);
        if (this.tagName === 'tr') {
          this.cells.push(child);
        }
        return child;
      }
      deleteCell(index: number): void {
        this.cells.splice(index, 1);
      }
      remove(index: number): void {
        this.options.splice(index, 1);
      }
      closest(selector: string): MockElement | null {
        if (selector === '.attr-expander') {
          return this;
        }
        return null;
      }
      getAttribute(name: string): string | null {
        if (name === 'data-object') return this.dataset.object || null;
        return null;
      }
    }

    const elements: { [id: string]: MockElement } = {
      tableLoadingOverlay: new MockElement('div'),
      metadataLoadError: new MockElement('div'),
      saveButton: new MockElement('button'),
      cancelButton: new MockElement('button'),
      hostMessageBanner: new MockElement('div'),
      roleTitle: new MockElement('span'),
      rlsTemplates: new MockElement('textarea'),
      showAllToggle: new MockElement('input'),
      searchInput: new MockElement('input'),
      typeFilter: new MockElement('select'),
      tableBody: new MockElement('tbody'),
      headerRow: new MockElement('tr'),
      emptyState: new MockElement('div'),
      searchStatus: new MockElement('span'),
    };

    const messageListeners: ((event: { data: unknown }) => void)[] = [];
    const postedMessages: Array<{ command: string; data?: any }> = [];
    const sandbox = {
      acquireVsCodeApi: () => ({ postMessage: (message: { command: string; data?: any }) => postedMessages.push(message) }),
      document: {
        getElementById: (id: string) => elements[id] || new MockElement('div'),
        createElement: (tag: string) => new MockElement(tag),
        addEventListener: () => {},
      },
      window: {
        addEventListener: (type: string, fn: (event: { data: unknown }) => void) => {
          if (type === 'message') messageListeners.push(fn);
        },
      },
      requestAnimationFrame: (fn: () => void) => fn(),
      setTimeout: (fn: () => void) => setTimeout(fn, 0),
      clearTimeout: (id: NodeJS.Timeout) => clearTimeout(id),
      console,
    };

    vm.createContext(sandbox);
    vm.runInContext(scriptContent, sandbox);

    function postMessage(msg: unknown): void {
      for (const fn of messageListeners) fn({ data: msg });
    }

    function inspectWebviewState(): any {
      return (sandbox.window as any).__rolesTestState();
    }

    // 1. Initial State: Catalog.Items and Catalog.Items.Attribute.Beta
    const initialTitles = elements.tableBody.children.map((tr) => tr.children[0].title);
    assert.deepStrictEqual(initialTitles, ['Catalog.Items', 'Catalog.Items.Attribute.Beta']);
    const initialUnique = new Set(initialTitles);
    assert.strictEqual(initialUnique.size, initialTitles.length, 'Initial rows must have unique fullNames');

    // 2. Index merge
    postMessage({
      command: 'objectsLoaded',
      data: {
        sessionId: 'session-1',
        phase: 'typeIndex',
        objects: [
          { fullName: 'Configuration', type: 'Configuration', name: 'Config', rowKind: 'configurationRoot' },
          { fullName: 'Catalog.Items', type: 'Catalog', name: 'Items', rowKind: 'object', attributesState: 'unloaded', hasRights: true },
          { fullName: 'Catalog.Other', type: 'Catalog', name: 'Other', rowKind: 'object', attributesState: 'unloaded', hasRights: false },
        ],
      },
    });
    const afterIndexTitles = elements.tableBody.children.map((tr) => tr.children[0].title);
    assert.deepStrictEqual(afterIndexTitles, ['Catalog.Items', 'Catalog.Items.Attribute.Beta']);

    // 3. Deliver loaded attributes
    postMessage({
      command: 'loadObjectAttributesResult',
      data: {
        sessionId: 'session-1',
        objectFullName: 'Catalog.Items',
        state: 'loaded',
        attributes: [
          { fullName: 'Catalog.Items.Attribute.Beta', type: 'Attribute', name: 'Beta', rowKind: 'attribute', parentLabel: 'Items (Catalog)' },
          { fullName: 'Catalog.Items.Attribute.Alpha', type: 'Attribute', name: 'Alpha', rowKind: 'attribute', parentLabel: 'Items (Catalog)' },
        ],
      },
    });

    // Expand Catalog.Items
    const expanderTarget = new MockElement('span');
    expanderTarget.dataset.object = 'Catalog.Items';
    expanderTarget.textContent = '▶';
    elements.tableBody.dispatchEvent({ type: 'click', target: expanderTarget });

    const rowsAfterExpand = elements.tableBody.children.map((tr) => tr.children[0].title);
    const betaExpandCount = rowsAfterExpand.filter((f) => f === 'Catalog.Items.Attribute.Beta').length;
    // RED ASSERTION: in current unpatched code, beta is duplicated (betaExpandCount === 2)
    assert.strictEqual(betaExpandCount, 1, 'Beta attribute must not be duplicated when parent object is expanded');
    const expandUnique = new Set(rowsAfterExpand);
    assert.strictEqual(expandUnique.size, rowsAfterExpand.length, 'Every rendered row must have a unique fullName when expanded');

    // 4. Collapse Catalog.Items
    elements.tableBody.dispatchEvent({ type: 'click', target: expanderTarget });
    const rowsAfterCollapse = elements.tableBody.children.map((tr) => tr.children[0].title);
    const betaCollapseCount = rowsAfterCollapse.filter((f) => f === 'Catalog.Items.Attribute.Beta').length;
    assert.strictEqual(betaCollapseCount, 1, 'Beta attribute must remain visible and unique after collapse');
    const collapseUnique = new Set(rowsAfterCollapse);
    assert.strictEqual(collapseUnique.size, rowsAfterCollapse.length, 'Every rendered row must have a unique fullName after collapse');

    // 5. Search
    elements.searchInput.value = 'beta';
    elements.searchInput.dispatchEvent({ type: 'input', target: elements.searchInput });
    const rowsAfterSearch = elements.tableBody.children.map((tr) => tr.children[0].title);
    const betaSearchCount = rowsAfterSearch.filter((f) => f === 'Catalog.Items.Attribute.Beta').length;
    assert.strictEqual(betaSearchCount, 1, 'Beta attribute must remain unique during search');
    const searchUnique = new Set(rowsAfterSearch);
    assert.strictEqual(searchUnique.size, rowsAfterSearch.length, 'Every rendered row must have a unique fullName during search');

    const indexedObjects = [
      { fullName: '__proto__', type: 'Catalog', name: 'Proto', displayName: 'Proto indexed', rowKind: 'object', hasRights: false },
      { fullName: 'constructor', type: 'Catalog', name: 'Constructor', displayName: 'Constructor indexed', rowKind: 'object', hasRights: false },
      { fullName: 'toString', type: 'Catalog', name: 'ToString', displayName: 'ToString indexed', rowKind: 'object', hasRights: false },
      { fullName: 'hasOwnProperty', type: 'Catalog', name: 'HasOwnProperty', displayName: 'HasOwnProperty indexed', rowKind: 'object', hasRights: false },
      { fullName: 'Catalog.Neighbor', type: 'Catalog', name: 'Neighbor', displayName: 'Neighbor indexed', rowKind: 'object', hasRights: false },
    ];
    postMessage({
      command: 'objectsLoaded',
      data: { sessionId: 'session-1', dataRevision: 3, phase: 'typeIndex', objects: indexedObjects },
    });
    const indexedMergeRows = JSON.parse(JSON.stringify(inspectWebviewState().allObjects.map(
      (object: { fullName: string; displayName: string }) => ({ fullName: object.fullName, displayName: object.displayName }),
    ))) as Array<{ fullName: string; displayName: string }>;
    for (const fullName of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'Catalog.Neighbor']) {
      assert.strictEqual(indexedMergeRows.filter((row) => row.fullName === fullName).length, 1, `${fullName} must be added exactly once through index merge`);
    }
    assert.strictEqual(inspectWebviewState().prototypeState, true, 'prototype-looking fullNames must not write into global prototypes or inherited functions');

    postMessage({
      command: 'objectsLoaded',
      data: { sessionId: 'session-1', dataRevision: 4, phase: 'initial', objects: indexedObjects },
    });
    postMessage({
      command: 'objectsLoaded',
      data: {
        sessionId: 'session-1',
        dataRevision: 5,
        phase: 'typeIndex',
        objects: indexedObjects.map((object) => ({ ...object, displayName: `${object.displayName} merged`, hasRights: true })),
      },
    });
    const mergedRows = JSON.parse(JSON.stringify(inspectWebviewState().allObjects.map(
      (object: { fullName: string; displayName: string }) => ({ fullName: object.fullName, displayName: object.displayName }),
    ))) as Array<{ fullName: string; displayName: string }>;
    for (const fullName of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'Catalog.Neighbor']) {
      const matches = mergedRows.filter((row) => row.fullName === fullName);
      assert.strictEqual(matches.length, 1, `${fullName} must be kept exactly once through index merge`);
      assert.ok(matches[0].displayName.endsWith('merged'), `${fullName} must receive indexed display data`);
    }

    inspectWebviewState().resetFilters();
    elements.showAllToggle.checked = true;
    elements.showAllToggle.dispatchEvent({ type: 'change', target: elements.showAllToggle });
    for (const fullName of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const row = elements.tableBody.children.find((candidate) => candidate.children[0].title === fullName);
      assert.ok(row, `${fullName} must render after the index and initial snapshot merge`);
      const readCheckbox = row.children[1].children[0];
      readCheckbox.checked = true;
      readCheckbox.dispatchEvent({ type: 'change', target: readCheckbox });
    }
    const protoRights = inspectWebviewState().rights['__proto__'] as Record<string, unknown>;
    assert.strictEqual(inspectWebviewState().rightsPrototypeIsNull, true, 'the outer rights record must have a null prototype');
    assert.strictEqual(inspectWebviewState().protoRightsPrototypeIsNull, true, 'each nested rights record must have a null prototype');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(protoRights, 'Read'), true);
    assert.strictEqual(protoRights.Read, true, 'checkbox updates must target the own rights record');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(protoRights, '__proto__'), true, 'dependency writes must keep the own prototype-looking right key');
    assert.strictEqual(protoRights['__proto__'], true);

    elements.saveButton.dispatchEvent({ type: 'click', target: elements.saveButton });
    const saveMessage = postedMessages.filter((message) => message.command === 'save').pop();
    assert.ok(saveMessage, 'save must post the hydrated role record');
    const savedRights = saveMessage.data.roleData.rights as Record<string, Record<string, unknown>>;
    assert.strictEqual(Object.getPrototypeOf(savedRights), null, 'the outer rights record must have a null prototype');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(savedRights, '__proto__'), true);
    assert.strictEqual(Object.getPrototypeOf(savedRights['__proto__']), null);
    assert.strictEqual(savedRights['__proto__']['__proto__'], true);
    const wireRights = JSON.parse(JSON.stringify(savedRights)) as Record<string, Record<string, unknown>>;
    assert.strictEqual(wireRights['__proto__']['__proto__'], true, 'saved JSON must preserve own prototype-looking keys');
    assert.strictEqual(inspectWebviewState().prototypeState, true, 'merge, checkbox dependency writes, and save must leave realm prototypes unchanged');
  });

  test('provider serializes own prototype-looking role rights through JSON.parse hydration (#404)', async () => {
    const rolePath = path.join(tmpRoot, 'src', 'Roles', 'PrototypeRole.xml');
    const rightsPath = path.join(tmpRoot, 'src', 'Roles', 'PrototypeRole', 'Ext', 'Rights.xml');
    await fs.promises.mkdir(path.dirname(rightsPath), { recursive: true });
    await fs.promises.mkdir(path.dirname(rolePath), { recursive: true });
    await fs.promises.writeFile(
      rolePath,
      '<Role xmlns="http://v8.1c.ru/8.3/MDClasses"><Properties><Name>PrototypeRole</Name></Properties><Rights/></Role>',
      'utf8',
    );
    await fs.promises.writeFile(rightsPath, [
      '<Rights xmlns="http://v8.1c.ru/8.2/roles">',
      ...['__proto__', 'constructor', 'toString', 'Catalog.Neighbor'].map((name) =>
        `<object><name>${name}</name><right><name>Read</name><value>true</value></right></object>`),
      '</Rights>',
    ].join(''), 'utf8');

    const { panel } = createFakeWebviewPanel({ autoReplyFlushWith: '' });
    const restorePanel = patchCreateWebviewPanel(panel);
    const provider = new RolesRightsEditorProvider(createFakeExtensionContext());

    try {
      await provider.show(rolePath, tmpRoot);
      const html = panel.webview.html;
      const hydrations = [...html.matchAll(/roleData\s*=\s*[^;]+;/g)];
      const hydration = hydrations[hydrations.length - 1];
      assert.ok(hydration, 'actual provider HTML must contain its role data hydration assignment');
      const sandbox = { roleData: undefined as unknown };
      vm.runInNewContext(hydration[0], sandbox);
      const roleData = sandbox.roleData as { rights: Record<string, { read: boolean }> };
      const providerRealmObjectPrototype = vm.runInNewContext('Object.prototype', sandbox);
      for (const name of ['__proto__', 'constructor', 'toString', 'Catalog.Neighbor']) {
        assert.strictEqual(Object.prototype.hasOwnProperty.call(roleData.rights, name), true,
          `${name} must stay an own property across the real provider boundary`);
        assert.strictEqual(roleData.rights[name].read, true);
      }
      assert.strictEqual(Object.getPrototypeOf(roleData.rights), providerRealmObjectPrototype);
      assert.strictEqual((Object.prototype as Record<string, unknown>).polluted, undefined);
    } finally {
      restorePanel();
      provider.dispose();
    }
  });
});

