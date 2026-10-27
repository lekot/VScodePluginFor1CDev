import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { XMLValidator } from 'fast-xml-parser';
import '../helpers/vscodeStubRegister';
import { elementChildren, parseXmlDocument, textContent, type XmlElement } from '../../src/compareMerge/xml/xmlDom';
import {
  buildCanonicalInterceptorBlock,
  findBslMethod,
  scanBslMethods,
} from '../../src/extensionSupport/cfeProject/bslInterceptorScanner';
import { CfeInterceptorService } from '../../src/extensionSupport/cfeProject/interceptorService';
import { CfeInterceptorError } from '../../src/extensionSupport/cfeProject/interceptorTypes';
import { CfeProjectService } from '../../src/extensionSupport/cfeProject/createProject';
import { CfeProjectRegistry } from '../../src/extensionSupport/cfeProject/registry';
import { CfeProjectError } from '../../src/extensionSupport/cfeProject/types';
import type { MutationPlan } from '../../src/services/configurationSession/mutationPlan';
import { WorkspaceRegistry } from '../../src/services/configurationSession/WorkspaceRegistry';
import {
  buildInternalInfoXml,
  getExplicitGeneratedTypeSpecs,
  ROOT_TAGS_WITHOUT_INTERNALINFO,
} from '../../src/utils/xml/internalInfoGenerator';

const UUIDS = {
  catalog: '22222222-2222-4222-8222-222222222222',
  commonModule: '33333333-3333-4333-8333-333333333333',
} as const;

interface InterceptorHarness {
  readonly workspace: string;
  readonly base: string;
  readonly extension: string;
  readonly registry: WorkspaceRegistry;
  readonly interceptor: CfeInterceptorService;
  readonly extensionConfigurationId: string;
}

