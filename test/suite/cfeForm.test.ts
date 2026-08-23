import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import { CfeProjectService } from '../../src/extensionSupport/cfeProject/createProject';
import { CfeFormService } from '../../src/extensionSupport/cfeProject/formService';
import { CfeFormError } from '../../src/extensionSupport/cfeProject/formTypes';
import { parseCfeFormXml, sanitizeBorrowedBasePart, serializeCfeFormXml } from '../../src/extensionSupport/cfeProject/formXml';
import { hashContent } from '../../src/services/configurationSession/atomicFileStorage';
import type { ExclusiveConfigurationOperation } from '../../src/services/configurationSession/ConfigurationSession';
import type { MutationPlan } from '../../src/services/configurationSession/mutationPlan';
import { WorkspaceRegistry } from '../../src/services/configurationSession/WorkspaceRegistry';

interface Harness {
  readonly workspace: string;
  readonly base: string;
  readonly extension: string;
  readonly registry: WorkspaceRegistry;
  readonly projectService: CfeProjectService;
  readonly formService: CfeFormService;
  readonly extensionConfigurationId: string;
  readonly ownerSourceUuid: string;
  readonly sourceFormUuid: string;
}

const UUIDS = {
  catalog: '22222222-2222-4222-8222-222222222222',
  document: '33333333-3333-4333-8333-333333333333',
  catalogForm: '44444444-4444-4444-8444-444444444444',
  documentForm: '55555555-5555-4555-8555-555555555555',
} as const;

