import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import {
  ConfigurationMutationEngine,
  setConfigurationMutationEngine,
  type MutationOutcomeStatus,
  type MutationReceipt,
  type SingleFileMutationIntent,
  type SingleFileTransform,
} from '../../src/services/configurationSession/ConfigurationMutationEngine';
import { applySubsystemCompositionFileUpdate } from '../../src/services/subsystemCompositionFileUpdater';

const CONTRACT_MODULE = path.resolve(
  __dirname,
  '../../src/services/configurationSession/mutationReceiptError',
);

function createReceipt<T>(
  status: MutationOutcomeStatus,
  options: { code?: string; message?: string; result?: T } = {},
): MutationReceipt<T> {
  return {
    status,
    kind: 'test.mutation',
    resourcePath: path.join(os.tmpdir(), 'mutation-receipt-test.xml'),
    ...options,
  };
}

suite('Mutation receipt adapter contract (#296)', () => {
  test('unwraps committed result and keeps receipt revision data available to adapters', () => {
    const { unwrapMutationReceipt } = require(CONTRACT_MODULE) as {
      unwrapMutationReceipt<T>(receipt: MutationReceipt<T>, message?: string): T;
    };
    const result = { refs: ['Catalog.Products'] };
    const receipt = {
      ...createReceipt('committed', { result }),
      oldRevision: 'before',
      newRevision: 'after',
    };

    assert.strictEqual(unwrapMutationReceipt(receipt), result);
    assert.strictEqual(receipt.oldRevision, 'before');
    assert.strictEqual(receipt.newRevision, 'after');
  });

  test('preserves every noncommitted outcome and assigns stable fallback codes', () => {
    const { MutationReceiptError, unwrapMutationReceipt } = require(CONTRACT_MODULE) as {
      MutationReceiptError: new (receipt: MutationReceipt<unknown>, message?: string) => Error & {
        receipt: MutationReceipt<unknown>;
        status: MutationOutcomeStatus;
        code: string;
      };
      unwrapMutationReceipt<T>(receipt: MutationReceipt<T>, message?: string): T;
    };
    const expectedCodes: Record<Exclude<MutationOutcomeStatus, 'committed'>, string> = {
      conflict: 'MUTATION_CONFLICT',
      rolledBack: 'MUTATION_ROLLED_BACK',
      recoveryRequired: 'MUTATION_RECOVERY_REQUIRED',
      inDoubt: 'MUTATION_IN_DOUBT',
    };

    for (const status of Object.keys(expectedCodes) as Array<keyof typeof expectedCodes>) {
      const receipt = createReceipt(status, { message: `engine ${status}` });
      assert.throws(
        () => unwrapMutationReceipt(receipt, `context ${status}`),
        (error: unknown) => {
          assert.ok(error instanceof MutationReceiptError);
          const typedError = error as InstanceType<typeof MutationReceiptError>;
          assert.strictEqual(typedError.receipt, receipt);
          assert.strictEqual(typedError.status, status);
          assert.strictEqual(typedError.code, expectedCodes[status]);
          if (status === 'recoveryRequired' || status === 'inDoubt') {
            assert.ok(typedError.message.startsWith(`context ${status}`));
            assert.match(typedError.message, /изменения могли сохраниться/i);
          } else {
            assert.strictEqual(typedError.message, `context ${status}`);
          }
          return true;
        },
      );
    }

    const uncertainWithoutContext = new MutationReceiptError(createReceipt('inDoubt'));
    assert.match(uncertainWithoutContext.message, /результат изменения не подтверждён/i);
    assert.match(uncertainWithoutContext.message, /восстановление конфигурации/i);
  });

  test('projects all outcomes and warns when recovery or effect is uncertain', () => {
    const { MutationReceiptError, projectMutationFailure } = require(CONTRACT_MODULE) as {
      MutationReceiptError: new (receipt: MutationReceipt<unknown>, message?: string) => Error;
      projectMutationFailure(error: unknown): {
        status: Exclude<MutationOutcomeStatus, 'committed'>;
        code: string;
        effectPossible: boolean;
        message: string;
      } | undefined;
    };
    const expected: Array<{
      status: Exclude<MutationOutcomeStatus, 'committed'>;
      effectPossible: boolean;
    }> = [
      { status: 'conflict', effectPossible: false },
      { status: 'rolledBack', effectPossible: false },
      { status: 'recoveryRequired', effectPossible: true },
      { status: 'inDoubt', effectPossible: true },
    ];

    for (const item of expected) {
      const receipt = createReceipt(item.status, { code: 'ENGINE_CODE', message: 'engine detail' });
      const error = new MutationReceiptError(receipt, `контекст ${item.status}`);
      const projection = projectMutationFailure(error);
      assert.ok(projection);
      assert.strictEqual(projection.status, item.status);
      assert.strictEqual(projection.code, 'ENGINE_CODE');
      assert.strictEqual(projection.effectPossible, item.effectPossible);
      assert.strictEqual(projection.message, error.message);
      if (item.effectPossible) {
        assert.match(projection.message, /изменения могли сохраниться/i);
        assert.match(projection.message, /проверьте|проверка/i);
        assert.match(projection.message, /восстанов/i);
      } else {
        assert.ok(!/могли сохраниться|восстанов/i.test(projection.message));
      }
    }
  });

  test('does not invent a mutation outcome for generic failures', () => {
    const { projectMutationFailure } = require(CONTRACT_MODULE) as {
      projectMutationFailure(error: unknown): unknown;
    };

    assert.strictEqual(projectMutationFailure(new Error('ordinary failure')), undefined);
    assert.strictEqual(projectMutationFailure({ status: 'recoveryRequired', code: 'RECOVERY_REQUIRED' }), undefined);
  });

  test('a real subsystem composition updater caller keeps its typed conflict and contextual message', async () => {
    const engine = new ConfigurationMutationEngine();
    const receipt = createReceipt('conflict', {
      code: 'CONCURRENT_CREATE_COLLISION',
      message: 'collision detail',
    });
    engine.transformFile = async <T>(
      _target: string,
      _intent: SingleFileMutationIntent,
      _transform: SingleFileTransform<T>,
    ): Promise<MutationReceipt<T>> => receipt as MutationReceipt<T>;
    setConfigurationMutationEngine(engine);

    try {
      await assert.rejects(
        applySubsystemCompositionFileUpdate(receipt.resourcePath, { add: ['Catalog.Products'] }),
        (error: unknown) => {
          const candidate = error as {
            name?: string;
            status?: MutationOutcomeStatus;
            code?: string;
            message?: string;
            receipt?: MutationReceipt<unknown>;
          };
          assert.strictEqual(candidate.name, 'MutationReceiptError');
          assert.strictEqual(candidate.status, 'conflict');
          assert.strictEqual(candidate.code, 'CONCURRENT_CREATE_COLLISION');
          assert.strictEqual(candidate.receipt, receipt);
          assert.ok(candidate.message?.includes(`Конфликт создания файла состава с параллельным процессом: ${receipt.resourcePath}.`));
          assert.ok(candidate.message?.includes('collision detail'));
          return true;
        },
      );
    } finally {
      setConfigurationMutationEngine(undefined);
    }
  });
});
