import * as assert from 'assert';
import '../helpers/vscodeStubRegister';
import { createExtensionState } from '../../src/state/extensionState';
import type { ExtensionRuntimeHandles } from '../../src/state/extensionStateComposition';
import {
  createBindingDialogContext,
  createConfigurationRepositoryContext,
  createTreeProviderContext,
  type BindingDialogContext,
  type ConfigurationRepositoryContext,
  type TreeProviderContext,
} from '../../src/extension/extensionFeatureContexts';

const TREE_PROVIDER_KEYS = ['treeDataProvider'] as const;
const BINDING_DIALOG_KEYS = [
  'bindingManager',
  'infobaseStorage',
  'treeView',
  'refreshBindingTreeDecorations',
] as const;
const CONFIGURATION_REPOSITORY_KEYS = [
  'bindingManager',
  'infobaseStorage',
  'configurationRepositoryService',
  'treeView',
] as const;

type TestState = ReturnType<typeof createExtensionState>['state'];

interface FeatureTestHandles {
  readonly treeDataProvider: NonNullable<ExtensionRuntimeHandles['treeDataProvider']>;
  readonly bindingManager: NonNullable<ExtensionRuntimeHandles['bindingManager']>;
  readonly infobaseStorage: NonNullable<ExtensionRuntimeHandles['infobaseStorage']>;
  readonly treeView: NonNullable<ExtensionRuntimeHandles['treeView']>;
  readonly refreshBindingTreeDecorations: NonNullable<ExtensionRuntimeHandles['refreshBindingTreeDecorations']>;
  readonly configurationRepositoryService: NonNullable<ExtensionRuntimeHandles['configurationRepositoryService']>;
  readonly reloadCoordinator: NonNullable<ExtensionRuntimeHandles['reloadCoordinator']>;
  readonly supportComposition: NonNullable<ExtensionRuntimeHandles['supportComposition']>;
  readonly supportStateCache: NonNullable<ExtensionRuntimeHandles['supportStateCache']>;
  readonly agentBridge: NonNullable<ExtensionRuntimeHandles['agentBridge']>;
}

function fakeHandle<Value>(): Value {
  return {} as unknown as Value;
}

function createFeatureTestHandles(): FeatureTestHandles {
  return {
    treeDataProvider: fakeHandle<FeatureTestHandles['treeDataProvider']>(),
    bindingManager: fakeHandle<FeatureTestHandles['bindingManager']>(),
    infobaseStorage: fakeHandle<FeatureTestHandles['infobaseStorage']>(),
    treeView: fakeHandle<FeatureTestHandles['treeView']>(),
    refreshBindingTreeDecorations: async () => undefined,
    configurationRepositoryService: fakeHandle<FeatureTestHandles['configurationRepositoryService']>(),
    reloadCoordinator: fakeHandle<FeatureTestHandles['reloadCoordinator']>(),
    supportComposition: fakeHandle<FeatureTestHandles['supportComposition']>(),
    supportStateCache: fakeHandle<FeatureTestHandles['supportStateCache']>(),
    agentBridge: fakeHandle<FeatureTestHandles['agentBridge']>(),
  };
}

function createState(handles: Partial<ExtensionRuntimeHandles>): ReturnType<typeof createExtensionState> {
  const assembly = createExtensionState();
  assembly.composition.bindDispose(async () => {
    assembly.composition.clear();
  });
  assembly.composition.publish(handles);
  return assembly;
}

function assertExactFrozenSnapshot(context: object, allowedKeys: readonly string[]): void {
  assert.strictEqual(Object.isFrozen(context), true);
  assert.deepStrictEqual(Object.keys(context).sort(), [...allowedKeys].sort());
}

function assertRuntimeCapabilitiesCannotChange(
  context: object,
  existingKey: string,
  unrelatedKey: string,
  replacement: unknown
): void {
  const originalValue = Reflect.get(context, existingKey);
  assert.strictEqual(Reflect.set(context, existingKey, replacement), false);
  assert.strictEqual(Reflect.get(context, existingKey), originalValue);
  assert.strictEqual(Reflect.set(context, unrelatedKey, replacement), false);
  assert.strictEqual(Reflect.has(context, unrelatedKey), false);
}

