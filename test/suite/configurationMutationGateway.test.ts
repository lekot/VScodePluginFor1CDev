import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  configureConfigurationMutationGateway,
  resetConfigurationMutationGateway,
  runConfigurationMutation,
  runConfigurationMutationOutcome,
  runConfigurationPlan,
  runConfigurationPlanOutcome,
  runExclusiveConfigurationOperation,
} from '../../src/services/configurationSession/configurationMutationGateway';
import {
  ConfigurationSession,
  type MutationExecutionOptions,
  type MutationOutcome,
} from '../../src/services/configurationSession/ConfigurationSession';
import { ConfigFormat } from '../../src/parsers/formatDetector';
import { hashContent } from '../../src/services/configurationSession/atomicFileStorage';
import { MutationPlan, MutationPlanExecutor } from '../../src/services/configurationSession/mutationPlan';

suite('configurationMutationGateway', () => {
  test('delegates nested mutation requests to the session adapter even for the same configuration root', async () => {
    const invocations: string[] = [];
    const gateway = configureConfigurationMutationGateway(
      async (resourcePath, _kind, op) => {
        invocations.push(resourcePath);
        return op();
      },
      async (_p, plan) => plan.result,
    );

    try {
      const fileA = '/workspace/project/Subsystem.xml';
      const fileB = '/workspace/project/CommonAttribute.xml';

      await runConfigurationMutation(fileA, 'ui.save', async () => {
        await runConfigurationMutation(fileB, 'ui.nested', async () => {
          return 42;
        });
      });

      assert.deepStrictEqual(invocations, [fileA, fileB]);
    } finally {
      gateway.dispose();
    }
  });

  test('distinct configuration roots invoke mutationRunner separately', async () => {
    const invocations: string[] = [];
    const gateway = configureConfigurationMutationGateway(
      async (resourcePath, _kind, op) => {
        invocations.push(resourcePath);
        return op();
      },
      async (_p, plan) => plan.result,
    );

    try {
      const config1 = '/workspace/project1/Configuration.xml';
      const config2 = '/workspace/project2/Configuration.xml';

      await runConfigurationMutation(config1, 'ui.save', async () => {
        await runConfigurationMutation(config2, 'ui.other', async () => {
          return 42;
        });
      });

      assert.deepStrictEqual(invocations, [config1, config2]);
    } finally {
      gateway.dispose();
    }
  });

  test('delegates same-root candidates without guessing configuration ownership from path case on POSIX', async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    const invocations: string[] = [];
    const gateway = configureConfigurationMutationGateway(
      async (resourcePath, _kind, op) => {
        invocations.push(resourcePath);
        return op();
      },
      async (_p, plan) => plan.result,
    );

    try {
      const configRootA = '/workspace/Config/Configuration.xml';
      const configRootB = '/workspace/config/Configuration.xml';

      await runConfigurationMutation(configRootA, 'test.mutation', async () => {
        await runConfigurationMutation(configRootB, 'test.nested', async () => {
          return 'done';
        });
      });

      assert.deepStrictEqual(invocations, [configRootA, configRootB]);
    } finally {
      gateway.dispose();
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    }
  });

  test('delegates case-variant paths to the session adapter on Windows as well', async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const invocations: string[] = [];
    const gateway = configureConfigurationMutationGateway(
      async (resourcePath, _kind, op) => {
        invocations.push(resourcePath);
        return op();
      },
      async (_p, plan) => plan.result,
    );

    try {
      const configRootA = 'C:\\workspace\\Config\\Configuration.xml';
      const configRootB = 'c:\\workspace\\config\\Configuration.xml';

      await runConfigurationMutation(configRootA, 'test.mutation', async () => {
        await runConfigurationMutation(configRootB, 'test.nested', async () => {
          return 'done';
        });
      });

      assert.deepStrictEqual(invocations, [configRootA, configRootB]);
    } finally {
      gateway.dispose();
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    }
  });

  test('runExclusiveConfigurationOperation routes through runConfigurationMutation', async () => {
    let called = false;
    const gateway = configureConfigurationMutationGateway(
      async (_path, kind, op) => {
        called = true;
        assert.strictEqual(kind, 'exclusive.test');
        return op();
      },
      async (_p, plan) => plan.result,
    );

    try {
      await runExclusiveConfigurationOperation('/workspace/project/file.xml', 'exclusive.test', async () => {
        return 'ok';
      });
      assert.strictEqual(called, true);
    } finally {
      gateway.dispose();
    }
  });

  test('routes typed mutation and plan outcomes with execution metadata and fails closed without outcome runners', async () => {
    const sentinel = configureConfigurationMutationGateway(
      async (_path, _kind, operation) => operation(),
      async (_path, plan) => plan.result,
    );
    resetConfigurationMutationGateway();

    try {
      await assert.rejects(
        runConfigurationMutationOutcome('/workspace/project/Configuration.xml', 'test.outcome', async () => 'unused'),
        (error: any) => error?.code === 'RUNNER_NOT_CONFIGURED',
      );
      await assert.rejects(
        runConfigurationPlanOutcome('/workspace/project/Configuration.xml', {
          kind: 'test.outcome-plan', steps: [], result: 'unused',
        }),
        (error: any) => error?.code === 'RUNNER_NOT_CONFIGURED',
      );

      const mutationOptions: MutationExecutionOptions<string> = {
        reconcile: false,
        commitWhen: (value) => value === 'mutation-result',
      };
      const planOptions: MutationExecutionOptions<string> = {
        shouldReconcile: (outcome) => outcome.status === 'committed',
      };
      let observedMutationOptions: MutationExecutionOptions<string> | undefined;
      let observedPlanOptions: MutationExecutionOptions<string> | undefined;
      const configured = configureConfigurationMutationGateway(
        async (_path, _kind, operation) => operation(),
        async (_path, plan) => plan.result,
        async <T>(
          _path: string,
          _kind: string,
          operation: () => Promise<T>,
          options?: MutationExecutionOptions<T>,
        ): Promise<MutationOutcome<T>> => {
          observedMutationOptions = options as MutationExecutionOptions<string> | undefined;
          return {
            configurationId: 'gateway-outcome-cfg' as never,
            operationId: 'gateway-mutation-operation',
            snapshotVersion: 4,
            status: 'committed',
            value: await operation(),
          };
        },
        async <T>(
          _path: string,
          plan: MutationPlan<T>,
          options?: MutationExecutionOptions<T>,
        ): Promise<MutationOutcome<T>> => {
          observedPlanOptions = options as MutationExecutionOptions<string> | undefined;
          return {
            configurationId: 'gateway-outcome-cfg' as never,
            operationId: 'gateway-plan-operation',
            snapshotVersion: 5,
            status: 'committed',
            value: plan.result,
          };
        },
      );
      try {
        const mutation = await runConfigurationMutationOutcome(
          '/workspace/project/Configuration.xml',
          'test.outcome',
          async () => 'mutation-result',
          mutationOptions,
        );
        const plan = await runConfigurationPlanOutcome('/workspace/project/Configuration.xml', {
          kind: 'test.outcome-plan', steps: [], result: 'plan-result',
        }, planOptions);

        assert.strictEqual(mutation.status, 'committed');
        assert.strictEqual(mutation.value, 'mutation-result');
        assert.strictEqual(mutation.operationId, 'gateway-mutation-operation');
        assert.strictEqual(plan.status, 'committed');
        assert.strictEqual(plan.value, 'plan-result');
        assert.strictEqual(plan.operationId, 'gateway-plan-operation');
        assert.strictEqual(observedMutationOptions, mutationOptions);
        assert.strictEqual(observedPlanOptions, planOptions);
      } finally {
        configured.dispose();
      }
    } finally {
      sentinel.dispose();
    }
  });

  test('#206: runConfigurationMutation fails closed when runner is not configured', async () => {
    let mutationCalls = 0;
    let planCalls = 0;
    const sentinel = configureConfigurationMutationGateway(
      async (_path, _kind, operation) => {
        mutationCalls++;
        return operation();
      },
      async (_path, plan) => {
        planCalls++;
        return plan.result;
      },
    );
    const scopedGateway = configureConfigurationMutationGateway(
      async (_path, _kind, operation) => operation(),
      async (_path, plan) => plan.result,
    );

    try {
      resetConfigurationMutationGateway();
      try {
        await assert.rejects(
          runConfigurationMutation('/workspace/project/file.xml', 'test.unconfigured', async () => 'mutated'),
          (err: any) => {
            assert.strictEqual(err.name, 'ConfigurationMutationGatewayError');
            assert.strictEqual(err.code, 'RUNNER_NOT_CONFIGURED');
            return true;
          },
        );
      } finally {
        scopedGateway.dispose();
      }

      const mutationResult = await runConfigurationMutation(
        '/workspace/project/sentinel.xml',
        'test.restored-sentinel',
        async () => 'sentinel mutation',
      );
      const planResult = await runConfigurationPlan('/workspace/project/sentinel.xml', {
        kind: 'test.restored-sentinel-plan',
        steps: [],
        result: 'sentinel plan',
      });
      assert.strictEqual(mutationResult, 'sentinel mutation');
      assert.strictEqual(planResult, 'sentinel plan');
      assert.strictEqual(mutationCalls, 1, 'The previous mutation adapter must be restored');
      assert.strictEqual(planCalls, 1, 'The previous plan adapter must be restored');
    } finally {
      sentinel.dispose();
    }
  });

  test('#206: ConfigurationSession.enqueue enforces capabilities.write and fails closed on read-only session', async () => {
    const session = new ConfigurationSession({
      configurationId: 'read-only-cfg' as any,
      rootPath: '/workspace/project',
      rootUri: 'file:///workspace/project',
      descriptorUri: 'file:///workspace/project/Configuration.xml',
      workspaceFolderUris: ['file:///workspace'],
      format: ConfigFormat.Designer,
      capabilities: { read: true, write: false, process: true },
    });

    const outcome = await session.enqueue({
      kind: 'test.write',
      execute: async () => 'done',
    });

    assert.strictEqual(outcome.status, 'conflict');
    assert.strictEqual((outcome as any).code, 'CONFIGURATION_CAPABILITY_UNSUPPORTED');
  });

  test('standalone plans fail closed with a typed error when no marker identifies the configuration root', async () => {
    const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gateway-no-marker-'));
    const inputDir = path.join(rootPath, 'input');
    const resourcePath = path.join(inputDir, 'Form.xml');
    const outsideTarget = path.join(rootPath, 'outside.xml');
    await fs.promises.mkdir(inputDir, { recursive: true });
    await fs.promises.writeFile(resourcePath, '<Form/>', 'utf8');

    const gateway = configureConfigurationMutationGateway(async (_path, _kind, operation) => operation());
    try {
      await assert.rejects(
        runConfigurationPlan(resourcePath, {
          kind: 'gateway.no-root',
          steps: [{
            type: 'writeFile',
            targetPath: outsideTarget,
            content: 'UNEXPECTED',
            encoding: 'utf8',
            expected: { state: 'missing' },
          }],
          result: 'committed',
        }),
        (error: any) => {
          assert.strictEqual(error.name, 'ConfigurationMutationGatewayError');
          assert.strictEqual(error.code, 'CONFIGURATION_ROOT_NOT_FOUND');
          return true;
        },
      );
      assert.strictEqual(fs.existsSync(outsideTarget), false, 'A plan without trusted context must not write its target');
    } finally {
      gateway.dispose();
      await fs.promises.rm(rootPath, { recursive: true, force: true });
    }
  });

  test('standalone root discovery ignores directory entries named as Designer and EDT markers', async () => {
    const markerPaths = [
      'Configuration.xml',
      path.join('src', 'Configuration', 'Configuration.mdo'),
    ];
    const gateway = configureConfigurationMutationGateway(async (_path, _kind, operation) => operation());

    try {
      for (const markerPath of markerPaths) {
        const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gateway-invalid-marker-'));
        const resourcePath = path.join(rootPath, 'input', 'Form.xml');
        const targetPath = path.join(rootPath, 'result.xml');
        await fs.promises.mkdir(path.join(rootPath, markerPath), { recursive: true });
        await fs.promises.mkdir(path.dirname(resourcePath), { recursive: true });
        await fs.promises.writeFile(resourcePath, '<Form/>', 'utf8');

        try {
          await assert.rejects(
            runConfigurationPlan(resourcePath, {
              kind: 'gateway.invalid-marker',
              steps: [{
                type: 'writeFile',
                targetPath,
                content: 'UNEXPECTED',
                encoding: 'utf8',
                expected: { state: 'missing' },
              }],
              result: 'committed',
            }),
            (error: any) => error.code === 'CONFIGURATION_ROOT_NOT_FOUND',
            `Directory marker ${markerPath} must not grant a plan root`,
          );
          assert.strictEqual(fs.existsSync(targetPath), false);
        } finally {
          await fs.promises.rm(rootPath, { recursive: true, force: true });
        }
      }
    } finally {
      gateway.dispose();
    }
  });

  test('standalone plans accept real Designer and EDT marker files', async () => {
    const markerPaths = [
      'Configuration.xml',
      path.join('src', 'Configuration', 'Configuration.mdo'),
    ];
    const gateway = configureConfigurationMutationGateway(async (_path, _kind, operation) => operation());

    try {
      for (const markerPath of markerPaths) {
        const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gateway-valid-marker-'));
        const resourcePath = path.join(rootPath, 'input', 'Form.xml');
        const targetPath = path.join(rootPath, 'result.xml');
        await fs.promises.mkdir(path.dirname(path.join(rootPath, markerPath)), { recursive: true });
        await fs.promises.mkdir(path.dirname(resourcePath), { recursive: true });
        await fs.promises.writeFile(path.join(rootPath, markerPath), '<Configuration/>', 'utf8');
        await fs.promises.writeFile(resourcePath, '<Form/>', 'utf8');

        try {
          const result = await runConfigurationPlan(resourcePath, {
            kind: 'gateway.valid-marker',
            steps: [{
              type: 'writeFile',
              targetPath,
              content: markerPath,
              encoding: 'utf8',
              expected: { state: 'missing' },
            }],
            result: 'committed',
          });
          assert.strictEqual(result, 'committed');
          assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), markerPath);
        } finally {
          await fs.promises.rm(rootPath, { recursive: true, force: true });
        }
      }
    } finally {
      gateway.dispose();
    }
  });

  test('standalone plans canonicalize the marker root before validating paths', async () => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gateway-canonical-root-'));
    const rootPath = path.join(tempRoot, 'configuration');
    const aliasPath = path.join(tempRoot, 'configuration-alias');
    const resourcePath = path.join(aliasPath, 'input', 'Form.xml');
    const targetPath = path.join(aliasPath, 'result.xml');
    await fs.promises.mkdir(path.join(rootPath, 'input'), { recursive: true });
    await fs.promises.writeFile(path.join(rootPath, 'Configuration.xml'), '<Configuration/>', 'utf8');
    await fs.promises.writeFile(path.join(rootPath, 'input', 'Form.xml'), '<Form/>', 'utf8');
    await fs.promises.symlink(rootPath, aliasPath, 'junction');

    const gateway = configureConfigurationMutationGateway(async (_path, _kind, operation) => operation());
    const originalExecute = MutationPlanExecutor.prototype.execute;
    let executorRoot: string | undefined;
    MutationPlanExecutor.prototype.execute = function <T>(
      this: MutationPlanExecutor,
      plan: MutationPlan<T>,
      operationId?: string,
    ): Promise<T> {
      executorRoot = (this as unknown as { rootPath: string }).rootPath;
      return originalExecute.call(this, plan, operationId) as Promise<T>;
    };
    try {
      const result = await runConfigurationPlan(resourcePath, {
        kind: 'gateway.canonical-root',
        steps: [{
          type: 'writeFile',
          targetPath,
          content: 'CANONICAL ROOT',
          encoding: 'utf8',
          expected: { state: 'missing' },
        }],
        result: 'committed',
      });

      assert.strictEqual(result, 'committed');
      assert.strictEqual(await fs.promises.readFile(path.join(rootPath, 'result.xml'), 'utf8'), 'CANONICAL ROOT');
      assert.strictEqual(executorRoot, await fs.promises.realpath(rootPath));
    } finally {
      MutationPlanExecutor.prototype.execute = originalExecute;
      gateway.dispose();
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('standalone marker root rejects outside write targets and move sources', async () => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gateway-root-boundary-'));
    const rootPath = path.join(tempRoot, 'configuration');
    const resourcePath = path.join(rootPath, 'input', 'Form.xml');
    const outsideTarget = path.join(tempRoot, 'outside.xml');
    const outsideSource = path.join(tempRoot, 'outside-source.xml');
    const moveTarget = path.join(rootPath, 'moved.xml');
    const sourceContent = 'OUTSIDE SOURCE';
    const junctionDir = path.join(rootPath, 'linked-outside');
    const outsideDir = path.join(tempRoot, 'outside-directory');
    const junctionTarget = path.join(junctionDir, 'target.xml');
    const junctionSource = path.join(junctionDir, 'source.xml');
    const junctionMoveTarget = path.join(rootPath, 'junction-moved.xml');
    await fs.promises.mkdir(path.dirname(resourcePath), { recursive: true });
    await fs.promises.mkdir(outsideDir, { recursive: true });
    await fs.promises.writeFile(path.join(rootPath, 'Configuration.xml'), '<Configuration/>', 'utf8');
    await fs.promises.writeFile(resourcePath, '<Form/>', 'utf8');
    await fs.promises.writeFile(outsideSource, sourceContent, 'utf8');
    await fs.promises.writeFile(path.join(outsideDir, 'source.xml'), sourceContent, 'utf8');
    await fs.promises.symlink(outsideDir, junctionDir, 'junction');

    const gateway = configureConfigurationMutationGateway(async (_path, _kind, operation) => operation());
    try {
      await assert.rejects(runConfigurationPlan(resourcePath, {
        kind: 'gateway.outside-target',
        steps: [{
          type: 'writeFile',
          targetPath: outsideTarget,
          content: 'OUTSIDE TARGET',
          encoding: 'utf8',
          expected: { state: 'missing' },
        }],
        result: 'committed',
      }));
      assert.strictEqual(fs.existsSync(outsideTarget), false);

      await assert.rejects(runConfigurationPlan(resourcePath, {
        kind: 'gateway.junction-target',
        steps: [{
          type: 'writeFile',
          targetPath: junctionTarget,
          content: 'OUTSIDE JUNCTION TARGET',
          encoding: 'utf8',
          expected: { state: 'missing' },
        }],
        result: 'committed',
      }));
      assert.strictEqual(fs.existsSync(path.join(outsideDir, 'target.xml')), false);

      await assert.rejects(runConfigurationPlan(resourcePath, {
        kind: 'gateway.outside-source',
        steps: [{
          type: 'movePath',
          sourcePath: outsideSource,
          targetPath: moveTarget,
          sourceExpected: { state: 'file', hash: hashContent(sourceContent) },
          targetExpected: { state: 'missing' },
        }],
        result: 'committed',
      }));
      assert.strictEqual(await fs.promises.readFile(outsideSource, 'utf8'), sourceContent);
      assert.strictEqual(fs.existsSync(moveTarget), false);

      await assert.rejects(runConfigurationPlan(resourcePath, {
        kind: 'gateway.junction-source',
        steps: [{
          type: 'movePath',
          sourcePath: junctionSource,
          targetPath: junctionMoveTarget,
          sourceExpected: { state: 'file', hash: hashContent(sourceContent) },
          targetExpected: { state: 'missing' },
        }],
        result: 'committed',
      }));
      assert.strictEqual(await fs.promises.readFile(path.join(outsideDir, 'source.xml'), 'utf8'), sourceContent);
      assert.strictEqual(fs.existsSync(junctionMoveTarget), false);
    } finally {
      gateway.dispose();
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

