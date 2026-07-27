import * as assert from 'assert';
import '../helpers/vscodeStubRegister';
import {
  AGENT_SUPPORT_COMMAND_IDS,
  AGENT_SUPPORT_COMMAND_REGISTRATIONS,
  AgentSupportOperations,
} from '../../src/agent/agentSupportOperations';
import type { SupportApplicationFacade } from '../../src/support/supportApplicationServiceRegistry';

type FacadeCall = {
  readonly method: keyof SupportApplicationFacade;
  readonly request: unknown;
};

suite('AgentSupportOperations', () => {
  test('publishes exactly six stable Agent command registrations', () => {
    assert.deepStrictEqual(AGENT_SUPPORT_COMMAND_REGISTRATIONS, [
      { operation: 'supportGetStatus', command: AGENT_SUPPORT_COMMAND_IDS.getStatus },
      { operation: 'supportSetObjectMode', command: AGENT_SUPPORT_COMMAND_IDS.setObjectMode },
      { operation: 'supportEnableObjectRules', command: AGENT_SUPPORT_COMMAND_IDS.enableObjectRules },
      { operation: 'supportSync', command: AGENT_SUPPORT_COMMAND_IDS.sync },
      { operation: 'supportVerify', command: AGENT_SUPPORT_COMMAND_IDS.verify },
      { operation: 'supportGetLastRun', command: AGENT_SUPPORT_COMMAND_IDS.getLastRun },
    ]);
    assert.strictEqual(new Set(AGENT_SUPPORT_COMMAND_REGISTRATIONS.map((item) => item.command)).size, 6);
  });

  test('getStatus forwards optional selectors and serializes support maps', async () => {
    const calls: FacadeCall[] = [];
    const facade = createFacade(calls, {
      getStatus: {
        status: 'available',
        master: {
          kind: 'ready',
          snapshot: {
            objectModes: new Map([
              ['object-1', { objectId: 'object-1', locked: true, effectiveMode: 'notEditable' }],
            ]),
          },
        },
      },
    });
    const operations = new AgentSupportOperations({ facade });

    const result = await operations.supportGetStatus({
      configurationId: 'cfg',
      objectIds: ['object-1'],
    });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(calls, [{
      method: 'getStatus',
      request: { configurationId: 'cfg', objectIds: ['object-1'] },
    }]);
    assert.deepStrictEqual((result.data as any).master.snapshot.objectModes, {
      'object-1': { objectId: 'object-1', locked: true, effectiveMode: 'notEditable' },
    });
    assert.doesNotThrow(() => JSON.stringify(result));
  });

  test('setObjectMode and enableObjectRules forward every CAS field unchanged', async () => {
    const calls: FacadeCall[] = [];
    const facade = createFacade(calls, {
      setObjectMode: { status: 'synchronized', marker: 'set' },
      enableObjectRules: { status: 'synchronized', marker: 'enable' },
    });
    const operations = new AgentSupportOperations({ facade });

    const setResult = await operations.supportSetObjectMode({
      configurationId: 'cfg',
      objectId: '11111111-1111-1111-1111-111111111111',
      targetMode: 'editableWithSupport',
      expectedGenerationId: 'a'.repeat(64),
    });
    const enableResult = await operations.supportEnableObjectRules({
      configurationId: 'cfg',
      targetObjectId: '22222222-2222-2222-2222-222222222222',
      targetMode: 'removedFromSupport',
      expectedGenerationId: 'b'.repeat(64),
      expectedMetadataUniverseGenerationId: 'c'.repeat(64),
    });

    assert.strictEqual(setResult.success, true);
    assert.strictEqual(enableResult.success, true);
    assert.deepStrictEqual(calls, [
      {
        method: 'setObjectMode',
        request: {
          configurationId: 'cfg',
          objectId: '11111111-1111-1111-1111-111111111111',
          targetMode: 'editableWithSupport',
          expectedGenerationId: 'a'.repeat(64),
        },
      },
      {
        method: 'enableObjectRules',
        request: {
          configurationId: 'cfg',
          targetObjectId: '22222222-2222-2222-2222-222222222222',
          targetMode: 'removedFromSupport',
          expectedGenerationId: 'b'.repeat(64),
          expectedMetadataUniverseGenerationId: 'c'.repeat(64),
        },
      },
    ]);
  });

  test('sync and verify preserve exact target selectors and verification policy', async () => {
    const calls: FacadeCall[] = [];
    const facade = createFacade(calls, {
      sync: { status: 'synchronized', marker: 'sync' },
      verify: { status: 'synchronized', marker: 'verify' },
    });
    const operations = new AgentSupportOperations({ facade });
    const targets = {
      kind: 'ids' as const,
      targetIds: ['file:C:/db/main', 'server:host/db'],
    };

    const syncResult = await operations.supportSync({
      configurationId: 'cfg',
      targets,
      verification: 'strict',
    });
    const verifyResult = await operations.supportVerify({
      configurationId: 'cfg',
      targets: { kind: 'all' },
    });

    assert.strictEqual(syncResult.success, true);
    assert.strictEqual(verifyResult.success, true);
    assert.deepStrictEqual(calls, [
      {
        method: 'sync',
        request: { configurationId: 'cfg', targets, verification: 'strict' },
      },
      {
        method: 'verify',
        request: { configurationId: 'cfg', targets: { kind: 'all' } },
      },
    ]);
  });

  test('getLastRun is successful only for available outcome', async () => {
    const calls: FacadeCall[] = [];
    const operations = new AgentSupportOperations({
      facade: createFacade(calls, {
        getLastRun: { status: 'available', run: { runId: 'run-1' } },
      }),
    });

    const result = await operations.supportGetLastRun({ configurationId: 'cfg' });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(calls, [{
      method: 'getLastRun',
      request: { configurationId: 'cfg' },
    }]);
    assert.strictEqual((result.data as any).run.runId, 'run-1');
  });

  test('failed facade outcomes keep data and expose direct or preflight error codes', async () => {
    const direct = new AgentSupportOperations({
      facade: createFacade([], {
        getStatus: {
          status: 'operationRejected',
          errorCode: 'SUPPORT_FILE_INVALID',
          retryable: false,
        },
      }),
    });
    const preflight = new AgentSupportOperations({
      facade: createFacade([], {
        sync: {
          status: 'preflightRejected',
          preflight: {
            accepted: false,
            errorCode: 'SUPPORT_TARGET_UNSUPPORTED',
          },
        },
      }),
    });

    const directResult = await direct.supportGetStatus({ configurationId: 'cfg' });
    const preflightResult = await preflight.supportSync({
      configurationId: 'cfg',
      targets: { kind: 'all' },
    });

    assert.strictEqual(directResult.success, false);
    assert.strictEqual(directResult.code, 'SUPPORT_FILE_INVALID');
    assert.strictEqual(directResult.data.status, 'operationRejected');
    assert.strictEqual(preflightResult.success, false);
    assert.strictEqual(preflightResult.code, 'SUPPORT_TARGET_UNSUPPORTED');
    assert.strictEqual(preflightResult.data.status, 'preflightRejected');
  });
});

function createFacade(
  calls: FacadeCall[],
  outcomes: Partial<Record<keyof SupportApplicationFacade, unknown>>,
): SupportApplicationFacade {
  const invoke = async (method: keyof SupportApplicationFacade, request: unknown): Promise<any> => {
    calls.push({ method, request });
    const outcome = outcomes[method];
    if (outcome === undefined) {
      return {
        status: 'operationRejected',
        errorCode: 'SUPPORT_OPERATION_FAILED',
        retryable: false,
      };
    }
    return outcome;
  };
  return {
    getStatus: (request) => invoke('getStatus', request),
    setObjectMode: (request) => invoke('setObjectMode', request),
    enableObjectRules: (request) => invoke('enableObjectRules', request),
    sync: (request) => invoke('sync', request),
    verify: (request) => invoke('verify', request),
    getLastRun: (request) => invoke('getLastRun', request),
  };
}
