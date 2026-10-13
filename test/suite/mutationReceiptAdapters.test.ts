import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RolesRightsEditorProvider } from '../../src/rolesEditor/rolesRightsEditorProvider';
import {
  ConfigurationMutationEngine,
  setConfigurationMutationEngine,
  type MutationOutcomeStatus,
  type MutationReceipt,
  type SingleFileMutationIntent,
  type SingleFileTransform,
} from '../../src/services/configurationSession/ConfigurationMutationEngine';
import { MetadataType, type TreeNode } from '../../src/models/treeNode';
import { applySubsystemCompositionFileUpdate } from '../../src/services/subsystemCompositionFileUpdater';
import { SubsystemCommandInterfaceProvider } from '../../src/subsystemCommandInterfaceEditor/subsystemCommandInterfaceProvider';
import {
  createFakeExtensionContext,
  createFakeWebviewPanel,
  patchCreateWebviewPanel,
} from '../helpers/rightsEditorTestHarness';

type ReceiptFactory = (target: string, kind: string) => MutationReceipt<unknown> | Promise<MutationReceipt<unknown>>;
type CiPostedMessage = {
  type?: string;
  status?: unknown;
  code?: unknown;
  effectPossible?: unknown;
  message?: unknown;
};
type RolesPostedMessage = {
  command?: string;
  data?: Record<string, unknown>;
};

function createReceipt(
  status: MutationOutcomeStatus,
  target: string,
  kind: string,
  code = 'TEST_MUTATION_FAILURE',
): MutationReceipt<unknown> {
  return {
    status,
    kind,
    resourcePath: target,
    code,
    message: 'engine outcome detail',
  };
}

function installEngine(
  outcome: ReceiptFactory | Promise<MutationReceipt<unknown>>,
): void {
  const engine = new ConfigurationMutationEngine();
  engine.transformFile = async <T>(
    target: string,
    intent: SingleFileMutationIntent,
    _transform: SingleFileTransform<T>,
  ): Promise<MutationReceipt<T>> => {
    const receipt = typeof outcome === 'function'
      ? await outcome(target, intent.kind)
      : await outcome;
    return receipt as MutationReceipt<T>;
  };
  setConfigurationMutationEngine(engine);
}

function createNode(root: string, name: string): TreeNode {
  return {
    id: `Subsystems.${name}`,
    name,
    type: MetadataType.Subsystem,
    filePath: path.join(root, 'Subsystems', `${name}.xml`),
    properties: {},
  };
}

function createRoleXml(name: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Role xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">',
    `  <Properties><Name>${name}</Name></Properties>`,
    '  <Rights/>',
    '</Role>',
  ].join('\n');
}

async function createRole(root: string, name: string): Promise<string> {
  const rolePath = path.join(root, 'Roles', name, 'Role.xml');
  await fs.promises.mkdir(path.dirname(rolePath), { recursive: true });
  await fs.promises.writeFile(rolePath, createRoleXml(name), 'utf8');
  return rolePath;
}

async function createConfigurationRoot(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mutation-receipt-adapter-'));
  await fs.promises.writeFile(
    path.join(root, 'Configuration.xml'),
    '<?xml version="1.0" encoding="UTF-8"?><Configuration xmlns="http://v8.1c.ru/8.3/MDClasses"/>',
    'utf8',
  );
  return root;
}

async function removeTempDir(root: string): Promise<void> {
  await fs.promises.rm(root, { recursive: true, force: true });
}

