import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';

import {
  buildBslModuleIndex,
  indexBslModuleFile,
  type BslModuleFileInput,
} from '../../../src/compareMerge/bsl/bslModuleIndexer';

suite('BslModuleIndexerCooperative', () => {
  test('yields to cancellation after the module batch limit', async () => {
    const originalNow = performance.now;
    const cancellation = { isCancellationRequested: false };
    performance.now = () => 0;
    const cancellationImmediate = setImmediate(() => {
      cancellation.isCancellationRequested = true;
    });

    try {
      await assert.rejects(
        buildBslModuleIndex(createInputs(1024), cancellation),
        isCompareCancelled
      );
    } finally {
      performance.now = originalNow;
      clearImmediate(cancellationImmediate);
    }
  });

  test('yields after the time budget before reaching the module batch limit', async () => {
    const originalNow = performance.now;
    const cancellation = { isCancellationRequested: false };
    let nowCalls = 0;
    performance.now = () => nowCalls++ === 0 ? 0 : 8;
    const cancellationImmediate = setImmediate(() => {
      cancellation.isCancellationRequested = true;
    });

    try {
      await assert.rejects(
        buildBslModuleIndex(createInputs(1), cancellation),
        isCompareCancelled
      );
      assert.strictEqual(nowCalls, 2);
    } finally {
      performance.now = originalNow;
      clearImmediate(cancellationImmediate);
    }
  });

  test('preserves module and diagnostic order across cooperative batches', async () => {
    const inputs = createInputs(130).map((input, index) => {
      if (index % 4 === 1) {
        return { ...input, source: [
          'Procedure Duplicate()',
          'EndProcedure',
          'Procedure Duplicate()',
          'EndProcedure',
        ].join('\n') };
      }
      if (index % 4 === 2) {
        return { ...input, source: 'Procedure Broken(' };
      }
      if (index % 4 === 3) {
        return {
          ...input,
          filePath: path.join(os.tmpdir(), 'bsl-indexer-cooperative', 'Constants', `Constant${index}`, 'Ext', 'ValueManagerModule.bsl'),
        };
      }
      if (index === 0) {
        return {
          ...input,
          filePath: path.join(os.tmpdir(), 'bsl-indexer-cooperative', 'Unrecognized', `Module${index}.bsl`),
        };
      }
      return input;
    });
    const expectedModules = [];
    const expectedDiagnostics = [];
    for (const input of inputs) {
      const result = await indexBslModuleFile(input);
      expectedModules.push(...result.modules);
      expectedDiagnostics.push(...result.diagnostics);
    }

    const actual = await buildBslModuleIndex(inputs);

    assert.deepStrictEqual(actual, {
      modules: expectedModules,
      diagnostics: expectedDiagnostics,
    });
  });

  test('rejects a pre-cancelled nonempty batch before indexing', async () => {
    await assert.rejects(
      buildBslModuleIndex(createInputs(1), { isCancellationRequested: true }),
      isCompareCancelled
    );
  });

  test('returns an empty result for an empty pre-cancelled batch without yielding', async () => {
    const cancellation = { isCancellationRequested: true };
    let immediateRan = false;
    const immediate = setImmediate(() => {
      immediateRan = true;
    });

    try {
      const actual = await buildBslModuleIndex([], cancellation);
      assert.deepStrictEqual(actual, { modules: [], diagnostics: [] });
      assert.strictEqual(immediateRan, false);
    } finally {
      clearImmediate(immediate);
    }
  });
});

function createInputs(count: number): BslModuleFileInput[] {
  const root = path.join(os.tmpdir(), 'bsl-indexer-cooperative');
  return Array.from({ length: count }, (_, index) => ({
    sourceId: 'left-source',
    side: 'left',
    filePath: path.join(root, 'CommonModules', `Module${index}`, 'Ext', 'Module.bsl'),
    configRoots: [root],
    source: 'Procedure Work()\nEndProcedure',
  }));
}

function isCompareCancelled(error: unknown): boolean {
  return (error as { code?: unknown })?.code === 'CONFIGURATION_COMPARE_CANCELLED';
}
