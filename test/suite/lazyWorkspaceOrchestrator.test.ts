import * as assert from 'assert';

import {
  registerLazyWorkspaceOrchestrator,
  type LazyWorkspaceView,
} from '../../src/extension/lazyWorkspaceOrchestrator';

suite('lazy workspace orchestrator', () => {
  test('does no metadata or git work before either view becomes visible', async () => {
    const metadata = new FakeView(false);
    const infobase = new FakeView(false);
    const calls = createCalls();

    registerLazyWorkspaceOrchestrator({
      metadataView: metadata,
      infobaseView: infobase,
      ...calls.options,
    });
    await flushPromises();

    assert.deepStrictEqual(calls.counts(), { load: 0, git: 0, errors: 0 });
  });

  test('loads metadata and registers git once on first metadata visibility', async () => {
    const metadata = new FakeView(false);
    const calls = createCalls();

    registerLazyWorkspaceOrchestrator({ metadataView: metadata, ...calls.options });
    metadata.setVisible(true);
    await flushPromises();
    metadata.setVisible(false);
    metadata.setVisible(true);
    await flushPromises();

    assert.deepStrictEqual(calls.counts(), { load: 1, git: 1, errors: 0 });
  });

  test('infobase-first visibility registers only git until metadata is visible', async () => {
    const metadata = new FakeView(false);
    const infobase = new FakeView(false);
    const calls = createCalls();

    registerLazyWorkspaceOrchestrator({
      metadataView: metadata,
      infobaseView: infobase,
      ...calls.options,
    });
    infobase.setVisible(true);
    await flushPromises();
    assert.deepStrictEqual(calls.counts(), { load: 0, git: 1, errors: 0 });

    metadata.setVisible(true);
    await flushPromises();
    assert.deepStrictEqual(calls.counts(), { load: 1, git: 1, errors: 0 });
  });

  test('honors initially visible metadata and infobase paths', async () => {
    const metadataCalls = createCalls();
    registerLazyWorkspaceOrchestrator({
      metadataView: new FakeView(true),
      infobaseView: new FakeView(false),
      ...metadataCalls.options,
    });
    await flushPromises();
    assert.deepStrictEqual(metadataCalls.counts(), { load: 1, git: 1, errors: 0 });

    const infobaseCalls = createCalls();
    registerLazyWorkspaceOrchestrator({
      metadataView: new FakeView(false),
      infobaseView: new FakeView(true),
      ...infobaseCalls.options,
    });
    await flushPromises();
    assert.deepStrictEqual(infobaseCalls.counts(), { load: 0, git: 1, errors: 0 });
  });

  test('reports a rejected automatic metadata load once', async () => {
    const metadata = new FakeView(false);
    let errors = 0;

    registerLazyWorkspaceOrchestrator({
      metadataView: metadata,
      loadMetadataTree: async () => {
        throw new Error('load failed');
      },
      registerGitHeadChangeHandlers: () => undefined,
      onAutoLoadError: () => {
        errors += 1;
      },
    });
    metadata.setVisible(true);
    await flushPromises();
    metadata.setVisible(false);
    metadata.setVisible(true);
    await flushPromises();

    assert.strictEqual(errors, 1);
  });
});

class FakeView implements LazyWorkspaceView {
  private readonly listeners = new Set<(event: { readonly visible: boolean }) => unknown>();

  constructor(public visible: boolean) {}

  onDidChangeVisibility(
    listener: (event: { readonly visible: boolean }) => unknown
  ): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.listeners.forEach((listener) => listener({ visible }));
  }
}

function createCalls(): {
  options: {
    loadMetadataTree: () => Promise<void>;
    registerGitHeadChangeHandlers: () => void;
    onAutoLoadError: () => void;
  };
  counts: () => { load: number; git: number; errors: number };
} {
  let load = 0;
  let git = 0;
  let errors = 0;
  return {
    options: {
      loadMetadataTree: async () => {
        load += 1;
      },
      registerGitHeadChangeHandlers: () => {
        git += 1;
      },
      onAutoLoadError: () => {
        errors += 1;
      },
    },
    counts: () => ({ load, git, errors }),
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
