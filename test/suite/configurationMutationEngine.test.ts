import * as assert from 'assert';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { cleanupTempDir, createTempDir } from '../helpers/testHelpers';
import {
  ConfigurationMutationEngine,
  type MutationReceipt,
  type SingleFileTransform,
} from '../../src/services/configurationSession/ConfigurationMutationEngine';
import { hashContent, type AtomicFileSystem } from '../../src/services/configurationSession/atomicFileStorage';
import { ConfigurationSession } from '../../src/services/configurationSession/ConfigurationSession';
import { ConfigFormat } from '../../src/parsers/formatDetector';
import type { ConfigurationContext, ConfigurationId } from '../../src/services/configurationSession/types';
import { ConfigurationContextResolver } from '../../src/services/configurationSession/ConfigurationContextResolver';
import { WorkspaceRegistry } from '../../src/services/configurationSession/WorkspaceRegistry';
import { configureConfigurationMutationGateway } from '../../src/services/configurationSession/configurationMutationGateway';
import { mutateCompositionFile } from '../../src/services/compositionFileMutation';

function createSampleConfigurationXml(name: string = 'TestConfig'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.17">
  <Configuration uuid="00000000-0000-0000-0000-000000000000">
    <Properties>
      <Name>${name}</Name>
    </Properties>
  </Configuration>
</MetaDataObject>`;
}

suite('ConfigurationMutationEngine (#242)', () => {
  let tmpDir: string;
  let configPath: string;
  let disposeMutationGateway: (() => void) | undefined;

  suiteSetup(() => {
    disposeMutationGateway = configureConfigurationMutationGateway(
      async (_resourcePath, _kind, operation) => operation(),
    ).dispose;
  });

  suiteTeardown(() => {
    disposeMutationGateway?.();
  });

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-mutation-engine-');
    configPath = path.join(tmpDir, 'Configuration.xml');
    await fsp.writeFile(configPath, createSampleConfigurationXml(), 'utf-8');
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  suite('Single-file transform (transformFile)', () => {
    test('successfully transforms existing file with CAS and returns committed receipt', async () => {
      const targetFile = path.join(tmpDir, 'Subsystem.xml');
      const initialXml = '<Subsystem><Name>Old</Name></Subsystem>';
      await fsp.writeFile(targetFile, initialXml, 'utf-8');

      const engine = new ConfigurationMutationEngine();
      const initialHash = hashContent(initialXml);

      const receipt: MutationReceipt<string> = await engine.transformFile(
        targetFile,
        {
          kind: 'ui.subsystem.save',
          resourcePath: targetFile,
          expectedRevision: initialHash,
          session: { id: 'sess-1', generation: 2 },
        },
        async ({ exists, content, revision }) => {
          assert.strictEqual(exists, true);
          assert.strictEqual(content, initialXml);
          assert.strictEqual(revision, initialHash);
          return {
            content: '<Subsystem><Name>New</Name></Subsystem>',
            result: 'updated',
          };
        },
      );

      assert.strictEqual(receipt.status, 'committed');
      assert.strictEqual(receipt.result, 'updated');
      assert.strictEqual(receipt.oldRevision, initialHash);
      assert.strictEqual(receipt.newRevision, hashContent('<Subsystem><Name>New</Name></Subsystem>'));
      assert.deepStrictEqual(receipt.session, { id: 'sess-1', generation: 2 });

      const updatedDiskContent = await fsp.readFile(targetFile, 'utf-8');
      assert.strictEqual(updatedDiskContent, '<Subsystem><Name>New</Name></Subsystem>');
    });

    test('returns committed without disk write when content is unchanged', async () => {
      const targetFile = path.join(tmpDir, 'Subsystem.xml');
      const xml = '<Subsystem><Name>Same</Name></Subsystem>';
      await fsp.writeFile(targetFile, xml, 'utf-8');

      const engine = new ConfigurationMutationEngine();
      const hash = hashContent(xml);

      const receipt = await engine.transformFile(
        targetFile,
        { kind: 'ui.subsystem.save', resourcePath: targetFile },
        async ({ content }) => ({ content, result: 'noop' }),
      );

      assert.strictEqual(receipt.status, 'committed');
      assert.strictEqual(receipt.result, 'noop');
      assert.strictEqual(receipt.oldRevision, hash);
      assert.strictEqual(receipt.newRevision, hash);
    });

    test('creates missing file and parent directories atomically (create-if-absent)', async () => {
      const targetFile = path.join(tmpDir, 'Ext', 'Content.xml');
      const engine = new ConfigurationMutationEngine();

      const receipt = await engine.transformFile(
        targetFile,
        { kind: 'ui.exchangePlan.create', resourcePath: targetFile },
        async ({ exists, content }) => {
          assert.strictEqual(exists, false);
          assert.strictEqual(content, '');
          return {
            content: '<Content><Item>Catalog.Goods</Item></Content>',
            result: 'created',
          };
        },
      );

      assert.strictEqual(receipt.status, 'committed');
      assert.strictEqual(receipt.result, 'created');
      assert.strictEqual(receipt.oldRevision, undefined);
      assert.strictEqual(receipt.newRevision, hashContent('<Content><Item>Catalog.Goods</Item></Content>'));

      const diskContent = await fsp.readFile(targetFile, 'utf-8');
      assert.strictEqual(diskContent, '<Content><Item>Catalog.Goods</Item></Content>');
    });

    test('removes a partially written create target when publication fails', async () => {
      const targetFile = path.join(tmpDir, 'Faulted', 'Content.xml');
      let injectedFailure = false;
      const faultingFileSystem: AtomicFileSystem = {
        readFile: (filePath) => fsp.readFile(filePath),
        open: async (filePath, flags) => {
          const handle = await fsp.open(filePath, flags);
          return {
            writeFile: async (data) => {
              injectedFailure = true;
              await handle.writeFile(Buffer.from(data).subarray(0, 4));
              throw new Error('injected partial create write failure');
            },
            sync: () => handle.sync(),
            close: () => handle.close(),
          };
        },
        link: (existingPath, newPath) => fsp.link(existingPath, newPath),
        rename: (oldPath, newPath) => fsp.rename(oldPath, newPath),
        rm: (filePath, options) => fsp.rm(filePath, options),
      };

      const engine = new ConfigurationMutationEngine({
        fileSystem: faultingFileSystem,
        runMutation: async (_resourcePath, _kind, operation) => operation(),
      });
      const receipt = await engine.transformFile(
        targetFile,
        { kind: 'test.create-fault', resourcePath: targetFile },
        async () => ({ content: '<complete-content/>', result: 'created' }),
      );

      assert.strictEqual(injectedFailure, true, 'Fault injection must interrupt the temp-file write');
      assert.strictEqual(receipt.status, 'rolledBack');
      assert.strictEqual(receipt.code, 'WRITE_FAILED');
      await assert.rejects(fsp.readFile(targetFile), { code: 'ENOENT' });
      assert.deepStrictEqual(await fsp.readdir(path.dirname(targetFile)), []);
    });

    test('rejects stale revision with conflict and does not modify disk', async () => {
      const targetFile = path.join(tmpDir, 'Subsystem.xml');
      const xml = '<Subsystem><Name>Initial</Name></Subsystem>';
      await fsp.writeFile(targetFile, xml, 'utf-8');

      const engine = new ConfigurationMutationEngine();

      const receipt = await engine.transformFile(
        targetFile,
        {
          kind: 'ui.subsystem.save',
          resourcePath: targetFile,
          expectedRevision: 'stale-hash-12345',
        },
        async () => ({
          content: '<Subsystem><Name>ShouldNotBeWritten</Name></Subsystem>',
          result: 'bad',
        }),
      );

      assert.strictEqual(receipt.status, 'conflict');
      assert.strictEqual(receipt.code, 'STALE_TARGET_REVISION');
      assert.strictEqual(await fsp.readFile(targetFile, 'utf-8'), xml);
    });

    test('rejects target outside configuration root with conflict', async () => {
      const outsideDir = await createTempDir('1cviewer-outside-');
      const outsideFile = path.join(outsideDir, 'Hacked.xml');
      await fsp.writeFile(outsideFile, '<root/>', 'utf-8');

      try {
        const engine = new ConfigurationMutationEngine();
        // Passing explicit root context where outsideFile is not inside
        const session = new ConfigurationSession({
          configurationId: 'test-cfg' as ConfigurationId,
          rootPath: tmpDir,
          rootUri: `file:///${tmpDir.replace(/\\/g, '/')}`,
          descriptorUri: `file:///${configPath.replace(/\\/g, '/')}`,
          workspaceFolderUris: [`file:///${tmpDir.replace(/\\/g, '/')}`],
          format: ConfigFormat.Designer,
          capabilities: { read: true, write: true, process: true },
        });

        const context: ConfigurationContext = {
          configurationId: 'test-cfg' as ConfigurationId,
          rootPath: tmpDir,
          rootUri: session.identity.rootUri,
          workspaceFolderUri: session.identity.rootUri,
          format: ConfigFormat.Designer,
          capabilities: session.identity.capabilities,
          descriptorUri: session.identity.descriptorUri,
          session,
        };

        const receipt = await engine.transformFile(
          context,
          { kind: 'ui.save', resourcePath: outsideFile },
          async () => ({ content: '<escaped/>', result: 'fail' }),
        );

        assert.strictEqual(receipt.status, 'conflict');
        assert.strictEqual(receipt.code, 'TARGET_OUTSIDE_ROOT');
      } finally {
        await cleanupTempDir(outsideDir);
      }
    });

    test('rejects mutation when expectedConfigurationId does not match', async () => {
      const targetFile = path.join(tmpDir, 'Subsystem.xml');
      await fsp.writeFile(targetFile, '<root/>', 'utf-8');

      const registry = new WorkspaceRegistry();
      await registry.registerTargetedRoot({ configPath: tmpDir, format: ConfigFormat.Designer });

      const resolver = new ConfigurationContextResolver(registry);
      const engine = new ConfigurationMutationEngine({ contextResolver: resolver });

      const receipt = await engine.transformFile(
        targetFile,
        {
          kind: 'ui.save',
          resourcePath: targetFile,
          expectedConfigurationId: 'wrong-cfg-id' as ConfigurationId,
        },
        async () => ({ content: '<changed/>', result: 'fail' }),
      );

      assert.strictEqual(receipt.status, 'conflict');
      assert.strictEqual(receipt.code, 'CONFIGURATION_ID_MISMATCH');
    });

    test('fails closed across mutation APIs when context resolution fails', async () => {
      const targetFile = path.join(tmpDir, 'Subsystem.xml');
      const originalContent = '<root><value>unchanged</value></root>';
      await fsp.writeFile(targetFile, originalContent, 'utf-8');

      const contextResolver = new ConfigurationContextResolver(new WorkspaceRegistry());
      let transformCalls = 0;
      let mutationRunnerCalls = 0;
      let planBuilderCalls = 0;
      let planRunnerCalls = 0;
      let externalRunnerCalls = 0;
      const engine = new ConfigurationMutationEngine({
        contextResolver,
        runMutation: async (_resourcePath, _kind, operation) => {
          mutationRunnerCalls++;
          return operation();
        },
        runPlan: async (_resourcePath, plan) => {
          planRunnerCalls++;
          return plan.result;
        },
      });

      const transformReceipt = await engine.transformFile(
        targetFile,
        {
          kind: 'test.resolver-failure.write',
          resourcePath: targetFile,
          expectedConfigurationId: 'cfg-expected' as ConfigurationId,
        },
        async () => {
          transformCalls++;
          return { content: '<root><value>changed</value></root>', result: 'changed' };
        },
      );
      const planReceipt = await engine.executePlan(
        tmpDir,
        { kind: 'test.resolver-failure.plan', expectedConfigurationId: 'cfg-expected' as ConfigurationId },
        () => {
          planBuilderCalls++;
          return { kind: 'test.resolver-failure.plan', steps: [], result: 'planned' };
        },
      );
      const externalReceipt = await engine.executeExternal(
        tmpDir,
        { kind: 'test.resolver-failure.process', expectedConfigurationId: 'cfg-expected' as ConfigurationId },
        async () => {
          externalRunnerCalls++;
          return 'ran';
        },
      );

      for (const receipt of [transformReceipt, planReceipt, externalReceipt]) {
        assert.strictEqual(receipt.status, 'conflict');
        assert.strictEqual(receipt.code, 'CONFIGURATION_CONTEXT_UNAVAILABLE');
      }
      assert.strictEqual(transformCalls, 0);
      assert.strictEqual(mutationRunnerCalls, 0);
      assert.strictEqual(planBuilderCalls, 0);
      assert.strictEqual(planRunnerCalls, 0);
      assert.strictEqual(externalRunnerCalls, 0);
      assert.strictEqual(await fsp.readFile(targetFile, 'utf-8'), originalContent);
    });

    test('rejects write on read-only configuration session', async () => {
      const targetFile = path.join(tmpDir, 'Subsystem.xml');
      await fsp.writeFile(targetFile, '<root/>', 'utf-8');

      const session = new ConfigurationSession({
        configurationId: 'ro-cfg' as ConfigurationId,
        rootPath: tmpDir,
        rootUri: `file:///${tmpDir.replace(/\\/g, '/')}`,
        descriptorUri: `file:///${configPath.replace(/\\/g, '/')}`,
        workspaceFolderUris: [`file:///${tmpDir.replace(/\\/g, '/')}`],
        format: ConfigFormat.Designer,
        capabilities: { read: true, write: false, process: false },
      });

      const context: ConfigurationContext = {
        configurationId: 'ro-cfg' as ConfigurationId,
        rootPath: tmpDir,
        rootUri: session.identity.rootUri,
        workspaceFolderUri: session.identity.rootUri,
        format: ConfigFormat.Designer,
        capabilities: session.identity.capabilities,
        descriptorUri: session.identity.descriptorUri,
        session,
      };

      const engine = new ConfigurationMutationEngine();

      const receipt = await engine.transformFile(
        context,
        { kind: 'ui.save', resourcePath: targetFile },
        async () => ({ content: '<changed/>', result: 'fail' }),
      );

      assert.strictEqual(receipt.status, 'conflict');
      assert.strictEqual(receipt.code, 'CONFIGURATION_CAPABILITY_UNSUPPORTED');
    });

    test('recovers from transform error with rolledBack status and leaves file untouched', async () => {
      const targetFile = path.join(tmpDir, 'Subsystem.xml');
      const initialXml = '<Subsystem><Name>Original</Name></Subsystem>';
      await fsp.writeFile(targetFile, initialXml, 'utf-8');

      const engine = new ConfigurationMutationEngine();

      const receipt = await engine.transformFile(
        targetFile,
        { kind: 'ui.subsystem.save', resourcePath: targetFile },
        async () => {
          throw new Error('Business validation error: invalid XML structure');
        },
      );

      assert.strictEqual(receipt.status, 'rolledBack');
      assert.strictEqual(receipt.code, 'TRANSFORM_FAILED');
      assert.ok(receipt.message?.includes('Business validation error'));
      assert.strictEqual(await fsp.readFile(targetFile, 'utf-8'), initialXml);
    });

    test('sequences concurrent transforms on the same file without lost updates', async () => {
      const targetFile = path.join(tmpDir, 'Counter.txt');
      await fsp.writeFile(targetFile, '0', 'utf-8');

      const engine = new ConfigurationMutationEngine();

      const makeTransform = (delta: number): SingleFileTransform<number> => async ({ content }) => {
        const val = parseInt(content, 10);
        return {
          content: String(val + delta),
          result: val + delta,
        };
      };

      const [r1, r2, r3] = await Promise.all([
        engine.transformFile(targetFile, { kind: 'test.inc', resourcePath: targetFile }, makeTransform(1)),
        engine.transformFile(targetFile, { kind: 'test.inc', resourcePath: targetFile }, makeTransform(10)),
        engine.transformFile(targetFile, { kind: 'test.inc', resourcePath: targetFile }, makeTransform(100)),
      ]);

      assert.strictEqual(r1.status, 'committed');
      assert.strictEqual(r2.status, 'committed');
      assert.strictEqual(r3.status, 'committed');

      const finalVal = parseInt(await fsp.readFile(targetFile, 'utf-8'), 10);
      assert.strictEqual(finalVal, 111);
    });
  });

  suite('Multi-file plan execution (executePlan)', () => {
    test('executes multi-file mutation plan and returns committed receipt', async () => {
      const file1 = path.join(tmpDir, 'File1.xml');
      const file2 = path.join(tmpDir, 'File2.xml');
      await fsp.writeFile(file1, '<File1/>', 'utf-8');

      const engine = new ConfigurationMutationEngine();

      const receipt = await engine.executePlan(
        tmpDir,
        { kind: 'test.multiPlan' },
        () => ({
          kind: 'test.multiPlan',
          steps: [
            {
              type: 'writeFile',
              targetPath: file1,
              content: '<File1Updated/>',
              encoding: 'utf8',
              expected: { state: 'file', hash: hashContent('<File1/>') },
            },
            {
              type: 'writeFile',
              targetPath: file2,
              content: '<File2Created/>',
              encoding: 'utf8',
              expected: { state: 'missing' },
            },
          ],
          result: 'plan-success',
        }),
      );

      assert.strictEqual(receipt.status, 'committed');
      assert.strictEqual(receipt.result, 'plan-success');
      assert.strictEqual(await fsp.readFile(file1, 'utf-8'), '<File1Updated/>');
      assert.strictEqual(await fsp.readFile(file2, 'utf-8'), '<File2Created/>');
    });
  });

  suite('External process execution (executeExternal)', () => {
    test('runs subprocess with acquired lease and passes context', async () => {
      const engine = new ConfigurationMutationEngine();

      const receipt = await engine.executeExternal(
        tmpDir,
        { kind: 'ibcmd.compile' },
        async (ctx) => {
          assert.strictEqual(ctx.rootPath, tmpDir);
          assert.strictEqual(ctx.cwd, tmpDir);
          return { exitCode: 0 };
        },
      );

      assert.strictEqual(receipt.status, 'committed');
      assert.deepStrictEqual(receipt.result, { exitCode: 0 });
    });

    test('returns rolledBack when runner reports failure or cancellation', async () => {
      const engine = new ConfigurationMutationEngine();

      const receipt = await engine.executeExternal(
        tmpDir,
        { kind: 'ibcmd.compile' },
        async () => {
          throw new Error('ibcmd process failed with exit code 1');
        },
      );

      assert.strictEqual(receipt.status, 'rolledBack');
      assert.strictEqual(receipt.code, 'PROCESS_FAILED');
      assert.ok(receipt.message?.includes('exit code 1'));
    });
  });

  suite('Reference writer migration: mutateCompositionFile', () => {
    test('mutateCompositionFile operates through engine without regression', async () => {
      const targetFile = path.join(tmpDir, 'SubsystemComposition.xml');
      await fsp.writeFile(targetFile, '<Content><Item>Catalog.A</Item></Content>', 'utf-8');

      const result = await mutateCompositionFile(
        targetFile,
        'ui.subsystem.composition',
        async ({ exists, rawContent }) => {
          assert.strictEqual(exists, true);
          return {
            nextXml: rawContent.replace('Catalog.A', 'Catalog.A,Catalog.B'),
            result: 'composition-updated',
          };
        },
      );

      assert.strictEqual(result, 'composition-updated');
      const updated = await fsp.readFile(targetFile, 'utf-8');
      assert.strictEqual(updated, '<Content><Item>Catalog.A,Catalog.B</Item></Content>');
    });
  });
});
