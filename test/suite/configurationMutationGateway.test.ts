import * as assert from 'assert';
import {
  configureConfigurationMutationGateway,
  runConfigurationMutation,
  runExclusiveConfigurationOperation,
} from '../../src/services/configurationSession/configurationMutationGateway';

suite('configurationMutationGateway', () => {
  test('nested mutation within the same configuration root re-uses lease and bypasses mutationRunner', async () => {
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

      assert.deepStrictEqual(invocations, [fileA]);
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

  test('on POSIX, roots differing only by case are treated as distinct configurations and do not bypass mutationRunner', async () => {
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

      // On POSIX, /workspace/Config and /workspace/config are distinct configurations;
      // second call must NOT be treated as a nested lease and must run via mutationRunner
      assert.deepStrictEqual(invocations, [configRootA, configRootB]);
    } finally {
      gateway.dispose();
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    }
  });

  test('on Windows, roots differing only by case share the active lease and avoid nested FIFO re-entrancy', async () => {
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

      assert.deepStrictEqual(invocations, [configRootA]);
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
});
