import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import { AtomicFileStorage } from '../../src/services/configurationSession/atomicFileStorage';
import {
  AgentStaticFormOperations,
  type FormEditFailureData,
  type FormEditResult,
  type FormInspectResult,
  type FormValidateResult,
} from '../../src/agent/agentStaticForms';

suite('Agent static form inspect and validate', () => {
  let root: string;

  setup(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-static-form-'));
  });

  teardown(async () => {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test('inspects a nested form as a stable relative JSON DTO with source revision', async () => {
    const formPath = 'Catalogs/Items/Forms/Item/Ext/Form.xml';
    const xml = validFormXml();
    await writeForm(formPath, xml);

    const result = await new AgentStaticFormOperations(root).inspect({ formPath });
    assert.strictEqual(result.success, true, result.error);
    const data = result.data as FormInspectResult;
    assert.strictEqual(data.formPath, formPath);
    assert.strictEqual(data.rev, crypto.createHash('sha256').update(Buffer.from(xml)).digest('hex'));
    assert.strictEqual(data.tree[0]?.tag, 'Form');
    assert.strictEqual(data.tree[0]?.children[0]?.tag, 'UsualGroup');
    assert.strictEqual(data.tree[0]?.children[0]?.children[0]?.name, 'NameField');
    assert.strictEqual(data.attributes[0]?.name, 'Object');
    assert.strictEqual(data.commands[0]?.name, 'Save');
    assert.ok(!JSON.stringify(data).includes(root), 'DTO must not contain the absolute workspace path');
  });

  test('validates nested identifiers, companions, bindings, command references, and event handlers', async () => {
    const formPath = 'CommonForms/Editor/Ext/Form.xml';
    await writeForm(formPath, invalidFormXml());
    await fs.promises.mkdir(path.join(root, 'CommonForms', 'Editor', 'Ext', 'Form'));
    await fs.promises.writeFile(
      path.join(root, 'CommonForms', 'Editor', 'Ext', 'Form', 'Module.bsl'),
      '// Процедура MissingFromComment(\n'
        + 'Сообщить("Процедура MissingFromString(");\n'
        + 'Процедура ExistingHandler(\n  Команда)\nКонецПроцедуры\n',
      'utf8',
    );

    const result = await new AgentStaticFormOperations(root).validate({
      formPath,
      formatVersion: '2.20',
    });
    assert.strictEqual(result.success, true, result.error);
    const data = result.data as FormValidateResult;
    assert.strictEqual(data.valid, false);
    const codes = data.issues.map((issue) => issue.code);
    assert.ok(codes.includes('FORM_DUPLICATE_ELEMENT_ID'));
    assert.ok(codes.includes('FORM_DUPLICATE_ELEMENT_NAME'));
    assert.ok(data.issues.some((issue) => issue.code === 'FORM_COMPANION_MISSING' && issue.severity === 'warning'));
    assert.ok(codes.includes('FORM_DATAPATH_ATTRIBUTE_NOT_FOUND'));
    assert.ok(codes.includes('FORM_COMMAND_REFERENCE_NOT_FOUND'));
    assert.ok(codes.includes('FORM_EVENT_HANDLER_NOT_FOUND'));
    assert.ok(!data.issues.some((issue) => issue.code === 'FORM_EVENT_HANDLER_NOT_FOUND' && issue.message.includes('ExistingHandler')));
    assert.ok(!codes.includes('FORM_COMMAND_ACTION_NOT_FOUND'));
    assert.ok(codes.includes('FORM_MULTIPLE_MAIN_ATTRIBUTES'));
    assert.ok(!codes.includes('MODULE_CHECK_SKIPPED'));
    assert.ok(data.issues.every((issue) => !path.isAbsolute(issue.path ?? '')));
  });

  test('reports an explicit module check skip when Module.bsl is absent', async () => {
    const formPath = 'Catalogs/Items/Forms/Item/Ext/Form.xml';
    await writeForm(formPath, validFormXml());
    const result = await new AgentStaticFormOperations(root).validate({ formPath });
    assert.strictEqual(result.success, true, result.error);
    const data = result.data as FormValidateResult;
    assert.ok(data.issues.some((issue) => issue.code === 'MODULE_CHECK_SKIPPED' && issue.severity === 'warning'));
  });

  test('checks the declared format version and the form version range', async () => {
    const formPath = 'Catalogs/Items/Forms/Item/Ext/Form.xml';
    await writeForm(formPath, validFormXml('2.19'));
    const result = await new AgentStaticFormOperations(root).validate({
      formPath,
      formatVersion: '2.20',
    });
    assert.strictEqual(result.success, true, result.error);
    const data = result.data as FormValidateResult;
    assert.ok(data.issues.some((issue) => issue.code === 'FORM_VERSION_MISMATCH'));
  });

  test('rejects nonnumeric form IDs and accepts numeric CFE extension IDs', async () => {
    const formPath = 'CommonForms/Editor/Ext/Form.xml';
    const invalidIdXml = validFormXml().replace('name="NameField" id="3"', 'name="NameField" id="field-three"');
    await writeForm(formPath, invalidIdXml);
    const invalidIdResult = await new AgentStaticFormOperations(root).validate({ formPath });
    assert.strictEqual(invalidIdResult.success, true, invalidIdResult.error);
    const invalidIdData = invalidIdResult.data as FormValidateResult;
    assert.ok(invalidIdData.issues.some((issue) => issue.code === 'FORM_ID_NOT_NUMERIC' && issue.path?.includes('NameField')));

    const cfeXml = validFormXml()
      .replace('Attribute name="Object" id="1"', 'Attribute name="Object" id="1000001"')
      .replace('Command name="Save" id="1"', 'Command name="Save" id="1000002"');
    await writeForm(formPath, cfeXml);
    const cfeResult = await new AgentStaticFormOperations(root).validate({ formPath });
    assert.strictEqual(cfeResult.success, true, cfeResult.error);
    const cfeData = cfeResult.data as FormValidateResult;
    assert.ok(!cfeData.issues.some((issue) => issue.code === 'FORM_ID_NOT_NUMERIC'));
    assert.strictEqual(cfeData.valid, true);
  });

  test('treats a missing AutoCommandBar as a warning', async () => {
    const formPath = 'Catalogs/Items/Forms/Item/Ext/Form.xml';
    await writeForm(formPath, validFormXml().replace(/<AutoCommandBar[\s\S]*?<\/AutoCommandBar>/, ''));
    const result = await new AgentStaticFormOperations(root).validate({ formPath });
    assert.strictEqual(result.success, true, result.error);
    const data = result.data as FormValidateResult;
    assert.strictEqual(data.valid, true);
    assert.ok(data.issues.some((issue) => issue.code === 'FORM_AUTOCOMMANDBAR_MISSING' && issue.severity === 'warning'));
  });

  test('dry-runs edits with a stable diff and leaves source bytes untouched', async () => {
    const formPath = 'CommonForms/Editor/Ext/Form.xml';
    const xml = editableFormXml();
    await writeForm(formPath, xml);
    const original = await fs.promises.readFile(path.join(root, ...formPath.split('/')));
    const result = await new AgentStaticFormOperations(root).edit({
      formPath,
      operations: [{ type: 'setElementIdentity', element: { id: '1', name: 'Submit' }, name: 'Confirm', id: '2' }],
      dryRun: true,
    });
    assert.strictEqual(result.success, true, result.error);
    const data = result.data as FormEditResult;
    assert.strictEqual(data.dryRun, true);
    assert.strictEqual(data.rev, crypto.createHash('sha256').update(original).digest('hex'));
    assert.deepStrictEqual(data.plannedChanges?.files, [formPath]);
    assert.match(data.plannedChanges?.summary ?? '', /1 операций/);
    assert.match(data.plannedChanges?.diff ?? '', /-    <Button name="Submit" id="1">/);
    assert.match(data.plannedChanges?.diff ?? '', /\+    <Button name="Confirm" id="2">/);
    assert.deepStrictEqual(await fs.promises.readFile(path.join(root, ...formPath.split('/'))), original);
  });

  test('commits only with matching ifRev and returns the new revision', async () => {
    const formPath = 'CommonForms/Editor/Ext/Form.xml';
    await writeForm(formPath, editableFormXml());
    const operations = [{ type: 'setElementIdentity', element: { id: '1', name: 'Submit' }, name: 'Confirm', id: '2' }] as const;
    const preview = await new AgentStaticFormOperations(root).edit({ formPath, operations: [...operations], dryRun: true });
    assert.strictEqual(preview.success, true, preview.error);
    const previousRev = (preview.data as FormEditResult).rev;
    const saved = await new AgentStaticFormOperations(root).edit({ formPath, operations: [...operations], ifRev: previousRev });
    assert.strictEqual(saved.success, true, saved.error);
    const data = saved.data as FormEditResult;
    const bytes = await fs.promises.readFile(path.join(root, ...formPath.split('/')));
    assert.strictEqual(data.dryRun, false);
    assert.strictEqual(data.previousRev, previousRev);
    assert.strictEqual(data.rev, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.match(bytes.toString('utf8'), /<Button name="Confirm" id="2">/);
  });

  test('refuses dry-run plans and commits for adopted CFE forms', async () => {
    const formPath = 'Catalogs/Items/Forms/Item/Ext/Form.xml';
    const xml = editableFormXml();
    await writeForm(formPath, xml);
    await fs.promises.writeFile(
      path.join(root, 'Catalogs', 'Items', 'Forms', 'Item.xml'),
      '<MetaDataObject version="2.20"><Form uuid="11111111-1111-4111-8111-111111111111"><Properties><ObjectBelonging>Adopted</ObjectBelonging><Name>Item</Name><ExtendedConfigurationObject>22222222-2222-4222-8222-222222222222</ExtendedConfigurationObject><FormType>Managed</FormType></Properties></Form></MetaDataObject>',
      'utf8',
    );
    const target = path.join(root, ...formPath.split('/'));
    const original = await fs.promises.readFile(target);
    const operations = [{ type: 'setElementIdentity', element: { id: '1', name: 'Submit' }, name: 'Confirm' }] as const;

    const dryRun = await new AgentStaticFormOperations(root).edit({ formPath, operations: [...operations], dryRun: true });
    assert.strictEqual(dryRun.success, false);
    assert.strictEqual(dryRun.code, 'CFE_ADOPTED_OPERATION_REQUIRED');
    assert.deepStrictEqual(await fs.promises.readFile(target), original);

    const commit = await new AgentStaticFormOperations(root).edit({
      formPath,
      operations: [...operations],
      ifRev: crypto.createHash('sha256').update(original).digest('hex'),
    });
    assert.strictEqual(commit.success, false);
    assert.strictEqual(commit.code, 'CFE_ADOPTED_OPERATION_REQUIRED');
    assert.deepStrictEqual(await fs.promises.readFile(target), original);
  });

  test('requires an ifRev for commit and rejects an already stale revision without writing', async () => {
    const formPath = 'CommonForms/Editor/Ext/Form.xml';
    await writeForm(formPath, editableFormXml());
    const target = path.join(root, ...formPath.split('/'));
    const original = await fs.promises.readFile(target);
    const operations = [{ type: 'setElementIdentity', element: { id: '1' }, name: 'Confirm' }] as const;
    const missingRevision = await new AgentStaticFormOperations(root).edit({ formPath, operations: [...operations] });
    assert.strictEqual(missingRevision.success, false);
    assert.strictEqual(missingRevision.code, 'FORM_REV_REQUIRED');
    assert.deepStrictEqual(await fs.promises.readFile(target), original);

    const staleRevision = 'a'.repeat(64);
    const stale = await new AgentStaticFormOperations(root).edit({ formPath, operations: [...operations], ifRev: staleRevision });
    assert.strictEqual(stale.success, false);
    assert.strictEqual(stale.code, 'CONCURRENT_MODIFICATION_ERROR');
    assert.strictEqual((stale.data as FormEditFailureData).currentRev, crypto.createHash('sha256').update(original).digest('hex'));
    assert.deepStrictEqual(await fs.promises.readFile(target), original);
  });

  test('uses AtomicFileStorage compare-and-swap when the file changes during commit', async () => {
    const formPath = 'CommonForms/Editor/Ext/Form.xml';
    await writeForm(formPath, editableFormXml());
    const target = path.join(root, ...formPath.split('/'));
    const oldBytes = await fs.promises.readFile(target);
    const ifRev = crypto.createHash('sha256').update(oldBytes).digest('hex');
    const racedBytes = Buffer.from(editableFormXml().replace('version="2.20"', 'version="2.21"'));
    class RacingStorage extends AtomicFileStorage {
      override async replace(targetPath: string, content: string | Uint8Array, expectedHash: string) {
        await fs.promises.writeFile(targetPath, racedBytes);
        return super.replace(targetPath, content, expectedHash);
      }
    }

    const result = await new AgentStaticFormOperations(root, new RacingStorage(root)).edit({
      formPath,
      operations: [{ type: 'setElementIdentity', element: { id: '1' }, name: 'Confirm' }],
      ifRev,
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.code, 'CONCURRENT_MODIFICATION_ERROR');
    assert.strictEqual((result.data as FormEditFailureData).currentRev, crypto.createHash('sha256').update(racedBytes).digest('hex'));
    assert.deepStrictEqual(await fs.promises.readFile(target), racedBytes);
  });

  test('rejects malformed XML and edits that introduce semantic errors without changing the file', async () => {
    const formPath = 'CommonForms/Editor/Ext/Form.xml';
    const target = path.join(root, ...formPath.split('/'));
    const malformed = '<Form><ChildItems></Form>';
    await writeForm(formPath, malformed);
    const malformedBytes = await fs.promises.readFile(target);
    const malformedResult = await new AgentStaticFormOperations(root).edit({
      formPath,
      operations: [{ type: 'setFormEvents', events: [{ name: 'OnOpen', method: 'Open' }] }],
      ifRev: crypto.createHash('sha256').update(malformedBytes).digest('hex'),
    });
    assert.strictEqual(malformedResult.success, false);
    assert.strictEqual(malformedResult.code, 'FORM_XML_INVALID');
    assert.deepStrictEqual(await fs.promises.readFile(target), malformedBytes);

    await writeForm(formPath, validFormXml());
    const validBytes = await fs.promises.readFile(target);
    const validationResult = await new AgentStaticFormOperations(root).edit({
      formPath,
      operations: [{ type: 'setAttribute', action: 'remove', selector: { name: 'Object' } }],
      ifRev: crypto.createHash('sha256').update(validBytes).digest('hex'),
    });
    assert.strictEqual(validationResult.success, false);
    assert.strictEqual(validationResult.code, 'FORM_VALIDATION_FAILED');
    assert.ok((validationResult.data as FormEditFailureData).issues?.some((issue) => issue.code === 'FORM_DATAPATH_ATTRIBUTE_NOT_FOUND'));
    assert.deepStrictEqual(await fs.promises.readFile(target), validBytes);
  });

  test('rejects traversal, absolute paths, and files outside Ext/Form.xml', async () => {
    const operations = new AgentStaticFormOperations(root);
    for (const formPath of [
      '../outside/Ext/Form.xml',
      path.join(root, 'Catalogs', 'Items', 'Forms', 'Item', 'Ext', 'Form.xml'),
      'Catalogs/Items/Object.xml',
    ]) {
      const result = await operations.inspect({ formPath });
      assert.strictEqual(result.success, false, `expected path rejection: ${formPath}`);
    }
  });

  test('rejects a symlinked form directory that escapes the configuration', async function () {
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-static-form-outside-'));
    try {
      const outsideForms = path.join(outside, 'Forms');
      await fs.promises.mkdir(path.join(outsideForms, 'Item', 'Ext'), { recursive: true });
      await fs.promises.writeFile(path.join(outsideForms, 'Item', 'Ext', 'Form.xml'), validFormXml(), 'utf8');
      await fs.promises.mkdir(path.join(root, 'Catalogs', 'Items'), { recursive: true });
      try {
        await fs.promises.symlink(outsideForms, path.join(root, 'Catalogs', 'Items', 'Forms'), 'junction');
      } catch {
        this.skip();
        return;
      }
      const result = await new AgentStaticFormOperations(root).inspect({
        formPath: 'Catalogs/Items/Forms/Item/Ext/Form.xml',
      });
      assert.strictEqual(result.success, false);
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test('rejects a symlinked sibling module that escapes the configuration', async function () {
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-static-module-outside-'));
    const formPath = 'Catalogs/Items/Forms/Item/Ext/Form.xml';
    try {
      await writeForm(formPath, validFormXml());
      await fs.promises.writeFile(path.join(outside, 'Module.bsl'), 'Процедура ExistingHandler()\nКонецПроцедуры\n', 'utf8');
      const moduleDirectory = path.join(root, 'Catalogs', 'Items', 'Forms', 'Item', 'Ext', 'Form');
      try {
        await fs.promises.symlink(outside, moduleDirectory, 'junction');
      } catch {
        this.skip();
        return;
      }
      const result = await new AgentStaticFormOperations(root).validate({ formPath });
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.code, 'FORM_PATH_OUTSIDE_CONFIGURATION');
      assert.ok(!result.error?.includes(root), 'failure must not disclose an absolute path');
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test('returns a typed validation failure for malformed XML', async () => {
    await writeForm('Catalogs/Items/Forms/Item/Ext/Form.xml', '<Form version="2.20"><Attributes></Form>');
    const result = await new AgentStaticFormOperations(root).validate({
      formPath: 'Catalogs/Items/Forms/Item/Ext/Form.xml',
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.code, 'FORM_XML_INVALID');
  });

  async function writeForm(formPath: string, xml: string): Promise<void> {
    const absolute = path.join(root, ...formPath.split('/'));
    await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
    await fs.promises.writeFile(absolute, xml, 'utf8');
  }
});

function validFormXml(version = '2.20'): string {
  return `<Form version="${version}">
  <Title>Editor</Title>
  <Attributes><Attribute name="Object" id="1"><MainAttribute>true</MainAttribute></Attribute></Attributes>
  <Commands><Command name="Save" id="1"><Action>OnSave</Action></Command></Commands>
  <Events><Event name="OnOpen">ExistingHandler</Event></Events>
  <AutoCommandBar name="FormCommandBar" id="-1"><ChildItems><Button name="SaveButton" id="10"><CommandName>Form.Command.Save</CommandName><ExtendedTooltip /></Button></ChildItems></AutoCommandBar>
  <ChildItems><UsualGroup name="MainGroup" id="2"><ExtendedTooltip /><ChildItems><InputField name="NameField" id="3"><DataPath>Object.Name</DataPath><ContextMenu /><ExtendedTooltip /></InputField></ChildItems></UsualGroup></ChildItems>
</Form>`;
}

function editableFormXml(): string {
  return `<Form version="2.20">
  <Attributes />
  <Commands />
  <AutoCommandBar name="FormCommandBar" id="-1"><ChildItems /></AutoCommandBar>
  <ChildItems>
    <Button name="Submit" id="1">
      <ExtendedTooltip />
    </Button>
  </ChildItems>
</Form>
`;
}

function invalidFormXml(): string {
  return `<Form version="2.20">
  <Attributes><Attribute name="Object" id="1"><MainAttribute>true</MainAttribute></Attribute><Attribute name="Other" id="2"><MainAttribute>true</MainAttribute></Attribute></Attributes>
  <Commands><Command name="Save" id="1"><Action>ExistingHandler</Action></Command></Commands>
  <Events><Event name="OnOpen">MissingHandler</Event><Event name="OnClose">ExistingHandler</Event></Events>
  <AutoCommandBar id="-1" />
  <ChildItems><UsualGroup name="Panel" id="7"><ExtendedTooltip /><ChildItems><InputField name="Field" id="8"><DataPath>Missing.Name</DataPath><ContextMenu /><ExtendedTooltip /></InputField><InputField name="Field" id="8"><DataPath>Object.Name</DataPath></InputField><Button name="BrokenButton" id="9"><CommandName>Form.Command.Missing</CommandName><ExtendedTooltip /></Button></ChildItems></UsualGroup></ChildItems>
</Form>`;
}