function assertBuilderFailsBeforeRegistration<Context>(
  state: TestState,
  buildContext: (state: TestState) => Context
): void {
  let registrationCalls = 0;
  const registerFeature = (_context: Context): void => {
    registrationCalls += 1;
  };

  assert.throws(() => registerFeature(buildContext(state)));
  assert.strictEqual(registrationCalls, 0);
}

suite('Extension feature context contracts (#261)', () => {
  test('TreeProviderContext is a frozen snapshot containing only its required provider', () => {
    const handles = createFeatureTestHandles();
    const assembly = createState(handles);
    const context = createTreeProviderContext(assembly.state);

    assertExactFrozenSnapshot(context, TREE_PROVIDER_KEYS);
    assert.strictEqual(context.treeDataProvider, handles.treeDataProvider);
    assertRuntimeCapabilitiesCannotChange(
      context,
      'treeDataProvider',
      'bindingManager',
      fakeHandle<FeatureTestHandles['treeDataProvider']>()
    );

    const replacement = fakeHandle<FeatureTestHandles['treeDataProvider']>();
    assembly.composition.publish({ treeDataProvider: replacement });
    assert.strictEqual(context.treeDataProvider, handles.treeDataProvider);

    const nextContext = createTreeProviderContext(assembly.state);
    assertExactFrozenSnapshot(nextContext, TREE_PROVIDER_KEYS);
    assert.strictEqual(nextContext.treeDataProvider, replacement);
  });

  test('BindingDialogContext contains exactly its four approved capabilities', () => {
    const handles = createFeatureTestHandles();
    const assembly = createState(handles);
    const context = createBindingDialogContext(assembly.state);

    assertExactFrozenSnapshot(context, BINDING_DIALOG_KEYS);
    assert.strictEqual(context.bindingManager, handles.bindingManager);
    assert.strictEqual(context.infobaseStorage, handles.infobaseStorage);
    assert.strictEqual(context.treeView, handles.treeView);
    assert.strictEqual(context.refreshBindingTreeDecorations, handles.refreshBindingTreeDecorations);
    assertRuntimeCapabilitiesCannotChange(
      context,
      'bindingManager',
      'supportComposition',
      fakeHandle<FeatureTestHandles['bindingManager']>()
    );

    const replacement = fakeHandle<FeatureTestHandles['bindingManager']>();
    assembly.composition.publish({ bindingManager: replacement });
    assert.strictEqual(context.bindingManager, handles.bindingManager);

    const nextContext = createBindingDialogContext(assembly.state);
    assertExactFrozenSnapshot(nextContext, BINDING_DIALOG_KEYS);
    assert.strictEqual(nextContext.bindingManager, replacement);
    assert.strictEqual(nextContext.infobaseStorage, handles.infobaseStorage);
    assert.strictEqual(nextContext.treeView, handles.treeView);
    assert.strictEqual(nextContext.refreshBindingTreeDecorations, handles.refreshBindingTreeDecorations);
  });

  test('ConfigurationRepositoryContext contains exactly its required handles', () => {
    const handles = createFeatureTestHandles();
    const assembly = createState(handles);
    const context = createConfigurationRepositoryContext(assembly.state);

    assertExactFrozenSnapshot(context, CONFIGURATION_REPOSITORY_KEYS);
    assert.strictEqual(context.bindingManager, handles.bindingManager);
    assert.strictEqual(context.infobaseStorage, handles.infobaseStorage);
    assert.strictEqual(context.configurationRepositoryService, handles.configurationRepositoryService);
    assert.strictEqual(context.treeView, handles.treeView);
    assertRuntimeCapabilitiesCannotChange(
      context,
      'configurationRepositoryService',
      'agentBridge',
      fakeHandle<FeatureTestHandles['configurationRepositoryService']>()
    );

    const replacement = fakeHandle<FeatureTestHandles['configurationRepositoryService']>();
    assembly.composition.publish({ configurationRepositoryService: replacement });
    assert.strictEqual(context.configurationRepositoryService, handles.configurationRepositoryService);

    const nextContext = createConfigurationRepositoryContext(assembly.state);
    assertExactFrozenSnapshot(nextContext, CONFIGURATION_REPOSITORY_KEYS);
    assert.strictEqual(nextContext.bindingManager, handles.bindingManager);
    assert.strictEqual(nextContext.infobaseStorage, handles.infobaseStorage);
    assert.strictEqual(nextContext.configurationRepositoryService, replacement);
    assert.strictEqual(nextContext.treeView, handles.treeView);
  });

  test('a missing mandatory handle aborts each builder before feature registration', () => {
    const treeHandles: Partial<FeatureTestHandles> = { ...createFeatureTestHandles() };
    Reflect.deleteProperty(treeHandles, 'treeDataProvider');
    assertBuilderFailsBeforeRegistration(
      createState(treeHandles).state,
      createTreeProviderContext
    );

    const dialogHandles: Partial<FeatureTestHandles> = { ...createFeatureTestHandles() };
    Reflect.deleteProperty(dialogHandles, 'bindingManager');
    assertBuilderFailsBeforeRegistration(
      createState(dialogHandles).state,
      createBindingDialogContext
    );

    const repositoryHandles: Partial<FeatureTestHandles> = { ...createFeatureTestHandles() };
    Reflect.deleteProperty(repositoryHandles, 'configurationRepositoryService');
    assertBuilderFailsBeforeRegistration(
      createState(repositoryHandles).state,
      createConfigurationRepositoryContext
    );
  });
});

