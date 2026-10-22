import * as assert from 'assert';
import type { ExtensionContext } from 'vscode';
import '../helpers/vscodeStubRegister';
import { createExtensionState } from '../../src/state/extensionState';
import type { ExtensionRuntimeHandles } from '../../src/state/extensionStateComposition';

function createContext(): ExtensionContext {
  return { subscriptions: [] } as unknown as ExtensionContext;
}

suite('ExtensionState composition facade (#261)', () => {
  test('creates isolated frozen facades without initialization or mutation methods', () => {
    const first = createExtensionState();
    const second = createExtensionState();
    const firstContext = createContext();
    const secondContext = createContext();

    assert.notStrictEqual(first.state, second.state);
    assert.strictEqual(first.state.extensionContext, undefined);
    assert.strictEqual(second.state.extensionContext, undefined);
    assert.strictEqual(first.state.workspaceRegistry, null);
    assert.strictEqual(second.state.workspaceRegistry, null);
    assert.strictEqual(Object.isFrozen(first.state), true);
    assert.strictEqual(Object.isFrozen(second.state), true);

    for (const method of ['init', 'initialize', 'publish', 'bindDispose', 'stopPublishing', 'clear']) {
      assert.strictEqual(method in first.state, false, `state facade must not expose ${method}`);
    }

    const handleKeys = Object.keys(first.state).filter(
      (key) => key !== 'extensionContext' && key !== 'dispose'
    ) as Array<keyof ExtensionRuntimeHandles>;
    for (const key of handleKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(first.state, key);
      assert.strictEqual(typeof descriptor?.get, 'function', `${key} must be exposed through a getter`);
      assert.strictEqual(descriptor?.set, undefined, `${key} must not have a setter`);
    }
    assert.strictEqual(Reflect.set(first.state, 'workspaceRegistry', {}), false);

    first.composition.initialize(firstContext);
    second.composition.initialize(secondContext);
    first.composition.bindDispose(async () => undefined);
    second.composition.bindDispose(async () => undefined);

    const firstRegistry = {} as NonNullable<ExtensionRuntimeHandles['workspaceRegistry']>;
    const secondRegistry = {} as NonNullable<ExtensionRuntimeHandles['workspaceRegistry']>;
    first.composition.publish({ workspaceRegistry: firstRegistry });
    second.composition.publish({ workspaceRegistry: secondRegistry });

    first.composition.clear();

    assert.strictEqual(first.state.extensionContext, undefined);
    assert.strictEqual(first.state.workspaceRegistry, null);
    assert.strictEqual(second.state.extensionContext, secondContext);
    assert.strictEqual(second.state.workspaceRegistry, secondRegistry);
  });

  test('initialization and disposal ownership are single-use; publishing needs an owner', async () => {
    const { state, composition } = createExtensionState();
    const context = createContext();
    const registry = {} as NonNullable<ExtensionRuntimeHandles['workspaceRegistry']>;
    let originalOwnerCalls = 0;
    let rejectedOwnerCalls = 0;

    composition.initialize(context);
    assert.strictEqual(state.extensionContext, context);
    assert.throws(() => composition.initialize(createContext()));
    assert.strictEqual(state.extensionContext, context);
    assert.throws(() => composition.publish({ workspaceRegistry: registry }));

    composition.bindDispose(async () => {
      originalOwnerCalls += 1;
      composition.clear();
    });
    assert.throws(() => composition.bindDispose(async () => {
      rejectedOwnerCalls += 1;
    }));
    composition.publish({ workspaceRegistry: registry });
    assert.strictEqual(state.workspaceRegistry, registry);

    await state.dispose();
    assert.strictEqual(originalOwnerCalls, 1);
    assert.strictEqual(rejectedOwnerCalls, 0);
    assert.strictEqual(state.workspaceRegistry, null);
  });

  test('clear is idempotent, clears every exposed handle, and does not own teardown', () => {
    const { state, composition } = createExtensionState();
    const context = createContext();
    let ownerCalls = 0;
    composition.initialize(context);
    composition.bindDispose(async () => {
      ownerCalls += 1;
    });

    const handleKeys = Object.keys(state).filter(
      (key) => key !== 'extensionContext' && key !== 'dispose'
    ) as Array<keyof ExtensionRuntimeHandles>;
    const published = {} as Partial<ExtensionRuntimeHandles>;
    const expected = new Map<keyof ExtensionRuntimeHandles, object>();
    for (const key of handleKeys) {
      const handle = { key };
      expected.set(key, handle);
      Object.defineProperty(published, key, {
        configurable: true,
        enumerable: true,
        value: handle,
      });
    }

    composition.publish(published);
    for (const key of handleKeys) {
      assert.strictEqual(state[key], expected.get(key), `${key} must be published`);
    }

    composition.stopPublishing();
    assert.throws(() => composition.publish({}));
    for (const key of handleKeys) {
      assert.strictEqual(state[key], expected.get(key), `${key} must remain observable until clear`);
    }

    composition.clear();
    composition.clear();

    assert.strictEqual(state.extensionContext, undefined);
    for (const key of handleKeys) {
      assert.strictEqual(state[key], null, `${key} must be cleared`);
    }
    assert.strictEqual(ownerCalls, 0, 'clear must not dispose resources itself');
  });

  test('dispose before an owner clears only the empty facade', async () => {
    const { state, composition } = createExtensionState();
    const handleKeys = Object.keys(state).filter(
      (key) => key !== 'extensionContext' && key !== 'dispose'
    ) as Array<keyof ExtensionRuntimeHandles>;

    await state.dispose();

    assert.strictEqual(state.extensionContext, undefined);
    for (const key of handleKeys) {
      assert.strictEqual(state[key], null, `${key} must remain empty`);
    }
    assert.throws(() => composition.initialize(createContext()));
    assert.throws(() => composition.bindDispose(async () => undefined));
    assert.throws(() => composition.publish({}));
  });

  test('dispose closes publication synchronously and waits for the bound owner to clear handles', async () => {
    const { state, composition } = createExtensionState();
    let releaseOwner!: () => void;
    const ownerGate = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    let ownerCalls = 0;
    const registry = {} as NonNullable<ExtensionRuntimeHandles['workspaceRegistry']>;

    composition.initialize(createContext());
    composition.bindDispose(async () => {
      ownerCalls += 1;
      await ownerGate;
      composition.clear();
    });
    composition.publish({ workspaceRegistry: registry });

    const firstDispose = state.dispose();
    try {
      assert.throws(
        () => composition.publish({
          workspaceRegistry: {} as NonNullable<ExtensionRuntimeHandles['workspaceRegistry']>,
        })
      );
      assert.strictEqual(state.workspaceRegistry, registry, 'handles remain observable while owner cleanup is pending');
      assert.strictEqual(state.extensionContext === undefined, false);
      assert.strictEqual(state.dispose(), firstDispose, 'concurrent dispose calls join the owner cleanup');

      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(ownerCalls, 1);
      assert.strictEqual(state.workspaceRegistry, registry);
    } finally {
      releaseOwner();
    }

    await firstDispose;
    assert.strictEqual(ownerCalls, 1);
    assert.strictEqual(state.workspaceRegistry, null);
    assert.strictEqual(state.extensionContext, undefined);
  });

  test('dispose propagates the owner error unchanged and invokes the owner once', async () => {
    const { state, composition } = createExtensionState();
    const primaryCleanupError = new Error('primary root cleanup failure');
    let ownerCalls = 0;

    composition.bindDispose(async () => {
      ownerCalls += 1;
      throw primaryCleanupError;
    });

    const firstDispose = state.dispose();
    const secondDispose = state.dispose();
    assert.strictEqual(firstDispose, secondDispose);
    await assert.rejects(firstDispose, (error: unknown) => error === primaryCleanupError);
    await assert.rejects(secondDispose, (error: unknown) => error === primaryCleanupError);
    assert.strictEqual(ownerCalls, 1);
  });
});
