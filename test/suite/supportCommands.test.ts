import * as assert from 'assert';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import {
  resetVscodeTestState,
  vscodeTestState,
} from '../helpers/vscodeModuleStub';
import {
  registerSupportCommands,
  SUPPORT_COMMAND_IDS,
} from '../../src/support/supportCommands';
import type {
  SupportApplicationFacade,
} from '../../src/support/supportApplicationServiceRegistry';
import type { ConfigurationId } from '../../src/services/configurationSession/types';
import type {
  MasterSupportSnapshot,
  SupportStatusResult,
} from '../../src/support/supportTypes';

type FacadeCall = {
  readonly method: keyof SupportApplicationFacade;
  readonly request: unknown;
};

suite('SupportCommands facade flows', () => {
  const configurationId = 'cfg-ui' as ConfigurationId;
  const objectId = '11111111-1111-1111-1111-111111111111';

  setup(resetVscodeTestState);
  teardown(resetVscodeTestState);

  test('registers exactly the six support UI commands', () => {
    registerSupportCommands(depsFor([], {}));

    assert.deepStrictEqual(vscodeTestState.registeredCommandIds, Object.values(SUPPORT_COMMAND_IDS));
    assert.strictEqual(new Set(vscodeTestState.registeredCommandIds).size, 6);
  });

  test('setObjectMode refreshes status, forwards generation CAS and invalidates UI state', async () => {
    const calls: FacadeCall[] = [];
    const changed: ConfigurationId[] = [];
    const facade = createFacade(calls, {
      getStatus: readyStatus(configurationId, objectId, 'notEditable', 'enabled'),
      setObjectMode: synchronizedMutation(),
    });
    registerSupportCommands({
      facade,
      resolveContext: () => ({ kind: 'object', configurationId, objectId }),
      listTargets: async () => [],
      onStatusChanged: (id) => changed.push(id),
    });
    vscodeTestState.quickPickQueue.push({ mode: 'removedFromSupport' });

    await invoke(SUPPORT_COMMAND_IDS.setObjectMode, { arbitraryTreeNode: true });

    assert.deepStrictEqual(calls, [
      {
        method: 'getStatus',
        request: { configurationId, objectIds: [objectId] },
      },
      {
        method: 'setObjectMode',
        request: {
          configurationId,
          objectId,
          targetMode: 'removedFromSupport',
          expectedGenerationId: 'generation-ui',
        },
      },
    ]);
    assert.deepStrictEqual(changed, [configurationId]);
    assert.strictEqual(vscodeTestState.informationLog.length, 1);
  });

  test('allowObjectEditing uses the same fresh CAS without opening a mode picker', async () => {
    const calls: FacadeCall[] = [];
    registerSupportCommands(depsFor(calls, {
      getStatus: readyStatus(configurationId, objectId, 'notEditable', 'enabled'),
      setObjectMode: synchronizedMutation(),
    }, { kind: 'object', configurationId, objectId }));

    await invoke(SUPPORT_COMMAND_IDS.allowObjectEditing, {});

    assert.deepStrictEqual(calls.map((call) => call.method), ['getStatus', 'setObjectMode']);
    assert.deepStrictEqual(calls[1]!.request, {
      configurationId,
      objectId,
      targetMode: 'editableWithSupport',
      expectedGenerationId: 'generation-ui',
    });
    assert.deepStrictEqual(vscodeTestState.quickPickQueue, []);
  });

  test('enableObjectRules confirms explicitly and forwards both master and universe generations', async () => {
    const calls: FacadeCall[] = [];
    registerSupportCommands(depsFor(calls, {
      getStatus: readyStatus(configurationId, objectId, 'notEditable', 'disabled'),
      enableObjectRules: synchronizedMutation(),
    }, { kind: 'object', configurationId, objectId }));

    await invoke(SUPPORT_COMMAND_IDS.enableObjectRules, {});

    assert.deepStrictEqual(calls.map((call) => call.method), ['getStatus', 'enableObjectRules']);
    assert.deepStrictEqual(calls[1]!.request, {
      configurationId,
      targetObjectId: objectId,
      targetMode: 'editableWithSupport',
      expectedGenerationId: 'generation-ui',
      expectedMetadataUniverseGenerationId: 'universe-ui',
    });
    assert.strictEqual(vscodeTestState.warningLog.length, 1);
  });

  test('sync selected targets deduplicates ids, requests fast verification and reports partial as warning', async () => {
    const calls: FacadeCall[] = [];
    const changed: ConfigurationId[] = [];
    const facade = createFacade(calls, {
      getStatus: readyStatus(configurationId, objectId, 'editableWithSupport', 'enabled'),
      sync: {
        status: 'incomplete',
        master: snapshot(configurationId, objectId, 'editableWithSupport', 'enabled'),
        errorCode: 'SUPPORT_REPLICATION_INCOMPLETE',
        retryable: true,
      },
    });
    registerSupportCommands({
      facade,
      resolveContext: () => ({ kind: 'configuration', configurationId }),
      listTargets: async () => [
        { canonicalTargetId: 'file:C:/one', label: 'One' },
        { canonicalTargetId: 'file:C:/two', label: 'Two' },
      ],
      onStatusChanged: (id) => changed.push(id),
    });
    vscodeTestState.quickPickQueue.push(
      { selectionKind: 'ids' },
      [
        { targetId: 'file:C:/one' },
        { targetId: 'file:C:/one' },
        { targetId: 'file:C:/two' },
      ],
    );

    await invoke(SUPPORT_COMMAND_IDS.sync, {});

    assert.deepStrictEqual(calls, [
      { method: 'getStatus', request: { configurationId } },
      {
        method: 'sync',
        request: {
          configurationId,
          targets: {
            kind: 'ids',
            targetIds: ['file:C:/one', 'file:C:/two'],
          },
          verification: 'fast',
        },
      },
    ]);
    assert.deepStrictEqual(changed, [configurationId]);
    assert.strictEqual(vscodeTestState.warningLog.length, 1);
    assert.strictEqual(vscodeTestState.informationLog.length, 0);
  });

  test('verify retryable preset forwards the exact closed retry state set', async () => {
    const calls: FacadeCall[] = [];
    registerSupportCommands(depsFor(calls, {
      getStatus: readyStatus(configurationId, objectId, 'editableWithSupport', 'enabled'),
      verify: {
        status: 'synchronized',
        master: snapshot(configurationId, objectId, 'editableWithSupport', 'enabled'),
        preflight: { accepted: true, scope: 'masterOnly', targets: [] },
        run: {
          runId: 'verify-ui',
          operation: 'verify',
          configurationId,
          scope: 'masterOnly',
          desiredGenerationId: 'generation-ui',
          state: 'complete',
          startedAt: '2026-07-29T00:00:00.000Z',
          completedAt: '2026-07-29T00:00:01.000Z',
          targets: [],
        },
      },
    }, { kind: 'configuration', configurationId }));
    vscodeTestState.quickPickQueue.push({ selectionKind: 'retryable' });

    await invoke(SUPPORT_COMMAND_IDS.verify, {});

    assert.deepStrictEqual(calls[1], {
      method: 'verify',
      request: {
        configurationId,
        targets: {
          kind: 'retryable',
          include: ['failed', 'inDoubt', 'targetDrift'],
        },
      },
    });
  });

  test('unmanaged fresh status fails closed before sync or mutation', async () => {
    const calls: FacadeCall[] = [];
    const unmanaged: SupportStatusResult = {
      status: 'available',
      master: {
        kind: 'unmanaged',
        reason: 'missing',
        configurationId,
        expectedFilePath: path.resolve('Ext', 'ParentConfigurations.bin'),
      },
    };
    registerSupportCommands(depsFor(calls, {
      getStatus: unmanaged,
    }, { kind: 'configuration', configurationId }));

    await invoke(SUPPORT_COMMAND_IDS.sync, {});

    assert.deepStrictEqual(calls.map((call) => call.method), ['getStatus']);
    assert.strictEqual(vscodeTestState.errorLog.length, 1);
    assert.deepStrictEqual(vscodeTestState.quickPickQueue, []);
  });

  test('unexpected facade exception is contained by the command boundary', async () => {
    registerSupportCommands(depsFor([], {
      getStatus: new Error('internal secret'),
    }, { kind: 'configuration', configurationId }));

    await assert.doesNotReject(invoke(SUPPORT_COMMAND_IDS.sync, {}));

    assert.strictEqual(vscodeTestState.errorLog.length, 1);
    assert.ok(!vscodeTestState.errorLog[0]!.includes('internal secret'));
  });
});