/** Compile-time proof only; runtime suites never invoke this function. */
export function extensionFeatureContextTypeProof(
  treeProvider: TreeProviderContext,
  bindingDialog: BindingDialogContext,
  configurationRepository: ConfigurationRepositoryContext,
  treeProviderReplacement: NonNullable<ExtensionRuntimeHandles['treeDataProvider']>,
  bindingManagerReplacement: NonNullable<ExtensionRuntimeHandles['bindingManager']>,
  repositoryServiceReplacement: NonNullable<ExtensionRuntimeHandles['configurationRepositoryService']>
): readonly [
  NonNullable<ExtensionRuntimeHandles['treeDataProvider']>,
  NonNullable<ExtensionRuntimeHandles['bindingManager']>,
  NonNullable<ExtensionRuntimeHandles['infobaseStorage']>,
  NonNullable<ExtensionRuntimeHandles['treeView']>,
  NonNullable<ExtensionRuntimeHandles['refreshBindingTreeDecorations']>,
  NonNullable<ExtensionRuntimeHandles['configurationRepositoryService']>
] {
  // @ts-expect-error TreeProviderContext exposes no binding service.
  treeProvider.bindingManager;
  // @ts-expect-error Feature snapshots are readonly.
  treeProvider.treeDataProvider = treeProviderReplacement;
  // @ts-expect-error BindingDialogContext exposes no tree provider.
  bindingDialog.treeDataProvider;
  // @ts-expect-error BindingDialogContext exposes no shared support graph.
  bindingDialog.supportComposition;
  // @ts-expect-error Feature snapshots are readonly.
  bindingDialog.bindingManager = bindingManagerReplacement;
  // @ts-expect-error ConfigurationRepositoryContext exposes no support graph.
  configurationRepository.supportComposition;
  // @ts-expect-error Feature snapshots are readonly.
  configurationRepository.configurationRepositoryService = repositoryServiceReplacement;

  return [
    treeProvider.treeDataProvider,
    bindingDialog.bindingManager,
    bindingDialog.infobaseStorage,
    bindingDialog.treeView,
    bindingDialog.refreshBindingTreeDecorations,
    configurationRepository.configurationRepositoryService,
  ];
}