suite('Mutation receipt UI adapters (#296)', () => {
  teardown(() => setConfigurationMutationEngine(undefined));

  test('a subsystem composition updater caller keeps typed conflict and its contextual message', async () => {
    const target = path.join(os.tmpdir(), 'subsystem-composition-mutation-receipt.xml');
    installEngine((filePath, kind) => createReceipt('conflict', filePath, kind, 'CONCURRENT_CREATE_COLLISION'));

    await assert.rejects(
      applySubsystemCompositionFileUpdate(target, { add: ['Catalog.Products'] }),
      (error: unknown) => {
        const candidate = error as { name?: string; status?: string; code?: string; message?: string };
        assert.strictEqual(candidate.name, 'MutationReceiptError');
        assert.strictEqual(candidate.status, 'conflict');
        assert.strictEqual(candidate.code, 'CONCURRENT_CREATE_COLLISION');
        assert.ok(candidate.message?.includes(`Конфликт создания файла состава с параллельным процессом: ${target}.`));
        return true;
      },
    );
  });

  test('a real composition updater keeps an uncertain-effect warning on Error.message', async () => {
    const target = path.join(os.tmpdir(), 'subsystem-composition-recovery-receipt.xml');
    installEngine((filePath, kind) => createReceipt('recoveryRequired', filePath, kind, 'RESTORE_REQUIRED'));

    await assert.rejects(
      applySubsystemCompositionFileUpdate(target, { add: ['Catalog.Products'] }),
      (error: unknown) => {
        const candidate = error as { name?: string; status?: string; message?: string };
        assert.strictEqual(candidate.name, 'MutationReceiptError');
        assert.strictEqual(candidate.status, 'recoveryRequired');
        assert.match(String(candidate.message), /изменения могли сохраниться/i);
        assert.match(String(candidate.message), /требуется проверка состояния/i);
        assert.match(String(candidate.message), /восстановление конфигурации/i);
        return true;
      },
    );
  });

  test('CommandInterface current save exposes uncertain result and generic failures stay untyped', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ci-mutation-receipt-'));
    const ciPath = path.join(root, 'Subsystems', 'SubA', 'Ext', 'CommandInterface.xml');
    await fs.promises.mkdir(path.dirname(ciPath), { recursive: true });
    await fs.promises.writeFile(ciPath, XML_A, 'utf8');
    const { panel, getPostedMessages } = createFakeWebviewPanel();
    const restore = patchCreateWebviewPanel(panel);
    const provider = new SubsystemCommandInterfaceProvider(createFakeExtensionContext());
    const node = createNode(root, 'SubA');

    try {
      installEngine((target, kind) => createReceipt('recoveryRequired', target, kind, 'VERIFY_AFTER_WRITE_FAILED'));
      await provider.show(node, ciPath);
      const save = (provider as unknown as {
        handleSave(visibility: unknown[], filePath?: string, generation?: number): Promise<void>;
      }).handleSave.bind(provider);
      await assert.rejects(save([], ciPath, 1));

      const failure = (getPostedMessages() as unknown as CiPostedMessage[])
        .find((message) => message.type === 'saveError');
      assert.ok(failure);
      assert.strictEqual(failure.status, 'recoveryRequired');
      assert.strictEqual(failure.code, 'VERIFY_AFTER_WRITE_FAILED');
      assert.strictEqual(failure.effectPossible, true);
      assert.match(String(failure.message), /изменения могли сохраниться/i);
      assert.match(String(failure.message), /восстанов/i);

      installEngine(async () => { throw new Error('ordinary serializer failure'); });
      const beforeGeneric = getPostedMessages().length;
      await assert.rejects(save([], ciPath, 1));
      const generic = (getPostedMessages() as unknown as CiPostedMessage[])
        .slice(beforeGeneric)
        .find((message) => message.type === 'saveError');
      assert.ok(generic);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(generic, 'status'), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(generic, 'code'), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(generic, 'effectPossible'), false);
      assert.ok(!/изменения могли сохраниться|восстановление/i.test(String(generic.message)));
    } finally {
      restore();
      provider.dispose();
      await removeTempDir(root);
    }
  });

  test('CommandInterface stale failure does not publish into the next editor session', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ci-mutation-stale-'));
    const ciPathA = path.join(root, 'Subsystems', 'SubA', 'Ext', 'CommandInterface.xml');
    const ciPathB = path.join(root, 'Subsystems', 'SubB', 'Ext', 'CommandInterface.xml');
    await fs.promises.mkdir(path.dirname(ciPathA), { recursive: true });
    await fs.promises.mkdir(path.dirname(ciPathB), { recursive: true });
    await fs.promises.writeFile(ciPathA, XML_A, 'utf8');
    await fs.promises.writeFile(ciPathB, XML_B, 'utf8');
    let markStarted: (() => void) | undefined;
    let finishMutation: ((receipt: MutationReceipt<unknown>) => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const result = new Promise<MutationReceipt<unknown>>((resolve) => { finishMutation = resolve; });
    installEngine(() => {
      markStarted?.();
      return result;
    });

    const { panel, getPostedMessages } = createFakeWebviewPanel();
    const restore = patchCreateWebviewPanel(panel);
    const provider = new SubsystemCommandInterfaceProvider(createFakeExtensionContext());
    try {
      await provider.show(createNode(root, 'SubA'), ciPathA);
      const save = (provider as unknown as {
        handleSave(visibility: unknown[], filePath?: string, generation?: number): Promise<void>;
      }).handleSave.bind(provider);
      const pendingSave = save([], ciPathA, 1).then(
        () => undefined,
        (error: unknown) => error,
      );
      await started;
      await provider.show(createNode(root, 'SubB'), ciPathB);
      finishMutation?.(createReceipt('inDoubt', ciPathA, 'subsystemCommandInterface.save'));
      const error = await pendingSave as { status?: string; code?: string };
      assert.strictEqual(error.status, 'inDoubt');
      assert.strictEqual(error.code, 'TEST_MUTATION_FAILURE');
      const posted = getPostedMessages() as unknown as CiPostedMessage[];
      assert.strictEqual(posted.some((message) => message.type === 'saveError'), false);
    } finally {
      restore();
      provider.dispose();
      await removeTempDir(root);
    }
  });

  test('Roles current save projects typed recovery details and stale completion remains fenced', async () => {
    const root = await createConfigurationRoot();
    const rolePathA = await createRole(root, 'RoleA');
    const rolePathB = await createRole(root, 'RoleB');
    const { panel, getPostedMessages } = createFakeWebviewPanel({ autoReplyFlushWith: '' });
    const restore = patchCreateWebviewPanel(panel);
    const provider = new RolesRightsEditorProvider(createFakeExtensionContext());
    const handleSave = (provider as unknown as {
      handleSave(message?: { command: 'save'; data: { restrictionTemplatesText: string } }): Promise<void>;
    }).handleSave.bind(provider);

    try {
      installEngine((target, kind) => createReceipt('recoveryRequired', target, kind, 'RESTORE_REQUIRED'));
      await provider.show(rolePathA, root);
      await assert.rejects(handleSave({ command: 'save', data: { restrictionTemplatesText: '' } }));
      const failure = (getPostedMessages() as unknown as RolesPostedMessage[])
        .find((message) => message.command === 'saveError');
      assert.ok(failure);
      assert.strictEqual(failure.data?.status, 'recoveryRequired');
      assert.strictEqual(failure.data?.code, 'RESTORE_REQUIRED');
      assert.strictEqual(failure.data?.effectPossible, true);
      assert.match(String(failure.data?.message), /изменения могли сохраниться/i);
      assert.match(String(failure.data?.message), /восстанов/i);

      let markStarted: (() => void) | undefined;
      let finishMutation: ((receipt: MutationReceipt<unknown>) => void) | undefined;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const result = new Promise<MutationReceipt<unknown>>((resolve) => { finishMutation = resolve; });
      installEngine(() => {
        markStarted?.();
        return result;
      });
      const beforeStaleSave = getPostedMessages().length;
      const pendingSave = handleSave({ command: 'save', data: { restrictionTemplatesText: '' } }).then(
        () => undefined,
        (error: unknown) => error,
      );
      await started;
      await provider.show(rolePathB, root);
      finishMutation?.(createReceipt('inDoubt', rolePathA, 'rolesRights.save'));
      const error = await pendingSave as { status?: string; code?: string };
      assert.strictEqual(error.status, 'inDoubt');
      assert.strictEqual(error.code, 'TEST_MUTATION_FAILURE');
      assert.strictEqual(
        (getPostedMessages() as unknown as RolesPostedMessage[])
          .slice(beforeStaleSave)
          .some((message) => message.command === 'saveError'),
        false,
      );
    } finally {
      restore();
      provider.dispose();
      await removeTempDir(root);
    }
  });
});

const XML_A = `<?xml version="1.0" encoding="UTF-8"?>
<CommandInterface xmlns="http://v8.1c.ru/8.3/xcf/extrnprops" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="2.17">
  <CommandsVisibility><Command name="Catalog.Goods.StandardCommand.OpenList"><Visibility><xr:Common>true</xr:Common></Visibility></Command></CommandsVisibility>
</CommandInterface>`;

const XML_B = `<?xml version="1.0" encoding="UTF-8"?>
<CommandInterface xmlns="http://v8.1c.ru/8.3/xcf/extrnprops" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="2.17">
  <CommandsVisibility><Command name="Document.Orders.StandardCommand.OpenList"><Visibility><xr:Common>true</xr:Common></Visibility></Command></CommandsVisibility>
</CommandInterface>`;