async function invoke(commandId: string, argument: unknown): Promise<void> {
  const handler = vscodeTestState.registeredCommandHandlers.get(commandId);
  assert.ok(handler, `missing registered command ${commandId}`);
  await handler(argument);
}

function depsFor(
  calls: FacadeCall[],
  outcomes: Partial<Record<keyof SupportApplicationFacade, unknown>>,
  context: ReturnType<Parameters<typeof registerSupportCommands>[0]['resolveContext']> = undefined,
): Parameters<typeof registerSupportCommands>[0] {
  return {
    facade: createFacade(calls, outcomes),
    resolveContext: () => context,
    listTargets: async () => [],
  };
}

function createFacade(
  calls: FacadeCall[],
  outcomes: Partial<Record<keyof SupportApplicationFacade, unknown>>,
): SupportApplicationFacade {
  const invokeFacade = async (
    method: keyof SupportApplicationFacade,
    request: unknown,
  ): Promise<any> => {
    calls.push({ method, request });
    const outcome = outcomes[method];
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome ?? {
      status: 'operationRejected',
      errorCode: 'SUPPORT_OPERATION_FAILED',
      retryable: true,
    };
  };
  return {
    getStatus: (request) => invokeFacade('getStatus', request),
    getMasterStatus: (request) => invokeFacade('getMasterStatus', request),
    setObjectMode: (request) => invokeFacade('setObjectMode', request),
    enableObjectRules: (request) => invokeFacade('enableObjectRules', request),
    sync: (request) => invokeFacade('sync', request),
    verify: (request) => invokeFacade('verify', request),
    getLastRun: (request) => invokeFacade('getLastRun', request),
  };
}