suite('CFE structural interceptors', () => {
  test('structurally scans comments, strings, async multiline signatures, region and preprocessor placement', async () => {
    const source = await readFixture('complex-module.bsl');
    const methods = scanBslMethods(source);
    assert.deepStrictEqual(methods.map((method) => method.name), ['ПриЗаписи', 'Рассчитать']);
    const write = methods[0]!;
    assert.strictEqual(write.isAsync, true);
    assert.strictEqual(write.kind, 'procedure');
    assert.deepStrictEqual(write.parameterNames, ['Отказ', 'Параметр']);
    assert.strictEqual(write.contextDirective, '&НаСервере');
    assert.deepStrictEqual(write.wrappers, [
      { kind: 'region', name: 'СерверныеМетоды' },
      { kind: 'preprocessor', condition: 'Сервер И НЕ ВнешнееСоединение' },
    ]);
    assert.match(write.sourceHash, /^[a-f0-9]{64}$/u);
    const generated = buildCanonicalInterceptorBlock(write, 'instead', 'Ext_ПриЗаписи');
    assert.match(generated, /^&НаСервере\r\n&Вместо\("ПриЗаписи"\)\r\nАсинх Процедура Ext_ПриЗаписи\(/u);
    assert.match(generated, /ПродолжитьВызов\(Отказ, Параметр\);/u);
  });

  test('uses oracle-canonical initial changeAndValidate body without synthetic diff markers', () => {
    const source = [
      'Функция Пустая()',
      'КонецФункции',
      '',
      'Функция СТелом(Знач Значение)',
      '\tВозврат Значение;',
      'КонецФункции',
    ].join('\n');
    const empty = findBslMethod(source, 'Пустая')!;
    const withBody = findBslMethod(source, 'СТелом')!;
    assert.strictEqual(
      buildCanonicalInterceptorBlock(empty, 'changeAndValidate', 'Ext_Пустая'),
      '&ИзменениеИКонтроль("Пустая")\r\nФункция Ext_Пустая()\r\nКонецФункции',
    );
    const generated = buildCanonicalInterceptorBlock(withBody, 'changeAndValidate', 'Ext_СТелом');
    assert.match(generated, /\tВозврат Значение;\r\nКонецФункции$/u);
    assert.doesNotMatch(generated, /#(?:Вставка|Удаление)/u);
  });

  test('creates canonical interceptors and PropertyState across XML formats 2.17–2.21', async function () {
    this.timeout(15_000);
    for (const format of ['2.17', '2.18', '2.19', '2.20', '2.21']) {
      await withHarness(format, async (harness) => {
        const outcome = await harness.interceptor.createInterceptor({
          extensionConfigurationId: harness.extensionConfigurationId,
          targetSourceUuid: UUIDS.catalog,
          moduleKind: 'ObjectModule',
          methodName: 'ПриЗаписи',
          kind: 'before',
        });
        assert.strictEqual(outcome.status, 'created');
        assert.strictEqual(outcome.targetType, 'Catalog');
        assert.strictEqual(outcome.targetName, 'Products');
        assert.strictEqual(outcome.modulePath, 'Catalogs/Products/Ext/ObjectModule.bsl');
        const modulePath = path.join(harness.extension, outcome.modulePath);
        const module = await fs.promises.readFile(modulePath, 'utf8');
        assert.match(module, /#Область СерверныеМетоды\r\n\r\n#Если Сервер И НЕ ВнешнееСоединение Тогда/u);
        assert.match(module, /&НаСервере\r\n&Перед\("ПриЗаписи"\)\r\nАсинх Процедура Ext_ПриЗаписи\(/u);
        assert.match(module, /TODO: код перед вызовом оригинального метода/u);
        const objectXml = await fs.promises.readFile(path.join(harness.extension, 'Catalogs', 'Products.xml'), 'utf8');
        if (format === '2.17' || format === '2.18') {
          assert.doesNotMatch(objectXml, /<xr:Property>ObjectModule<\/xr:Property>/u);
          assert.strictEqual(outcome.propertyStateUpdated, false);
        } else {
          assert.match(objectXml, /<xr:Property>ObjectModule<\/xr:Property>\s*<xr:State>Extended<\/xr:State>/u);
          assert.strictEqual(outcome.propertyStateUpdated, true);
        }
        const repeated = await harness.interceptor.createInterceptor({
          extensionConfigurationId: harness.extensionConfigurationId,
          targetSourceUuid: UUIDS.catalog,
          moduleKind: 'ObjectModule',
          methodName: 'ПриЗаписи',
          kind: 'before',
        });
        assert.strictEqual(repeated.status, 'already-exists');
        assert.strictEqual(repeated.propertyStateUpdated, false);
      });
    }
  });

  test('creates a sparse CommonModule PropertyState only in formats that support it and remains idempotent', async function () {
    this.timeout(60_000);
    for (const format of ['2.17', '2.18', '2.19', '2.20', '2.21']) {
      await withHarness(format, async (harness) => {
        const objectPath = path.join(harness.extension, 'CommonModules', 'Core.xml');
        const before = await fs.promises.readFile(objectPath, 'utf8');
        assert.doesNotMatch(before, /<InternalInfo\b/u);

        const created = await harness.interceptor.createInterceptor({
          extensionConfigurationId: harness.extensionConfigurationId,
          targetSourceUuid: UUIDS.commonModule,
          moduleKind: 'Module',
          methodName: 'ПриЗаписи',
          kind: 'before',
        });
        assert.strictEqual(created.status, 'created');
        assert.strictEqual(created.propertyStateUpdated, Number(format.slice(2)) >= 19);

        const after = await fs.promises.readFile(objectPath, 'utf8');
        assert.strictEqual(XMLValidator.validate(after), true);
        const propertyStateCount = (after.match(/<(?:[\w.-]+:)?PropertyState\b/gu) ?? []).length;
        assert.strictEqual(propertyStateCount, Number(format.slice(2)) >= 19 ? 1 : 0);
        if (Number(format.slice(2)) < 19) {
          assert.strictEqual(after, before);
        } else {
          assert.doesNotMatch(after, /GeneratedType/u);
        }

        const repeated = await harness.interceptor.createInterceptor({
          extensionConfigurationId: harness.extensionConfigurationId,
          targetSourceUuid: UUIDS.commonModule,
          moduleKind: 'Module',
          methodName: 'ПриЗаписи',
          kind: 'before',
        });
        assert.strictEqual(repeated.status, 'already-exists');
        assert.strictEqual(await fs.promises.readFile(objectPath, 'utf8'), after);
      });
    }
  });

  test('adds PropertyState with namespace aliases on a sparse prefixed CommonModule', async () => {
    await withHarness('2.19', async (harness) => {
      const objectPath = path.join(harness.extension, 'CommonModules', 'Core.xml');
      const created = await harness.interceptor.createInterceptor({
        extensionConfigurationId: harness.extensionConfigurationId,
        targetSourceUuid: UUIDS.commonModule,
        moduleKind: 'Module',
        methodName: 'ПриЗаписи',
        kind: 'before',
      });
      assert.strictEqual(created.status, 'created');

      const after = await fs.promises.readFile(objectPath, 'utf8');
      assert.strictEqual(XMLValidator.validate(after), true);
      assert.match(after, /<m:MetaDataObject\b/u);
      const rootObject = elementChildren(parseXmlDocument(after).root)
        .find((element) => element.localName === 'CommonModule');
      assert.ok(rootObject);
      assert.strictEqual(rootObject.name, 'm:CommonModule');
      const internalInfo = elementChildren(rootObject).find((element) => element.localName === 'InternalInfo');
      assert.ok(internalInfo);
      assert.strictEqual(internalInfo.name, 'm:InternalInfo');
      assert.strictEqual(resolveElementNamespace(internalInfo), 'http://v8.1c.ru/8.3/MDClasses');
      const propertyStates = elementChildren(internalInfo).filter((element) => element.localName === 'PropertyState');
      assert.strictEqual(propertyStates.length, 1);
      const propertyState = propertyStates[0]!;
      assert.strictEqual(resolveElementNamespace(propertyState), 'http://v8.1c.ru/8.3/xcf/readable');
      const property = elementChildren(propertyState).find((element) => element.localName === 'Property');
      const state = elementChildren(propertyState).find((element) => element.localName === 'State');
      assert.ok(property);
      assert.ok(state);
      assert.strictEqual(resolveElementNamespace(property), 'http://v8.1c.ru/8.3/xcf/readable');
      assert.strictEqual(resolveElementNamespace(state), 'http://v8.1c.ru/8.3/xcf/readable');
      assert.strictEqual(textContent(property).trim(), 'Module');
      assert.strictEqual(textContent(state).trim(), 'Extended');

      const repeated = await harness.interceptor.createInterceptor({
        extensionConfigurationId: harness.extensionConfigurationId,
        targetSourceUuid: UUIDS.commonModule,
        moduleKind: 'Module',
        methodName: 'ПриЗаписи',
        kind: 'before',
      });
      assert.strictEqual(repeated.status, 'already-exists');
      assert.strictEqual(await fs.promises.readFile(objectPath, 'utf8'), after);
    }, {
      commonModuleXml: (format) => aliasedCommonModuleXml(format),
    });
  });

  test('rejects before/after on functions, unsupported module compatibility, and modified generated bodies', async function () {
    this.timeout(15_000);
    await withHarness('2.20', async (harness) => {
      const commonModule = await harness.interceptor.createInterceptor({
        extensionConfigurationId: harness.extensionConfigurationId,
        targetSourceUuid: UUIDS.commonModule,
        moduleKind: 'Module',
        methodName: 'ПриЗаписи',
        kind: 'before',
      });
      assert.strictEqual(commonModule.modulePath, 'CommonModules/Core/Ext/Module.bsl');
      const commonModuleXml = await fs.promises.readFile(path.join(harness.extension, 'CommonModules', 'Core.xml'), 'utf8');
      assert.match(commonModuleXml, /<xr:Property>Module<\/xr:Property>/u);
      await assert.rejects(
        () => harness.interceptor.createInterceptor({
          extensionConfigurationId: harness.extensionConfigurationId,
          targetSourceUuid: UUIDS.catalog,
          moduleKind: 'ObjectModule',
          methodName: 'Рассчитать',
          kind: 'before',
        }),
        (error: unknown) => error instanceof CfeProjectError && error.code === 'CFE_VALIDATION_FAILED',
      );
      await assert.rejects(
        () => harness.interceptor.createInterceptor({
          extensionConfigurationId: harness.extensionConfigurationId,
          targetSourceUuid: UUIDS.catalog,
          moduleKind: 'RecordSetModule',
          methodName: 'ПриЗаписи',
          kind: 'before',
        }),
        (error: unknown) => error instanceof CfeProjectError && error.code === 'CFE_DEPENDENCY_UNSUPPORTED',
      );
      const initial = await harness.interceptor.createInterceptor({
        extensionConfigurationId: harness.extensionConfigurationId,
        targetSourceUuid: UUIDS.catalog,
        moduleKind: 'ObjectModule',
        methodName: 'ПриЗаписи',
        kind: 'before',
      });
      const modulePath = path.join(harness.extension, initial.modulePath);
      const before = await fs.promises.readFile(modulePath, 'utf8');
      await fs.promises.writeFile(
        modulePath,
        before.replace('TODO: код перед вызовом оригинального метода', 'пользовательская доработка'),
        'utf8',
      );
      await assert.rejects(
        () => harness.interceptor.createInterceptor({
          extensionConfigurationId: harness.extensionConfigurationId,
          targetSourceUuid: UUIDS.catalog,
          moduleKind: 'ObjectModule',
          methodName: 'ПриЗаписи',
          kind: 'before',
        }),
        (error: unknown) => error instanceof CfeInterceptorError && error.code === 'CFE_INTERCEPTOR_CONFLICT',
      );
    });
  });

  test('requires and fences the source method hash for changeAndValidate', async () => {
    await withHarness('2.20', async (harness) => {
      const sourcePath = path.join(harness.base, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
      const source = await fs.promises.readFile(sourcePath, 'utf8');
      const sourceHash = findBslMethod(source, 'Рассчитать')!.sourceHash;
      await assert.rejects(
        () => harness.interceptor.createInterceptor({
          extensionConfigurationId: harness.extensionConfigurationId,
          targetSourceUuid: UUIDS.catalog,
          moduleKind: 'ObjectModule',
          methodName: 'Рассчитать',
          kind: 'changeAndValidate',
        }),
        (error: unknown) => error instanceof CfeProjectError && error.code === 'CFE_VALIDATION_FAILED',
      );
      const outcome = await harness.interceptor.createInterceptor({
        extensionConfigurationId: harness.extensionConfigurationId,
        targetSourceUuid: UUIDS.catalog,
        moduleKind: 'ObjectModule',
        methodName: 'Рассчитать',
        kind: 'changeAndValidate',
        expectedSourceHash: sourceHash,
      });
      const module = await fs.promises.readFile(path.join(harness.extension, outcome.modulePath), 'utf8');
      assert.match(module, /&ИзменениеИКонтроль\("Рассчитать"\)/u);
      assert.match(module, /\tВозврат Число \+ 1;/u);
      assert.doesNotMatch(module, /#(?:Вставка|Удаление)/u);
      await fs.promises.writeFile(
        path.join(harness.extension, outcome.modulePath),
        module.replace('\tВозврат Число + 1;', '#Вставка\r\n\tВозврат Число + 1;\r\n#КонецВставки'),
        'utf8',
      );
      await assert.rejects(
        () => harness.interceptor.createInterceptor({
          extensionConfigurationId: harness.extensionConfigurationId,
          targetSourceUuid: UUIDS.catalog,
          moduleKind: 'ObjectModule',
          methodName: 'Рассчитать',
          kind: 'changeAndValidate',
          expectedSourceHash: sourceHash,
        }),
        (error: unknown) => error instanceof CfeInterceptorError && error.code === 'CFE_INTERCEPTOR_CONFLICT',
      );
      await fs.promises.writeFile(sourcePath, source.replace('Число + 1', 'Число + 2'), 'utf8');
      await assert.rejects(
        () => harness.interceptor.createInterceptor({
          extensionConfigurationId: harness.extensionConfigurationId,
          targetSourceUuid: UUIDS.catalog,
          moduleKind: 'ObjectModule',
          methodName: 'Рассчитать',
          kind: 'changeAndValidate',
          expectedSourceHash: sourceHash,
        }),
        (error: unknown) => error instanceof CfeProjectError && error.code === 'CFE_SOURCE_CHANGED',
      );
    });
  });

  test('rolls back module creation when the metadata CAS fence changes', async () => {
    await withHarness('2.20', async (harness) => {
      const session = harness.registry.require(harness.extensionConfigurationId);
      const originalExecute = session.mutations.execute.bind(session.mutations);
      session.mutations.execute = async <T>(plan: MutationPlan<T>, operationId?: string): Promise<T> => {
        const objectPath = path.join(harness.extension, 'Catalogs', 'Products.xml');
        const object = await fs.promises.readFile(objectPath, 'utf8');
        await fs.promises.writeFile(objectPath, `${object}\n<!-- concurrent edit -->`, 'utf8');
        return originalExecute(plan, operationId);
      };
      try {
        await assert.rejects(
          () => harness.interceptor.createInterceptor({
            extensionConfigurationId: harness.extensionConfigurationId,
            targetSourceUuid: UUIDS.catalog,
            moduleKind: 'ObjectModule',
            methodName: 'ПриЗаписи',
            kind: 'before',
          }),
          (error: unknown) => error instanceof CfeProjectError && error.code === 'CFE_VALIDATION_FAILED',
        );
        await assert.rejects(() => fs.promises.access(path.join(harness.extension, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl')));
      } finally {
        session.mutations.execute = originalExecute;
      }
    });
  });

  test('fails closed when a CFE module path is replaced by a symbolic link', async function () {
    await withHarness('2.20', async (harness) => {
      const moduleFolder = path.join(harness.extension, 'Catalogs', 'Products', 'Ext');
      const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cfe-interceptor-outside-'));
      const outsideModule = path.join(outside, 'ObjectModule.bsl');
      await fs.promises.mkdir(path.dirname(moduleFolder), { recursive: true });
      await fs.promises.writeFile(outsideModule, 'Процедура Внешняя()\nКонецПроцедуры\n', 'utf8');
      try {
        try {
          // A directory junction is available on Windows installations where ordinary
          // file symlinks require an elevated token. The boundary must reject both.
          await fs.promises.symlink(outside, moduleFolder, 'junction');
        } catch (error) {
          if (isLinkPermissionError(error)) {
            this.skip();
            return;
          }
          throw error;
        }
        await assert.rejects(
          () => harness.interceptor.createInterceptor({
            extensionConfigurationId: harness.extensionConfigurationId,
            targetSourceUuid: UUIDS.catalog,
            moduleKind: 'ObjectModule',
            methodName: 'ПриЗаписи',
            kind: 'before',
          }),
          (error: unknown) => error instanceof CfeProjectError && error.code === 'CFE_VALIDATION_FAILED',
        );
      } finally {
        await fs.promises.rm(outside, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
      }
    });
  });
});

async function withHarness(
  format: string,
  callback: (harness: InterceptorHarness) => Promise<void>,
  options: { readonly commonModuleXml?: (format: string) => string } = {},
): Promise<void> {
  const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cfe-interceptor-'));
  const base = path.join(workspace, 'base');
  const extension = path.join(base, 'ConfigurationExtensions', 'InterceptorExtension');
  const registry = new WorkspaceRegistry();
  try {
    await writeBaseConfiguration(base, format, options.commonModuleXml);
    await registry.refresh([{ configPath: base, workspaceFolderPath: workspace }]);
    const projects = new CfeProjectService(workspace, registry, {
      refreshWorkspace: async () => registry.refresh([
        { configPath: base, workspaceFolderPath: workspace },
        { configPath: extension, workspaceFolderPath: workspace },
      ]),
    });
    await projects.createProject({
      baseConfigurationId: registry.list()[0]!.configurationId,
      extensionName: 'InterceptorExtension',
      purpose: 'Customization',
      namePrefix: 'Ext_',
      compatibilityMode: 'Version8_3_24',
    });
    const extensionRoot = await fs.promises.realpath(extension);
    const extensionConfigurationId = registry.list().find((item) => item.rootPath === extensionRoot)!.configurationId;
    await projects.borrowObject({
      extensionConfigurationId,
      sourceUuid: UUIDS.catalog,
    });
    await projects.borrowObject({
      extensionConfigurationId,
      sourceUuid: UUIDS.commonModule,
    });
    const interceptor = new CfeInterceptorService(new CfeProjectRegistry(workspace, registry));
    await callback({ workspace, base, extension: extensionRoot, registry, interceptor, extensionConfigurationId });
  } finally {
    await registry.dispose();
    await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
  }
}

async function writeBaseConfiguration(
  base: string,
  format: string,
  commonModuleXmlFactory?: (format: string) => string,
): Promise<void> {
  const module = await readFixture('complex-module.bsl');
  await Promise.all([
    fs.promises.mkdir(path.join(base, 'Languages'), { recursive: true }),
    fs.promises.mkdir(path.join(base, 'Catalogs', 'Products', 'Ext'), { recursive: true }),
    fs.promises.mkdir(path.join(base, 'CommonModules', 'Core', 'Ext'), { recursive: true }),
  ]);
  await fs.promises.writeFile(
    path.join(base, 'Configuration.xml'),
    `<?xml version="1.0"?><MetaDataObject version="${format}"><Configuration uuid="11111111-1111-4111-8111-111111111111"><Properties><DefaultLanguage>Language.Russian</DefaultLanguage><ScriptVariant>Russian</ScriptVariant><InterfaceCompatibilityMode>TaxiEnableVersion8_2</InterfaceCompatibilityMode></Properties><ChildObjects><Language>Russian</Language><Catalog>Products</Catalog><CommonModule>Core</CommonModule></ChildObjects></Configuration></MetaDataObject>`,
    'utf8',
  );
  await fs.promises.writeFile(
    path.join(base, 'Languages', 'Russian.xml'),
    `<?xml version="1.0"?><MetaDataObject version="${format}"><Language uuid="12121212-1212-4121-8121-121212121212"><Properties><Name>Russian</Name><LanguageCode>ru</LanguageCode></Properties></Language></MetaDataObject>`,
    'utf8',
  );
  await fs.promises.writeFile(
    path.join(base, 'Catalogs', 'Products.xml'),
    sourceObjectXml('Catalog', 'Products', UUIDS.catalog, format),
    'utf8',
  );
  await fs.promises.writeFile(path.join(base, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl'), module, 'utf8');
  await fs.promises.writeFile(
    path.join(base, 'CommonModules', 'Core.xml'),
    commonModuleXmlFactory?.(format) ?? sourceObjectXml('CommonModule', 'Core', UUIDS.commonModule, format),
    'utf8',
  );
  await fs.promises.writeFile(path.join(base, 'CommonModules', 'Core', 'Ext', 'Module.bsl'), module, 'utf8');
}

function sourceObjectXml(type: string, name: string, uuid: string, format: string): string {
  const childObjects = type === 'Catalog' ? '<ChildObjects/>' : '';
  const hasGeneratedTypes = !ROOT_TAGS_WITHOUT_INTERNALINFO.has(type)
    && getExplicitGeneratedTypeSpecs(type) !== undefined;
  const internalInfo = hasGeneratedTypes ? buildInternalInfoXml(type, name, '') : '';
  return `<?xml version="1.0"?><MetaDataObject xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="${format}"><${type} uuid="${uuid}">${internalInfo}<Properties><Name>${name}</Name></Properties>${childObjects}</${type}></MetaDataObject>`;
}

function aliasedCommonModuleXml(format: string): string {
  return `<?xml version="1.0"?><m:MetaDataObject xmlns:m="http://v8.1c.ru/8.3/MDClasses" xmlns:r="http://v8.1c.ru/8.3/xcf/readable" version="${format}"><m:CommonModule uuid="${UUIDS.commonModule}"><m:Properties><m:Name>Core</m:Name></m:Properties></m:CommonModule></m:MetaDataObject>`;
}

async function readFixture(fileName: string): Promise<string> {
  return fs.promises.readFile(path.join(__dirname, '..', 'fixtures', 'cfe-interceptor', fileName), 'utf8');
}

function isLinkPermissionError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error.code === 'EPERM' || error.code === 'EACCES'));
}

function resolveElementNamespace(element: XmlElement): string | undefined {
  const prefix = element.name.includes(':') ? element.name.slice(0, element.name.indexOf(':')) : '';
  let current: XmlElement | undefined = element;
  while (current) {
    const declarationName = prefix ? `xmlns:${prefix}` : 'xmlns';
    const declaration = current.attributes.find((attribute) => attribute.name === declarationName);
    if (declaration) {
      return declaration.value;
    }
    current = current.parent;
  }
  return undefined;
}
