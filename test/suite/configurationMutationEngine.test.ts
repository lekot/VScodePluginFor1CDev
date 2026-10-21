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
import {
  ConfigurationSession,
  type MutationOutcome,
  type ConfigurationCommitObserver,
} from '../../src/services/configurationSession/ConfigurationSession';
import { MutationPlanError } from '../../src/services/configurationSession/mutationPlan';
import { ConfigFormat } from '../../src/parsers/formatDetector';
import type {
  ConfigurationCapabilities,
  ConfigurationContext,
  ConfigurationId,
} from '../../src/services/configurationSession/types';
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

function createAtomicFileSystem(overrides: Partial<AtomicFileSystem> = {}): AtomicFileSystem {
  return {
    readFile: (filePath) => fsp.readFile(filePath),
    open: (filePath, flags) => fsp.open(filePath, flags),
    link: (existingPath, newPath) => fsp.link(existingPath, newPath),
    rename: (oldPath, newPath) => fsp.rename(oldPath, newPath),
    rm: (filePath, options) => fsp.rm(filePath, options),
    ...overrides,
  };
}

function createConfigurationContext(
  rootPath: string,
  configPath: string,
  configurationId: string,
  capabilities: ConfigurationCapabilities,
  commitObserver?: ConfigurationCommitObserver,
): ConfigurationContext {
  const rootUri = `file:///${rootPath.replace(/\\/g, '/')}`;
  const session = new ConfigurationSession({
    configurationId: configurationId as ConfigurationId,
    rootPath,
    rootUri,
    descriptorUri: `file:///${configPath.replace(/\\/g, '/')}`,
    workspaceFolderUris: [rootUri],
    format: ConfigFormat.Designer,
    capabilities,
  }, commitObserver);
  return {
    configurationId: session.identity.configurationId,
    rootPath: session.identity.rootPath,
    rootUri: session.identity.rootUri,
    workspaceFolderUri: session.identity.rootUri,
    format: session.identity.format,
    capabilities: session.identity.capabilities,
    descriptorUri: session.identity.descriptorUri,
    descriptorUuid: session.identity.descriptorUuid,
    session,
  };
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

    test('does not notify reconciliation for a known unchanged-content transform', async () => {
      const targetFile = path.join(tmpDir, 'Subsystem-known-noop.xml');
      const xml = '<Subsystem><Name>Same</Name></Subsystem>';
      await fsp.writeFile(targetFile, xml, 'utf-8');
      let observerCalls = 0;
      const context = createConfigurationContext(
        tmpDir,
        configPath,
        'engine-noop-configuration',
        { read: true, write: true, process: true },
        async () => {
          observerCalls++;
          return { status: 'succeeded' };
        },
      );
      const session = context.session;
      const engine = new ConfigurationMutationEngine({
        runMutationWithOutcome: async (_resourcePath, kind, operation, options) =>
          session.enqueue({ kind, ...options, execute: operation }),
      });

      try {
        const receipt = await engine.transformFile(
          context,
          { kind: 'ui.subsystem.save', resourcePath: targetFile },
          async ({ content }) => ({ content, result: 'noop' }),
        );

        assert.strictEqual(receipt.status, 'committed');
        assert.strictEqual(receipt.oldRevision, receipt.newRevision);
        assert.strictEqual(observerCalls, 0, 'the engine has explicit knowledge that no file bytes changed');
        assert.strictEqual(session.snapshotVersion, 1);
      } finally {
        await session.dispose();
      }
    });

    test('preserves an engine conflict receipt without notifying reconciliation', async () => {
      const targetFile = path.join(tmpDir, 'Subsystem-conflict.xml');
      const originalXml = '<Subsystem><Name>Original</Name></Subsystem>';
      await fsp.writeFile(targetFile, originalXml, 'utf-8');
      const canonicalTarget = await fsp.realpath(targetFile);
      let observerCalls = 0;
      const context = createConfigurationContext(
        tmpDir,
        configPath,
        'engine-conflict-configuration',
        { read: true, write: true, process: true },
        async () => {
          observerCalls++;
          return { status: 'succeeded' };
        },
      );
      const session = context.session;
      const engine = new ConfigurationMutationEngine({
        fileSystem: createAtomicFileSystem({
          readFile: async (filePath) => {
            let canonicalPath: string;
            try {
              canonicalPath = await fsp.realpath(filePath);
            } catch {
              canonicalPath = path.resolve(filePath);
            }
            const comparablePath = process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
            const comparableTarget = process.platform === 'win32' ? canonicalTarget.toLowerCase() : canonicalTarget;
            return comparablePath === comparableTarget
              ? Buffer.from('<Subsystem><Name>Parallel</Name></Subsystem>', 'utf8')
              : fsp.readFile(filePath);
          },
        }),
        runMutationWithOutcome: async (_resourcePath, kind, operation, options) =>
          session.enqueue({ kind, ...options, execute: operation }),
      });

      const receipt = await engine.transformFile(
        context,
        { kind: 'ui.subsystem.save', resourcePath: targetFile },
        async () => ({ content: '<Subsystem><Name>Ours</Name></Subsystem>', result: 'updated' }),
      );

      assert.strictEqual(receipt.status, 'conflict');
      assert.strictEqual(receipt.code, 'STALE_TARGET_HASH');
      assert.strictEqual(receipt.operationId !== undefined, true);
      assert.strictEqual(receipt.snapshotVersion, 0);
      assert.strictEqual(session.snapshotVersion, 0);
      assert.strictEqual(observerCalls, 0, 'a CAS conflict receipt returned as a value is not a commit');
      assert.strictEqual(await fsp.readFile(targetFile, 'utf-8'), originalXml);
      await session.dispose();
    });

    test('maps typed session outcomes to engine receipts without losing status metadata', async () => {
      const targetFile = path.join(tmpDir, 'Typed-outcome.xml');
      await fsp.writeFile(targetFile, '<Typed/>', 'utf-8');
      const context = createConfigurationContext(
        tmpDir,
        configPath,
        'engine-typed-mutation-outcomes',
        { read: true, write: true, process: true },
      );
      const reconciliation = { status: 'failed' as const, code: 'RELOAD_FAILED', message: 'reload failed' };
      const common = {
        configurationId: context.configurationId,
        operationId: 'typed-mutation-operation',
        snapshotVersion: 7,
      };
      const cases: Array<{
        name: string;
        outcome: MutationOutcome<MutationReceipt<string>>;
        status: MutationReceipt['status'];
        code?: string;
        message?: string;
      }> = [
        {
          name: 'conflict',
          outcome: {
            ...common,
            status: 'conflict',
            code: 'STALE_SNAPSHOT',
            error: new Error('snapshot changed'),
            reconciliation,
          },
          status: 'conflict',
          code: 'STALE_SNAPSHOT',
          message: 'snapshot changed',
        },
        {
          name: 'cancelled',
          outcome: { ...common, status: 'cancelled' },
          status: 'rolledBack',
          code: 'CANCELLED',
          message: 'Configuration mutation was cancelled.',
        },
        {
          name: 'recovery required',
          outcome: {
            ...common,
            status: 'failed',
            error: new MutationPlanError('RECOVERY_REQUIRED', 'recovery needed'),
          },
          status: 'recoveryRequired',
          code: 'RECOVERY_REQUIRED',
          message: 'recovery needed',
        },
        {
          name: 'failed with plan error',
          outcome: {
            ...common,
            status: 'failed',
            error: new MutationPlanError('PLAN_FAILED', 'plan rolled back'),
          },
          status: 'rolledBack',
          code: 'MUTATION_FAILED',
          message: 'plan rolled back',
        },
        {
          name: 'failed without error details',
          outcome: { ...common, status: 'failed' },
          status: 'rolledBack',
          code: 'MUTATION_FAILED',
          message: 'Configuration mutation failed.',
        },
        {
          name: 'failed with an in-doubt value',
          outcome: {
            ...common,
            status: 'failed',
            value: {
              status: 'inDoubt',
              kind: 'ui.typed-mutation',
              resourcePath: targetFile,
              code: 'POSSIBLE_WRITE',
              message: 'write may have reached disk',
            },
            reconciliation,
          },
          status: 'inDoubt',
          code: 'POSSIBLE_WRITE',
          message: 'write may have reached disk',
        },
      ];

      try {
        for (const entry of cases) {
          const engine = new ConfigurationMutationEngine({
            runMutationWithOutcome: async <T>() => entry.outcome as unknown as MutationOutcome<T>,
          });
          const receipt = await engine.transformFile(
            context,
            { kind: 'ui.typed-mutation', resourcePath: targetFile },
            async ({ content }) => ({ content: `${content}changed`, result: 'updated' }),
          );

          assert.strictEqual(receipt.status, entry.status, entry.name);
          assert.strictEqual(receipt.code, entry.code, entry.name);
          assert.strictEqual(receipt.message, entry.message, entry.name);
          assert.strictEqual(receipt.configurationId, context.configurationId, entry.name);
          assert.strictEqual(receipt.operationId, common.operationId, entry.name);
          assert.strictEqual(receipt.snapshotVersion, common.snapshotVersion, entry.name);
          if (entry.outcome.reconciliation) {
            assert.deepStrictEqual(receipt.reconciliation, reconciliation, entry.name);
          }
        }
      } finally {
        await context.session.dispose();
      }
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

    test('expected missing revision rejects a target created before the engine snapshot', async () => {
      const targetFile = path.join(tmpDir, 'ExpectedMissing', 'Rights.xml');
      await fsp.mkdir(path.dirname(targetFile), { recursive: true });
      await fsp.writeFile(targetFile, 'created by another writer', 'utf-8');
      let transformCalls = 0;

      const receipt = await new ConfigurationMutationEngine().transformFile(
        targetFile,
        { kind: 'test.create-if-still-missing', resourcePath: targetFile, expectedRevision: null },
        async () => {
          transformCalls++;
          return { content: 'ours', result: 'created' };
        },
      );

      assert.strictEqual(receipt.status, 'conflict');
      assert.strictEqual(receipt.code, 'STALE_TARGET_REVISION');
      assert.strictEqual(transformCalls, 0, 'the transform must not inspect or merge an unexpected file');
      assert.strictEqual(await fsp.readFile(targetFile, 'utf-8'), 'created by another writer');
    });

    test('expected missing revision preserves a parallel creator that wins atomic publication', async () => {
      const targetFile = path.join(tmpDir, 'ExpectedMissingRace', 'Rights.xml');
      let transformCalls = 0;
      let publishedByOtherWriter = false;
      const fileSystem = createAtomicFileSystem({
        link: async (_tempPath, destination) => {
          publishedByOtherWriter = true;
          await fsp.writeFile(destination, 'parallel creator', { flag: 'wx' });
          throw Object.assign(new Error('target was created concurrently'), { code: 'EEXIST' });
        },
      });

      const receipt = await new ConfigurationMutationEngine({ fileSystem }).transformFile(
        targetFile,
        { kind: 'test.create-if-still-missing-race', resourcePath: targetFile, expectedRevision: null },
        async ({ exists }) => {
          transformCalls++;
          assert.strictEqual(exists, false);
          return { content: 'ours', result: 'created' };
        },
      );

      assert.strictEqual(publishedByOtherWriter, true);
      assert.strictEqual(receipt.status, 'conflict');
      assert.strictEqual(receipt.code, 'STALE_TARGET_REVISION');
      assert.strictEqual(transformCalls, 1, 'the engine must not retry over an expected-missing session');
      assert.strictEqual(await fsp.readFile(targetFile, 'utf-8'), 'parallel creator');
      assert.deepStrictEqual((await fsp.readdir(path.dirname(targetFile))).sort(), ['Rights.xml']);
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

    test('maps an atomic compare-and-swap race to a conflict receipt', async () => {
      const targetFile = path.join(tmpDir, 'Conflict', 'Subsystem.xml');
      const original = '<Subsystem>original</Subsystem>';
      await fsp.mkdir(path.dirname(targetFile), { recursive: true });
      await fsp.writeFile(targetFile, original, 'utf-8');

      const engine = new ConfigurationMutationEngine({
        fileSystem: createAtomicFileSystem({
          readFile: async () => Buffer.from('<Subsystem>changed by another writer</Subsystem>'),
        }),
      });
      const receipt = await engine.transformFile(
        targetFile,
        { kind: 'test.replace-conflict', resourcePath: targetFile },
        async () => ({ content: '<Subsystem>ours</Subsystem>', result: 'changed' }),
      );

      assert.strictEqual(receipt.status, 'conflict');
      assert.strictEqual(receipt.code, 'STALE_TARGET_HASH');
      assert.strictEqual(await fsp.readFile(targetFile, 'utf-8'), original);
    });

    test('reports recoveryRequired when post-write bytes fail hash validation', async () => {
      const targetFile = path.join(tmpDir, 'Recovery', 'Subsystem.xml');
      const original = '<Subsystem>original</Subsystem>';
      const updated = '<Subsystem>updated</Subsystem>';
      await fsp.mkdir(path.dirname(targetFile), { recursive: true });
      await fsp.writeFile(targetFile, original, 'utf-8');
      let readCount = 0;

      const engine = new ConfigurationMutationEngine({
        fileSystem: createAtomicFileSystem({
          readFile: async (filePath) => {
            readCount++;
            if (readCount === 3) {
              return Buffer.from('<Subsystem>unverifiable</Subsystem>');
            }
            return fsp.readFile(filePath);
          },
        }),
      });
      const receipt = await engine.transformFile(
        targetFile,
        { kind: 'test.replace-recovery', resourcePath: targetFile },
        async () => ({ content: updated, result: 'changed' }),
      );

      assert.strictEqual(receipt.status, 'recoveryRequired');
      assert.strictEqual(receipt.code, 'POST_WRITE_VALIDATION_FAILED');
      assert.strictEqual(readCount, 3);
      assert.strictEqual(await fsp.readFile(targetFile, 'utf-8'), updated);
    });

    test('maps a failed atomic replace with original bytes intact to rolledBack', async () => {
      const targetFile = path.join(tmpDir, 'Rollback', 'Subsystem.xml');
      const original = '<Subsystem>original</Subsystem>';
      await fsp.mkdir(path.dirname(targetFile), { recursive: true });
      await fsp.writeFile(targetFile, original, 'utf-8');

      const engine = new ConfigurationMutationEngine({
        fileSystem: createAtomicFileSystem({
          open: async () => { throw new Error('injected temp open failure'); },
        }),
      });
      const receipt = await engine.transformFile(
        targetFile,
        { kind: 'test.replace-rollback', resourcePath: targetFile },
        async () => ({ content: '<Subsystem>ours</Subsystem>', result: 'changed' }),
      );

      assert.strictEqual(receipt.status, 'rolledBack');
      assert.strictEqual(receipt.code, 'WRITE_FAILED');
      assert.ok(receipt.message?.includes('injected temp open failure'));
      assert.strictEqual(await fsp.readFile(targetFile, 'utf-8'), original);
    });

    test('retries transform once after a parallel creator publishes the missing target', async () => {
      const targetFile = path.join(tmpDir, 'Race', 'Content.xml');
      let publishedByOtherWriter = false;
      let transformCalls = 0;
      const fileSystem = createAtomicFileSystem({
        link: async (tempPath, destination) => {
          if (!publishedByOtherWriter) {
            publishedByOtherWriter = true;
            await fsp.writeFile(destination, 'parallel writer', 'utf-8');
            throw Object.assign(new Error('target was created concurrently'), { code: 'EEXIST' });
          }
          return fsp.link(tempPath, destination);
        },
      });
      const engine = new ConfigurationMutationEngine({ fileSystem });

      const receipt = await engine.transformFile(
        targetFile,
        { kind: 'test.create-race', resourcePath: targetFile },
        async ({ exists, content }) => {
          transformCalls++;
          return {
            content: exists ? `${content} + ours` : 'initial create',
            result: exists ? 'retried' : 'first attempt',
          };
        },
      );

      assert.strictEqual(receipt.status, 'committed');
      assert.strictEqual(receipt.result, 'retried');
      assert.strictEqual(transformCalls, 2);
      assert.strictEqual(await fsp.readFile(targetFile, 'utf-8'), 'parallel writer + ours');
    });

    test('keeps the parallel creator file when the retry transform fails', async () => {
      const targetFile = path.join(tmpDir, 'FailedRace', 'Content.xml');
      let publishedByOtherWriter = false;
      let transformCalls = 0;
      const fileSystem = createAtomicFileSystem({
        link: async (_tempPath, destination) => {
          if (!publishedByOtherWriter) {
            publishedByOtherWriter = true;
            await fsp.writeFile(destination, 'parallel writer', 'utf-8');
            throw Object.assign(new Error('target was created concurrently'), { code: 'EEXIST' });
          }
          throw new Error('unexpected second create publication');
        },
      });
      const engine = new ConfigurationMutationEngine({ fileSystem });

      const receipt = await engine.transformFile(
        targetFile,
        { kind: 'test.create-race-transform-failure', resourcePath: targetFile },
        async ({ exists }) => {
          transformCalls++;
          if (exists) {
            throw new Error('retry transform rejected concurrent state');
          }
          return { content: 'initial create', result: 'first attempt' };
        },
      );

      assert.strictEqual(receipt.status, 'rolledBack');
      assert.strictEqual(receipt.code, 'TRANSFORM_FAILED');
      assert.strictEqual(transformCalls, 2);
      assert.strictEqual(await fsp.readFile(targetFile, 'utf-8'), 'parallel writer');
    });

    test('maps post-create hash mismatch to recoveryRequired without deleting the published file', async () => {
      const targetFile = path.join(tmpDir, 'CreateRecovery', 'Content.xml');
      let postCreateReadCount = 0;
      const fileSystem = createAtomicFileSystem({
        readFile: async () => {
          postCreateReadCount++;
          return Buffer.from('unverifiable post-create bytes');
        },
      });
      const engine = new ConfigurationMutationEngine({ fileSystem });

      const receipt = await engine.transformFile(
        targetFile,
        { kind: 'test.create-recovery', resourcePath: targetFile },
        async () => ({ content: '<complete-content/>', result: 'created' }),
      );

      assert.strictEqual(receipt.status, 'recoveryRequired');
      assert.strictEqual(receipt.code, 'POST_WRITE_VALIDATION_FAILED');
      assert.strictEqual(postCreateReadCount, 1);
      assert.strictEqual(await fsp.readFile(targetFile, 'utf-8'), '<complete-content/>');
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

    test('maps plan conflicts, recovery requirements, and unexpected failures to stable receipts', async () => {
      const failures: Array<{
        error: unknown;
        status: MutationReceipt['status'];
        code: string;
        message: string;
      }> = [
        {
          error: new MutationPlanError('PLAN_CONFLICT', 'pre-state changed'),
          status: 'conflict',
          code: 'PLAN_CONFLICT',
          message: 'pre-state changed',
        },
        {
          error: new MutationPlanError('RECOVERY_REQUIRED', 'rollback is incomplete'),
          status: 'recoveryRequired',
          code: 'RECOVERY_REQUIRED',
          message: 'rollback is incomplete',
        },
        {
          error: new MutationPlanError('PLAN_FAILED', 'write was rolled back'),
          status: 'rolledBack',
          code: 'PLAN_FAILED',
          message: 'write was rolled back',
        },
        {
          error: 'unexpected non-Error failure',
          status: 'rolledBack',
          code: 'PLAN_FAILED',
          message: 'unexpected non-Error failure',
        },
      ];

      for (const failure of failures) {
        const engine = new ConfigurationMutationEngine({
          runPlan: async () => { throw failure.error; },
        });
        const receipt = await engine.executePlan(
          tmpDir,
          { kind: 'test.plan-failure' },
          () => ({ kind: 'test.plan-failure', steps: [], result: 'unused' }),
        );

        assert.strictEqual(receipt.status, failure.status);
        assert.strictEqual(receipt.code, failure.code);
        assert.strictEqual(receipt.message, failure.message);
      }
    });

    test('maps typed plan session outcomes to committed, conflict, cancel, and failure receipts', async () => {
      const context = createConfigurationContext(
        tmpDir,
        configPath,
        'engine-typed-plan-outcomes',
        { read: true, write: true, process: true },
      );
      const common = {
        configurationId: context.configurationId,
        operationId: 'typed-plan-operation',
        snapshotVersion: 11,
      };
      const reconciliation = { status: 'failed' as const, code: 'RELOAD_FAILED', message: 'reload failed' };
      const cases: Array<{
        name: string;
        outcome: MutationOutcome<string>;
        status: MutationReceipt['status'];
        code?: string;
        message?: string;
      }> = [
        {
          name: 'committed',
          outcome: { ...common, status: 'committed', value: 'plan-result', reconciliation },
          status: 'committed',
        },
        {
          name: 'conflict',
          outcome: { ...common, status: 'conflict', code: 'STALE_SNAPSHOT', error: new Error('snapshot stale') },
          status: 'conflict',
          code: 'STALE_SNAPSHOT',
          message: 'snapshot stale',
        },
        {
          name: 'cancelled',
          outcome: { ...common, status: 'cancelled' },
          status: 'rolledBack',
          code: 'CANCELLED',
          message: 'Configuration mutation was cancelled.',
        },
        {
          name: 'plan conflict',
          outcome: { ...common, status: 'failed', error: new MutationPlanError('PLAN_CONFLICT', 'plan conflict') },
          status: 'conflict',
          code: 'PLAN_CONFLICT',
          message: 'plan conflict',
        },
        {
          name: 'recovery required',
          outcome: { ...common, status: 'failed', error: new MutationPlanError('RECOVERY_REQUIRED', 'recovery required') },
          status: 'recoveryRequired',
          code: 'RECOVERY_REQUIRED',
          message: 'recovery required',
        },
        {
          name: 'rolled back',
          outcome: { ...common, status: 'failed', error: new MutationPlanError('PLAN_FAILED', 'plan failed') },
          status: 'rolledBack',
          code: 'PLAN_FAILED',
          message: 'plan failed',
        },
        {
          name: 'failed without error details',
          outcome: { ...common, status: 'failed' },
          status: 'rolledBack',
          code: 'PLAN_FAILED',
          message: 'Configuration mutation failed.',
        },
      ];

      try {
        for (const entry of cases) {
          const engine = new ConfigurationMutationEngine({
            runPlanWithOutcome: async <T>() => entry.outcome as unknown as MutationOutcome<T>,
          });
          const receipt = await engine.executePlan(
            context,
            { kind: 'ui.typed-plan' },
            () => ({ kind: 'ui.typed-plan', steps: [], result: 'unused' }),
          );

          assert.strictEqual(receipt.status, entry.status, entry.name);
          assert.strictEqual(receipt.code, entry.code, entry.name);
          assert.strictEqual(receipt.message, entry.message, entry.name);
          assert.strictEqual(receipt.configurationId, common.configurationId, entry.name);
          assert.strictEqual(receipt.operationId, common.operationId, entry.name);
          assert.strictEqual(receipt.snapshotVersion, common.snapshotVersion, entry.name);
          if (entry.outcome.reconciliation) {
            assert.deepStrictEqual(receipt.reconciliation, reconciliation, entry.name);
          }
        }
      } finally {
        await context.session.dispose();
      }
    });

    test('fails closed on read-only context and stale expected configuration identity', async () => {
      const readOnlyContext = createConfigurationContext(
        tmpDir,
        configPath,
        'read-only-configuration',
        { read: true, write: false, process: false },
      );
      const writableContext = createConfigurationContext(
        tmpDir,
        configPath,
        'current-configuration',
        { read: true, write: true, process: true },
      );
      let builderCalls = 0;
      let planRunnerCalls = 0;
      const engine = new ConfigurationMutationEngine({
        runPlan: async (_root, plan) => {
          planRunnerCalls++;
          return plan.result;
        },
      });
      const buildPlan = () => {
        builderCalls++;
        return { kind: 'test.plan-gate', steps: [], result: 'unused' };
      };

      const readOnlyReceipt = await engine.executePlan(
        readOnlyContext,
        { kind: 'test.plan-read-only' },
        buildPlan,
      );
      const staleIdentityReceipt = await engine.executePlan(
        writableContext,
        {
          kind: 'test.plan-stale-identity',
          expectedConfigurationId: 'previous-configuration' as ConfigurationId,
        },
        buildPlan,
      );

      for (const receipt of [readOnlyReceipt, staleIdentityReceipt]) {
        assert.strictEqual(receipt.status, 'conflict');
        assert.strictEqual(receipt.code, receipt === readOnlyReceipt
          ? 'CONFIGURATION_CAPABILITY_UNSUPPORTED'
          : 'CONFIGURATION_ID_MISMATCH');
      }
      assert.strictEqual(builderCalls, 0);
      assert.strictEqual(planRunnerCalls, 0);
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

    test('rejects an external operation when process capability is unavailable', async () => {
      const context = createConfigurationContext(
        tmpDir,
        configPath,
        'read-only-configuration',
        { read: true, write: false, process: false },
      );
      let runnerCalls = 0;
      const receipt = await new ConfigurationMutationEngine().executeExternal(
        context,
        { kind: 'ibcmd.not-supported' },
        async () => {
          runnerCalls++;
          return 'must not run';
        },
      );

      assert.strictEqual(receipt.status, 'conflict');
      assert.strictEqual(receipt.code, 'CONFIGURATION_CAPABILITY_UNSUPPORTED');
      assert.strictEqual(runnerCalls, 0);
    });

    test('rejects an external operation when its expected configuration identity is stale', async () => {
      const context = createConfigurationContext(
        tmpDir,
        configPath,
        'actual-configuration',
        { read: true, write: true, process: true },
      );
      let runnerCalls = 0;
      const engine = new ConfigurationMutationEngine();

      const receipt = await engine.executeExternal(
        context,
        {
          kind: 'ibcmd.stale-configuration',
          expectedConfigurationId: 'expected-configuration' as ConfigurationId,
        },
        async () => {
          runnerCalls++;
          return 'must not run';
        },
      );

      assert.strictEqual(receipt.status, 'conflict');
      assert.strictEqual(receipt.code, 'CONFIGURATION_ID_MISMATCH');
      assert.strictEqual(runnerCalls, 0);
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

    test('classifies cancellation and non-Error process failures consistently', async () => {
      const failures: Array<{ error: unknown; code: string; message: string }> = [
        {
          error: Object.assign(new Error('process interrupted'), { name: 'AbortError' }),
          code: 'CANCELLED',
          message: 'process interrupted',
        },
        {
          error: new Error('operation cancelled by the user'),
          code: 'CANCELLED',
          message: 'operation cancelled by the user',
        },
        {
          error: 'native spawn failure',
          code: 'PROCESS_FAILED',
          message: 'native spawn failure',
        },
      ];

      for (const failure of failures) {
        const receipt = await new ConfigurationMutationEngine().executeExternal(
          tmpDir,
          { kind: 'ibcmd.failure-mapping' },
          async () => { throw failure.error; },
        );
        assert.strictEqual(receipt.status, 'rolledBack');
        assert.strictEqual(receipt.code, failure.code);
        assert.strictEqual(receipt.message, failure.message);
      }
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