function readyStatus(
  configurationId: ConfigurationId,
  objectId: string,
  mode: 'notEditable' | 'editableWithSupport' | 'removedFromSupport',
  globalEditability: 'enabled' | 'disabled',
): SupportStatusResult {
  return {
    status: 'available',
    master: {
      kind: 'ready',
      snapshot: snapshot(configurationId, objectId, mode, globalEditability),
    },
    metadataUniverse: {
      configRoot: path.resolve('configuration'),
      metadataUniverseGenerationId: 'universe-ui',
      entries: [],
    },
  };
}

function snapshot(
  configurationId: ConfigurationId,
  objectId: string,
  mode: 'notEditable' | 'editableWithSupport' | 'removedFromSupport',
  globalEditability: 'enabled' | 'disabled',
): MasterSupportSnapshot {
  return {
    configurationId,
    generationId: 'generation-ui',
    semanticDigest: 'a'.repeat(64),
    filePath: path.resolve('Ext', 'ParentConfigurations.bin'),
    formatRevision: '6',
    globalEditability,
    configurationMode: mode === 'notEditable' ? 'locked' : 'editable',
    objectModes: new Map([[
      objectId,
      {
        objectId,
        locked: mode === 'notEditable',
        effectiveMode: mode,
        sources: [],
      },
    ]]),
    supplierConfigurations: [],
  };
}

function synchronizedMutation(): unknown {
  return {
    status: 'synchronized',
    preflight: {
      accepted: true,
      scope: 'masterOnly',
      targets: [],
    },
  };
}