suite('CFE form domain', () => {
  test('creates an own form on a borrowed Catalog and preserves module content on idempotency', async () => {
    await withHarness('2.20', async (harness) => {
      const created = await harness.formService.createOwnForm({
        extensionConfigurationId: harness.extensionConfigurationId,
        ownerDotPath: 'Catalog.Products',
        formName: 'Ext_Custom',
      });
      assert.strictEqual(created.status, 'created');
      const [metadata, form] = await Promise.all([
        fs.promises.readFile(path.join(harness.extension, created.metadataPath), 'utf8'),
        fs.promises.readFile(path.join(harness.extension, created.formPath), 'utf8'),
      ]);
      assert.doesNotMatch(metadata, /ObjectBelonging/);
      assert.doesNotMatch(metadata, /ExtendedConfigurationObject/);
      assert.match(metadata, /<FormType>Managed<\/FormType>/);
      assert.match(form, /<AutoCommandBar name="ФормаКоманднаяПанель" id="-1">/);
      assert.match(form, /<Attributes\/>/);
      assert.doesNotMatch(form, /BaseForm/);
      const modulePath = path.join(harness.extension, created.modulePath);
      await fs.promises.writeFile(modulePath, '\uFEFF// user code', 'utf8');

      const repeated = await harness.formService.createOwnForm({
        extensionConfigurationId: harness.extensionConfigurationId,
        ownerDotPath: 'Catalog.Products',
        formName: 'Ext_Custom',
      });
      assert.strictEqual(repeated.status, 'already-created');
      assert.strictEqual(await fs.promises.readFile(modulePath, 'utf8'), '\uFEFF// user code');
      const owner = await fs.promises.readFile(path.join(harness.extension, 'Catalogs', 'Products.xml'), 'utf8');
      assert.strictEqual((owner.match(/<Form>\s*Ext_Custom\s*<\/Form>/g) ?? []).length, 1);
    });
  });

  test('borrows managed Catalog and Document forms across 2.17–2.21 with ordered Part1/BaseForm', async function () {
    this.timeout(30_000);
    for (const format of ['2.17', '2.18', '2.19', '2.20', '2.21'] as const) {
      await withHarness(format, async (harness) => {
        const borrowed = await harness.formService.borrowForm({
          extensionConfigurationId: harness.extensionConfigurationId,
          ownerSourceUuid: harness.ownerSourceUuid,
          sourceFormUuid: harness.sourceFormUuid,
        });
        assert.strictEqual(borrowed.status, 'borrowed');
        const [metadata, form] = await Promise.all([
          fs.promises.readFile(path.join(harness.extension, borrowed.metadataPath), 'utf8'),
          fs.promises.readFile(path.join(harness.extension, borrowed.formPath), 'utf8'),
        ]);
        assert.match(metadata, new RegExp(`<MetaDataObject[^>]*version="${format.replace('.', '\\.')}"`));
        assert.match(metadata, new RegExp(`<ExtendedConfigurationObject>${harness.sourceFormUuid}<\\/ExtendedConfigurationObject>`));
        if (format === '2.17' || format === '2.18') {
          assert.doesNotMatch(metadata, /<xr:PropertyState>/);
        } else {
          assert.match(metadata, /<xr:PropertyState>[\s\S]*?<xr:Property>Form<\/xr:Property>[\s\S]*?<xr:State>Extended<\/xr:State>/);
        }
        assert.match(form, new RegExp(`<Form[^>]*version="${format.replace('.', '\\.')}"`));
        assert.strictEqual(form.indexOf('<BaseForm '), form.lastIndexOf('<BaseForm '));
        assert.ok(form.indexOf('<BaseForm ') > form.indexOf('<Attributes'));
        assert.ok(form.indexOf('</BaseForm>') < form.indexOf('</Form>'));
        const base = form.slice(form.indexOf('<BaseForm '), form.indexOf('</BaseForm>') + '</BaseForm>'.length);
        assert.doesNotMatch(base, /<(?:Events|Commands|Parameters|CommandInterface)\b/);
        assert.match(form, /<AutoCommandBar name="ФормаКоманднаяПанель" id="-1">[\s\S]*?<Autofill>false<\/Autofill>[\s\S]*?<\/AutoCommandBar>/);
        const autoCommandBar = form.slice(form.indexOf('<AutoCommandBar '), form.indexOf('</AutoCommandBar>') + '</AutoCommandBar>'.length);
        assert.doesNotMatch(autoCommandBar, /<ChildItems>/);
        assert.doesNotMatch(form, /Object\.Description/);
        assert.doesNotMatch(form, /Items\.Table/);
        assert.doesNotMatch(form, /BaseHandler/);
        if (format === '2.21') {
          assert.match(form, /xmlns:pal="http:\/\/v8\.1c\.ru\/8\.1\/data\/ui\/colors\/palette"/);
        } else {
          assert.doesNotMatch(form, /xmlns:pal=/);
        }

        const modulePath = path.join(harness.extension, borrowed.modulePath);
        await fs.promises.writeFile(modulePath, '\uFEFF// preserve me', 'utf8');
        const repeated = await harness.formService.borrowForm({
          extensionConfigurationId: harness.extensionConfigurationId,
          ownerSourceUuid: harness.ownerSourceUuid,
          sourceFormUuid: harness.sourceFormUuid,
        });
        assert.strictEqual(repeated.status, 'already-borrowed');
        assert.strictEqual(await fs.promises.readFile(modulePath, 'utf8'), '\uFEFF// preserve me');

        await harness.projectService.borrowObject({
          extensionConfigurationId: harness.extensionConfigurationId,
          sourceDotPath: 'Document.Order',
        });
        const documentForm = await harness.formService.borrowForm({
          extensionConfigurationId: harness.extensionConfigurationId,
          ownerSourceUuid: UUIDS.document,
          sourceFormUuid: UUIDS.documentForm,
        });
        assert.deepStrictEqual(
          { status: documentForm.status, ownerType: documentForm.ownerType, sourceFormUuid: documentForm.sourceFormUuid },
          { status: 'borrowed', ownerType: 'Document', sourceFormUuid: UUIDS.documentForm },
        );
        const documentXml = await fs.promises.readFile(path.join(harness.extension, documentForm.formPath), 'utf8');
        assert.ok(documentXml.indexOf('<BaseForm ') > documentXml.indexOf('<Attributes'));
        assert.ok(documentXml.lastIndexOf('<BaseForm ') < documentXml.lastIndexOf('</Form>'));
      });
    }
  });

  test('extends an adopted form only additively, preserves multiple Action and allocates extension IDs', async function () {
    this.timeout(30_000);
    await withHarness('2.20', async (harness) => {
      const borrowed = await borrowCatalogForm(harness);
      const sourcePath = path.join(harness.base, 'Catalogs', 'Products', 'Forms', 'List', 'Ext', 'Form.xml');
      const expectedFormHash = hashContent(await fs.promises.readFile(sourcePath, 'utf8'));
      const request = {
        extensionConfigurationId: harness.extensionConfigurationId,
        sourceFormUuid: harness.sourceFormUuid,
        expectedFormHash,
        operations: [
          { kind: 'addAttribute' as const, name: 'Ext_Text', type: { typeName: 'xs:string' }, title: 'Текст' },
          { kind: 'addCommand' as const, name: 'Ext_Command', title: 'Команда', actions: [
            { handler: 'Ext_Before', callType: 'Before' as const },
            { handler: 'Ext_After', callType: 'After' as const },
          ] },
          { kind: 'addElement' as const, elementType: 'UsualGroup' as const, name: 'Ext_Group', title: 'Группа' },
          { kind: 'addElement' as const, elementType: 'InputField' as const, name: 'Ext_Field', parentName: 'Ext_Group', attributeName: 'Ext_Text' },
          { kind: 'addElement' as const, elementType: 'Button' as const, name: 'Ext_Button', parentName: 'Ext_Group', commandName: 'Ext_Command' },
          { kind: 'setFormEvent' as const, eventName: 'OnOpen', handler: 'Ext_OnOpen', callType: 'After' as const },
          { kind: 'setElementEvent' as const, elementName: 'BaseField', eventName: 'OnChange', handler: 'Ext_BaseChanged', callType: 'Before' as const },
          { kind: 'addCommandAction' as const, commandName: 'BaseCommand', handler: 'Ext_BaseBefore', callType: 'Before' as const },
          { kind: 'addCommandAction' as const, commandName: 'BaseCommand', handler: 'Ext_BaseAfter', callType: 'After' as const },
        ],
      };
      const extended = await harness.formService.extendForm(request);
      assert.strictEqual(extended.status, 'extended');
      const form = await fs.promises.readFile(path.join(harness.extension, borrowed.formPath), 'utf8');
      assert.match(form, /<Attribute name="Ext_Text" id="1000000">/);
      assert.match(form, /<Command name="Ext_Command" id="1000001">[\s\S]*?<Action callType="Before">Ext_Before<\/Action>[\s\S]*?<Action callType="After">Ext_After<\/Action>/);
      assert.match(form, /<UsualGroup name="Ext_Group" id="1000002">/);
      assert.match(form, /<InputField name="Ext_Field" id="1000003">[\s\S]*?<DataPath>Ext_Text<\/DataPath>/);
      assert.match(form, /<Button name="Ext_Button" id="1000004">[\s\S]*?<CommandName>Form\.Command\.Ext_Command<\/CommandName>/);
      assert.match(form, /<Event name="OnOpen" callType="After">Ext_OnOpen<\/Event>/);
      assert.match(form, /<Event name="OnChange" callType="Before">Ext_BaseChanged<\/Event>/);
      assert.match(form, /<Command name="BaseCommand" id="1000005">[\s\S]*?<Action callType="Before">Ext_BaseBefore<\/Action>[\s\S]*?<Action callType="After">Ext_BaseAfter<\/Action>/);
      const base = form.slice(form.indexOf('<BaseForm '), form.indexOf('</BaseForm>') + '</BaseForm>'.length);
      assert.doesNotMatch(base, /Ext_(?:Text|Command|Group|Field|Button|OnOpen|BaseChanged|BaseBefore|BaseAfter)/);
      assert.ok(form.lastIndexOf('<BaseForm ') < form.lastIndexOf('</Form>'));
      assert.strictEqual((await harness.formService.extendForm(request)).status, 'unchanged');
    });
  });

  test('fails before writing when dependency closure is unsupported or an additive operation conflicts', async function () {
    this.timeout(30_000);
    await withHarness('2.20', async (harness) => {
      const sourcePath = path.join(harness.base, 'Catalogs', 'Products', 'Forms', 'List', 'Ext', 'Form.xml');
      const source = await fs.promises.readFile(sourcePath, 'utf8');
      await fs.promises.writeFile(sourcePath, source.replace('</Form>', '<Picture><xr:Ref>CommonPicture.Missing</xr:Ref></Picture></Form>'), 'utf8');
      await assert.rejects(
        () => harness.formService.borrowForm({
          extensionConfigurationId: harness.extensionConfigurationId,
          ownerSourceUuid: harness.ownerSourceUuid,
          sourceFormUuid: harness.sourceFormUuid,
        }),
        (error: CfeFormError) => error.code === 'CFE_DEPENDENCY_UNSUPPORTED',
      );
      assert.strictEqual(await exists(path.join(harness.extension, 'Catalogs', 'Products', 'Forms', 'List.xml')), false);

      await fs.promises.writeFile(sourcePath, source.replace('</Form>', '<Type><v8:Type>cfg:InformationRegisterRef.Stock</v8:Type></Type></Form>'), 'utf8');
      await assert.rejects(
        () => harness.formService.borrowForm({
          extensionConfigurationId: harness.extensionConfigurationId,
          ownerSourceUuid: harness.ownerSourceUuid,
          sourceFormUuid: harness.sourceFormUuid,
        }),
        (error: CfeFormError) => error.code === 'CFE_DEPENDENCY_UNSUPPORTED',
      );
      assert.strictEqual(await exists(path.join(harness.extension, 'Catalogs', 'Products', 'Forms', 'List.xml')), false);

      await fs.promises.writeFile(sourcePath, source, 'utf8');
      const borrowed = await borrowCatalogForm(harness);
      const expectedFormHash = hashContent(source);
      await harness.formService.extendForm({
        extensionConfigurationId: harness.extensionConfigurationId,
        sourceFormUuid: harness.sourceFormUuid,
        expectedFormHash,
        operations: [{ kind: 'addAttribute', name: 'Ext_Text', type: { typeName: 'xs:string' } }],
      });
      const before = await fs.promises.readFile(path.join(harness.extension, borrowed.formPath), 'utf8');
      await assert.rejects(
        () => harness.formService.extendForm({
          extensionConfigurationId: harness.extensionConfigurationId,
          sourceFormUuid: harness.sourceFormUuid,
          expectedFormHash,
          operations: [{ kind: 'addAttribute', name: 'Ext_Text', type: { typeName: 'xs:boolean' } }],
        }),
        (error: CfeFormError) => error.code === 'CFE_VALIDATION_FAILED',
      );
      assert.strictEqual(await fs.promises.readFile(path.join(harness.extension, borrowed.formPath), 'utf8'), before);
    });
  });

  test('detects source drift and rolls back when Form.xml CAS fails', async function () {
    this.timeout(30_000);
    await withHarness('2.20', async (harness) => {
      const borrowed = await borrowCatalogForm(harness);
      const sourcePath = path.join(harness.base, 'Catalogs', 'Products', 'Forms', 'List', 'Ext', 'Form.xml');
      const expectedFormHash = hashContent(await fs.promises.readFile(sourcePath, 'utf8'));
      const session = harness.registry.require(harness.extensionConfigurationId);
      const originalRunExclusive = session.runExclusive.bind(session);
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      session.runExclusive = async <T>(operation: ExclusiveConfigurationOperation<T>) => {
        entered();
        return originalRunExclusive({ ...operation, execute: async () => { await gate; return operation.execute(); } });
      };
      try {
        const extending = harness.formService.extendForm({
          extensionConfigurationId: harness.extensionConfigurationId,
          sourceFormUuid: harness.sourceFormUuid,
          expectedFormHash,
          operations: [{ kind: 'addAttribute', name: 'Ext_Later', type: { typeName: 'xs:string' } }],
        });
        await enteredPromise;
        await fs.promises.writeFile(sourcePath, `${await fs.promises.readFile(sourcePath, 'utf8')}<!-- source changed -->`, 'utf8');
        release();
        await assert.rejects(() => extending, (error: CfeFormError) => error.code === 'CFE_SOURCE_CHANGED');
      } finally {
        session.runExclusive = originalRunExclusive;
      }

      const beforeCas = await fs.promises.readFile(path.join(harness.extension, borrowed.formPath), 'utf8');
      const changedSource = await fs.promises.readFile(sourcePath, 'utf8');
      const newExpectedHash = hashContent(changedSource);
      const originalExecute = session.mutations.execute.bind(session.mutations);
      session.mutations.execute = async <T>(plan: MutationPlan<T>, operationId?: string): Promise<T> => {
        const formPath = path.join(harness.extension, borrowed.formPath);
        await fs.promises.writeFile(formPath, `${await fs.promises.readFile(formPath, 'utf8')}<!-- external edit -->`, 'utf8');
        return originalExecute(plan, operationId);
      };
      try {
        await assert.rejects(
          () => harness.formService.extendForm({
            extensionConfigurationId: harness.extensionConfigurationId,
            sourceFormUuid: harness.sourceFormUuid,
            expectedFormHash: newExpectedHash,
            operations: [{ kind: 'addAttribute', name: 'Ext_Cas', type: { typeName: 'xs:string' } }],
          }),
          (error: CfeFormError) => error.code === 'CFE_VALIDATION_FAILED',
        );
        const afterCas = await fs.promises.readFile(path.join(harness.extension, borrowed.formPath), 'utf8');
        assert.ok(afterCas.includes('<!-- external edit -->'));
        assert.ok(!afterCas.includes('Ext_Cas'));
        assert.notStrictEqual(afterCas, beforeCas);
      } finally {
        session.mutations.execute = originalExecute;
      }
    });
  });

  test('retains only a proven main-attribute root DataPath while stripping Items and element events', () => {
    const document = parseCfeFormXml(`<?xml version="1.0"?><Form version="2.20"><ChildItems><InputField name="Root" id="1"><DataPath>Object.Description</DataPath><Events><Event name="OnChange">X</Event></Events></InputField><InputField name="Deep" id="2"><DataPath>Items.Rows.Value</DataPath><TypeLink><xr:DataPath>Items.Rows</xr:DataPath></TypeLink></InputField></ChildItems></Form>`);
    sanitizeBorrowedBasePart(document.root, new Set(['Object']));
    const xml = serializeCfeFormXml(document);
    assert.match(xml, /<DataPath>Object\.Description<\/DataPath>/);
    assert.doesNotMatch(xml, /Items\.Rows/);
    assert.doesNotMatch(xml, /<Events>/);
  });

  test('fails closed when a CFE Forms path crosses a symbolic link', async function () {
    const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cfe-form-link-'));
    try {
      await withHarness('2.20', async (harness) => {
        const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cfe-form-outside-'));
        const forms = path.join(harness.extension, 'Catalogs', 'Products', 'Forms');
        try {
          await fs.promises.symlink(outside, forms, process.platform === 'win32' ? 'junction' : 'dir');
        } catch {
          await fs.promises.rm(outside, { recursive: true, force: true });
          this.skip();
          return;
        }
        try {
          await assert.rejects(
            () => harness.formService.createOwnForm({
              extensionConfigurationId: harness.extensionConfigurationId,
              ownerDotPath: 'Catalog.Products',
              formName: 'Ext_Linked',
            }),
            (error: CfeFormError) => error.code === 'CFE_OWNERSHIP_INVALID' || error.code === 'CFE_VALIDATION_FAILED',
          );
          assert.strictEqual(await exists(path.join(outside, 'Ext_Linked.xml')), false);
        } finally {
          await fs.promises.rm(forms, { recursive: true, force: true }).catch(() => undefined);
          await fs.promises.rm(outside, { recursive: true, force: true }).catch(() => undefined);
        }
      });
    } finally {
      await fs.promises.rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

async function borrowCatalogForm(harness: Harness) {
  return harness.formService.borrowForm({
    extensionConfigurationId: harness.extensionConfigurationId,
    ownerSourceUuid: harness.ownerSourceUuid,
    sourceFormUuid: harness.sourceFormUuid,
  });
}

async function withHarness(format: string, callback: (harness: Harness) => Promise<void>): Promise<void> {
  const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cfe-form-'));
  const base = path.join(workspace, 'base');
  const extension = path.join(base, 'ConfigurationExtensions', 'FormExtension');
  const registry = new WorkspaceRegistry();
  try {
    await writeBase(base, format);
    await registry.refresh([{ configPath: base, workspaceFolderPath: workspace }]);
    const projectService = new CfeProjectService(workspace, registry, {
      refreshWorkspace: async () => registry.refresh([
        { configPath: base, workspaceFolderPath: workspace },
        { configPath: extension, workspaceFolderPath: workspace },
      ]),
    });
    const baseConfigurationId = registry.list()[0]!.configurationId;
    await projectService.createProject({
      baseConfigurationId, extensionName: 'FormExtension', purpose: 'Customization', namePrefix: 'Ext_', compatibilityMode: 'Version8_3_24',
    });
    const extensionRoot = await fs.promises.realpath(extension);
    const extensionConfigurationId = registry.list().find((item) => item.rootPath === extensionRoot)!.configurationId;
    await projectService.borrowObject({ extensionConfigurationId, sourceDotPath: 'Catalog.Products' });
    await callback({
      workspace, base, extension: extensionRoot, registry, projectService,
      formService: new CfeFormService(projectService.projects), extensionConfigurationId,
      ownerSourceUuid: UUIDS.catalog, sourceFormUuid: UUIDS.catalogForm,
    });
  } finally {
    await registry.dispose();
    await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
  }
}

async function writeBase(base: string, format: string): Promise<void> {
  await Promise.all([
    fs.promises.mkdir(path.join(base, 'Languages'), { recursive: true }),
    fs.promises.mkdir(path.join(base, 'Catalogs', 'Products', 'Forms', 'List', 'Ext'), { recursive: true }),
    fs.promises.mkdir(path.join(base, 'Documents', 'Order', 'Forms', 'List', 'Ext'), { recursive: true }),
  ]);
  await fs.promises.writeFile(
    path.join(base, 'Configuration.xml'),
    `<?xml version="1.0"?><MetaDataObject version="${format}"><Configuration uuid="11111111-1111-4111-8111-111111111111"><Properties><DefaultLanguage>Language.Russian</DefaultLanguage><ScriptVariant>Russian</ScriptVariant><InterfaceCompatibilityMode>TaxiEnableVersion8_2</InterfaceCompatibilityMode></Properties><ChildObjects><Language>Russian</Language><Catalog>Products</Catalog><Document>Order</Document></ChildObjects></Configuration></MetaDataObject>`,
    'utf8',
  );
  await fs.promises.writeFile(path.join(base, 'Languages', 'Russian.xml'), `<?xml version="1.0"?><MetaDataObject version="${format}"><Language uuid="12121212-1212-4121-8121-121212121212"><Properties><Name>Russian</Name><LanguageCode>ru</LanguageCode></Properties></Language></MetaDataObject>`, 'utf8');
  await fs.promises.writeFile(path.join(base, 'Catalogs', 'Products.xml'), rootObjectXml('Catalog', 'Products', UUIDS.catalog, format), 'utf8');
  await fs.promises.writeFile(path.join(base, 'Documents', 'Order.xml'), rootObjectXml('Document', 'Order', UUIDS.document, format), 'utf8');
  await fs.promises.writeFile(path.join(base, 'Catalogs', 'Products', 'Forms', 'List.xml'), formMetadataXml('List', UUIDS.catalogForm, format), 'utf8');
  await fs.promises.writeFile(path.join(base, 'Documents', 'Order', 'Forms', 'List.xml'), formMetadataXml('List', UUIDS.documentForm, format), 'utf8');
  const fixture = await fs.promises.readFile(path.join(__dirname, '..', 'fixtures', 'cfe-forms', `source-${format}.xml`), 'utf8');
  await fs.promises.writeFile(path.join(base, 'Catalogs', 'Products', 'Forms', 'List', 'Ext', 'Form.xml'), fixture, 'utf8');
  await fs.promises.writeFile(path.join(base, 'Documents', 'Order', 'Forms', 'List', 'Ext', 'Form.xml'), fixture.replace(/CatalogObject\.Products/g, 'DocumentObject.Order'), 'utf8');
}

function rootObjectXml(type: string, name: string, uuid: string, format: string): string {
  return `<?xml version="1.0"?><MetaDataObject version="${format}"><${type} uuid="${uuid}"><Properties><Name>${name}</Name><Comment/></Properties><ChildObjects/></${type}></MetaDataObject>`;
}

function formMetadataXml(name: string, uuid: string, format: string): string {
  return `<?xml version="1.0"?><MetaDataObject version="${format}"><Form uuid="${uuid}"><InternalInfo/><Properties><Name>${name}</Name><Comment/><FormType>Managed</FormType></Properties></Form></MetaDataObject>`;
}

async function exists(target: string): Promise<boolean> {
  try { await fs.promises.access(target); return true; } catch { return false; }
}
