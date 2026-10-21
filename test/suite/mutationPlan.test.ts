import * as assert from 'assert';
import { spawn, type ChildProcess } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hashContent } from '../../src/services/configurationSession/atomicFileStorage';
import { MutationPlanExecutor, MutationPlanError, calculateDirectoryFingerprint } from '../../src/services/configurationSession/mutationPlan';
import {
  cleanupCurrentRootLeaseHeartbeatTemps,
  isProcessAlive,
  RootLeaseOwnershipError,
  rootLeaseHeartbeatPath,
  writeRootLeaseHeartbeat,
} from '../../src/services/configurationSession/rootLease';
import { logCleanupFailure } from '../../src/services/configurationSession/journalCleanupDiagnostics';
import { Logger } from '../../src/utils/logger';
import {
  assertJournalNamespace,
  assertLexicallyInside,
  canonicalizePathWithMissingSuffix,
  isSamePath,
  PathBoundaryError,
} from '../../src/services/configurationSession/pathBoundary';

function collectChildOutput(child: ChildProcess): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function createDirectorySymlink(target: string, linkPath: string): Promise<void> {
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.promises.symlink(target, linkPath, type);
}

suite('MutationPlanExecutor', () => {
  let tempDir: string;

  setup(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mutation-plan-'));
  });

  teardown(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
  });

  test('directory fingerprint entry hashing matches the executor for nested file and directory snapshots', async () => {
    const nestedPath = path.join(tempDir, 'Forms');
    const emptyPath = path.join(tempDir, 'Empty');
    await fs.promises.mkdir(nestedPath, { recursive: true });
    await fs.promises.mkdir(emptyPath, { recursive: true });
    await fs.promises.writeFile(path.join(tempDir, 'z.bin'), Buffer.from([0, 255, 2]));
    await fs.promises.writeFile(path.join(nestedPath, 'Main.xml'), '<Form/>', 'utf8');

    type FingerprintEntry =
      | { readonly name: string; readonly type: 'file'; readonly hash: string }
      | { readonly name: string; readonly type: 'directory'; readonly fingerprint: string };
    const fingerprintModule = require('../../src/services/configurationSession/mutationPlan') as {
      calculateDirectoryFingerprintFromEntries?: (entries: readonly FingerprintEntry[]) => string;
    };
    const calculateFromEntries = fingerprintModule.calculateDirectoryFingerprintFromEntries;
    assert.strictEqual(typeof calculateFromEntries, 'function',
      'the filesystem and duplicate snapshot must share the directory-entry hashing contract');

    const rootEntries: FingerprintEntry[] = [
      { name: 'z.bin', type: 'file', hash: hashContent(await fs.promises.readFile(path.join(tempDir, 'z.bin'))) },
      { name: 'Forms', type: 'directory', fingerprint: await calculateDirectoryFingerprint(nestedPath) },
      { name: 'Empty', type: 'directory', fingerprint: await calculateDirectoryFingerprint(emptyPath) },
    ];
    assert.strictEqual(calculateFromEntries!(rootEntries), await calculateDirectoryFingerprint(tempDir));
  });

  test('rolls every file back when a later step fails', async () => {
    const first = path.join(tempDir, 'first.xml');
    const second = path.join(tempDir, 'second.xml');
    await fs.promises.writeFile(first, 'first-old', 'utf8');
    await fs.promises.writeFile(second, 'second-old', 'utf8');
    const executor = new MutationPlanExecutor(tempDir);

    await assert.rejects(
      executor.execute({
        kind: 'test.rollback',
        steps: [
          {
            type: 'writeFile', targetPath: first, content: 'first-new', encoding: 'utf8',
            expected: { state: 'file', hash: hashContent('first-old') },
          },
          {
            type: 'writeFile', targetPath: first, content: 'never', encoding: 'utf8',
            expected: { state: 'file', hash: hashContent('unexpected') },
          },
          {
            type: 'writeFile', targetPath: second, content: 'second-new', encoding: 'utf8',
            expected: { state: 'file', hash: hashContent('second-old') },
          },
        ],
        result: undefined,
      }),
      (error: MutationPlanError) => error.code === 'PLAN_CONFLICT',
    );

    assert.strictEqual(await fs.promises.readFile(first, 'utf8'), 'first-old');
    assert.strictEqual(await fs.promises.readFile(second, 'utf8'), 'second-old');
    assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), false);
  });

  test('#264: subtree reset removes old-only children and creates a deterministic mixed binary/XML tree', async () => {
    const targetDir = path.join(tempDir, 'Resources');
    const oldNested = path.join(targetDir, 'Forms', 'Nested');
    await fs.promises.mkdir(path.join(oldNested, 'OldEmpty'), { recursive: true });
    await fs.promises.mkdir(path.join(targetDir, 'OldRootEmpty'), { recursive: true });
    await fs.promises.writeFile(path.join(targetDir, 'obsolete.xml'), '<Old/>', 'utf8');
    await fs.promises.writeFile(path.join(targetDir, 'Forms', 'Form.xml'), '<OldForm/>', 'utf8');
    await fs.promises.writeFile(path.join(oldNested, 'Preview.bin'), Buffer.from([0, 1, 255, 0]));

    const targetXml = path.join(targetDir, 'Forms', 'Form.xml');
    const targetBinary = path.join(oldNested, 'Preview.bin');
    const targetEmpty = path.join(targetDir, 'Generated', 'Deep', 'Empty');
    const xmlContent = '<Form><Name>New</Name></Form>';
    const binaryContent = Buffer.from([0, 255, 7, 0, 128]);
    const executor = new MutationPlanExecutor(tempDir);

    await executor.execute({
      kind: 'test.subtreeReset',
      steps: [
        {
          type: 'deletePath', targetPath: targetDir,
          expected: { state: 'directory', fingerprint: await calculateDirectoryFingerprint(targetDir) },
        },
        { type: 'ensureDirectory', targetPath: targetDir },
        { type: 'ensureDirectory', targetPath: path.join(targetDir, 'Forms') },
        { type: 'ensureDirectory', targetPath: oldNested },
        { type: 'ensureDirectory', targetPath: targetEmpty },
        {
          type: 'writeFile', targetPath: targetXml, content: xmlContent, encoding: 'utf8',
          expected: { state: 'missing' },
        },
        {
          type: 'writeFile', targetPath: targetBinary, content: binaryContent.toString('base64'), encoding: 'base64',
          expected: { state: 'missing' },
        },
      ],
      result: undefined,
    });

    assert.strictEqual(await fs.promises.readFile(targetXml, 'utf8'), xmlContent);
    assert.deepStrictEqual(await fs.promises.readFile(targetBinary), binaryContent);
    assert.strictEqual(fs.existsSync(path.join(targetDir, 'obsolete.xml')), false);
    assert.strictEqual(fs.existsSync(path.join(targetDir, 'OldRootEmpty')), false);
    assert.strictEqual(fs.existsSync(path.join(oldNested, 'OldEmpty')), false);
    assert.strictEqual(fs.existsSync(targetEmpty), true);
    const expectedTree = path.join(tempDir, 'expected-tree');
    await fs.promises.mkdir(path.join(expectedTree, 'Forms', 'Nested'), { recursive: true });
    await fs.promises.mkdir(path.join(expectedTree, 'Generated', 'Deep', 'Empty'), { recursive: true });
    await fs.promises.writeFile(path.join(expectedTree, 'Forms', 'Form.xml'), xmlContent, 'utf8');
    await fs.promises.writeFile(path.join(expectedTree, 'Forms', 'Nested', 'Preview.bin'), binaryContent);
    assert.strictEqual(
      await calculateDirectoryFingerprint(targetDir),
      await calculateDirectoryFingerprint(expectedTree),
    );
  });

  test('#264: late write failure rolls a recreated mixed subtree back to its complete original tree', async () => {
    const targetDir = path.join(tempDir, 'Resources');
    const nestedDir = path.join(targetDir, 'Forms', 'Nested');
    await fs.promises.mkdir(path.join(nestedDir, 'OldEmpty'), { recursive: true });
    await fs.promises.mkdir(path.join(targetDir, 'OldRootEmpty'), { recursive: true });
    await fs.promises.writeFile(path.join(targetDir, 'obsolete.xml'), '<Old/>', 'utf8');
    await fs.promises.writeFile(path.join(targetDir, 'Forms', 'Form.xml'), '<OldForm/>', 'utf8');
    await fs.promises.writeFile(path.join(nestedDir, 'Preview.bin'), Buffer.from([9, 8, 7]));
    const originalFingerprint = await calculateDirectoryFingerprint(targetDir);
    const originalRename = fs.promises.rename;
    let atomicFileWrites = 0;
    fs.promises.rename = async function (source: fs.PathLike, destination: fs.PathLike): Promise<void> {
      if (path.basename(String(source)).startsWith('.cdt-plan-') && ++atomicFileWrites === 2) {
        throw new Error('injected late atomic write failure');
      }
      return originalRename.call(fs.promises, source, destination);
    };

    try {
      await assert.rejects(
        new MutationPlanExecutor(tempDir).execute({
          kind: 'test.subtreeResetRollback',
          steps: [
            {
              type: 'deletePath', targetPath: targetDir,
              expected: { state: 'directory', fingerprint: originalFingerprint },
            },
            { type: 'ensureDirectory', targetPath: targetDir },
            { type: 'ensureDirectory', targetPath: path.join(targetDir, 'Forms') },
            { type: 'ensureDirectory', targetPath: nestedDir },
            {
              type: 'writeFile', targetPath: path.join(targetDir, 'Forms', 'Form.xml'),
              content: '<NewForm/>', encoding: 'utf8', expected: { state: 'missing' },
            },
            {
              type: 'writeFile', targetPath: path.join(nestedDir, 'Preview.bin'),
              content: Buffer.from([1, 2, 3]).toString('base64'), encoding: 'base64',
              expected: { state: 'missing' },
            },
          ],
          result: undefined,
        }),
        (error: MutationPlanError) => error.code === 'PLAN_FAILED',
      );
    } finally {
      fs.promises.rename = originalRename;
    }

    assert.strictEqual(await calculateDirectoryFingerprint(targetDir), originalFingerprint);
    assert.strictEqual(await fs.promises.readFile(path.join(targetDir, 'Forms', 'Form.xml'), 'utf8'), '<OldForm/>');
    assert.deepStrictEqual(await fs.promises.readFile(path.join(nestedDir, 'Preview.bin')), Buffer.from([9, 8, 7]));
    assert.strictEqual(fs.existsSync(path.join(nestedDir, 'OldEmpty')), true);
    assert.strictEqual(fs.existsSync(path.join(targetDir, 'OldRootEmpty')), true);
    assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), false);
  });

  test('#264: rollback preserves a foreign child added after subtree recreation', async () => {
    const targetDir = path.join(tempDir, 'Resources');
    await fs.promises.mkdir(path.join(targetDir, 'Forms'), { recursive: true });
    await fs.promises.writeFile(path.join(targetDir, 'old.xml'), '<Old/>', 'utf8');
    const originalRename = fs.promises.rename;
    let foreignFileAdded = false;
    fs.promises.rename = async function (source: fs.PathLike, destination: fs.PathLike): Promise<void> {
      await originalRename.call(fs.promises, source, destination);
      if (!foreignFileAdded && path.basename(String(source)).startsWith('.cdt-plan-')) {
        foreignFileAdded = true;
        await fs.promises.writeFile(path.join(targetDir, 'foreign.xml'), '<Foreign/>', 'utf8');
      }
    };

    try {
      await assert.rejects(
        new MutationPlanExecutor(tempDir).execute({
          kind: 'test.subtreeResetForeignChild',
          steps: [
            {
              type: 'deletePath', targetPath: targetDir,
              expected: { state: 'directory', fingerprint: await calculateDirectoryFingerprint(targetDir) },
            },
            { type: 'ensureDirectory', targetPath: targetDir },
            { type: 'ensureDirectory', targetPath: path.join(targetDir, 'Forms') },
            {
              type: 'writeFile', targetPath: path.join(targetDir, 'Forms', 'Form.xml'),
              content: '<Planned/>', encoding: 'utf8', expected: { state: 'missing' },
            },
            {
              type: 'writeFile', targetPath: path.join(targetDir, 'foreign.xml'),
              content: '<PlannedForeign/>', encoding: 'utf8', expected: { state: 'missing' },
            },
          ],
          result: undefined,
        }),
        (error: MutationPlanError) => error.code === 'RECOVERY_REQUIRED',
      );
    } finally {
      fs.promises.rename = originalRename;
    }

    assert.strictEqual(await fs.promises.readFile(path.join(targetDir, 'foreign.xml'), 'utf8'), '<Foreign/>');
    assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), true);
  });

  test('#264: an unknown descendant state after an ancestor move fails before filesystem effects', async () => {
    const sourceDir = path.join(tempDir, 'Source');
    const targetDir = path.join(tempDir, 'Target');
    await fs.promises.mkdir(sourceDir, { recursive: true });
    await fs.promises.writeFile(path.join(sourceDir, 'from-source.xml'), '<Source/>', 'utf8');

    await assert.rejects(
      new MutationPlanExecutor(tempDir).execute({
        kind: 'test.unknownMovedDescendant',
        steps: [
          {
            type: 'movePath', sourcePath: sourceDir, targetPath: targetDir,
            sourceExpected: { state: 'directory', fingerprint: await calculateDirectoryFingerprint(sourceDir) },
            targetExpected: { state: 'missing' },
          },
          {
            type: 'writeFile', targetPath: path.join(targetDir, 'from-source.xml'),
            content: '<Replacement/>', encoding: 'utf8', expected: { state: 'missing' },
          },
        ],
        result: undefined,
      }),
      (error: MutationPlanError) => error.code === 'PLAN_CONFLICT',
    );

    assert.strictEqual(await fs.promises.readFile(path.join(sourceDir, 'from-source.xml'), 'utf8'), '<Source/>');
    assert.strictEqual(fs.existsSync(targetDir), false);
    assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), false);
  });

  test('#264: repeated ensures after recreating nested directories preserve the full rollback prefix', async () => {
    const targetDir = path.join(tempDir, 'Tree');
    const nestedDir = path.join(targetDir, 'Forms', 'Nested');
    await fs.promises.mkdir(path.join(nestedDir, 'OldEmpty'), { recursive: true });
    await fs.promises.mkdir(path.join(targetDir, 'OldRootEmpty'), { recursive: true });
    await fs.promises.writeFile(path.join(targetDir, 'old.xml'), '<Old/>', 'utf8');
    await fs.promises.writeFile(path.join(nestedDir, 'Preview.bin'), Buffer.from([0, 255, 4]));
    const originalFingerprint = await calculateDirectoryFingerprint(targetDir);
    const originalRename = fs.promises.rename;
    fs.promises.rename = async function (source: fs.PathLike, destination: fs.PathLike): Promise<void> {
      if (path.basename(String(destination)) === 'C.xml') {
        throw new Error('injected late write failure');
      }
      return originalRename.call(fs.promises, source, destination);
    };

    try {
      await assert.rejects(
        new MutationPlanExecutor(tempDir).execute({
          kind: 'test.repeatedEnsureResetRollback',
          steps: [
            { type: 'deletePath', targetPath: targetDir, expected: { state: 'directory', fingerprint: originalFingerprint } },
            { type: 'ensureDirectory', targetPath: targetDir },
            { type: 'writeFile', targetPath: path.join(targetDir, 'A.xml'), content: '<A/>', encoding: 'utf8', expected: { state: 'missing' } },
            { type: 'ensureDirectory', targetPath: targetDir },
            { type: 'writeFile', targetPath: path.join(targetDir, 'B.xml'), content: '<B/>', encoding: 'utf8', expected: { state: 'missing' } },
            { type: 'ensureDirectory', targetPath: nestedDir },
            { type: 'writeFile', targetPath: path.join(nestedDir, 'A.xml'), content: '<NestedA/>', encoding: 'utf8', expected: { state: 'missing' } },
            { type: 'ensureDirectory', targetPath: nestedDir },
            { type: 'writeFile', targetPath: path.join(nestedDir, 'B.xml'), content: '<NestedB/>', encoding: 'utf8', expected: { state: 'missing' } },
            { type: 'writeFile', targetPath: path.join(targetDir, 'C.xml'), content: '<C/>', encoding: 'utf8', expected: { state: 'missing' } },
          ],
          result: undefined,
        }),
        (error: MutationPlanError) => error.code === 'PLAN_FAILED',
      );
    } finally {
      fs.promises.rename = originalRename;
    }

    assert.strictEqual(await calculateDirectoryFingerprint(targetDir), originalFingerprint);
    assert.strictEqual(await fs.promises.readFile(path.join(targetDir, 'old.xml'), 'utf8'), '<Old/>');
    assert.deepStrictEqual(await fs.promises.readFile(path.join(nestedDir, 'Preview.bin')), Buffer.from([0, 255, 4]));
    assert.strictEqual(fs.existsSync(path.join(targetDir, 'OldRootEmpty')), true);
    assert.strictEqual(fs.existsSync(path.join(nestedDir, 'OldEmpty')), true);
    assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), false);
  });

  test('#264: repeated ensures in an existing nested tree roll back planned files without losing original children', async () => {
    const targetDir = path.join(tempDir, 'Tree');
    const nestedDir = path.join(targetDir, 'Forms', 'Nested');
    await fs.promises.mkdir(path.join(nestedDir, 'KeepEmpty'), { recursive: true });
    await fs.promises.writeFile(path.join(targetDir, 'old.xml'), '<Old/>', 'utf8');
    await fs.promises.writeFile(path.join(nestedDir, 'keep.bin'), Buffer.from([7, 0, 7]));
    const originalFingerprint = await calculateDirectoryFingerprint(targetDir);
    const originalRename = fs.promises.rename;
    fs.promises.rename = async function (source: fs.PathLike, destination: fs.PathLike): Promise<void> {
      if (path.basename(String(destination)) === 'C.xml') {
        throw new Error('injected late write failure');
      }
      return originalRename.call(fs.promises, source, destination);
    };

    try {
      await assert.rejects(
        new MutationPlanExecutor(tempDir).execute({
          kind: 'test.repeatedEnsureExistingRollback',
          steps: [
            { type: 'ensureDirectory', targetPath: targetDir },
            { type: 'writeFile', targetPath: path.join(targetDir, 'A.xml'), content: '<A/>', encoding: 'utf8', expected: { state: 'missing' } },
            { type: 'ensureDirectory', targetPath: targetDir },
            { type: 'ensureDirectory', targetPath: nestedDir },
            { type: 'writeFile', targetPath: path.join(nestedDir, 'A.xml'), content: '<NestedA/>', encoding: 'utf8', expected: { state: 'missing' } },
            { type: 'ensureDirectory', targetPath: nestedDir },
            { type: 'writeFile', targetPath: path.join(nestedDir, 'B.xml'), content: '<NestedB/>', encoding: 'utf8', expected: { state: 'missing' } },
            { type: 'writeFile', targetPath: path.join(targetDir, 'C.xml'), content: '<C/>', encoding: 'utf8', expected: { state: 'missing' } },
          ],
          result: undefined,
        }),
        (error: MutationPlanError) => error.code === 'PLAN_FAILED',
      );
    } finally {
      fs.promises.rename = originalRename;
    }

    assert.strictEqual(await calculateDirectoryFingerprint(targetDir), originalFingerprint);
    assert.strictEqual(await fs.promises.readFile(path.join(targetDir, 'old.xml'), 'utf8'), '<Old/>');
    assert.deepStrictEqual(await fs.promises.readFile(path.join(nestedDir, 'keep.bin')), Buffer.from([7, 0, 7]));
    assert.strictEqual(fs.existsSync(path.join(nestedDir, 'KeepEmpty')), true);
    assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), false);
  });

  test('#264: existing directory projection fails closed before delete when a write made its tree fingerprint unknown', async () => {
    const targetDir = path.join(tempDir, 'Tree');
    await fs.promises.mkdir(path.join(targetDir, 'OriginalEmpty'), { recursive: true });
    await fs.promises.writeFile(path.join(targetDir, 'old.xml'), '<Old/>', 'utf8');
    const originalFingerprint = await calculateDirectoryFingerprint(targetDir);

    await assert.rejects(
      new MutationPlanExecutor(tempDir).execute({
        kind: 'test.opaqueExistingDirectoryProjection',
        steps: [
          { type: 'writeFile', targetPath: path.join(targetDir, 'A.xml'), content: '<A/>', encoding: 'utf8', expected: { state: 'missing' } },
          { type: 'ensureDirectory', targetPath: targetDir },
          { type: 'deletePath', targetPath: targetDir, expected: { state: 'directory', fingerprint: originalFingerprint } },
        ],
        result: undefined,
      }),
      (error: MutationPlanError) => error.code === 'PLAN_CONFLICT',
    );

    assert.strictEqual(await calculateDirectoryFingerprint(targetDir), originalFingerprint);
    assert.strictEqual(fs.existsSync(path.join(targetDir, 'A.xml')), false);
    assert.strictEqual(await fs.promises.readFile(path.join(targetDir, 'old.xml'), 'utf8'), '<Old/>');
    assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), false);
  });

  test('#264: a directory-state-only move accepts a known child write in its source directory', async () => {
    const sourceDir = path.join(tempDir, 'Tree');
    const targetDir = path.join(tempDir, 'RenamedTree');
    const childPath = path.join(sourceDir, 'Existing.xml');
    await fs.promises.mkdir(sourceDir, { recursive: true });
    await fs.promises.writeFile(childPath, '<Old/>', 'utf8');

    await new MutationPlanExecutor(tempDir).execute({
      kind: 'test.directoryStateOnlyMoveAfterChildWrite',
      steps: [
        {
          type: 'writeFile', targetPath: childPath, content: '<Renamed/>', encoding: 'utf8',
          expected: { state: 'file', hash: hashContent('<Old/>') },
        },
        {
          type: 'movePath', sourcePath: sourceDir, targetPath: targetDir,
          sourceExpected: { state: 'directory' }, targetExpected: { state: 'missing' },
        },
      ],
      result: undefined,
    });

    assert.strictEqual(fs.existsSync(sourceDir), false);
    assert.strictEqual(await fs.promises.readFile(path.join(targetDir, 'Existing.xml'), 'utf8'), '<Renamed/>');
    assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), false);
  });

  test('#264: a stale explicit directory fingerprint still rejects a move after child writes before effects', async () => {
    const sourceDir = path.join(tempDir, 'Tree');
    const targetDir = path.join(tempDir, 'RenamedTree');
    const childPath = path.join(sourceDir, 'Existing.xml');
    await fs.promises.mkdir(sourceDir, { recursive: true });
    await fs.promises.writeFile(childPath, '<Old/>', 'utf8');
    const originalFingerprint = await calculateDirectoryFingerprint(sourceDir);

    await assert.rejects(
      new MutationPlanExecutor(tempDir).execute({
        kind: 'test.staleDirectoryFingerprintAfterChildWrite',
        steps: [
          {
            type: 'writeFile', targetPath: childPath, content: '<Renamed/>', encoding: 'utf8',
            expected: { state: 'file', hash: hashContent('<Old/>') },
          },
          {
            type: 'movePath', sourcePath: sourceDir, targetPath: targetDir,
            sourceExpected: { state: 'directory', fingerprint: originalFingerprint },
            targetExpected: { state: 'missing' },
          },
        ],
        result: undefined,
      }, 'stale-explicit-directory-fingerprint'),
      (error: MutationPlanError) => error.code === 'PLAN_CONFLICT',
    );

    assert.strictEqual(await fs.promises.readFile(childPath, 'utf8'), '<Old/>');
    assert.strictEqual(fs.existsSync(targetDir), false);
    assert.strictEqual(
      fs.existsSync(path.join(tempDir, '.cdt-journal', 'stale-explicit-directory-fingerprint')),
      false,
    );
    const journalRoot = path.join(tempDir, '.cdt-journal');
    if (fs.existsSync(journalRoot)) {
      const journalEntries = await fs.promises.readdir(journalRoot);
      assert.deepStrictEqual(
        journalEntries,
        [],
        `unexpected journal entries after preflight conflict: ${journalEntries.join(', ')}`,
      );
    }
  });

  test('#264: rollback rejects an opaque moved-directory state and preserves planned and foreign children', async () => {
    const sourceDir = path.join(tempDir, 'Tree');
    const targetDir = path.join(tempDir, 'MovedTree');
    const childPath = path.join(sourceDir, 'Existing.xml');
    const failurePath = path.join(tempDir, 'C.xml');
    await fs.promises.mkdir(sourceDir, { recursive: true });
    await fs.promises.writeFile(childPath, '<Old/>', 'utf8');
    const originalRename = fs.promises.rename;
    fs.promises.rename = async function (source: fs.PathLike, destination: fs.PathLike): Promise<void> {
      if (path.basename(String(destination)) === path.basename(failurePath)) {
        throw new Error('injected failure after directory move');
      }
      await originalRename.call(fs.promises, source, destination);
      if (
        path.basename(String(source)) === path.basename(sourceDir)
        && path.basename(String(destination)) === path.basename(targetDir)
      ) {
        await fs.promises.writeFile(path.join(targetDir, 'Foreign.xml'), '<Foreign/>', 'utf8');
      }
    };

    try {
      await assert.rejects(
        new MutationPlanExecutor(tempDir).execute({
          kind: 'test.opaqueMovedDirectoryRollback',
          steps: [
            {
              type: 'writeFile', targetPath: childPath, content: '<Planned/>', encoding: 'utf8',
              expected: { state: 'file', hash: hashContent('<Old/>') },
            },
            {
              type: 'movePath', sourcePath: sourceDir, targetPath: targetDir,
              sourceExpected: { state: 'directory' }, targetExpected: { state: 'missing' },
            },
            {
              type: 'writeFile', targetPath: failurePath, content: '<C/>', encoding: 'utf8',
              expected: { state: 'missing' },
            },
          ],
          result: undefined,
        }),
        (error: MutationPlanError) => error.code === 'RECOVERY_REQUIRED',
      );
    } finally {
      fs.promises.rename = originalRename;
    }

    assert.strictEqual(fs.existsSync(sourceDir), false);
    assert.strictEqual(await fs.promises.readFile(path.join(targetDir, 'Existing.xml'), 'utf8'), '<Planned/>');
    assert.strictEqual(await fs.promises.readFile(path.join(targetDir, 'Foreign.xml'), 'utf8'), '<Foreign/>');
    assert.strictEqual(fs.existsSync(failurePath), false);
    assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), true);
  });

  test('#264: crash recovery handles recorded and unrecorded writes after repeated ensure', async () => {
    for (const crashPoint of ['after-repeat-ensure', 'after-next-write-before-counter'] as const) {
      const root = path.join(tempDir, crashPoint);
      await fs.promises.mkdir(root, { recursive: true });
      const targetDir = path.join(root, 'Tree');
      const nestedDir = path.join(targetDir, 'Generated', 'Empty');
      await fs.promises.mkdir(path.join(targetDir, 'OldEmpty'), { recursive: true });
      await fs.promises.writeFile(path.join(targetDir, 'old.xml'), '<Old/>', 'utf8');
      const originalFingerprint = await calculateDirectoryFingerprint(targetDir);
      const aPath = path.join(targetDir, 'A.xml');
      const bPath = path.join(nestedDir, 'B.xml');
      const cPath = path.join(nestedDir, 'C.xml');
      const plan = {
        kind: 'test.repeatedEnsureCrashRecovery',
        steps: [
          { type: 'deletePath' as const, targetPath: targetDir, expected: { state: 'directory' as const, fingerprint: originalFingerprint } },
          { type: 'ensureDirectory' as const, targetPath: targetDir },
          { type: 'writeFile' as const, targetPath: aPath, content: '<A/>', encoding: 'utf8' as const, expected: { state: 'missing' as const } },
          { type: 'ensureDirectory' as const, targetPath: targetDir },
          { type: 'ensureDirectory' as const, targetPath: nestedDir },
          { type: 'writeFile' as const, targetPath: bPath, content: '<B/>', encoding: 'utf8' as const, expected: { state: 'missing' as const } },
          { type: 'ensureDirectory' as const, targetPath: nestedDir },
          { type: 'writeFile' as const, targetPath: cPath, content: '<C/>', encoding: 'utf8' as const, expected: { state: 'missing' as const } },
        ],
        result: null,
      };
      const appliedSteps = 7;
      const interruptedOp = path.join(root, '.cdt-journal', `interrupted-${crashPoint}`);
      const backupPath = path.join(interruptedOp, 'backups', '0');
      await fs.promises.mkdir(path.dirname(backupPath), { recursive: true });
      await fs.promises.cp(targetDir, backupPath, { recursive: true });
      const snapshots = [
        { targetPath: targetDir, state: 'directory', fingerprint: originalFingerprint, backupName: '0', contentsBackedUp: true },
        { targetPath: aPath, state: 'missing', contentsBackedUp: false },
        { targetPath: nestedDir, state: 'missing', contentsBackedUp: false },
        { targetPath: bPath, state: 'missing', contentsBackedUp: false },
        { targetPath: cPath, state: 'missing', contentsBackedUp: false },
      ];
      await fs.promises.writeFile(path.join(interruptedOp, 'owner.json'), JSON.stringify({ pid: 999999, createdAt: Date.now() - 10000 }), 'utf8');
      await fs.promises.writeFile(path.join(interruptedOp, 'journal.json'), JSON.stringify({
        version: 1,
        operationId: `interrupted-${crashPoint}`,
        plan,
        state: 'applying',
        appliedSteps,
        snapshots,
      }), 'utf8');

      await fs.promises.rm(targetDir, { recursive: true, force: true });
      await fs.promises.mkdir(targetDir, { recursive: true });
      await fs.promises.writeFile(aPath, '<A/>', 'utf8');
      await fs.promises.mkdir(nestedDir, { recursive: true });
      await fs.promises.writeFile(bPath, '<B/>', 'utf8');
      if (crashPoint === 'after-next-write-before-counter') {
        await fs.promises.writeFile(cPath, '<C/>', 'utf8');
      }

      await new MutationPlanExecutor(root).recover();

      assert.strictEqual(await calculateDirectoryFingerprint(targetDir), originalFingerprint, `rollback failed at ${crashPoint}`);
      assert.strictEqual(await fs.promises.readFile(path.join(targetDir, 'old.xml'), 'utf8'), '<Old/>');
      assert.strictEqual(fs.existsSync(path.join(targetDir, 'OldEmpty')), true);
      assert.strictEqual(fs.existsSync(path.join(root, '.cdt-journal')), false);
    }
  });

  test('#264: recovery preserves a real external edit after repeated ensure projection', async () => {
    const targetDir = path.join(tempDir, 'Tree');
    await fs.promises.mkdir(path.join(targetDir, 'OldEmpty'), { recursive: true });
    await fs.promises.writeFile(path.join(targetDir, 'old.xml'), '<Old/>', 'utf8');
    const originalFingerprint = await calculateDirectoryFingerprint(targetDir);
    const originalRename = fs.promises.rename;
    let externalEditAdded = false;
    fs.promises.rename = async function (source: fs.PathLike, destination: fs.PathLike): Promise<void> {
      if (path.basename(String(destination)) === 'B.xml' && !externalEditAdded) {
        await originalRename.call(fs.promises, source, destination);
        externalEditAdded = true;
        await fs.promises.writeFile(path.join(targetDir, 'foreign.xml'), '<Foreign/>', 'utf8');
        return;
      }
      if (path.basename(String(destination)) === 'C.xml') {
        throw new Error('injected late write failure');
      }
      return originalRename.call(fs.promises, source, destination);
    };

    try {
      await assert.rejects(
        new MutationPlanExecutor(tempDir).execute({
          kind: 'test.repeatedEnsureExternalEdit',
          steps: [
            { type: 'deletePath', targetPath: targetDir, expected: { state: 'directory', fingerprint: originalFingerprint } },
            { type: 'ensureDirectory', targetPath: targetDir },
            { type: 'writeFile', targetPath: path.join(targetDir, 'A.xml'), content: '<A/>', encoding: 'utf8', expected: { state: 'missing' } },
            { type: 'ensureDirectory', targetPath: targetDir },
            { type: 'writeFile', targetPath: path.join(targetDir, 'B.xml'), content: '<B/>', encoding: 'utf8', expected: { state: 'missing' } },
            { type: 'writeFile', targetPath: path.join(targetDir, 'C.xml'), content: '<C/>', encoding: 'utf8', expected: { state: 'missing' } },
          ],
          result: undefined,
        }),
        (error: MutationPlanError) => error.code === 'RECOVERY_REQUIRED',
      );
    } finally {
      fs.promises.rename = originalRename;
    }

    assert.strictEqual(await fs.promises.readFile(path.join(targetDir, 'foreign.xml'), 'utf8'), '<Foreign/>');
    assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), true);
  });

  test('#264: crash recovery restores a reset subtree before recreation, after recreation, and after a child write', async () => {
    for (const crashPoint of ['after-delete', 'after-recreate', 'after-child-write'] as const) {
      const root = path.join(tempDir, crashPoint);
      await fs.promises.mkdir(root, { recursive: true });
      const targetDir = path.join(root, 'Resources');
      const originalNested = path.join(targetDir, 'Forms', 'Nested');
      await fs.promises.mkdir(path.join(originalNested, 'OldEmpty'), { recursive: true });
      await fs.promises.mkdir(path.join(targetDir, 'OldRootEmpty'), { recursive: true });
      await fs.promises.writeFile(path.join(targetDir, 'obsolete.xml'), '<Old/>', 'utf8');
      await fs.promises.writeFile(path.join(targetDir, 'Forms', 'Form.xml'), '<OldForm/>', 'utf8');
      await fs.promises.writeFile(path.join(originalNested, 'Preview.bin'), Buffer.from([3, 2, 1]));
      const originalFingerprint = await calculateDirectoryFingerprint(targetDir);
      const targetXml = path.join(targetDir, 'Forms', 'Form.xml');
      const targetBinary = path.join(originalNested, 'Preview.bin');
      const emptyDir = path.join(targetDir, 'Generated', 'Empty');
      const plan = {
        kind: 'test.subtreeResetCrashRecovery',
        steps: [
          {
            type: 'deletePath' as const, targetPath: targetDir,
            expected: { state: 'directory' as const, fingerprint: originalFingerprint },
          },
          { type: 'ensureDirectory' as const, targetPath: targetDir },
          { type: 'ensureDirectory' as const, targetPath: path.join(targetDir, 'Forms') },
          { type: 'ensureDirectory' as const, targetPath: originalNested },
          { type: 'ensureDirectory' as const, targetPath: emptyDir },
          { type: 'writeFile' as const, targetPath: targetXml, content: '<NewForm/>', encoding: 'utf8' as const, expected: { state: 'missing' as const } },
          { type: 'writeFile' as const, targetPath: targetBinary, content: Buffer.from([0, 255]).toString('base64'), encoding: 'base64' as const, expected: { state: 'missing' as const } },
        ],
        result: null,
      };
      const appliedStepsByCrashPoint = {
        'after-delete': 1,
        'after-recreate': 5,
        'after-child-write': 6,
      };
      const appliedSteps = appliedStepsByCrashPoint[crashPoint];
      const interruptedOp = path.join(root, '.cdt-journal', `interrupted-${crashPoint}`);
      const backupPath = path.join(interruptedOp, 'backups', '0');
      await fs.promises.mkdir(path.dirname(backupPath), { recursive: true });
      await fs.promises.cp(targetDir, backupPath, { recursive: true });
      const snapshots = [
        { targetPath: targetDir, state: 'directory', fingerprint: originalFingerprint, backupName: '0', contentsBackedUp: true },
        { targetPath: path.join(targetDir, 'Forms'), state: 'directory', fingerprint: await calculateDirectoryFingerprint(path.join(targetDir, 'Forms')), contentsBackedUp: false },
        { targetPath: originalNested, state: 'directory', fingerprint: await calculateDirectoryFingerprint(originalNested), contentsBackedUp: false },
        { targetPath: emptyDir, state: 'missing', contentsBackedUp: false },
        { targetPath: targetXml, state: 'file', hash: hashContent('<OldForm/>'), backupName: '1', contentsBackedUp: true },
        { targetPath: targetBinary, state: 'file', hash: hashContent(Buffer.from([3, 2, 1])), backupName: '2', contentsBackedUp: true },
      ];
      await fs.promises.writeFile(path.join(interruptedOp, 'backups', '1'), '<OldForm/>', 'utf8');
      await fs.promises.writeFile(path.join(interruptedOp, 'backups', '2'), Buffer.from([3, 2, 1]));
      await fs.promises.writeFile(path.join(interruptedOp, 'owner.json'), JSON.stringify({ pid: 999999, createdAt: Date.now() - 10000 }), 'utf8');
      await fs.promises.writeFile(path.join(interruptedOp, 'journal.json'), JSON.stringify({
        version: 1,
        operationId: `interrupted-${crashPoint}`,
        plan,
        state: 'applying',
        appliedSteps,
        snapshots,
      }), 'utf8');

      await fs.promises.rm(targetDir, { recursive: true, force: true });
      if (appliedSteps >= 2) {
        await fs.promises.mkdir(path.join(targetDir, 'Forms', 'Nested'), { recursive: true });
        await fs.promises.mkdir(emptyDir, { recursive: true });
      }
      if (appliedSteps >= 6) {
        await fs.promises.writeFile(targetXml, '<NewForm/>', 'utf8');
      }

      await new MutationPlanExecutor(root).recover();

      assert.strictEqual(await calculateDirectoryFingerprint(targetDir), originalFingerprint, `rollback failed at ${crashPoint}`);
      assert.strictEqual(await fs.promises.readFile(targetXml, 'utf8'), '<OldForm/>');
      assert.deepStrictEqual(await fs.promises.readFile(targetBinary), Buffer.from([3, 2, 1]));
      assert.strictEqual(fs.existsSync(path.join(targetDir, 'OldRootEmpty')), true);
      assert.strictEqual(fs.existsSync(path.join(originalNested, 'OldEmpty')), true);
      assert.strictEqual(fs.existsSync(path.join(root, '.cdt-journal')), false);
    }
  });

  test('serializes plans per root and reports a stale second writer as a typed conflict', async () => {
    const target = path.join(tempDir, 'Configuration.xml');
    await fs.promises.writeFile(target, 'original', 'utf8');
    const expected = { state: 'file' as const, hash: hashContent('original') };
    const originalRealpathDescriptor = Object.getOwnPropertyDescriptor(fs.promises, 'realpath');
    if (!originalRealpathDescriptor || typeof originalRealpathDescriptor.value !== 'function') {
      throw new Error('fs.promises.realpath must be a configurable data property for this test.');
    }
    const originalRealpath = originalRealpathDescriptor.value as typeof fs.promises.realpath;
    let rootRealpathCalls = 0;
    let markFirstRealpathEntered!: () => void;
    let releaseFirstRealpath!: () => void;
    const firstRealpathEntered = new Promise<void>((resolve) => { markFirstRealpathEntered = resolve; });
    const firstRealpathGate = new Promise<void>((resolve) => { releaseFirstRealpath = resolve; });
    const interceptedRealpath = async (requestedPath: fs.PathLike): Promise<string> => {
      if (path.resolve(String(requestedPath)) === path.resolve(tempDir)) {
        rootRealpathCalls++;
        if (rootRealpathCalls === 1) {
          markFirstRealpathEntered();
          await firstRealpathGate;
        }
      }
      return originalRealpath(requestedPath);
    };
    Object.defineProperty(fs.promises, 'realpath', {
      ...originalRealpathDescriptor,
      value: interceptedRealpath,
    });

    let first: Promise<string> | undefined;
    let second: Promise<string> | undefined;
    try {
      first = new MutationPlanExecutor(tempDir).execute({
        kind: 'test.concurrent.first',
        steps: [{
          type: 'writeFile', targetPath: target, content: 'first', encoding: 'utf8', expected,
        }],
        result: 'first',
      });
      await firstRealpathEntered;
      second = new MutationPlanExecutor(tempDir).execute({
        kind: 'test.concurrent.second',
        steps: [{
          type: 'writeFile', targetPath: target, content: 'second', encoding: 'utf8', expected,
        }],
        result: 'second',
      });

      assert.strictEqual(rootRealpathCalls, 1, 'The second writer must queue before canonicalization.');
      releaseFirstRealpath();
      const outcomes = await Promise.allSettled([first, second]);
      assert.strictEqual(outcomes[0].status, 'fulfilled');
      assert.strictEqual(outcomes[1].status, 'rejected');
      const rejection = outcomes[1] as PromiseRejectedResult;
      assert.ok(rejection.reason instanceof MutationPlanError);
      assert.strictEqual((rejection.reason as MutationPlanError).code, 'PLAN_CONFLICT');
      assert.strictEqual(await fs.promises.readFile(target, 'utf8'), 'first');
      assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), false);
    } finally {
      releaseFirstRealpath();
      Object.defineProperty(fs.promises, 'realpath', originalRealpathDescriptor);
      await Promise.allSettled([first, second].filter((value): value is Promise<string> => value !== undefined));
    }
    assert.deepStrictEqual(
      Object.getOwnPropertyDescriptor(fs.promises, 'realpath'),
      originalRealpathDescriptor,
    );
  });

  test('recovers an interrupted journal before accepting another mutation', async () => {
    const target = path.join(tempDir, 'Configuration.xml');
    await fs.promises.writeFile(target, 'original', 'utf8');
    const operationPath = path.join(tempDir, '.cdt-journal', 'interrupted');
    await fs.promises.mkdir(path.join(operationPath, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(operationPath, 'backups', '0'), 'original', 'utf8');
    await fs.promises.writeFile(target, 'partial-effect', 'utf8');
    await fs.promises.writeFile(path.join(operationPath, 'journal.json'), JSON.stringify({
      version: 1,
      operationId: 'interrupted',
      plan: {
        kind: 'test.interrupted',
        steps: [{
          type: 'writeFile',
          targetPath: target,
          content: 'partial-effect',
          encoding: 'utf8',
          expected: { state: 'file', hash: hashContent('original') },
        }],
        result: null,
      },
      state: 'applying',
      appliedSteps: 1,
      snapshots: [{
        targetPath: target,
        state: 'file',
        hash: hashContent('original'),
        backupName: '0',
        contentsBackedUp: true,
      }],
    }), 'utf8');

    await new MutationPlanExecutor(tempDir).recover();

    assert.strictEqual(await fs.promises.readFile(target, 'utf8'), 'original');
    assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), false);
  });

  test('read-only source assertions are boundary-checked and stay outside recovery snapshots around crash boundaries', async () => {
    const source = path.join(tempDir, 'source.xml');
    const sourceDirectory = path.join(tempDir, 'sourceDirectory');
    const target = path.join(tempDir, 'duplicate.xml');
    const sourceContent = '<source/>';
    const sourceArtifactPath = path.join(sourceDirectory, 'Main.xml');
    const targetContent = '<duplicate/>';
    await fs.promises.writeFile(source, sourceContent, 'utf8');
    await fs.promises.mkdir(sourceDirectory, { recursive: true });
    await fs.promises.writeFile(sourceArtifactPath, '<artifact/>', 'utf8');
    const sourceMtime = (await fs.promises.stat(source)).mtimeMs;
    const plan = {
      kind: 'test.readOnlySourceAssertionsRecovery',
      steps: [
        { type: 'assertFile' as const, targetPath: source, expected: { state: 'file' as const, hash: hashContent(sourceContent) } },
        {
          type: 'assertDirectory' as const,
          targetPath: sourceDirectory,
          expected: { state: 'directory' as const, fingerprint: await calculateDirectoryFingerprint(sourceDirectory) },
        },
        { type: 'writeFile' as const, targetPath: target, content: targetContent, encoding: 'utf8' as const, expected: { state: 'missing' as const } },
      ],
      result: null,
    };

    for (const scenario of [
      { operationId: 'before-read-only-assertions', appliedSteps: 0, targetWritten: false },
      { operationId: 'after-source-file-assertion', appliedSteps: 1, targetWritten: false },
      { operationId: 'after-source-directory-assertion', appliedSteps: 2, targetWritten: false },
      { operationId: 'write-before-counter', appliedSteps: 2, targetWritten: true },
      { operationId: 'write-recorded', appliedSteps: 3, targetWritten: true },
    ]) {
      await fs.promises.rm(target, { force: true });
      if (scenario.targetWritten) {
        await fs.promises.writeFile(target, targetContent, 'utf8');
      }
      const operationPath = path.join(tempDir, '.cdt-journal', scenario.operationId);
      await fs.promises.mkdir(path.join(operationPath, 'backups'), { recursive: true });
      const snapshots = [{ targetPath: target, state: 'missing', contentsBackedUp: false }];
      assert.ok(!snapshots.some((snapshot) => snapshot.targetPath === source),
        'the read-only source file assertion must never have a backup or restore snapshot');
      assert.ok(!snapshots.some((snapshot) => snapshot.targetPath === sourceDirectory),
        'the read-only source directory assertion must never have a backup or restore snapshot');
      await fs.promises.writeFile(path.join(operationPath, 'journal.json'), JSON.stringify({
        version: 1,
        operationId: scenario.operationId,
        plan,
        state: 'applying',
        appliedSteps: scenario.appliedSteps,
        snapshots,
      }), 'utf8');

      await assert.doesNotReject(() => new MutationPlanExecutor(tempDir).recover(),
        `${scenario.operationId} must recover without a false RECOVERY_REQUIRED`);
      assert.strictEqual(fs.existsSync(target), false,
        `${scenario.operationId} must roll back a later duplicate write when it occurred`);
      assert.strictEqual(await fs.promises.readFile(source, 'utf8'), sourceContent);
      assert.strictEqual((await fs.promises.stat(source)).mtimeMs, sourceMtime);
      assert.strictEqual(fs.existsSync(operationPath), false);
    }

    const externalRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mutation-plan-outside-'));
    const externalSource = path.join(externalRoot, 'source.xml');
    const externalDirectory = path.join(externalRoot, 'sourceDirectory');
    await fs.promises.writeFile(externalSource, sourceContent, 'utf8');
    await fs.promises.mkdir(externalDirectory, { recursive: true });
    await fs.promises.writeFile(path.join(externalDirectory, 'Main.xml'), '<artifact/>', 'utf8');
    const externalDirectoryFingerprint = await calculateDirectoryFingerprint(externalDirectory);
    try {
      await assert.rejects(
        () => new MutationPlanExecutor(tempDir).execute({
          kind: 'test.readOnlySourceAssertionsBoundary',
          steps: [
            { type: 'assertFile', targetPath: source, expected: { state: 'file', hash: hashContent(sourceContent) } },
            {
              type: 'assertDirectory',
              targetPath: externalDirectory,
              expected: { state: 'directory', fingerprint: externalDirectoryFingerprint },
            },
            { type: 'writeFile', targetPath: target, content: targetContent, encoding: 'utf8', expected: { state: 'missing' } },
          ],
          result: undefined,
        }),
        (error: unknown) => Boolean(error && typeof error === 'object'
          && (error as { code?: string }).code === 'PATH_OUTSIDE_ROOT'),
      );
      assert.strictEqual(fs.existsSync(target), false, 'out-of-root assertion must fail before any write');
    } finally {
      await fs.promises.rm(externalRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('Issue #167: failed preparation cleans up pre-effect operation directory and unblocks next plan', async () => {
    const fileA = path.join(tempDir, 'fileA.xml');
    const fileB = path.join(tempDir, 'fileB.xml');
    await fs.promises.writeFile(fileA, 'initial-A', 'utf8');
    await fs.promises.writeFile(fileB, 'initial-B', 'utf8');
    const executor = new MutationPlanExecutor(tempDir);

    const origWriteFile = fs.promises.writeFile;
    let failTempJournal = true;
    (fs.promises as any).writeFile = async (targetPath: any, data: any, options: any) => {
      if (failTempJournal && typeof targetPath === 'string' && targetPath.includes('.journal-') && targetPath.endsWith('.tmp')) {
        const err = new Error('ENOSPC: write failed');
        (err as any).code = 'ENOSPC';
        throw err;
      }
      return origWriteFile.call(fs.promises, targetPath, data, options);
    };

    try {
      await assert.rejects(
        executor.execute({
          kind: 'test.plan1',
          steps: [{
            type: 'writeFile', targetPath: fileA, content: 'mutated-A', encoding: 'utf8',
            expected: { state: 'file', hash: hashContent('initial-A') },
          }],
          result: null,
        }),
        (err: Error) => (err as any).code === 'ENOSPC' || err.message.includes('ENOSPC'),
      );
    } finally {
      (fs.promises as any).writeFile = origWriteFile;
    }

    // Target fileA was never modified
    assert.strictEqual(await fs.promises.readFile(fileA, 'utf8'), 'initial-A');

    // Preparation failure must clean up immediately, not rely on next recover()
    assert.strictEqual(
      fs.existsSync(path.join(tempDir, '.cdt-journal')),
      false,
      'failed preparation must clean up immediately, not rely on next recover()',
    );

    // Subsequent plan2 must succeed without RECOVERY_REQUIRED
    await executor.execute({
      kind: 'test.plan2',
      steps: [{
        type: 'writeFile', targetPath: fileB, content: 'mutated-B', encoding: 'utf8',
        expected: { state: 'file', hash: hashContent('initial-B') },
      }],
      result: null,
    });

    assert.strictEqual(await fs.promises.readFile(fileB, 'utf8'), 'mutated-B');
    assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), false);
  });

  test('Issue #167: failed snapshot copying during preparation cleans up partially written backups immediately', async () => {
    const fileA = path.join(tempDir, 'fileA.xml');
    await fs.promises.writeFile(fileA, 'initial-A', 'utf8');
    const executor = new MutationPlanExecutor(tempDir);

    const origCopyFile = fs.promises.copyFile;
    (fs.promises as any).copyFile = async () => {
      throw new Error('EACCES: copyFile denied during snapshot');
    };

    try {
      await assert.rejects(
        executor.execute({
          kind: 'test.snapshotFailure',
          steps: [{
            type: 'writeFile', targetPath: fileA, content: 'mutated-A', encoding: 'utf8',
            expected: { state: 'file', hash: hashContent('initial-A') },
          }],
          result: null,
        }),
        /EACCES: copyFile denied/,
      );
    } finally {
      (fs.promises as any).copyFile = origCopyFile;
    }

    assert.strictEqual(await fs.promises.readFile(fileA, 'utf8'), 'initial-A');
    assert.strictEqual(
      fs.existsSync(path.join(tempDir, '.cdt-journal')),
      false,
      'snapshot preparation failure must remove operation directory and journal root immediately',
    );
  });

  test('Issue #167: execute() rejects unsafe operationId with path traversal or hidden prefix', async () => {
    const fileA = path.join(tempDir, 'fileA.xml');
    await fs.promises.writeFile(fileA, 'initial-A', 'utf8');
    const executor = new MutationPlanExecutor(tempDir);

    for (const badOpId of ['../escape', 'foo/bar', '.hidden', '..']) {
      await assert.rejects(
        executor.execute(
          {
            kind: 'test.unsafeOpId',
            steps: [{
              type: 'writeFile', targetPath: fileA, content: 'mutated', encoding: 'utf8',
              expected: { state: 'file', hash: hashContent('initial-A') },
            }],
            result: null,
          },
          badOpId,
        ),
        (err: MutationPlanError) => {
          assert.strictEqual(err.code, 'PLAN_CONFLICT');
          return true;
        },
      );
    }
  });

  test('Issue #167: recover() does NOT treat unreadable journal.json as orphan and preserves backups with RECOVERY_REQUIRED', async () => {
    const unreadableOp = path.join(tempDir, '.cdt-journal', 'unreadable-journal-op');
    await fs.promises.mkdir(path.join(unreadableOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(unreadableOp, 'backups', '0'), 'critical-backup', 'utf8');
    // Create journal.json as a directory so readFile throws EISDIR (non-ENOENT)
    await fs.promises.mkdir(path.join(unreadableOp, 'journal.json'));

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      executor.recover(),
      (err: MutationPlanError) => {
        assert.strictEqual(err.code, 'RECOVERY_REQUIRED');
        assert.ok(err.message.includes('unreadable-journal-op'));
        return true;
      },
    );

    assert.ok(
      fs.existsSync(path.join(unreadableOp, 'backups', '0')),
      'Backups must survive when journal read fails with non-ENOENT error',
    );
  });

  test('Issue #167: recover() safely cleans up orphan operation directories without journal.json', async () => {
    const orphanOp = path.join(tempDir, '.cdt-journal', 'orphan-op-1');
    await fs.promises.mkdir(path.join(orphanOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(orphanOp, '.journal-abandoned.tmp'), '{"partial":true}', 'utf8');

    const fileB = path.join(tempDir, 'fileB.xml');
    await fs.promises.writeFile(fileB, 'initial-B', 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    // recover() must not throw RECOVERY_REQUIRED due to missing journal.json
    await executor.recover();

    assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), false);

    // After recover(), plans can execute normally
    await executor.execute({
      kind: 'test.plan2',
      steps: [{
        type: 'writeFile', targetPath: fileB, content: 'mutated-B', encoding: 'utf8',
        expected: { state: 'file', hash: hashContent('initial-B') },
      }],
      result: null,
    });
    assert.strictEqual(await fs.promises.readFile(fileB, 'utf8'), 'mutated-B');
  });

  test('Issue #167: recover() cleans up orphan directory while still rolling back valid interrupted journal', async () => {
    const targetA = path.join(tempDir, 'fileA.xml');
    const targetB = path.join(tempDir, 'fileB.xml');
    await fs.promises.writeFile(targetA, 'interrupted-effect', 'utf8');
    await fs.promises.writeFile(targetB, 'initial-B', 'utf8');

    // 1. Orphan operation folder with no journal.json but with CDT temp journal marker
    const orphanOp = path.join(tempDir, '.cdt-journal', 'orphan-op-empty');
    await fs.promises.mkdir(path.join(orphanOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(orphanOp, '.journal-abandoned.tmp'), '{"partial":true}', 'utf8');

    // 2. Real interrupted operation folder with valid journal.json
    const interruptedOp = path.join(tempDir, '.cdt-journal', 'real-interrupted');
    await fs.promises.mkdir(path.join(interruptedOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(interruptedOp, 'backups', '0'), 'original-A', 'utf8');
    await fs.promises.writeFile(path.join(interruptedOp, 'journal.json'), JSON.stringify({
      version: 1,
      operationId: 'real-interrupted',
      plan: {
        kind: 'test.interrupted',
        steps: [{
          type: 'writeFile',
          targetPath: targetA,
          content: 'interrupted-effect',
          encoding: 'utf8',
          expected: { state: 'file', hash: hashContent('original-A') },
        }],
        result: null,
      },
      state: 'applying',
      appliedSteps: 1,
      snapshots: [{
        targetPath: targetA,
        state: 'file',
        hash: hashContent('original-A'),
        backupName: '0',
        contentsBackedUp: true,
      }],
    }), 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    await executor.recover();

    // targetA rolled back to original
    assert.strictEqual(await fs.promises.readFile(targetA, 'utf8'), 'original-A');
    // .cdt-journal fully cleaned up
    assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), false);
  });

  test('#349: recover() reports an orphan cleanup failure, records safe diagnostics, and recovers adjacent rollback on retry', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    const orphanOp = path.join(journalRoot, '01-orphan-op');
    const abandonedTemp = path.join(orphanOp, '.journal-abandoned.tmp');
    await fs.promises.mkdir(path.join(orphanOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(abandonedTemp, 'metadata-secret-must-not-be-logged', 'utf8');

    const target = path.join(tempDir, 'pending-target.xml');
    const pendingOp = path.join(journalRoot, '02-pending-rollback');
    await fs.promises.writeFile(target, 'partial-effect', 'utf8');
    await fs.promises.mkdir(path.join(pendingOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(pendingOp, 'backups', '0'), 'original', 'utf8');
    await fs.promises.writeFile(path.join(pendingOp, 'journal.json'), JSON.stringify({
      version: 1,
      operationId: '02-pending-rollback',
      plan: {
        kind: 'test.pendingRollback',
        steps: [{
          type: 'writeFile',
          targetPath: target,
          content: 'partial-effect',
          encoding: 'utf8',
          expected: { state: 'file', hash: hashContent('original') },
        }],
        result: null,
      },
      state: 'rollback-required',
      appliedSteps: 1,
      snapshots: [{
        targetPath: target,
        state: 'file',
        hash: hashContent('original'),
        backupName: '0',
        contentsBackedUp: true,
      }],
    }), 'utf8');

    const originalRm = fs.promises.rm;
    let injected = false;
    (fs.promises as any).rm = async (targetPath: fs.PathLike, options?: fs.RmDirOptions) => {
      if (!injected && path.resolve(String(targetPath)) === path.resolve(orphanOp)) {
        injected = true;
        const error = new Error('controlled EBUSY during orphan removal') as NodeJS.ErrnoException;
        error.code = 'EBUSY';
        throw error;
      }
      return originalRm.call(fs.promises, targetPath, options);
    };

    const executor = new MutationPlanExecutor(tempDir);
    Logger.clearBuffer();
    try {
      await assert.rejects(
        executor.recover(),
        (error: unknown) => error instanceof MutationPlanError
          && error.code === 'RECOVERY_REQUIRED'
          && error.message.includes('01-orphan-op'),
      );
    } finally {
      (fs.promises as any).rm = originalRm;
    }

    assert.strictEqual(injected, true, 'the controlled filesystem failure must be exercised');
    assert.strictEqual(fs.existsSync(orphanOp), true, 'failed orphan cleanup must retain the directory');
    const diagnostic = Logger.getBufferedContent();
    assert.ok(diagnostic.includes('"stage":"orphan-operation-directory"'), diagnostic);
    assert.ok(diagnostic.includes('"fsCode":"EBUSY"'), diagnostic);
    assert.ok(diagnostic.includes('"name":".journal-abandoned.tmp"'), diagnostic);
    assert.ok(diagnostic.includes('"type":"file"'), diagnostic);
    assert.ok(!diagnostic.includes('metadata-secret-must-not-be-logged'), 'diagnostics must not include file contents');

    await executor.recover();
    assert.strictEqual(await fs.promises.readFile(target, 'utf8'), 'original');
    assert.strictEqual(fs.existsSync(orphanOp), false);
    assert.strictEqual(fs.existsSync(pendingOp), false);
    assert.strictEqual(fs.existsSync(journalRoot), false);
  });

  test('#349: malformed lease claims and heartbeat records fail closed', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    await fs.promises.mkdir(journalRoot, { recursive: true });
    const malformedClaimPath = path.join(journalRoot, '.root-lease.json.claim-v2-invalid');
    const now = Date.now() - 60_000;
    await fs.promises.writeFile(malformedClaimPath, JSON.stringify({
      leaseId: 'malformed-claim',
      pid: 2147483647,
      createdAt: now,
      heartbeatAt: now,
      operationId: 'malformed-claim-test',
    }), 'utf8');

    await assert.rejects(
      new MutationPlanExecutor(tempDir).recover(),
      (error: unknown) => error instanceof MutationPlanError && error.code === 'PLAN_CONFLICT',
    );
    assert.strictEqual(fs.existsSync(malformedClaimPath), true, 'malformed claim markers must remain untouched');
    await fs.promises.rm(malformedClaimPath, { force: true });

    const executor = new MutationPlanExecutor(tempDir);
    const malformedRecords = [
      { leaseId: 'missing-record-id', record: JSON.stringify({ heartbeatAt: Date.now() }) },
      { leaseId: 'invalid-heartbeat-time', record: JSON.stringify({ leaseId: 'invalid-heartbeat-time', heartbeatAt: 'invalid' }) },
      { leaseId: 'non-object-heartbeat', record: '[]' },
    ];
    for (const malformed of malformedRecords) {
      const heartbeatHash = createHash('sha256').update(malformed.leaseId, 'utf8').digest('hex');
      const heartbeatPath = path.join(journalRoot, `.root-lease.json.${heartbeatHash}.heartbeat`);
      await fs.promises.writeFile(heartbeatPath, malformed.record, 'utf8');
      await assert.rejects(
        executor.recover(),
        (error: unknown) => error instanceof MutationPlanError
          && error.code === 'RECOVERY_REQUIRED'
          && error.message.includes('heartbeat'),
      );
      assert.strictEqual(fs.existsSync(heartbeatPath), true, 'malformed sidecars must remain untouched');
      await fs.promises.rm(heartbeatPath, { force: true });
    }
  });

  test('#349: recover removes a valid heartbeat temp left by failed rename and cleanup', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    await fs.promises.mkdir(journalRoot, { recursive: true });
    const leaseId = 'heartbeat-temp-rename-cleanup';
    const heartbeatPath = rootLeaseHeartbeatPath(journalRoot, leaseId);
    const originalRename = fs.promises.rename;
    const originalRm = fs.promises.rm;
    let renameFailed = false;
    let cleanupFailed = false;
    (fs.promises as any).rename = async (sourcePath: fs.PathLike, targetPath: fs.PathLike) => {
      if (!renameFailed && path.resolve(String(targetPath)) === path.resolve(heartbeatPath)) {
        renameFailed = true;
        const error = new Error('controlled EBUSY during heartbeat rename') as NodeJS.ErrnoException;
        error.code = 'EBUSY';
        throw error;
      }
      return originalRename.call(fs.promises, sourcePath, targetPath);
    };
    (fs.promises as any).rm = async (targetPath: fs.PathLike, options?: fs.RmDirOptions) => {
      const name = path.basename(String(targetPath));
      if (renameFailed && !cleanupFailed && name.startsWith(path.basename(heartbeatPath)) && name.endsWith('.tmp')) {
        cleanupFailed = true;
        const error = new Error('controlled EPERM during heartbeat temp cleanup') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return originalRm.call(fs.promises, targetPath, options);
    };

    Logger.clearBuffer();
    try {
      await assert.rejects(
        writeRootLeaseHeartbeat(heartbeatPath, leaseId, Date.now()),
        (error: unknown) => error instanceof Error
          && 'code' in error
          && error.code === 'EBUSY',
      );
    } finally {
      (fs.promises as any).rename = originalRename;
      (fs.promises as any).rm = originalRm;
    }

    assert.strictEqual(renameFailed, true);
    assert.strictEqual(cleanupFailed, true);
    assert.ok(Logger.getBufferedContent().includes('"stage":"root-lease-heartbeat-temp-remove"'));
    assert.ok(Logger.getBufferedContent().includes('"fsCode":"EPERM"'));
    const tempEntries = (await fs.promises.readdir(journalRoot)).filter((name) => name.startsWith(`${path.basename(heartbeatPath)}.`));
    assert.strictEqual(tempEntries.length, 1, 'the actual write must leave one recoverable temp artifact');
    const tempPath = path.join(journalRoot, tempEntries[0]!);
    const writtenHeartbeat = JSON.parse(await fs.promises.readFile(tempPath, 'utf8')) as { leaseId?: unknown; heartbeatAt?: unknown };
    assert.strictEqual(writtenHeartbeat.leaseId, leaseId, 'temp content must be the completed heartbeat record');
    assert.strictEqual(typeof writtenHeartbeat.heartbeatAt, 'number');

    await new MutationPlanExecutor(tempDir).recover();
    assert.strictEqual(fs.existsSync(tempPath), false, 'recovery must remove a validated stale heartbeat temp');
    assert.strictEqual(fs.existsSync(journalRoot), false);
  });

  test('#349: malformed and hash-mismatched heartbeat temp files remain fail-closed', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    await fs.promises.mkdir(journalRoot, { recursive: true });
    const malformedLeaseId = 'partial-heartbeat-temp';
    const malformedPath = `${rootLeaseHeartbeatPath(journalRoot, malformedLeaseId)}.${randomUUID()}.tmp`;
    const malformedNamePath = `${rootLeaseHeartbeatPath(journalRoot, 'malformed-heartbeat-temp-name')}.not-a-uuid.tmp`;
    const mismatchLeaseId = 'heartbeat-temp-name-owner';
    const mismatchPath = `${rootLeaseHeartbeatPath(journalRoot, mismatchLeaseId)}.${randomUUID()}.tmp`;
    await fs.promises.writeFile(malformedPath, '{"leaseId":', 'utf8');
    await fs.promises.writeFile(malformedNamePath, JSON.stringify({ leaseId: 'malformed-heartbeat-temp-name', heartbeatAt: Date.now() }), 'utf8');
    await fs.promises.writeFile(mismatchPath, JSON.stringify({ leaseId: 'heartbeat-temp-record-owner', heartbeatAt: Date.now() }), 'utf8');

    for (const tempPath of [malformedPath, malformedNamePath, mismatchPath]) {
      await assert.rejects(
        new MutationPlanExecutor(tempDir).recover(),
        (error: unknown) => error instanceof MutationPlanError
          && error.code === 'RECOVERY_REQUIRED'
          && error.message.includes('heartbeat'),
      );
      assert.strictEqual(fs.existsSync(tempPath), true, 'unverifiable heartbeat temp records must remain');
      await fs.promises.rm(tempPath, { force: true });
    }
  });

  test('#349: heartbeat temp protected by a foreign active claim remains untouched', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    await fs.promises.mkdir(journalRoot, { recursive: true });
    const leaseId = 'foreign-claim-heartbeat-temp';
    const now = Date.now();
    const claimPath = path.join(journalRoot, `.root-lease.json.claim-v2-${now}-${process.pid}-${randomUUID()}`);
    const tempPath = `${rootLeaseHeartbeatPath(journalRoot, leaseId)}.${randomUUID()}.tmp`;
    await fs.promises.writeFile(claimPath, JSON.stringify({
      leaseId,
      pid: process.pid,
      createdAt: now,
      heartbeatAt: now,
      operationId: 'foreign-claim-temp-test',
    }), 'utf8');
    await fs.promises.writeFile(tempPath, JSON.stringify({ leaseId, heartbeatAt: now }), 'utf8');

    await assert.rejects(
      new MutationPlanExecutor(tempDir).recover(),
      (error: unknown) => error instanceof MutationPlanError && error.code === 'PLAN_CONFLICT',
    );
    assert.strictEqual(fs.existsSync(claimPath), true);
    assert.strictEqual(fs.existsSync(tempPath), true);
  });

  test('#349: heartbeat temp symlink remains fail-closed and preserves its target', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    await fs.promises.mkdir(journalRoot, { recursive: true });
    const leaseId = 'symlink-heartbeat-temp';
    const tempPath = `${rootLeaseHeartbeatPath(journalRoot, leaseId)}.${randomUUID()}.tmp`;
    const targetDir = path.join(tempDir, 'heartbeat-temp-symlink-target');
    await fs.promises.mkdir(targetDir);
    const targetFile = path.join(targetDir, 'payload.txt');
    await fs.promises.writeFile(targetFile, 'keep this target', 'utf8');
    await createDirectorySymlink(targetDir, tempPath);

    await assert.rejects(
      new MutationPlanExecutor(tempDir).recover(),
      (error: unknown) => error instanceof MutationPlanError
        && error.code === 'RECOVERY_REQUIRED'
        && error.message.includes('heartbeat'),
    );
    assert.strictEqual(fs.lstatSync(tempPath).isSymbolicLink(), true);
    assert.strictEqual(await fs.promises.readFile(targetFile, 'utf8'), 'keep this target');
  });

  test('#349: release removes its current lease heartbeat temp while ownership is still fenced', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    const originalWriteFile = fs.promises.writeFile;
    const originalRm = fs.promises.rm;
    let currentTempPath: string | undefined;
    let tempRemoveSawOwnedLease = false;
    (fs.promises as any).writeFile = async (
      targetPath: fs.PathLike,
      data: string | NodeJS.ArrayBufferView,
      options?: fs.WriteFileOptions,
    ) => {
      const result = await originalWriteFile.call(fs.promises, targetPath, data, options);
      if (!currentTempPath && path.basename(String(targetPath)) === '.root-lease.json') {
        const { leaseId } = JSON.parse(String(data)) as { leaseId: string };
        currentTempPath = `${rootLeaseHeartbeatPath(journalRoot, leaseId)}.${randomUUID()}.tmp`;
        await originalWriteFile.call(fs.promises, currentTempPath, JSON.stringify({ leaseId, heartbeatAt: Date.now() }), 'utf8');
      }
      return result;
    };
    (fs.promises as any).rm = async (targetPath: fs.PathLike, options?: fs.RmDirOptions) => {
      if (currentTempPath && path.basename(String(targetPath)) === path.basename(currentTempPath)) {
        tempRemoveSawOwnedLease = fs.existsSync(path.join(journalRoot, '.root-lease.json'));
      }
      return originalRm.call(fs.promises, targetPath, options);
    };

    try {
      await new MutationPlanExecutor(tempDir).recover();
    } finally {
      (fs.promises as any).writeFile = originalWriteFile;
      (fs.promises as any).rm = originalRm;
    }

    assert.ok(currentTempPath);
    assert.strictEqual(fs.existsSync(currentTempPath), false, 'recover reported success while its current lease temp remained');
    assert.strictEqual(tempRemoveSawOwnedLease, true, 'the current temp must be removed before the owned lease is released');
    assert.strictEqual(fs.existsSync(journalRoot), false);
  });

  test('#349: terminal current heartbeat temp cleanup failure makes recover report incomplete cleanup', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    const originalWriteFile = fs.promises.writeFile;
    const originalRm = fs.promises.rm;
    let currentTempPath: string | undefined;
    let tempCleanupAttempts = 0;
    (fs.promises as any).writeFile = async (
      targetPath: fs.PathLike,
      data: string | NodeJS.ArrayBufferView,
      options?: fs.WriteFileOptions,
    ) => {
      const result = await originalWriteFile.call(fs.promises, targetPath, data, options);
      if (!currentTempPath && path.basename(String(targetPath)) === '.root-lease.json') {
        const { leaseId } = JSON.parse(String(data)) as { leaseId: string };
        currentTempPath = `${rootLeaseHeartbeatPath(journalRoot, leaseId)}.${randomUUID()}.tmp`;
        await originalWriteFile.call(fs.promises, currentTempPath, JSON.stringify({ leaseId, heartbeatAt: Date.now() }), 'utf8');
      }
      return result;
    };
    (fs.promises as any).rm = async (targetPath: fs.PathLike, options?: fs.RmDirOptions) => {
      if (currentTempPath && path.basename(String(targetPath)) === path.basename(currentTempPath)) {
        tempCleanupAttempts++;
        const error = new Error('controlled EPERM during current heartbeat temp cleanup') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return originalRm.call(fs.promises, targetPath, options);
    };

    Logger.clearBuffer();
    try {
      await assert.rejects(
        new MutationPlanExecutor(tempDir).recover(),
        (error: unknown) => error instanceof MutationPlanError
          && error.code === 'RECOVERY_REQUIRED'
          && error.message.includes('root-lease-heartbeat-temp'),
      );
    } finally {
      (fs.promises as any).writeFile = originalWriteFile;
      (fs.promises as any).rm = originalRm;
    }

    assert.ok(currentTempPath);
    assert.strictEqual(tempCleanupAttempts, 1);
    assert.strictEqual(fs.existsSync(currentTempPath), true);
    const diagnostic = Logger.getBufferedContent();
    assert.ok(diagnostic.includes('"stage":"root-lease-heartbeat-temp-cleanup"'), diagnostic);
    assert.ok(diagnostic.includes('"fsCode":"EPERM"'), diagnostic);
    assert.ok(diagnostic.includes(`"targetName":"${path.basename(currentTempPath)}"`), diagnostic);

    await new MutationPlanExecutor(tempDir).recover();
    assert.strictEqual(fs.existsSync(currentTempPath), false, 'later recovery must remove the now-stale validated temp');
    assert.strictEqual(fs.existsSync(journalRoot), false);
  });

  test('#349: current heartbeat temp cleanup validates names, records, paths, and ownership', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    await fs.promises.mkdir(journalRoot, { recursive: true });
    const leaseId = 'current-heartbeat-temp-validation';
    const heartbeatPath = rootLeaseHeartbeatPath(journalRoot, leaseId);
    const expectedHash = path.basename(heartbeatPath).split('.')[3]!;
    const tempPath = (uuid: string) => `${heartbeatPath}.${uuid}.tmp`;
    const validRecord = JSON.stringify({ leaseId, heartbeatAt: Date.now() });

    const malformedName = `${heartbeatPath}.not-a-uuid.tmp`;
    await fs.promises.writeFile(malformedName, validRecord, 'utf8');
    const malformedNameIssue = await cleanupCurrentRootLeaseHeartbeatTemps(tempDir, journalRoot, leaseId, async () => undefined);
    assert.strictEqual(malformedNameIssue.length, 1);
    assert.strictEqual(fs.existsSync(malformedName), true);
    await fs.promises.rm(malformedName, { force: true });

    const uppercaseHashPath = path.join(
      journalRoot,
      path.basename(heartbeatPath).replace(expectedHash, expectedHash.toUpperCase()) + `.${randomUUID()}.tmp`,
    );
    await fs.promises.writeFile(uppercaseHashPath, validRecord, 'utf8');
    const uppercaseHashIssue = await cleanupCurrentRootLeaseHeartbeatTemps(tempDir, journalRoot, leaseId, async () => undefined);
    assert.strictEqual(uppercaseHashIssue.length, 1, 'a case-insensitive prefix match must still pass the strict filename check');
    assert.strictEqual(fs.existsSync(uppercaseHashPath), true);
    await fs.promises.rm(uppercaseHashPath, { force: true });

    const missingRecordIdPath = tempPath(randomUUID());
    await fs.promises.writeFile(missingRecordIdPath, JSON.stringify({ heartbeatAt: Date.now() }), 'utf8');
    const missingRecordIdIssue = await cleanupCurrentRootLeaseHeartbeatTemps(tempDir, journalRoot, leaseId, async () => undefined);
    assert.strictEqual(missingRecordIdIssue.length, 1);
    assert.strictEqual(fs.existsSync(missingRecordIdPath), true);
    await fs.promises.rm(missingRecordIdPath, { force: true });

    const mismatchedRecordPath = tempPath(randomUUID());
    await fs.promises.writeFile(mismatchedRecordPath, JSON.stringify({ leaseId: 'foreign-current-temp', heartbeatAt: Date.now() }), 'utf8');
    const mismatchedRecordIssue = await cleanupCurrentRootLeaseHeartbeatTemps(tempDir, journalRoot, leaseId, async () => undefined);
    assert.strictEqual(mismatchedRecordIssue.length, 1);
    assert.strictEqual(fs.existsSync(mismatchedRecordPath), true);
    await fs.promises.rm(mismatchedRecordPath, { force: true });

    const symlinkPath = tempPath(randomUUID());
    const symlinkTarget = path.join(tempDir, 'current-temp-symlink-target');
    await fs.promises.mkdir(symlinkTarget);
    await createDirectorySymlink(symlinkTarget, symlinkPath);
    const symlinkIssue = await cleanupCurrentRootLeaseHeartbeatTemps(tempDir, journalRoot, leaseId, async () => undefined);
    assert.strictEqual(symlinkIssue.length, 1);
    assert.strictEqual(fs.lstatSync(symlinkPath).isSymbolicLink(), true);
    await fs.promises.rm(symlinkPath, { recursive: true, force: true });

    const validTempPath = tempPath(randomUUID());
    await fs.promises.writeFile(validTempPath, validRecord, 'utf8');
    const ownershipIssue = await cleanupCurrentRootLeaseHeartbeatTemps(
      tempDir,
      journalRoot,
      leaseId,
      async () => { throw new RootLeaseOwnershipError('Controlled ownership verification failure.', 'unverified'); },
    );
    assert.strictEqual(ownershipIssue.length, 1);
    assert.ok(ownershipIssue[0]!.error instanceof RootLeaseOwnershipError);
    assert.strictEqual(fs.existsSync(validTempPath), true, 'an unverifiable lease must preserve its temp artifact');
    await fs.promises.rm(validTempPath, { force: true });

    const canonicalPathTemp = tempPath(randomUUID());
    await fs.promises.writeFile(canonicalPathTemp, validRecord, 'utf8');
    const originalRealpath = fs.promises.realpath;
    (fs.promises as any).realpath = async (targetPath: fs.PathLike, ...options: unknown[]) => {
      if (path.resolve(String(targetPath)) === path.resolve(canonicalPathTemp)) {
        return path.join(tempDir, 'outside-current-temp');
      }
      return (originalRealpath as any).call(fs.promises, targetPath, ...options);
    };
    try {
      const canonicalIssue = await cleanupCurrentRootLeaseHeartbeatTemps(tempDir, journalRoot, leaseId, async () => undefined);
      assert.strictEqual(canonicalIssue.length, 1);
      assert.strictEqual(fs.existsSync(canonicalPathTemp), true);
    } finally {
      (fs.promises as any).realpath = originalRealpath;
      await fs.promises.rm(canonicalPathTemp, { force: true });
    }
  });

  test('#349: acquisition cleanup logs a failed lease removal without replacing the claim conflict', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    const leasePath = path.join(journalRoot, '.root-lease.json');
    const originalWriteFile = fs.promises.writeFile;
    const originalRename = fs.promises.rename;
    let claimPath: string | undefined;
    let renameFailed = false;
    (fs.promises as any).writeFile = async (targetPath: fs.PathLike, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      const result = await originalWriteFile.call(fs.promises, targetPath, data, options);
      if (!claimPath && path.resolve(String(targetPath)) === path.resolve(leasePath)) {
        const now = Date.now();
        claimPath = path.join(journalRoot, `.root-lease.json.claim-v2-${now}-${process.pid}-${randomUUID()}`);
        await originalWriteFile.call(fs.promises, claimPath, JSON.stringify({
          leaseId: 'active-acquisition-claim',
          pid: process.pid,
          createdAt: now,
          heartbeatAt: now,
          operationId: 'do-not-log-claim-content',
        }), 'utf8');
      }
      return result;
    };
    (fs.promises as any).rename = async (sourcePath: fs.PathLike, targetPath: fs.PathLike) => {
      if (!renameFailed && path.resolve(String(sourcePath)) === path.resolve(leasePath)) {
        renameFailed = true;
        const error = new Error('controlled EBUSY while aborting lease acquisition') as NodeJS.ErrnoException;
        error.code = 'EBUSY';
        throw error;
      }
      return originalRename.call(fs.promises, sourcePath, targetPath);
    };

    Logger.clearBuffer();
    try {
      await assert.rejects(
        new MutationPlanExecutor(tempDir).recover(),
        (error: unknown) => error instanceof MutationPlanError
          && error.code === 'PLAN_CONFLICT'
          && error.message.includes('being fenced by an active process'),
      );
    } finally {
      (fs.promises as any).writeFile = originalWriteFile;
      (fs.promises as any).rename = originalRename;
    }

    assert.ok(claimPath);
    assert.strictEqual(renameFailed, true);
    assert.strictEqual(fs.existsSync(leasePath), true);
    const diagnostic = Logger.getBufferedContent();
    assert.ok(diagnostic.includes('"stage":"root-lease-acquisition-cleanup"'), diagnostic);
    assert.ok(diagnostic.includes('"fsCode":"EBUSY"'), diagnostic);
    assert.ok(diagnostic.includes('"state":"acquisition-aborted"'), diagnostic);
    assert.ok(diagnostic.includes('"type":"file"'), diagnostic);
    assert.ok(!diagnostic.includes('do-not-log-claim-content'), 'diagnostics must not expose claim contents');
  });

  test('#349: acquisition cleanup reports an already-removed lease while preserving the claim conflict', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    const leasePath = path.join(journalRoot, '.root-lease.json');
    const originalWriteFile = fs.promises.writeFile;
    const originalReaddir = fs.promises.readdir;
    const originalRm = fs.promises.rm;
    let claimPath: string | undefined;
    let leaseRemoved = false;
    (fs.promises as any).writeFile = async (targetPath: fs.PathLike, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      const result = await originalWriteFile.call(fs.promises, targetPath, data, options);
      if (!claimPath && path.resolve(String(targetPath)) === path.resolve(leasePath)) {
        const now = Date.now();
        claimPath = path.join(journalRoot, `.root-lease.json.claim-v2-${now}-${process.pid}-${randomUUID()}`);
        await originalWriteFile.call(fs.promises, claimPath, JSON.stringify({
          leaseId: 'active-acquisition-claim-removed-lease',
          pid: process.pid,
          createdAt: now,
          heartbeatAt: now,
          operationId: 'do-not-log-claim-content',
        }), 'utf8');
      }
      return result;
    };
    (fs.promises as any).readdir = async (directoryPath: fs.PathLike, options?: any) => {
      if (!leaseRemoved && claimPath && path.resolve(String(directoryPath)) === path.resolve(journalRoot)) {
        leaseRemoved = true;
        await originalRm.call(fs.promises, leasePath, { force: true });
      }
      return originalReaddir.call(fs.promises, directoryPath, options);
    };

    Logger.clearBuffer();
    try {
      await assert.rejects(
        new MutationPlanExecutor(tempDir).recover(),
        (error: unknown) => error instanceof MutationPlanError
          && error.code === 'PLAN_CONFLICT'
          && error.message.includes('being fenced by an active process'),
      );
    } finally {
      (fs.promises as any).writeFile = originalWriteFile;
      (fs.promises as any).readdir = originalReaddir;
    }

    assert.ok(claimPath);
    assert.strictEqual(leaseRemoved, true);
    assert.strictEqual(fs.existsSync(leasePath), false);
    const diagnostic = Logger.getBufferedContent();
    assert.ok(diagnostic.includes('"stage":"root-lease-acquisition-cleanup"'), diagnostic);
    assert.ok(diagnostic.includes('"state":"acquisition-aborted"'), diagnostic);
    assert.ok(diagnostic.includes(path.basename(claimPath)), diagnostic);
    assert.ok(!diagnostic.includes('do-not-log-claim-content'), 'diagnostics must contain names and types only');
  });

  test('#349: stale takeover logs heartbeat removal failure but recovery still cleans the sidecar', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    const leasePath = path.join(journalRoot, '.root-lease.json');
    const leaseId = 'stale-heartbeat-removal-failure';
    const staleAt = Date.now() - 60_000;
    const heartbeatPath = rootLeaseHeartbeatPath(journalRoot, leaseId);
    await fs.promises.mkdir(journalRoot, { recursive: true });
    await fs.promises.writeFile(leasePath, JSON.stringify({
      leaseId,
      pid: 2147483647,
      createdAt: staleAt,
      heartbeatAt: staleAt,
      operationId: 'stale-heartbeat-removal-failure',
    }), 'utf8');
    await fs.promises.writeFile(heartbeatPath, JSON.stringify({ leaseId, heartbeatAt: staleAt }), 'utf8');

    const originalRm = fs.promises.rm;
    let removeFailed = false;
    (fs.promises as any).rm = async (targetPath: fs.PathLike, options?: fs.RmDirOptions) => {
      if (!removeFailed && path.resolve(String(targetPath)) === path.resolve(heartbeatPath)) {
        removeFailed = true;
        const error = new Error('controlled EBUSY during stale heartbeat cleanup') as NodeJS.ErrnoException;
        error.code = 'EBUSY';
        throw error;
      }
      return originalRm.call(fs.promises, targetPath, options);
    };

    Logger.clearBuffer();
    try {
      await new MutationPlanExecutor(tempDir).recover();
    } finally {
      (fs.promises as any).rm = originalRm;
    }

    assert.strictEqual(removeFailed, true);
    assert.strictEqual(fs.existsSync(heartbeatPath), false, 'the later owned recovery pass must clean the stale sidecar');
    const diagnostic = Logger.getBufferedContent();
    assert.ok(diagnostic.includes('"stage":"stale-root-lease-heartbeat-remove"'), diagnostic);
    assert.ok(diagnostic.includes('"fsCode":"EBUSY"'), diagnostic);
    assert.ok(diagnostic.includes('"state":"stale-takeover"'), diagnostic);
    assert.strictEqual(fs.existsSync(journalRoot), false);
  });

  test('#349: cleanup diagnostics retain the cleanup outcome when journal inspection fails', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    await fs.promises.mkdir(journalRoot, { recursive: true });
    const originalReaddir = fs.promises.readdir;
    const cleanupError = new Error('controlled EBUSY during operation cleanup') as NodeJS.ErrnoException;
    cleanupError.code = 'EBUSY';
    let inspectionFailed = false;
    (fs.promises as any).readdir = async (directoryPath: fs.PathLike, options?: any) => {
      if (!inspectionFailed
        && path.basename(String(directoryPath)) === path.basename(journalRoot)
        && options
        && typeof options === 'object'
        && options.withFileTypes) {
        inspectionFailed = true;
        const error = new Error('controlled EACCES while inspecting journal entries') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      return originalReaddir.call(fs.promises, directoryPath, options);
    };

    Logger.clearBuffer();
    try {
      const failure = await logCleanupFailure(
        tempDir,
        journalRoot,
        'orphan-operation-directory',
        cleanupError,
        path.join(journalRoot, 'orphan-operation'),
        { leaseId: 'diagnostics-lifecycle', state: 'recovering' },
      );
      assert.strictEqual(failure.stage, 'orphan-operation-directory');
      assert.strictEqual(failure.fsCode, 'EBUSY');
      assert.strictEqual(failure.remainingRootEntryCount, undefined);
    } finally {
      (fs.promises as any).readdir = originalReaddir;
    }

    assert.strictEqual(inspectionFailed, true);
    const diagnostic = Logger.getBufferedContent();
    assert.ok(diagnostic.includes('"stage":"orphan-operation-directory"'), diagnostic);
    assert.ok(diagnostic.includes('"fsCode":"EBUSY"'), diagnostic);
    assert.ok(diagnostic.includes('"journalRootInspectionError":{"fsCode":"EACCES"'), diagnostic);
  });

  test('#349: logger failure does not replace a structured cleanup outcome', async () => {
    const originalWarn = Logger.warn;
    const cleanupError = new Error('controlled cleanup failure') as NodeJS.ErrnoException;
    cleanupError.code = 'EPERM';
    (Logger as any).warn = () => { throw new Error('controlled logger failure'); };

    try {
      const failure = await logCleanupFailure(
        tempDir,
        path.join(tempDir, '.cdt-journal'),
        'root-lease-release',
        cleanupError,
        path.join(tempDir, '.cdt-journal', '.root-lease.json'),
      );
      assert.deepStrictEqual(failure, {
        stage: 'root-lease-release',
        fsCode: 'EPERM',
        remainingRootEntryCount: 0,
      });
    } finally {
      (Logger as any).warn = originalWarn;
    }
  });

  test('#349: root lease process liveness rejects invalid process identifiers', () => {
    assert.strictEqual(isProcessAlive(0), false);
    assert.strictEqual(isProcessAlive(-1), false);
    assert.strictEqual(isProcessAlive(Number.NaN), false);
  });

  test('#349: recover preserves unknown malformed heartbeat sidecar names', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    await fs.promises.mkdir(journalRoot, { recursive: true });
    const malformedPath = path.join(journalRoot, '.root-lease.json.foreign-heartbeat');
    await fs.promises.writeFile(malformedPath, '{}', 'utf8');

    await assert.rejects(
      new MutationPlanExecutor(tempDir).recover(),
      (error: unknown) => error instanceof MutationPlanError
        && error.code === 'RECOVERY_REQUIRED'
        && error.message.includes('heartbeat'),
    );
    assert.strictEqual(fs.existsSync(malformedPath), true);
  });

  test('#349: recover rejects a heartbeat whose canonical path changes during inspection', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    await fs.promises.mkdir(journalRoot, { recursive: true });
    const leaseId = 'heartbeat-canonical-path-race';
    const heartbeatPath = rootLeaseHeartbeatPath(journalRoot, leaseId);
    await fs.promises.writeFile(heartbeatPath, JSON.stringify({ leaseId, heartbeatAt: Date.now() - 60_000 }), 'utf8');

    const originalRealpath = fs.promises.realpath;
    (fs.promises as any).realpath = async (targetPath: unknown, ...options: unknown[]) => {
      if (path.resolve(String(targetPath)) === path.resolve(heartbeatPath)) {
        return path.join(tempDir, 'outside-heartbeat-target');
      }
      return (originalRealpath as any).call(fs.promises, targetPath, ...options);
    };

    try {
      await assert.rejects(
        new MutationPlanExecutor(tempDir).recover(),
        (error: unknown) => error instanceof MutationPlanError
          && error.code === 'RECOVERY_REQUIRED'
          && error.message.includes('canonical'),
      );
    } finally {
      (fs.promises as any).realpath = originalRealpath;
    }

    assert.strictEqual(fs.existsSync(heartbeatPath), true, 'a sidecar that fails canonical inspection must remain');
  });

  test('#349: recover() reports its own heartbeat cleanup failure and a later recovery removes the stale sidecar', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    const originalRm = fs.promises.rm;
    const originalWriteFile = fs.promises.writeFile;
    let heartbeatPath: string | undefined;
    (fs.promises as any).writeFile = async (targetPath: fs.PathLike, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      const result = await originalWriteFile.call(fs.promises, targetPath, data, options);
      if (path.basename(String(targetPath)) === '.root-lease.json') {
        const lease = JSON.parse(String(data)) as { leaseId: string };
        const leaseHash = createHash('sha256').update(lease.leaseId, 'utf8').digest('hex');
        heartbeatPath = path.join(journalRoot, `.root-lease.json.${leaseHash}.heartbeat`);
        await originalWriteFile.call(fs.promises, heartbeatPath, JSON.stringify({
          leaseId: lease.leaseId,
          heartbeatAt: Date.now() - 60_000,
        }), 'utf8');
      }
      return result;
    };
    (fs.promises as any).rm = async (targetPath: fs.PathLike, options?: fs.RmDirOptions) => {
      const candidate = String(targetPath);
      if (heartbeatPath && path.resolve(candidate) === path.resolve(heartbeatPath)) {
        const error = new Error('controlled EPERM during heartbeat cleanup') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return originalRm.call(fs.promises, targetPath, options);
    };

    Logger.clearBuffer();
    try {
      await assert.rejects(
        new MutationPlanExecutor(tempDir).recover(),
        (error: unknown) => error instanceof MutationPlanError
          && error.code === 'RECOVERY_REQUIRED'
          && error.message.includes('root-lease-heartbeat'),
      );
    } finally {
      (fs.promises as any).rm = originalRm;
      (fs.promises as any).writeFile = originalWriteFile;
    }

    assert.ok(heartbeatPath, 'release must attempt to remove its heartbeat sidecar');
    assert.strictEqual(fs.existsSync(heartbeatPath), true, 'the injected failure must retain the heartbeat');
    const diagnostic = Logger.getBufferedContent();
    assert.ok(diagnostic.includes('"stage":"root-lease-heartbeat-remove"'), diagnostic);
    assert.ok(diagnostic.includes('"fsCode":"EPERM"'), diagnostic);
    assert.ok(diagnostic.includes('"name":".root-lease.json.'), diagnostic);
    assert.ok(diagnostic.includes('"type":"file"'), diagnostic);
    assert.ok(fs.existsSync(journalRoot), 'journal root must remain while the heartbeat is retained');

    await new MutationPlanExecutor(tempDir).recover();
    assert.strictEqual(fs.existsSync(heartbeatPath), false, 'a later recovery must remove the validated stale sidecar');
    assert.strictEqual(fs.existsSync(journalRoot), false);
  });

  test('#349: recover reports when release cannot verify its own lease after an access error', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    const leasePath = path.join(journalRoot, '.root-lease.json');
    const originalReadFile = fs.promises.readFile;
    let leaseReads = 0;
    (fs.promises as any).readFile = async (targetPath: fs.PathLike, options?: any) => {
      if (path.resolve(String(targetPath)) === path.resolve(leasePath) && ++leaseReads === 4) {
        const error = new Error('controlled EACCES while verifying own lease during release') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      return originalReadFile.call(fs.promises, targetPath, options);
    };

    Logger.clearBuffer();
    try {
      await assert.rejects(
        new MutationPlanExecutor(tempDir).recover(),
        (error: unknown) => error instanceof MutationPlanError
          && error.code === 'RECOVERY_REQUIRED'
          && error.message.includes('root-lease-release'),
      );
    } finally {
      (fs.promises as any).readFile = originalReadFile;
    }

    assert.strictEqual(leaseReads, 4, 'the injected access error must occur during release verification');
    assert.strictEqual(fs.existsSync(leasePath), true, 'an unverified lease must be preserved');
    const diagnostic = Logger.getBufferedContent();
    assert.ok(diagnostic.includes('"stage":"root-lease-release"'), diagnostic);
    assert.ok(diagnostic.includes('"fsCode":"EACCES"'), diagnostic);
  });

  test('#349: recover reports a terminal journal root removal failure and cleans it on retry', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    const originalRmdir = fs.promises.rmdir;
    let injected = false;
    (fs.promises as any).rmdir = async (targetPath: fs.PathLike) => {
      if (!injected && path.resolve(String(targetPath)) === path.resolve(journalRoot)) {
        injected = true;
        const error = new Error('controlled EACCES during journal root removal') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      return originalRmdir.call(fs.promises, targetPath);
    };

    Logger.clearBuffer();
    try {
      await assert.rejects(
        new MutationPlanExecutor(tempDir).recover(),
        (error: unknown) => error instanceof MutationPlanError
          && error.code === 'RECOVERY_REQUIRED'
          && error.message.includes('journal-root-removal'),
      );
    } finally {
      (fs.promises as any).rmdir = originalRmdir;
    }

    assert.strictEqual(injected, true);
    assert.strictEqual(fs.existsSync(journalRoot), true, 'failed root removal must retain the journal directory');
    const diagnostic = Logger.getBufferedContent();
    assert.ok(diagnostic.includes('"stage":"journal-root-removal"'), diagnostic);
    assert.ok(diagnostic.includes('"fsCode":"EACCES"'), diagnostic);
    assert.ok(diagnostic.includes('"remainingEntries":{"journalRoot":[]}'), diagnostic);

    await new MutationPlanExecutor(tempDir).recover();
    assert.strictEqual(fs.existsSync(journalRoot), false);
  });

  test('#349: committed execute keeps its result when release cannot remove its heartbeat', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    const target = path.join(tempDir, 'committed-target.xml');
    await fs.promises.writeFile(target, 'before', 'utf8');

    const originalRm = fs.promises.rm;
    const originalWriteFile = fs.promises.writeFile;
    let heartbeatPath: string | undefined;
    (fs.promises as any).writeFile = async (targetPath: fs.PathLike, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      const result = await originalWriteFile.call(fs.promises, targetPath, data, options);
      if (path.basename(String(targetPath)) === '.root-lease.json') {
        const lease = JSON.parse(String(data)) as { leaseId: string };
        const leaseHash = createHash('sha256').update(lease.leaseId, 'utf8').digest('hex');
        heartbeatPath = path.join(journalRoot, `.root-lease.json.${leaseHash}.heartbeat`);
        await originalWriteFile.call(fs.promises, heartbeatPath, JSON.stringify({
          leaseId: lease.leaseId,
          heartbeatAt: Date.now() - 60_000,
        }), 'utf8');
      }
      return result;
    };
    (fs.promises as any).rm = async (targetPath: fs.PathLike, options?: fs.RmDirOptions) => {
      if (heartbeatPath && path.resolve(String(targetPath)) === path.resolve(heartbeatPath)) {
        const error = new Error('controlled EPERM during heartbeat cleanup') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return originalRm.call(fs.promises, targetPath, options);
    };

    try {
      const result = await new MutationPlanExecutor(tempDir).execute({
        kind: 'test.issue349CommittedReleaseCleanup',
        steps: [{
          type: 'writeFile',
          targetPath: target,
          content: 'committed',
          encoding: 'utf8',
          expected: { state: 'file', hash: hashContent('before') },
        }],
        result: 'committed-result',
      });
      assert.strictEqual(result, 'committed-result');
      assert.strictEqual(await fs.promises.readFile(target, 'utf8'), 'committed');
      assert.ok(heartbeatPath && fs.existsSync(heartbeatPath), 'best-effort release failure must retain its sidecar');
    } finally {
      (fs.promises as any).rm = originalRm;
      (fs.promises as any).writeFile = originalWriteFile;
    }

    await new MutationPlanExecutor(tempDir).recover();
    assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), false);
  });

  test('#349: a transient heartbeat write failure does not fail recovery after a later write and cleanup succeed', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    const orphanOp = path.join(journalRoot, randomUUID());
    await fs.promises.mkdir(path.join(orphanOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(orphanOp, '.journal-abandoned.tmp'), '{}', 'utf8');

    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    const originalWriteFile = fs.promises.writeFile;
    const originalRm = fs.promises.rm;
    let interval: { active: boolean } | undefined;
    let heartbeatTempWrites = 0;
    let resolveHeartbeatWrite!: () => void;
    const secondHeartbeatWrite = new Promise<void>((resolve) => { resolveHeartbeatWrite = resolve; });
    (global as any).setInterval = (callback: () => void) => {
      interval = { active: true };
      const tick = () => {
        if (!interval?.active) { return; }
        callback();
        setTimeout(tick, 1);
      };
      setTimeout(tick, 0);
      return { unref: () => undefined };
    };
    (global as any).clearInterval = () => {
      if (interval) { interval.active = false; }
    };
    (fs.promises as any).writeFile = async (
      targetPath: fs.PathLike,
      data: string | NodeJS.ArrayBufferView,
      options?: fs.WriteFileOptions,
    ) => {
      const name = path.basename(String(targetPath));
      if (name.startsWith('.root-lease.json.') && name.endsWith('.tmp')) {
        heartbeatTempWrites++;
        if (heartbeatTempWrites === 1) {
          const error = new Error('controlled transient EBUSY during heartbeat write') as NodeJS.ErrnoException;
          error.code = 'EBUSY';
          throw error;
        }
        const result = await originalWriteFile.call(fs.promises, targetPath, data, options);
        resolveHeartbeatWrite();
        return result;
      }
      return originalWriteFile.call(fs.promises, targetPath, data, options);
    };
    (fs.promises as any).rm = async (targetPath: fs.PathLike, options?: fs.RmDirOptions) => {
      if (path.resolve(String(targetPath)) === path.resolve(orphanOp)) {
        await secondHeartbeatWrite;
      }
      return originalRm.call(fs.promises, targetPath, options);
    };

    Logger.clearBuffer();
    try {
      await new MutationPlanExecutor(tempDir).recover();
    } finally {
      if (interval) { interval.active = false; }
      (global as any).setInterval = originalSetInterval;
      (global as any).clearInterval = originalClearInterval;
      (fs.promises as any).writeFile = originalWriteFile;
      (fs.promises as any).rm = originalRm;
    }

    assert.ok(heartbeatTempWrites >= 2, 'a successful heartbeat write must follow the injected transient failure');
    assert.ok(Logger.getBufferedContent().includes('"stage":"root-lease-heartbeat-write"'));
    assert.ok(Logger.getBufferedContent().includes('"fsCode":"EBUSY"'));
    assert.strictEqual(fs.existsSync(orphanOp), false);
    assert.strictEqual(fs.existsSync(journalRoot), false);
  });

  test('#349: recover preserves malformed and symlink heartbeat sidecars', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    await fs.promises.mkdir(journalRoot, { recursive: true });
    const leaseId = 'foreign-heartbeat-record';
    const leaseHash = createHash('sha256').update(leaseId, 'utf8').digest('hex');
    const malformedPath = path.join(journalRoot, `.root-lease.json.${leaseHash}.heartbeat`);
    await fs.promises.writeFile(malformedPath, JSON.stringify({
      leaseId: 'mismatched-heartbeat-record',
      heartbeatAt: Date.now(),
    }), 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      executor.recover(),
      (error: unknown) => error instanceof MutationPlanError
        && error.code === 'RECOVERY_REQUIRED'
        && error.message.includes('heartbeat'),
    );
    assert.strictEqual(fs.existsSync(malformedPath), true, 'a mismatched filename/record pair must be retained');

    await fs.promises.rm(malformedPath, { force: true });
    const symlinkLeaseId = 'symlink-heartbeat-record';
    const symlinkHash = createHash('sha256').update(symlinkLeaseId, 'utf8').digest('hex');
    const symlinkPath = path.join(journalRoot, `.root-lease.json.${symlinkHash}.heartbeat`);
    const linkTarget = path.join(tempDir, 'heartbeat-link-target');
    await fs.promises.mkdir(linkTarget);
    const linkTargetFile = path.join(linkTarget, 'payload.txt');
    await fs.promises.writeFile(linkTargetFile, 'must remain untouched', 'utf8');
    await createDirectorySymlink(linkTarget, symlinkPath);

    await assert.rejects(
      executor.recover(),
      (error: unknown) => error instanceof MutationPlanError
        && error.code === 'RECOVERY_REQUIRED'
        && error.message.includes('heartbeat'),
    );
    assert.strictEqual(await fs.promises.realpath(symlinkPath), await fs.promises.realpath(linkTarget));
    assert.strictEqual(await fs.promises.readFile(linkTargetFile, 'utf8'), 'must remain untouched');
  });

  test('#349: recover leaves a heartbeat protected by an active lease claim', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    await fs.promises.mkdir(journalRoot, { recursive: true });
    const leaseId = 'active-claim-heartbeat';
    const now = Date.now();
    const claimName = `.root-lease.json.claim-v2-${now}-${process.pid}-${randomUUID()}`;
    const heartbeatHash = createHash('sha256').update(leaseId, 'utf8').digest('hex');
    const heartbeatPath = path.join(journalRoot, `.root-lease.json.${heartbeatHash}.heartbeat`);
    await fs.promises.writeFile(path.join(journalRoot, claimName), JSON.stringify({
      leaseId,
      pid: process.pid,
      createdAt: now,
      heartbeatAt: now,
      operationId: 'active-claim-test',
    }), 'utf8');
    await fs.promises.writeFile(heartbeatPath, JSON.stringify({ leaseId, heartbeatAt: now }), 'utf8');

    await assert.rejects(
      new MutationPlanExecutor(tempDir).recover(),
      (error: unknown) => error instanceof MutationPlanError && error.code === 'PLAN_CONFLICT',
    );
    assert.strictEqual(fs.existsSync(path.join(journalRoot, claimName)), true);
    assert.strictEqual(fs.existsSync(heartbeatPath), true);
  });

  test('#349: recover() waits for a delayed orphan removal before reporting success', async () => {
    const orphanOp = path.join(tempDir, '.cdt-journal', 'delayed-orphan');
    await fs.promises.mkdir(path.join(orphanOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(orphanOp, '.journal-abandoned.tmp'), '{}', 'utf8');

    const originalRm = fs.promises.rm;
    let markRmStarted!: () => void;
    let finishRm!: () => void;
    const rmStarted = new Promise<void>((resolve) => { markRmStarted = resolve; });
    const rmGate = new Promise<void>((resolve) => { finishRm = resolve; });
    let recoverySettled = false;
    (fs.promises as any).rm = async (targetPath: fs.PathLike, options?: fs.RmDirOptions) => {
      if (path.resolve(String(targetPath)) === path.resolve(orphanOp)) {
        markRmStarted();
        await rmGate;
      }
      return originalRm.call(fs.promises, targetPath, options);
    };

    try {
      const recovery = new MutationPlanExecutor(tempDir).recover().finally(() => { recoverySettled = true; });
      await rmStarted;
      assert.strictEqual(recoverySettled, false, 'recover must await orphan cleanup');
      finishRm();
      await recovery;
    } finally {
      finishRm();
      (fs.promises as any).rm = originalRm;
    }

    assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), false);
  });

  test('Issue #167: recover() still throws RECOVERY_REQUIRED if journal.json is corrupt', async () => {
    const corruptOp = path.join(tempDir, '.cdt-journal', 'corrupt-op');
    await fs.promises.mkdir(corruptOp, { recursive: true });
    await fs.promises.writeFile(path.join(corruptOp, 'journal.json'), '{corrupt-json', 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      executor.recover(),
      (err: MutationPlanError) => {
        assert.strictEqual(err.code, 'RECOVERY_REQUIRED');
        assert.ok(err.message.includes('corrupt-op'));
        return true;
      },
    );
  });

  test('Issue #167: recover() fails-closed with PLAN_CONFLICT and preserves backups when pre-effect operation has active owner PID', async () => {
    const activeOp = path.join(tempDir, '.cdt-journal', 'active-snapshotting-op');
    await fs.promises.mkdir(path.join(activeOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(activeOp, 'backups', '0'), 'precious-backup-data', 'utf8');
    await fs.promises.writeFile(
      path.join(activeOp, 'owner.json'),
      JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
      'utf8',
    );

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      executor.recover(),
      (err: MutationPlanError) => {
        assert.strictEqual(err.code, 'PLAN_CONFLICT');
        assert.ok(err.message.includes('active-snapshotting-op'));
        assert.ok(err.message.includes(String(process.pid)));
        return true;
      },
    );

    // Fail-closed guarantee: operation directory and backups must NOT be deleted while process is alive
    assert.strictEqual(fs.existsSync(activeOp), true, 'active operation directory must be preserved');
    assert.strictEqual(
      await fs.promises.readFile(path.join(activeOp, 'backups', '0'), 'utf8'),
      'precious-backup-data',
      'backups must not be deleted while owner process is alive',
    );
  });

  test('Issue #167: recover() fails-closed with PLAN_CONFLICT when in-progress journal has active owner PID', async () => {
    const targetFile = path.join(tempDir, 'active-target.xml');
    await fs.promises.writeFile(targetFile, 'current-in-flight-content', 'utf8');

    const activeOp = path.join(tempDir, '.cdt-journal', 'active-applying-op');
    await fs.promises.mkdir(path.join(activeOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(activeOp, 'backups', '0'), 'initial-content', 'utf8');
    await fs.promises.writeFile(
      path.join(activeOp, 'owner.json'),
      JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
      'utf8',
    );
    await fs.promises.writeFile(
      path.join(activeOp, 'journal.json'),
      JSON.stringify({
        version: 1,
        operationId: 'active-applying-op',
        plan: { kind: 'test.activePlan', steps: [], result: null },
        state: 'applying',
        appliedSteps: 1,
        snapshots: [{
          targetPath: targetFile,
          state: 'file',
          hash: hashContent('initial-content'),
          backupName: '0',
          contentsBackedUp: true,
        }],
      }),
      'utf8',
    );

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      executor.recover(),
      (err: MutationPlanError) => {
        assert.strictEqual(err.code, 'PLAN_CONFLICT');
        assert.ok(err.message.includes('active-applying-op'));
        assert.ok(err.message.includes(String(process.pid)));
        return true;
      },
    );

    // Operation directory and in-flight file must NOT be rolled back or deleted while process is alive
    assert.strictEqual(fs.existsSync(activeOp), true);
    assert.strictEqual(await fs.promises.readFile(targetFile, 'utf8'), 'current-in-flight-content');
  });

  test('Issue #167: recover() safely cleans up orphan directory without journal.json when owner process is terminated', async () => {
    const deadOp = path.join(tempDir, '.cdt-journal', 'terminated-orphan-op');
    await fs.promises.mkdir(path.join(deadOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(deadOp, 'backups', '0'), 'abandoned-backup', 'utf8');
    await fs.promises.writeFile(
      path.join(deadOp, 'owner.json'),
      JSON.stringify({ pid: 999999, createdAt: Date.now() - 60000 }),
      'utf8',
    );

    const executor = new MutationPlanExecutor(tempDir);
    await executor.recover();

    assert.strictEqual(fs.existsSync(deadOp), false);
    assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), false);
  });

  test('Issue #167: execute() writes owner.json with process PID before capturing snapshots and applying plan', async () => {
    const fileA = path.join(tempDir, 'fileA.xml');
    await fs.promises.writeFile(fileA, 'initial-A', 'utf8');
    const executor = new MutationPlanExecutor(tempDir);

    let observedOwnerPid: number | undefined;
    const origCopyFile = fs.promises.copyFile;
    (fs.promises as any).copyFile = async (src: any, dest: any) => {
      // While copying snapshots during preparation, verify owner.json is already present on disk
      const journalDir = path.dirname(path.dirname(dest));
      const ownerPath = path.join(journalDir, 'owner.json');
      if (fs.existsSync(ownerPath)) {
        const raw = await fs.promises.readFile(ownerPath, 'utf8');
        observedOwnerPid = JSON.parse(raw).pid;
      }
      return origCopyFile.call(fs.promises, src, dest);
    };

    try {
      await executor.execute({
        kind: 'test.ownerCheck',
        steps: [{
          type: 'writeFile', targetPath: fileA, content: 'mutated-A', encoding: 'utf8',
          expected: { state: 'file', hash: hashContent('initial-A') },
        }],
        result: 'success',
      });
    } finally {
      (fs.promises as any).copyFile = origCopyFile;
    }

    assert.strictEqual(observedOwnerPid, process.pid, 'owner.json must be written with process.pid prior to copying snapshots');
    assert.strictEqual(await fs.promises.readFile(fileA, 'utf8'), 'mutated-A');
    assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), false, 'journal cleaned up after success');
  });

  test('Issue #167: recover() fails-closed with RECOVERY_REQUIRED if owner.json is corrupt', async () => {
    const corruptOwnerOp = path.join(tempDir, '.cdt-journal', 'corrupt-owner-op');
    await fs.promises.mkdir(path.join(corruptOwnerOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(corruptOwnerOp, 'backups', '0'), 'precious-backup', 'utf8');
    await fs.promises.writeFile(path.join(corruptOwnerOp, 'owner.json'), '{corrupt-json', 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      executor.recover(),
      (err: MutationPlanError) => {
        assert.strictEqual(err.code, 'RECOVERY_REQUIRED');
        assert.ok(err.message.includes('corrupt-owner-op'));
        return true;
      },
    );

    // Fail-closed: backups must survive when owner metadata is corrupt/unreadable
    assert.strictEqual(fs.existsSync(corruptOwnerOp), true);
    assert.strictEqual(fs.existsSync(path.join(corruptOwnerOp, 'backups', '0')), true);
  });

  test('Issue #167: recover() fails-closed with RECOVERY_REQUIRED if owner.json has invalid PID type', async () => {
    const invalidPidOp = path.join(tempDir, '.cdt-journal', 'invalid-pid-op');
    await fs.promises.mkdir(path.join(invalidPidOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(invalidPidOp, 'backups', '0'), 'precious-backup', 'utf8');
    await fs.promises.writeFile(path.join(invalidPidOp, 'owner.json'), JSON.stringify({ pid: 'not-a-number' }), 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      executor.recover(),
      (err: MutationPlanError) => {
        assert.strictEqual(err.code, 'RECOVERY_REQUIRED');
        assert.ok(err.message.includes('invalid-pid-op'));
        return true;
      },
    );

    assert.strictEqual(fs.existsSync(invalidPidOp), true);
    assert.strictEqual(fs.existsSync(path.join(invalidPidOp, 'backups', '0')), true);
  });

  test('Issue #167: recover() stops with PLAN_CONFLICT when encountering active owner alongside terminated orphan', async () => {
    const terminatedOp = path.join(tempDir, '.cdt-journal', '01-terminated-op');
    await fs.promises.mkdir(path.join(terminatedOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(terminatedOp, 'backups', '0'), 'stale-backup', 'utf8');
    await fs.promises.writeFile(path.join(terminatedOp, 'owner.json'), JSON.stringify({ pid: 999999, createdAt: 100 }), 'utf8');

    const activeOp = path.join(tempDir, '.cdt-journal', '02-active-op');
    await fs.promises.mkdir(path.join(activeOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(activeOp, 'backups', '0'), 'active-backup', 'utf8');
    await fs.promises.writeFile(path.join(activeOp, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: 200 }), 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      executor.recover(),
      (err: MutationPlanError) => {
        assert.strictEqual(err.code, 'PLAN_CONFLICT');
        assert.ok(err.message.includes('02-active-op'));
        return true;
      },
    );

    assert.strictEqual(fs.existsSync(activeOp), true);
    assert.strictEqual(fs.existsSync(path.join(activeOp, 'backups', '0')), true);
  });

  test('Issue #167: recover() cleans up committed journal even if owner process PID is alive and unblocks next plan', async () => {
    const fileA = path.join(tempDir, 'fileA.xml');
    await fs.promises.writeFile(fileA, 'committed-content', 'utf8');

    const committedOp = path.join(tempDir, '.cdt-journal', 'committed-op-alive-pid');
    await fs.promises.mkdir(committedOp, { recursive: true });
    await fs.promises.writeFile(
      path.join(committedOp, 'owner.json'),
      JSON.stringify({ pid: process.pid, createdAt: Date.now() - 5000 }),
      'utf8',
    );
    await fs.promises.writeFile(
      path.join(committedOp, 'journal.json'),
      JSON.stringify({
        version: 1,
        operationId: 'committed-op-alive-pid',
        plan: { kind: 'test.committed', steps: [], result: null },
        state: 'committed',
        appliedSteps: 1,
        snapshots: [],
      }),
      'utf8',
    );

    const executor = new MutationPlanExecutor(tempDir);
    // recover() must NOT throw PLAN_CONFLICT even though process.pid is alive!
    await executor.recover();

    // Committed operation directory must be removed and journal root cleaned up
    assert.strictEqual(fs.existsSync(committedOp), false, 'committed directory must be cleaned up');
    assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), false);

    // Next plan executes cleanly without being blocked
    const fileB = path.join(tempDir, 'fileB.xml');
    await fs.promises.writeFile(fileB, 'initial-B', 'utf8');
    await executor.execute({
      kind: 'test.planB',
      steps: [{
        type: 'writeFile', targetPath: fileB, content: 'mutated-B', encoding: 'utf8',
        expected: { state: 'file', hash: hashContent('initial-B') },
      }],
      result: null,
    });
    assert.strictEqual(await fs.promises.readFile(fileB, 'utf8'), 'mutated-B');
  });

  test('Issue #167: recover() fails-closed with PLAN_CONFLICT on recent staging directory without owner.json', async () => {
    const stagingOp = path.join(tempDir, '.cdt-journal', '.prep-in-flight-tmp');
    await fs.promises.mkdir(stagingOp, { recursive: true });
    // In-flight staging directory created just now, owner.json not yet written

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      executor.recover(),
      (err: MutationPlanError) => {
        assert.strictEqual(err.code, 'PLAN_CONFLICT');
        assert.ok(err.message.includes('.prep-in-flight-tmp'));
        return true;
      },
    );

    // Fail-closed: recent staging directory must NOT be deleted while another process might be initializing it
    assert.strictEqual(fs.existsSync(stagingOp), true, 'recent staging directory must be preserved');
  });

  test('Issue #167: executor collision on same operationId does not delete first executor journal/backups on rename failure', async () => {
    const fileA = path.join(tempDir, 'fileA.xml');
    await fs.promises.writeFile(fileA, 'initial-content', 'utf8');
    const sharedOpId = 'collision-op-id';
    const activeOpDir = path.join(tempDir, '.cdt-journal', sharedOpId);
    const executor2 = new MutationPlanExecutor(tempDir);

    const origRename = fs.promises.rename;
    try {
      (fs.promises as any).rename = async (oldPath: string, newPath: string) => {
        if (newPath === activeOpDir) {
          // Simulate Process 1 winning the race and publishing activeOpDir just before Process 2's rename
          await fs.promises.mkdir(path.join(activeOpDir, 'backups'), { recursive: true });
          await fs.promises.writeFile(
            path.join(activeOpDir, 'owner.json'),
            JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
            'utf8',
          );
          await fs.promises.writeFile(
            path.join(activeOpDir, 'journal.json'),
            JSON.stringify({
              version: 1,
              operationId: sharedOpId,
              plan: { kind: 'test.proc1', steps: [], result: null },
              state: 'prepared',
              appliedSteps: 0,
              snapshots: [],
            }),
            'utf8',
          );
          await fs.promises.writeFile(path.join(activeOpDir, 'backups', 'backup-0'), 'precious-backup', 'utf8');

          const err = new Error('EEXIST: file already exists, rename') as NodeJS.ErrnoException;
          err.code = 'EEXIST';
          throw err;
        }
        return origRename(oldPath, newPath);
      };

      // Now executor2 executes with operationId: sharedOpId
      // Both processes passed recoverLocked(), Process 1 published activeOpDir, and Process 2's rename threw EEXIST
      await assert.rejects(
        executor2.execute({
          kind: 'test.proc2',
          steps: [{
            type: 'writeFile', targetPath: fileA, content: 'from-proc2', encoding: 'utf8',
            expected: { state: 'file', hash: hashContent('initial-content') },
          }],
          result: null,
        }, sharedOpId),
        /EEXIST/,
      );

      // CRITICAL ASSERTION:
      // Executor 2's catch block MUST NOT have deleted activeOpDir, journal.json, or precious-backup!
      assert.strictEqual(fs.existsSync(activeOpDir), true, 'activeOpDir must NOT be deleted by failed second executor');
      assert.strictEqual(fs.existsSync(path.join(activeOpDir, 'journal.json')), true, 'journal.json must remain intact');
      assert.strictEqual(fs.existsSync(path.join(activeOpDir, 'backups', 'backup-0')), true, 'backups must remain intact');
    } finally {
      (fs.promises as any).rename = origRename;
    }
  });

  test('Issue #167: persistent cleanup failure on committed operation does not throw or block subsequent plans', async () => {
    const fileA = path.join(tempDir, 'fileA.xml');
    await fs.promises.writeFile(fileA, 'initial-A', 'utf8');

    const committedOp = path.join(tempDir, '.cdt-journal', 'committed-unremovable-op');
    await fs.promises.mkdir(committedOp, { recursive: true });
    await fs.promises.writeFile(
      path.join(committedOp, 'owner.json'),
      JSON.stringify({ pid: process.pid, createdAt: Date.now() - 5000 }),
      'utf8',
    );
    await fs.promises.writeFile(
      path.join(committedOp, 'journal.json'),
      JSON.stringify({
        version: 1,
        operationId: 'committed-unremovable-op',
        plan: { kind: 'test.committed', steps: [], result: null },
        state: 'committed',
        appliedSteps: 1,
        snapshots: [],
      }),
      'utf8',
    );

    const origRm = fs.promises.rm;
    try {
      (fs.promises as any).rm = async (targetPath: string, opts?: any) => {
        if (targetPath === committedOp) {
          const err = new Error('EBUSY: resource busy or locked, rm') as NodeJS.ErrnoException;
          err.code = 'EBUSY';
          throw err;
        }
        return origRm(targetPath, opts);
      };

      const executor = new MutationPlanExecutor(tempDir);
      // recover() should NOT throw even if removing committedOp fails with EBUSY!
      await executor.recover();

      // Subsequent execute() must succeed without error
      await executor.execute({
        kind: 'test.planSubsequent',
        steps: [{
          type: 'writeFile', targetPath: fileA, content: 'mutated-A', encoding: 'utf8',
          expected: { state: 'file', hash: hashContent('initial-A') },
        }],
        result: 'success',
      });
      assert.strictEqual(await fs.promises.readFile(fileA, 'utf8'), 'mutated-A');
    } finally {
      (fs.promises as any).rm = origRm;
    }
  });

  test('#183: recover() rolls back journal with state rollback-required from same process rather than throwing PLAN_CONFLICT', async () => {
    const fileA = path.join(tempDir, 'fileA.txt');
    await fs.promises.writeFile(fileA, 'initial-content', 'utf8');

    const journalRoot = path.join(tempDir, '.cdt-journal');
    const opDir = path.join(journalRoot, 'failed-op-123');
    const backupsDir = path.join(opDir, 'backups');
    await fs.promises.mkdir(backupsDir, { recursive: true });

    const backupFile = path.join(backupsDir, '0');
    await fs.promises.writeFile(backupFile, 'initial-content', 'utf8');

    await fs.promises.writeFile(fileA, 'mutated', 'utf8');

    await fs.promises.writeFile(
      path.join(opDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, createdAt: Date.now() - 5000 }),
      'utf8',
    );

    await fs.promises.writeFile(
      path.join(opDir, 'journal.json'),
      JSON.stringify({
        version: 1,
        operationId: 'failed-op-123',
        plan: {
          kind: 'test.failed',
          steps: [{
            type: 'writeFile', targetPath: fileA, content: 'mutated', encoding: 'utf8',
            expected: { state: 'file', hash: hashContent('initial-content') },
          }],
          result: null,
        },
        state: 'rollback-required',
        appliedSteps: 1,
        snapshots: [{
          targetPath: fileA,
          state: 'file',
          hash: hashContent('initial-content'),
          backupName: '0',
          contentsBackedUp: true,
        }],
      }),
      'utf8',
    );

    const executor = new MutationPlanExecutor(tempDir);
    await executor.recover();

    assert.strictEqual(
      await fs.promises.readFile(fileA, 'utf8'),
      'initial-content',
      'recover() must restore snapshots for rollback-required operations from the same process',
    );
    assert.strictEqual(fs.existsSync(opDir), false, 'operation directory must be removed after successful recovery');
  });

  test('#212: recover() recovers stale journal with live PID when heartbeat has expired (reused PID)', async () => {
    const fileA = path.join(tempDir, 'fileA.txt');
    await fs.promises.writeFile(fileA, 'initial-content', 'utf8');

    const journalRoot = path.join(tempDir, '.cdt-journal');
    const opDir = path.join(journalRoot, 'stale-reused-pid-op');
    const backupsDir = path.join(opDir, 'backups');
    await fs.promises.mkdir(backupsDir, { recursive: true });

    const backupFile = path.join(backupsDir, '0');
    await fs.promises.writeFile(backupFile, 'initial-content', 'utf8');

    await fs.promises.writeFile(fileA, 'mutated', 'utf8');

    await fs.promises.writeFile(
      path.join(opDir, 'owner.json'),
      JSON.stringify({
        pid: process.pid,
        createdAt: Date.now() - 60000,
        heartbeatAt: Date.now() - 60000,
      }),
      'utf8',
    );

    await fs.promises.writeFile(
      path.join(opDir, 'journal.json'),
      JSON.stringify({
        version: 1,
        operationId: 'stale-reused-pid-op',
        plan: {
          kind: 'test.stale',
          steps: [{
            type: 'writeFile', targetPath: fileA, content: 'mutated', encoding: 'utf8',
            expected: { state: 'file', hash: hashContent('initial-content') },
          }],
          result: null,
        },
        state: 'applying',
        appliedSteps: 1,
        snapshots: [{
          targetPath: fileA,
          state: 'file',
          hash: hashContent('initial-content'),
          backupName: '0',
          contentsBackedUp: true,
        }],
      }),
      'utf8',
    );

    const executor = new MutationPlanExecutor(tempDir);
    await executor.recover();

    assert.strictEqual(
      await fs.promises.readFile(fileA, 'utf8'),
      'initial-content',
      'recover() must restore snapshots when lease has expired despite live PID',
    );
    assert.strictEqual(fs.existsSync(opDir), false);
  });

  test('#184: active root lease from another process blocks execution with PLAN_CONFLICT', async () => {
    const fileA = path.join(tempDir, 'fileA.txt');
    await fs.promises.writeFile(fileA, 'initial-content', 'utf8');

    const journalRoot = path.join(tempDir, '.cdt-journal');
    await fs.promises.mkdir(journalRoot, { recursive: true });

    const leasePath = path.join(journalRoot, '.root-lease.json');
    await fs.promises.writeFile(
      leasePath,
      JSON.stringify({
        pid: process.pid,
        leaseId: 'other-process-lease',
        createdAt: Date.now(),
        heartbeatAt: Date.now(),
        operationId: 'other-process-operation',
      }),
      'utf8',
    );

    const executor = new MutationPlanExecutor(tempDir);

    await assert.rejects(
      () => executor.execute({
        kind: 'test.concurrent',
        steps: [{
          type: 'writeFile', targetPath: fileA, content: 'mutated-2', encoding: 'utf8',
          expected: { state: 'file', hash: hashContent('initial-content') },
        }],
        result: 'success',
      }),
      (err: MutationPlanError) => err.code === 'PLAN_CONFLICT',
    );
  });

  test('#219: fresh heartbeat sidecar keeps an aged live lease active', async () => {
    const target = path.join(tempDir, 'protected.txt');
    const journalRoot = path.join(tempDir, '.cdt-journal');
    const leasePath = path.join(journalRoot, '.root-lease.json');
    const leaseId = 'aged-but-active-lease';
    const agedAt = Date.now() - 60000;
    const freshAt = Date.now();
    const heartbeatPath = path.join(
      journalRoot,
      `.root-lease.json.${createHash('sha256').update(leaseId, 'utf8').digest('hex')}.heartbeat`,
    );
    await fs.promises.mkdir(journalRoot, { recursive: true });
    await fs.promises.writeFile(target, 'original', 'utf8');
    await fs.promises.writeFile(leasePath, JSON.stringify({
      leaseId,
      pid: process.pid,
      createdAt: agedAt,
      heartbeatAt: agedAt,
      operationId: 'active-aged-operation',
    }), 'utf8');
    await fs.promises.writeFile(heartbeatPath, JSON.stringify({ leaseId, heartbeatAt: freshAt }), 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      () => executor.execute({
        kind: 'test.freshHeartbeatSidecar',
        steps: [{
          type: 'writeFile', targetPath: target, content: 'mutated', encoding: 'utf8',
          expected: { state: 'file', hash: hashContent('original') },
        }],
        result: 'success',
      }),
      (err: MutationPlanError) => err instanceof MutationPlanError && err.code === 'PLAN_CONFLICT',
    );

    assert.strictEqual(await fs.promises.readFile(target, 'utf8'), 'original');
    assert.strictEqual(JSON.parse(await fs.promises.readFile(leasePath, 'utf8')).leaseId, leaseId);
    assert.strictEqual(JSON.parse(await fs.promises.readFile(heartbeatPath, 'utf8')).heartbeatAt, freshAt);
  });

  test('#219: malformed root lease JSON fails closed and remains untouched', async () => {
    const target = path.join(tempDir, 'protected.txt');
    const journalRoot = path.join(tempDir, '.cdt-journal');
    const leasePath = path.join(journalRoot, '.root-lease.json');
    const malformedLease = '{"leaseId":"partial"';
    await fs.promises.mkdir(journalRoot, { recursive: true });
    await fs.promises.writeFile(target, 'original', 'utf8');
    await fs.promises.writeFile(leasePath, malformedLease, 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      () => executor.execute({
        kind: 'test.malformedLease',
        steps: [{
          type: 'writeFile', targetPath: target, content: 'mutated', encoding: 'utf8',
          expected: { state: 'file', hash: hashContent('original') },
        }],
        result: 'success',
      }),
      (err: MutationPlanError) => err instanceof MutationPlanError && err.code === 'PLAN_CONFLICT',
    );

    assert.strictEqual(await fs.promises.readFile(target, 'utf8'), 'original');
    assert.strictEqual(await fs.promises.readFile(leasePath, 'utf8'), malformedLease);
  });

  test('#219: structurally invalid root lease JSON fails closed', async () => {
    const target = path.join(tempDir, 'protected.txt');
    const journalRoot = path.join(tempDir, '.cdt-journal');
    const leasePath = path.join(journalRoot, '.root-lease.json');
    const malformedLease = JSON.stringify({ leaseId: '', pid: 'current', createdAt: -1, heartbeatAt: 'now' });
    await fs.promises.mkdir(journalRoot, { recursive: true });
    await fs.promises.writeFile(target, 'original', 'utf8');
    await fs.promises.writeFile(leasePath, malformedLease, 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      () => executor.execute({
        kind: 'test.invalidLeaseFields',
        steps: [{
          type: 'writeFile', targetPath: target, content: 'mutated', encoding: 'utf8',
          expected: { state: 'file', hash: hashContent('original') },
        }],
        result: 'success',
      }),
      (err: MutationPlanError) => err instanceof MutationPlanError && err.code === 'PLAN_CONFLICT',
    );

    assert.strictEqual(await fs.promises.readFile(target, 'utf8'), 'original');
    assert.strictEqual(await fs.promises.readFile(leasePath, 'utf8'), malformedLease);
  });

  test('#219: unreadable root lease fails closed instead of assuming it is free', async () => {
    const target = path.join(tempDir, 'protected.txt');
    const journalRoot = path.join(tempDir, '.cdt-journal');
    const leasePath = path.join(journalRoot, '.root-lease.json');
    await fs.promises.mkdir(journalRoot, { recursive: true });
    await fs.promises.writeFile(target, 'original', 'utf8');
    await fs.promises.writeFile(leasePath, JSON.stringify({
      leaseId: 'unreadable-lease',
      pid: process.pid,
      createdAt: Date.now(),
      heartbeatAt: Date.now(),
      operationId: 'other-operation',
    }), 'utf8');

    const originalDescriptor = Object.getOwnPropertyDescriptor(fs.promises, 'readFile');
    if (!originalDescriptor || typeof originalDescriptor.value !== 'function') {
      throw new Error('fs.promises.readFile must be a configurable data property for this test.');
    }
    const originalReadFile = originalDescriptor.value as typeof fs.promises.readFile;
    Object.defineProperty(fs.promises, 'readFile', {
      ...originalDescriptor,
      value: async (...args: unknown[]) => {
        if (path.resolve(String(args[0])) === path.resolve(leasePath)) {
          const error = new Error('simulated EACCES') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return (originalReadFile as (...readArgs: unknown[]) => Promise<unknown>).apply(fs.promises, args);
      },
    });

    try {
      const executor = new MutationPlanExecutor(tempDir);
      await assert.rejects(
        () => executor.execute({
          kind: 'test.unreadableLease',
          steps: [{
            type: 'writeFile', targetPath: target, content: 'mutated', encoding: 'utf8',
            expected: { state: 'file', hash: hashContent('original') },
          }],
          result: 'success',
        }),
        (err: MutationPlanError) => err instanceof MutationPlanError && err.code === 'PLAN_CONFLICT',
      );
    } finally {
      Object.defineProperty(fs.promises, 'readFile', originalDescriptor);
    }

    assert.strictEqual(await fs.promises.readFile(target, 'utf8'), 'original');
    assert.strictEqual(fs.existsSync(leasePath), true);
  });

  test('#219: a fresh claim marker blocks execution and remains untouched', async () => {
    const target = path.join(tempDir, 'protected.txt');
    const journalRoot = path.join(tempDir, '.cdt-journal');
    const claimPath = path.join(journalRoot, '.root-lease.json.claim-active');
    await fs.promises.mkdir(journalRoot, { recursive: true });
    await fs.promises.writeFile(target, 'original', 'utf8');
    const activeClaim = JSON.stringify({
      leaseId: 'active-claim',
      pid: process.pid,
      createdAt: Date.now(),
      heartbeatAt: Date.now(),
      operationId: 'active-operation',
    });
    await fs.promises.writeFile(claimPath, activeClaim, 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      () => executor.execute({
        kind: 'test.activeClaimMarker',
        steps: [{
          type: 'writeFile', targetPath: target, content: 'mutated', encoding: 'utf8',
          expected: { state: 'file', hash: hashContent('original') },
        }],
        result: 'success',
      }),
      (err: MutationPlanError) => err instanceof MutationPlanError && err.code === 'PLAN_CONFLICT',
    );

    assert.strictEqual(await fs.promises.readFile(target, 'utf8'), 'original');
    assert.strictEqual(await fs.promises.readFile(claimPath, 'utf8'), activeClaim);
  });

  test('#219: stale claim left by a crashed process is recovered automatically', async () => {
    const target = path.join(tempDir, 'protected.txt');
    const journalRoot = path.join(tempDir, '.cdt-journal');
    const claimPath = path.join(
      journalRoot,
      '.root-lease.json.claim-v2-' + String(Date.now() - 60000)
        + '-2147483647-00000000-0000-4000-8000-000000000001',
    );
    await fs.promises.mkdir(journalRoot, { recursive: true });
    await fs.promises.writeFile(target, 'original', 'utf8');
    await fs.promises.writeFile(claimPath, JSON.stringify({
      leaseId: 'crashed-claim',
      pid: 2147483647,
      createdAt: Date.now() - 60000,
      heartbeatAt: Date.now() - 60000,
      operationId: 'crashed-operation',
    }), 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    await executor.execute({
      kind: 'test.recoverStaleClaim',
      steps: [{
        type: 'writeFile', targetPath: target, content: 'mutated', encoding: 'utf8',
        expected: { state: 'file', hash: hashContent('original') },
      }],
      result: 'success',
    });

    assert.strictEqual(await fs.promises.readFile(target, 'utf8'), 'mutated');
    assert.strictEqual(fs.existsSync(claimPath), false);
  });

  test('#219: stale lease takeover removes the old heartbeat sidecar', async () => {
    const target = path.join(tempDir, 'protected.txt');
    const journalRoot = path.join(tempDir, '.cdt-journal');
    const leasePath = path.join(journalRoot, '.root-lease.json');
    const leaseId = 'stale-sidecar-lease';
    const staleAt = Date.now() - 60000;
    const heartbeatPath = path.join(
      journalRoot,
      `.root-lease.json.${createHash('sha256').update(leaseId, 'utf8').digest('hex')}.heartbeat`,
    );
    await fs.promises.mkdir(journalRoot, { recursive: true });
    await fs.promises.writeFile(target, 'original', 'utf8');
    await fs.promises.writeFile(leasePath, JSON.stringify({
      leaseId,
      pid: 2147483647,
      createdAt: staleAt,
      heartbeatAt: staleAt,
      operationId: 'stale-sidecar-operation',
    }), 'utf8');
    await fs.promises.writeFile(heartbeatPath, JSON.stringify({ leaseId, heartbeatAt: staleAt }), 'utf8');

    await new MutationPlanExecutor(tempDir).execute({
      kind: 'test.cleanupStaleHeartbeatSidecar',
      steps: [{
        type: 'writeFile', targetPath: target, content: 'mutated', encoding: 'utf8',
        expected: { state: 'file', hash: hashContent('original') },
      }],
      result: 'success',
    });

    assert.strictEqual(await fs.promises.readFile(target, 'utf8'), 'mutated');
    assert.strictEqual(fs.existsSync(heartbeatPath), false);
    assert.strictEqual(fs.existsSync(journalRoot), false);
  });

  test('#219: a competing process cannot clear a fresh stale-lease claim marker', async function () {
    this.timeout(10000);
    const target = path.join(tempDir, 'protected.txt');
    const journalRoot = path.join(tempDir, '.cdt-journal');
    const leasePath = path.join(journalRoot, '.root-lease.json');
    await fs.promises.mkdir(journalRoot, { recursive: true });
    await fs.promises.writeFile(target, 'original', 'utf8');
    await fs.promises.writeFile(leasePath, JSON.stringify({
      leaseId: 'stale-claim-race-lease',
      pid: 2147483647,
      createdAt: Date.now() - 60000,
      heartbeatAt: Date.now() - 60000,
      operationId: 'stale-claim-race-operation',
    }), 'utf8');

    const mutationModule = path.resolve(__dirname, '../../src/services/configurationSession/mutationPlan.js');
    const storageModule = path.resolve(__dirname, '../../src/services/configurationSession/atomicFileStorage.js');
    const vscodeStub = path.resolve(__dirname, '../helpers/vscodeStubRegister.js');
    const childScript = `
      const fs = require('fs');
      const path = require('path');
      require(${JSON.stringify(vscodeStub)});
      const { MutationPlanExecutor, MutationPlanError } = require(${JSON.stringify(mutationModule)});
      const { hashContent } = require(${JSON.stringify(storageModule)});
      const [root, target, content, role] = process.argv.slice(1);
      if (role === 'holder') {
        const originalRename = fs.promises.rename;
        let signaled = false;
        fs.promises.rename = async function (source, destination) {
          const result = await originalRename.call(fs.promises, source, destination);
          if (!signaled && path.basename(String(destination)).startsWith('.root-lease.json.claim-')) {
            signaled = true;
            process.stdout.write('CLAIMED\\n');
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
          return result;
        };
      }
      new MutationPlanExecutor(root).execute({
        kind: 'test.freshClaimRace',
        steps: [{
          type: 'writeFile', targetPath: target, content, encoding: 'utf8',
          expected: { state: 'file', hash: hashContent('original') },
        }],
        result: content,
      }).then(() => {
        process.stdout.write('ACQUIRED\\n');
        process.exitCode = 0;
      }).catch((error) => {
        if (error instanceof MutationPlanError && error.code === 'PLAN_CONFLICT') {
          process.stdout.write('CONFLICT\\n');
          process.exitCode = 2;
          return;
        }
        process.stderr.write(String(error && (error.stack || error)));
        process.exitCode = 3;
      });
    `;
    const startChild = (content: string, role: string): ChildProcess => spawn(
      process.execPath,
      ['-e', childScript, tempDir, target, content, role],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const holder = startChild('holder-content', 'holder');
    const holderResult = collectChildOutput(holder);
    let holderOutput = '';
    const holderReady = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Holder did not fence stale lease: ${holderOutput}`)), 5000);
      holder.stdout?.on('data', (chunk: Buffer | string) => {
        holderOutput += chunk.toString();
        if (holderOutput.includes('CLAIMED\n')) {
          clearTimeout(timer);
          resolve();
        }
      });
      holder.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      holder.once('close', (code) => {
        if (!holderOutput.includes('CLAIMED\n')) {
          clearTimeout(timer);
          reject(new Error(`Holder exited before creating claim marker (code ${code}): ${holderOutput}`));
        }
      });
    });

    let contender: ChildProcess | undefined;
    try {
      await holderReady;
      const claimEntry = (await fs.promises.readdir(journalRoot))
        .find((entry) => entry.startsWith('.root-lease.json.claim-'));
      assert.ok(claimEntry, 'holder must leave its fenced lease in a claim marker');

      contender = startChild('contender-content', 'contender');
      const contenderResult = await collectChildOutput(contender);
      assert.strictEqual(contenderResult.code, 2, contenderResult.stderr);
      assert.ok(contenderResult.stdout.includes('CONFLICT'));
      assert.strictEqual(fs.existsSync(path.join(journalRoot, claimEntry)), true);

      const firstResult = await holderResult;
      assert.strictEqual(firstResult.code, 0, firstResult.stderr);
      assert.ok(firstResult.stdout.includes('ACQUIRED'));
    } finally {
      if (contender && contender.exitCode === null) { contender.kill(); }
      if (holder.exitCode === null) { holder.kill(); }
    }

    assert.strictEqual(await fs.promises.readFile(target, 'utf8'), 'holder-content');
    assert.strictEqual(fs.existsSync(leasePath), false);
    assert.strictEqual(fs.existsSync(journalRoot), false);
  });

  test('#219: stale lease takeover preserves a replacement installed after the stale read', async () => {
    const target = path.join(tempDir, 'protected.txt');
    const journalRoot = path.join(tempDir, '.cdt-journal');
    const leasePath = path.join(journalRoot, '.root-lease.json');
    const staleLease = JSON.stringify({
      leaseId: 'stale-lease',
      pid: 2147483647,
      createdAt: Date.now() - 60000,
      heartbeatAt: Date.now() - 60000,
      operationId: 'stale-operation',
    });
    const replacementLease = JSON.stringify({
      leaseId: 'replacement-lease',
      pid: process.pid,
      createdAt: Date.now(),
      heartbeatAt: Date.now(),
      operationId: 'replacement-operation',
    });
    await fs.promises.mkdir(journalRoot, { recursive: true });
    await fs.promises.writeFile(target, 'original', 'utf8');
    await fs.promises.writeFile(leasePath, staleLease, 'utf8');

    const originalDescriptor = Object.getOwnPropertyDescriptor(fs.promises, 'readFile');
    if (!originalDescriptor || typeof originalDescriptor.value !== 'function') {
      throw new Error('fs.promises.readFile must be a configurable data property for this test.');
    }
    const originalReadFile = originalDescriptor.value as typeof fs.promises.readFile;
    let replacementInstalled = false;
    Object.defineProperty(fs.promises, 'readFile', {
      ...originalDescriptor,
      value: async (...args: unknown[]) => {
        const result = await (originalReadFile as (...readArgs: unknown[]) => Promise<unknown>).apply(fs.promises, args);
        if (!replacementInstalled && path.resolve(String(args[0])) === path.resolve(leasePath)) {
          replacementInstalled = true;
          await fs.promises.writeFile(leasePath, replacementLease, 'utf8');
        }
        return result;
      },
    });

    try {
      const executor = new MutationPlanExecutor(tempDir);
      await assert.rejects(
        () => executor.execute({
          kind: 'test.staleLeaseReplacement',
          steps: [{
            type: 'writeFile', targetPath: target, content: 'mutated', encoding: 'utf8',
            expected: { state: 'file', hash: hashContent('original') },
          }],
          result: 'success',
        }),
        (err: MutationPlanError) => err instanceof MutationPlanError && err.code === 'PLAN_CONFLICT',
      );
    } finally {
      Object.defineProperty(fs.promises, 'readFile', originalDescriptor);
    }

    assert.strictEqual(replacementInstalled, true);
    assert.strictEqual(await fs.promises.readFile(target, 'utf8'), 'original');
    assert.strictEqual(await fs.promises.readFile(leasePath, 'utf8'), replacementLease);
  });

  test('#219: stale lease takeover stops if a new lease wins the rename-to-restore window', async () => {
    const target = path.join(tempDir, 'protected.txt');
    const journalRoot = path.join(tempDir, '.cdt-journal');
    const leasePath = path.join(journalRoot, '.root-lease.json');
    const staleLease = JSON.stringify({
      leaseId: 'stale-before-restore',
      pid: 2147483647,
      createdAt: Date.now() - 60000,
      heartbeatAt: Date.now() - 60000,
      operationId: 'stale-operation',
    });
    const replacedLease = JSON.stringify({
      leaseId: 'replaced-during-takeover',
      pid: process.pid,
      createdAt: Date.now(),
      heartbeatAt: Date.now(),
      operationId: 'replacement-operation',
    });
    const winningLease = JSON.stringify({
      leaseId: 'winner-during-restore',
      pid: process.pid,
      createdAt: Date.now(),
      heartbeatAt: Date.now(),
      operationId: 'winning-operation',
    });
    await fs.promises.mkdir(journalRoot, { recursive: true });
    await fs.promises.writeFile(target, 'original', 'utf8');
    await fs.promises.writeFile(leasePath, staleLease, 'utf8');

    const originalDescriptor = Object.getOwnPropertyDescriptor(fs.promises, 'readFile');
    if (!originalDescriptor || typeof originalDescriptor.value !== 'function') {
      throw new Error('fs.promises.readFile must be a configurable data property for this test.');
    }
    const originalReadFile = originalDescriptor.value as typeof fs.promises.readFile;
    let replacedAfterRead = false;
    let winnerCreatedDuringRestore = false;
    Object.defineProperty(fs.promises, 'readFile', {
      ...originalDescriptor,
      value: async (...args: unknown[]) => {
        const requestedPath = path.resolve(String(args[0]));
        const result = await (originalReadFile as (...readArgs: unknown[]) => Promise<unknown>).apply(fs.promises, args);
        if (!replacedAfterRead && requestedPath === path.resolve(leasePath)) {
          replacedAfterRead = true;
          await fs.promises.writeFile(leasePath, replacedLease, 'utf8');
        } else if (!winnerCreatedDuringRestore
          && path.basename(requestedPath).startsWith('.root-lease.json.claim-')) {
          winnerCreatedDuringRestore = true;
          await fs.promises.writeFile(leasePath, winningLease, 'utf8');
        }
        return result;
      },
    });

    try {
      const executor = new MutationPlanExecutor(tempDir);
      await assert.rejects(
        () => executor.execute({
          kind: 'test.staleLeaseRestoreRace',
          steps: [{
            type: 'writeFile', targetPath: target, content: 'mutated', encoding: 'utf8',
            expected: { state: 'file', hash: hashContent('original') },
          }],
          result: 'success',
        }),
        (err: MutationPlanError) => err instanceof MutationPlanError && err.code === 'PLAN_CONFLICT',
      );
    } finally {
      Object.defineProperty(fs.promises, 'readFile', originalDescriptor);
    }

    assert.strictEqual(replacedAfterRead, true);
    assert.strictEqual(winnerCreatedDuringRestore, true);
    assert.strictEqual(await fs.promises.readFile(target, 'utf8'), 'original');
    assert.strictEqual(await fs.promises.readFile(leasePath, 'utf8'), winningLease);
    const claimName = (await fs.promises.readdir(journalRoot)).find((name) => name.startsWith('.root-lease.json.claim-'));
    assert.ok(claimName, 'the prior replacement must remain preserved behind a claim marker');
    assert.strictEqual(await fs.promises.readFile(path.join(journalRoot, claimName!), 'utf8'), replacedLease);
  });

  test('#219: competing processes on one stale lease produce one winner and one typed conflict', async function () {
    this.timeout(10000);
    const target = path.join(tempDir, 'protected.txt');
    const journalRoot = path.join(tempDir, '.cdt-journal');
    const leasePath = path.join(journalRoot, '.root-lease.json');
    await fs.promises.mkdir(journalRoot, { recursive: true });
    await fs.promises.writeFile(target, 'original', 'utf8');
    await fs.promises.writeFile(leasePath, JSON.stringify({
      leaseId: 'stale-competing-lease',
      pid: 2147483647,
      createdAt: Date.now() - 60000,
      heartbeatAt: Date.now() - 60000,
      operationId: 'stale-operation',
    }), 'utf8');

    const mutationModule = path.resolve(__dirname, '../../src/services/configurationSession/mutationPlan.js');
    const storageModule = path.resolve(__dirname, '../../src/services/configurationSession/atomicFileStorage.js');
    const vscodeStub = path.resolve(__dirname, '../helpers/vscodeStubRegister.js');
    const childScript = `
      const fs = require('fs');
      const path = require('path');
      require(${JSON.stringify(vscodeStub)});
      const { MutationPlanExecutor, MutationPlanError } = require(${JSON.stringify(mutationModule)});
      const { hashContent } = require(${JSON.stringify(storageModule)});
      const [root, target, content, role] = process.argv.slice(1);
      if (role === 'holder') {
        const originalRename = fs.promises.rename;
        let signaled = false;
        fs.promises.rename = async function (source, destination) {
          if (!signaled && String(source).includes('.cdt-plan-')) {
            signaled = true;
            process.stdout.write('READY\\n');
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
          return originalRename.call(fs.promises, source, destination);
        };
      }
      new MutationPlanExecutor(root).execute({
        kind: 'test.crossProcessLease',
        steps: [{
          type: 'writeFile', targetPath: target, content, encoding: 'utf8',
          expected: { state: 'file', hash: hashContent('original') },
        }],
        result: content,
      }).then(() => {
        process.stdout.write('ACQUIRED\\n');
        process.exitCode = 0;
      }).catch((error) => {
        if (error instanceof MutationPlanError && error.code === 'PLAN_CONFLICT') {
          process.stdout.write('CONFLICT\\n');
          process.exitCode = 2;
          return;
        }
        process.stderr.write(String(error && (error.stack || error)));
        process.exitCode = 3;
      });
    `;
    const startChild = (content: string, role: string): ChildProcess => spawn(
      process.execPath,
      ['-e', childScript, tempDir, target, content, role],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const holder = startChild('holder-content', 'holder');
    const holderResult = collectChildOutput(holder);
    let holderOutput = '';
    const holderReady = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Holder did not reach mutation step: ${holderOutput}`)), 5000);
      holder.stdout?.on('data', (chunk: Buffer | string) => {
        holderOutput += chunk.toString();
        if (holderOutput.includes('READY\n')) {
          clearTimeout(timer);
          resolve();
        }
      });
      holder.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      holder.once('close', (code) => {
        if (!holderOutput.includes('READY\n')) {
          clearTimeout(timer);
          reject(new Error(`Holder exited before acquiring the lease (code ${code}): ${holderOutput}`));
        }
      });
    });

    let contender: ChildProcess | undefined;
    try {
      await holderReady;
      contender = startChild('contender-content', 'contender');
      const contenderResult = await collectChildOutput(contender);
      const firstResult = await holderResult;
      assert.strictEqual(firstResult.code, 0, firstResult.stderr);
      assert.ok(firstResult.stdout.includes('ACQUIRED'));
      assert.strictEqual(contenderResult.code, 2, contenderResult.stderr);
      assert.ok(contenderResult.stdout.includes('CONFLICT'));
    } finally {
      if (contender && contender.exitCode === null) { contender.kill(); }
      if (holder.exitCode === null) { holder.kill(); }
    }

    assert.strictEqual(await fs.promises.readFile(target, 'utf8'), 'holder-content');
    assert.strictEqual(fs.existsSync(leasePath), false);
  });

  test('#219: release preserves a replacement lease installed after its ownership read', async () => {
    const target = path.join(tempDir, 'protected.txt');
    const journalRoot = path.join(tempDir, '.cdt-journal');
    const leasePath = path.join(journalRoot, '.root-lease.json');
    const replacementLease = JSON.stringify({
      leaseId: 'replacement-after-release-read',
      pid: process.pid,
      createdAt: Date.now(),
      heartbeatAt: Date.now(),
      operationId: 'replacement-operation',
    });
    await fs.promises.writeFile(target, 'original', 'utf8');

    const readDescriptor = Object.getOwnPropertyDescriptor(fs.promises, 'readFile');
    const rmDescriptor = Object.getOwnPropertyDescriptor(fs.promises, 'rm');
    if (!readDescriptor || typeof readDescriptor.value !== 'function'
      || !rmDescriptor || typeof rmDescriptor.value !== 'function') {
      throw new Error('fs.promises read/rm methods must be configurable data properties for this test.');
    }
    const originalReadFile = readDescriptor.value as typeof fs.promises.readFile;
    const originalRm = rmDescriptor.value as typeof fs.promises.rm;
    const operationPath = path.join(journalRoot, 'release-race-operation');
    let planApplied = false;
    let replacementInstalled = false;
    Object.defineProperty(fs.promises, 'rm', {
      ...rmDescriptor,
      value: async (...args: unknown[]) => {
        const result = await (originalRm as (...rmArgs: unknown[]) => Promise<unknown>).apply(fs.promises, args);
        if (path.resolve(String(args[0])) === path.resolve(operationPath)) {
          planApplied = true;
        }
        return result;
      },
    });
    Object.defineProperty(fs.promises, 'readFile', {
      ...readDescriptor,
      value: async (...args: unknown[]) => {
        const result = await (originalReadFile as (...readArgs: unknown[]) => Promise<unknown>).apply(fs.promises, args);
        if (planApplied && !replacementInstalled
          && path.resolve(String(args[0])) === path.resolve(leasePath)) {
          replacementInstalled = true;
          await fs.promises.writeFile(
            leasePath,
            replacementLease,
            'utf8',
          );
        }
        return result;
      },
    });

    try {
      const executor = new MutationPlanExecutor(tempDir);
      await executor.execute({
        kind: 'test.releaseLeaseReplacement',
        steps: [{
          type: 'writeFile', targetPath: target, content: 'mutated', encoding: 'utf8',
          expected: { state: 'file', hash: hashContent('original') },
        }],
        result: 'success',
      }, 'release-race-operation');
    } finally {
      Object.defineProperty(fs.promises, 'readFile', readDescriptor);
      Object.defineProperty(fs.promises, 'rm', rmDescriptor);
    }

    assert.strictEqual(planApplied, true);
    assert.strictEqual(replacementInstalled, true);
    assert.strictEqual(await fs.promises.readFile(leasePath, 'utf8'), replacementLease);
  });

  test('#219: partial heartbeat write cannot corrupt the active root lease', async function () {
    this.timeout(8000);
    const target = path.join(tempDir, 'protected.txt');
    const journalRoot = path.join(tempDir, '.cdt-journal');
    await fs.promises.writeFile(target, 'original', 'utf8');

    const writeDescriptor = Object.getOwnPropertyDescriptor(fs.promises, 'writeFile');
    if (!writeDescriptor || typeof writeDescriptor.value !== 'function') {
      throw new Error('fs.promises.writeFile must be a configurable data property for this test.');
    }
    const originalWriteFile = writeDescriptor.value as typeof fs.promises.writeFile;
    let markJournalWriteEntered!: () => void;
    let releaseJournalWrite!: () => void;
    const journalWriteEntered = new Promise<void>((resolve) => { markJournalWriteEntered = resolve; });
    const journalWriteGate = new Promise<void>((resolve) => { releaseJournalWrite = resolve; });
    let holdFirstJournalWrite = true;
    let injectPartialHeartbeat = false;
    let partialHeartbeatInjected = false;
    Object.defineProperty(fs.promises, 'writeFile', {
      ...writeDescriptor,
      value: async (...args: unknown[]) => {
        const requestedPath = path.resolve(String(args[0]));
        const fileName = path.basename(requestedPath);
        if (holdFirstJournalWrite && fileName.startsWith('.journal-') && fileName.endsWith('.tmp')) {
          holdFirstJournalWrite = false;
          markJournalWriteEntered();
          await journalWriteGate;
        }
        if (injectPartialHeartbeat && !partialHeartbeatInjected
          && fileName.startsWith('.root-lease.json')) {
          partialHeartbeatInjected = true;
          await (originalWriteFile as (...writeArgs: unknown[]) => Promise<unknown>).apply(fs.promises, [
            args[0],
            '{"leaseId":"partial',
            'utf8',
          ]);
          throw new Error('simulated interrupted heartbeat write');
        }
        return (originalWriteFile as (...writeArgs: unknown[]) => Promise<unknown>).apply(fs.promises, args);
      },
    });

    let execution: Promise<string> | undefined;
    try {
      const executor = new MutationPlanExecutor(tempDir);
      execution = executor.execute({
        kind: 'test.partialHeartbeat',
        steps: [{
          type: 'writeFile', targetPath: target, content: 'mutated', encoding: 'utf8',
          expected: { state: 'file', hash: hashContent('original') },
        }],
        result: 'success',
      });
      await journalWriteEntered;
      injectPartialHeartbeat = true;
      await new Promise<void>((resolve) => setTimeout(resolve, 2200));

      const leasePath = path.join(journalRoot, '.root-lease.json');
      const activeLease = JSON.parse(await fs.promises.readFile(leasePath, 'utf8')) as { leaseId?: unknown; pid?: unknown };
      assert.strictEqual(partialHeartbeatInjected, true, 'the heartbeat failure must be exercised');
      assert.strictEqual(typeof activeLease.leaseId, 'string');
      assert.strictEqual(activeLease.pid, process.pid);
      assert.ok(!(await fs.promises.readdir(journalRoot)).some((name) => name.startsWith('.root-lease.json.')
        && name.endsWith('.tmp')), 'partial heartbeat temp files should be cleaned up');
    } finally {
      releaseJournalWrite();
      Object.defineProperty(fs.promises, 'writeFile', writeDescriptor);
      await execution?.catch(() => undefined);
    }
  });

  test('#219: heartbeat for a lease read before replacement cannot overwrite its new owner', async function () {
    this.timeout(8000);
    const target = path.join(tempDir, 'protected.txt');
    const journalRoot = path.join(tempDir, '.cdt-journal');
    const leasePath = path.join(journalRoot, '.root-lease.json');
    const replacementLease = JSON.stringify({
      leaseId: 'heartbeat-replacement-owner',
      pid: process.pid,
      createdAt: Date.now(),
      heartbeatAt: Date.now(),
      operationId: 'replacement-operation',
    });
    await fs.promises.writeFile(target, 'original', 'utf8');

    const writeDescriptor = Object.getOwnPropertyDescriptor(fs.promises, 'writeFile');
    const readDescriptor = Object.getOwnPropertyDescriptor(fs.promises, 'readFile');
    if (!writeDescriptor || typeof writeDescriptor.value !== 'function'
      || !readDescriptor || typeof readDescriptor.value !== 'function') {
      throw new Error('fs.promises read/write methods must be configurable data properties for this test.');
    }
    const originalWriteFile = writeDescriptor.value as typeof fs.promises.writeFile;
    const originalReadFile = readDescriptor.value as typeof fs.promises.readFile;
    let markJournalWriteEntered!: () => void;
    let releaseJournalWrite!: () => void;
    const journalWriteEntered = new Promise<void>((resolve) => { markJournalWriteEntered = resolve; });
    const journalWriteGate = new Promise<void>((resolve) => { releaseJournalWrite = resolve; });
    let holdFirstJournalWrite = true;
    let replaceAfterHeartbeatRead = false;
    let replacementInstalled = false;
    Object.defineProperty(fs.promises, 'writeFile', {
      ...writeDescriptor,
      value: async (...args: unknown[]) => {
        const fileName = path.basename(String(args[0]));
        if (holdFirstJournalWrite && fileName.startsWith('.journal-') && fileName.endsWith('.tmp')) {
          holdFirstJournalWrite = false;
          markJournalWriteEntered();
          await journalWriteGate;
        }
        return (originalWriteFile as (...writeArgs: unknown[]) => Promise<unknown>).apply(fs.promises, args);
      },
    });
    Object.defineProperty(fs.promises, 'readFile', {
      ...readDescriptor,
      value: async (...args: unknown[]) => {
        const result = await (originalReadFile as (...readArgs: unknown[]) => Promise<unknown>).apply(fs.promises, args);
        if (replaceAfterHeartbeatRead && !replacementInstalled
          && path.resolve(String(args[0])) === path.resolve(leasePath)) {
          replacementInstalled = true;
          await (originalWriteFile as (...writeArgs: unknown[]) => Promise<unknown>).apply(fs.promises, [
            leasePath,
            replacementLease,
            'utf8',
          ]);
        }
        return result;
      },
    });

    let execution: Promise<string> | undefined;
    try {
      const executor = new MutationPlanExecutor(tempDir);
      execution = executor.execute({
        kind: 'test.heartbeatReplacement',
        steps: [{
          type: 'writeFile', targetPath: target, content: 'mutated', encoding: 'utf8',
          expected: { state: 'file', hash: hashContent('original') },
        }],
        result: 'success',
      });
      await journalWriteEntered;
      replaceAfterHeartbeatRead = true;
      await new Promise<void>((resolve) => setTimeout(resolve, 2200));
      assert.strictEqual(replacementInstalled, true, 'the heartbeat ownership read must be raced');
      assert.strictEqual(await fs.promises.readFile(leasePath, 'utf8'), replacementLease);
    } finally {
      releaseJournalWrite();
      Object.defineProperty(fs.promises, 'readFile', readDescriptor);
      Object.defineProperty(fs.promises, 'writeFile', writeDescriptor);
      await execution?.catch(() => undefined);
    }

    assert.strictEqual(await fs.promises.readFile(target, 'utf8'), 'original');
    assert.strictEqual(await fs.promises.readFile(leasePath, 'utf8'), replacementLease);
  });

  test('#215: execute rejects and preserves external target when .cdt-journal is a symlink or junction', async () => {
    const victimDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'victim-target-'));
    try {
      const victimSub = path.join(victimDir, 'victim-sub');
      const victimSecret = path.join(victimSub, 'secret.txt');
      await fs.promises.mkdir(victimSub, { recursive: true });
      await fs.promises.writeFile(victimSecret, 'victim-payload', 'utf8');

      const journalLink = path.join(tempDir, '.cdt-journal');
      await createDirectorySymlink(victimDir, journalLink);

      const targetFile = path.join(tempDir, 'file.txt');
      await fs.promises.writeFile(targetFile, 'original', 'utf8');

      const executor = new MutationPlanExecutor(tempDir);
      await assert.rejects(
        executor.execute({
          kind: 'test.symlinkEscape',
          steps: [{
            type: 'writeFile',
            targetPath: targetFile,
            content: 'mutated',
            encoding: 'utf8',
            expected: { state: 'file', hash: hashContent('original') },
          }],
          result: 'done',
        }),
        (err: Error) => err instanceof PathBoundaryError || (err instanceof MutationPlanError && err.code === 'PLAN_CONFLICT'),
      );

      assert.strictEqual(fs.existsSync(victimSub), true, 'victim subdirectory must not be deleted');
      assert.strictEqual(await fs.promises.readFile(victimSecret, 'utf8'), 'victim-payload');
      assert.strictEqual(fs.existsSync(path.join(victimDir, '.root-lease.json')), false, 'lease file must not be written to external victim');
    } finally {
      await fs.promises.rm(victimDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
    }
  });

  test('#215: recover rejects and preserves external target when .cdt-journal is a symlink or junction', async () => {
    const victimDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'victim-target-'));
    try {
      const victimSub = path.join(victimDir, 'victim-sub');
      const victimSecret = path.join(victimSub, 'secret.txt');
      await fs.promises.mkdir(victimSub, { recursive: true });
      await fs.promises.writeFile(victimSecret, 'victim-payload', 'utf8');

      const journalLink = path.join(tempDir, '.cdt-journal');
      await createDirectorySymlink(victimDir, journalLink);

      const executor = new MutationPlanExecutor(tempDir);
      await assert.rejects(
        executor.recover(),
        (err: Error) => err instanceof PathBoundaryError || (err instanceof MutationPlanError && (err.code === 'PLAN_CONFLICT' || err.code === 'RECOVERY_REQUIRED')),
      );

      assert.strictEqual(fs.existsSync(victimSub), true, 'victim subdirectory must not be deleted by recovery');
      assert.strictEqual(await fs.promises.readFile(victimSecret, 'utf8'), 'victim-payload');
      assert.strictEqual(fs.existsSync(path.join(victimDir, '.root-lease.json')), false, 'lease file must not be written to external victim');
    } finally {
      await fs.promises.rm(victimDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
    }
  });

  test('#215: recover rejects and preserves external target when an operation directory inside .cdt-journal is a symlink or junction', async () => {
    const victimDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'victim-op-'));
    try {
      const victimSecret = path.join(victimDir, 'external-data.txt');
      await fs.promises.writeFile(victimSecret, 'important', 'utf8');

      const journalRoot = path.join(tempDir, '.cdt-journal');
      await fs.promises.mkdir(journalRoot, { recursive: true });

      const symlinkOp = path.join(journalRoot, 'symlink-operation');
      await createDirectorySymlink(victimDir, symlinkOp);

      const executor = new MutationPlanExecutor(tempDir);
      await assert.rejects(
        executor.recover(),
        (err: Error) => err instanceof PathBoundaryError || (err instanceof MutationPlanError && (err.code === 'PLAN_CONFLICT' || err.code === 'RECOVERY_REQUIRED')),
      );

      assert.strictEqual(fs.existsSync(victimSecret), true, 'external target file must not be deleted');
      assert.strictEqual(await fs.promises.readFile(victimSecret, 'utf8'), 'important');
    } finally {
      await fs.promises.rm(victimDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
    }
  });

  test('#215: recover fails closed and preserves unrecognized non-CDT directory in .cdt-journal', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    await fs.promises.mkdir(journalRoot, { recursive: true });

    const unrecognizedDir = path.join(journalRoot, 'unrecognized-user-folder');
    const secretFile = path.join(unrecognizedDir, 'user-file.txt');
    await fs.promises.mkdir(unrecognizedDir, { recursive: true });
    await fs.promises.writeFile(secretFile, 'preserve-me', 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      executor.recover(),
      (err: Error) => err instanceof MutationPlanError && (err.code === 'RECOVERY_REQUIRED' || err.code === 'PLAN_CONFLICT'),
    );

    assert.strictEqual(fs.existsSync(secretFile), true, 'unrecognized directory must NOT be blindly deleted');
    assert.strictEqual(await fs.promises.readFile(secretFile, 'utf8'), 'preserve-me');
  });

  test('#215: execute rejects and preserves target when .cdt-journal is an internal symlink pointing within root', async () => {
    const internalVictim = path.join(tempDir, 'internal-subfolder');
    const secretFile = path.join(internalVictim, 'user-code.bsl');
    await fs.promises.mkdir(internalVictim, { recursive: true });
    await fs.promises.writeFile(secretFile, 'sensitive-bsl-code', 'utf8');

    const journalLink = path.join(tempDir, '.cdt-journal');
    await createDirectorySymlink(internalVictim, journalLink);

    const targetFile = path.join(tempDir, 'file.txt');
    await fs.promises.writeFile(targetFile, 'original', 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      executor.execute({
        kind: 'test.internalSymlinkEscape',
        steps: [{
          type: 'writeFile',
          targetPath: targetFile,
          content: 'mutated',
          encoding: 'utf8',
          expected: { state: 'file', hash: hashContent('original') },
        }],
        result: 'done',
      }),
      (err: Error) => err instanceof PathBoundaryError || (err instanceof MutationPlanError && err.code === 'PLAN_CONFLICT'),
    );

    assert.strictEqual(fs.existsSync(secretFile), true, 'internal folder pointed to by symlink must not be deleted or corrupted');
    assert.strictEqual(await fs.promises.readFile(secretFile, 'utf8'), 'sensitive-bsl-code');
    assert.strictEqual(fs.existsSync(path.join(internalVictim, '.root-lease.json')), false, 'lease file must not be written to redirected target');
  });

  test('#215: assertJournalNamespace directly validates canonical paths and rejects non-directory file', async () => {
    const { canonicalRoot, canonicalJournalRoot } = await assertJournalNamespace(tempDir);
    assert.strictEqual(path.basename(canonicalJournalRoot), '.cdt-journal');
    assert.ok(canonicalJournalRoot.startsWith(canonicalRoot));

    const fileJournal = path.join(tempDir, '.cdt-journal');
    await fs.promises.writeFile(fileJournal, 'not-a-directory', 'utf8');
    await assert.rejects(
      assertJournalNamespace(tempDir),
      (err: PathBoundaryError) => err.code === 'PATH_OUTSIDE_ROOT',
    );
  });

  test('#215: assertJournalNamespace rejects non-existent workspace root with PATH_UNAVAILABLE', async () => {
    const nonExistent = path.join(tempDir, 'does-not-exist');
    await assert.rejects(
      assertJournalNamespace(nonExistent),
      (err: PathBoundaryError) => err.code === 'PATH_UNAVAILABLE',
    );
  });

  test('#215: assertLexicallyInside and isSamePath edge cases', () => {
    assert.strictEqual(isSamePath(tempDir, tempDir), true);
    assert.strictEqual(isSamePath(tempDir, path.join(tempDir, 'sub')), false);

    assert.doesNotThrow(() => assertLexicallyInside(tempDir, path.join(tempDir, 'sub')));
    assert.throws(
      () => assertLexicallyInside(path.join(tempDir, 'sub'), tempDir),
      (err: PathBoundaryError) => err.code === 'PATH_OUTSIDE_ROOT',
    );
  });

  test('shared missing-suffix canonicalizer normalizes relative targets from the nearest existing ancestor', async () => {
    const canonicalRoot = await fs.promises.realpath(tempDir);
    const relativeSuffix = path.join('missing', 'nested', 'target.xml');
    const expectedPath = path.join(canonicalRoot, relativeSuffix);

    assert.strictEqual(
      await canonicalizePathWithMissingSuffix(path.join(tempDir, relativeSuffix)),
      expectedPath,
    );
    assert.strictEqual(
      await canonicalizePathWithMissingSuffix(path.relative(process.cwd(), path.join(tempDir, relativeSuffix))),
      expectedPath,
    );
  });

  test('#215: recover skips .journal-*.tmp and non-directory files without error', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    await fs.promises.mkdir(journalRoot, { recursive: true });
    await fs.promises.writeFile(path.join(journalRoot, '.journal-skip-test.tmp'), 'temp-data', 'utf8');
    await fs.promises.writeFile(path.join(journalRoot, 'skip-file.txt'), 'file-data', 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    await executor.recover();
    assert.strictEqual(fs.existsSync(path.join(journalRoot, 'skip-file.txt')), true);
  });

  test('#215: recover rejects unrecognized dot directory in journal with RECOVERY_REQUIRED', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    await fs.promises.mkdir(journalRoot, { recursive: true });
    await fs.promises.mkdir(path.join(journalRoot, '.unrecognized-hidden'), { recursive: true });

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      executor.recover(),
      (err: MutationPlanError) => err.code === 'RECOVERY_REQUIRED' && err.message.includes('.unrecognized-hidden'),
    );
  });

  test('#215: recover rejects when operation directory escapes journal root via canonical realpath', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    const validOp = path.join(journalRoot, 'valid-op');
    await fs.promises.mkdir(validOp, { recursive: true });
    await fs.promises.writeFile(path.join(validOp, 'owner.json'), JSON.stringify({ pid: 9999999, createdAt: 100 }), 'utf8');
    await fs.promises.writeFile(path.join(validOp, 'journal.json'), JSON.stringify({
      version: 1,
      operationId: 'valid-op',
      plan: { kind: 'test', steps: [], result: null },
      state: 'committed',
      appliedSteps: 0,
      snapshots: [],
    }), 'utf8');

    const origRealpath = fs.promises.realpath;
    (fs.promises as any).realpath = async (p: any, opts: any) => {
      if (path.resolve(String(p)) === path.resolve(validOp)) {
        return path.join(os.tmpdir(), 'escaped-path');
      }
      return origRealpath.call(fs.promises, p, opts);
    };

    try {
      const executor = new MutationPlanExecutor(tempDir);
      await assert.rejects(
        executor.recover(),
        (err: PathBoundaryError) => err.code === 'PATH_OUTSIDE_ROOT',
      );
    } finally {
      (fs.promises as any).realpath = origRealpath;
    }
  });

  test('#215: acquireRootLease rejects when journalRoot realpath escapes canonical root', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    await fs.promises.mkdir(journalRoot, { recursive: true });

    const origRealpath = fs.promises.realpath;
    (fs.promises as any).realpath = async (p: any, opts: any) => {
      if (path.basename(String(p)) === '.cdt-journal') {
        return path.join(os.tmpdir(), 'foreign-journal');
      }
      return origRealpath.call(fs.promises, p, opts);
    };

    try {
      const executor = new MutationPlanExecutor(tempDir);
      await assert.rejects(
        executor.recover(),
        (err: PathBoundaryError) => err.code === 'PATH_OUTSIDE_ROOT',
      );
    } finally {
      (fs.promises as any).realpath = origRealpath;
    }
  });

  test('#215: removeOperationDir rejects symlink and escaped path with PATH_OUTSIDE_ROOT', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    await fs.promises.mkdir(journalRoot, { recursive: true });

    const symlinkTarget = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rm-victim-'));
    try {
      const symlinkPath = path.join(journalRoot, 'symlink-dir');
      await createDirectorySymlink(symlinkTarget, symlinkPath);

      const executor = new MutationPlanExecutor(tempDir);
      await assert.rejects(
        (executor as any).removeOperationDir(symlinkPath),
        (err: PathBoundaryError) => err.code === 'PATH_OUTSIDE_ROOT',
      );

      const escapedPath = path.join(journalRoot, 'escaped-dir');
      await fs.promises.mkdir(escapedPath, { recursive: true });
      const origRealpath = fs.promises.realpath;
      (fs.promises as any).realpath = async (p: any, opts: any) => {
        if (path.resolve(String(p)) === path.resolve(escapedPath)) {
          return path.join(os.tmpdir(), 'other-place');
        }
        return origRealpath.call(fs.promises, p, opts);
      };
      try {
        await assert.rejects(
          (executor as any).removeOperationDir(escapedPath),
          (err: PathBoundaryError) => err.code === 'PATH_OUTSIDE_ROOT',
        );
      } finally {
        (fs.promises as any).realpath = origRealpath;
      }
    } finally {
      await fs.promises.rm(symlinkTarget, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test('#215: recover fails with RECOVERY_REQUIRED if reading operation directory throws unexpected error', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    const unreadableOp = path.join(journalRoot, 'unreadable-op');
    await fs.promises.mkdir(unreadableOp, { recursive: true });

    const origReaddir = fs.promises.readdir;
    (fs.promises as any).readdir = async (p: any, opts: any) => {
      if (path.resolve(String(p)) === path.resolve(unreadableOp)) {
        throw new Error('EACCES: permission denied');
      }
      return origReaddir.call(fs.promises, p, opts);
    };

    try {
      const executor = new MutationPlanExecutor(tempDir);
      await assert.rejects(
        executor.recover(),
        (err: MutationPlanError) => err.code === 'RECOVERY_REQUIRED' && err.message.includes('Cannot read operation directory'),
      );
    } finally {
      (fs.promises as any).readdir = origReaddir;
    }
  });

  test('#215 (Codex P1): recover fails closed and preserves alien directory data/backups/user-file without deleting it', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    const dataDir = path.join(journalRoot, 'data');
    const backupsDir = path.join(dataDir, 'backups');
    const userFilePath = path.join(backupsDir, 'user-file');
    await fs.promises.mkdir(backupsDir, { recursive: true });
    await fs.promises.writeFile(userFilePath, 'important user data', 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      executor.recover(),
      (err: MutationPlanError) => err.code === 'RECOVERY_REQUIRED',
    );

    // Critical: user file and data dir must remain intact, NOT deleted as orphan!
    assert.strictEqual(fs.existsSync(userFilePath), true);
    assert.strictEqual(await fs.promises.readFile(userFilePath, 'utf8'), 'important user data');
  });

  test('#215 (Codex P1): recover fails closed and preserves unowned directory data without CDT markers', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    const dataDir = path.join(journalRoot, 'data');
    await fs.promises.mkdir(dataDir, { recursive: true });

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      executor.recover(),
      (err: MutationPlanError) => err.code === 'RECOVERY_REQUIRED',
    );

    // Critical: unowned directory without any CDT markers must NOT be deleted as orphan!
    assert.strictEqual(fs.existsSync(dataDir), true);
  });

  test('#215 (Codex P1): recover successfully restores interrupted deletePath of nested directory from backups/0 directory', async () => {
    const targetDir = path.join(tempDir, 'nested-dir');
    await fs.promises.mkdir(targetDir, { recursive: true });
    const targetFile = path.join(targetDir, 'subfile.txt');
    await fs.promises.writeFile(targetFile, 'original-content', 'utf8');

    const interruptedOp = path.join(tempDir, '.cdt-journal', 'interrupted-delete-dir');
    await fs.promises.mkdir(path.join(interruptedOp, 'backups', '0'), { recursive: true });
    await fs.promises.writeFile(path.join(interruptedOp, 'backups', '0', 'subfile.txt'), 'original-content', 'utf8');
    await fs.promises.writeFile(path.join(interruptedOp, 'owner.json'), JSON.stringify({ pid: 999999, createdAt: Date.now() - 10000 }), 'utf8');
    await fs.promises.writeFile(path.join(interruptedOp, 'journal.json'), JSON.stringify({
      version: 1,
      operationId: 'interrupted-delete-dir',
      plan: {
        kind: 'test.deleteDir',
        steps: [{
          type: 'deletePath',
          targetPath: targetDir,
          expected: { state: 'directory' },
        }],
        result: null,
      },
      state: 'applying',
      appliedSteps: 1,
      snapshots: [{
        targetPath: targetDir,
        state: 'directory',
        backupName: '0',
        contentsBackedUp: true,
      }],
    }), 'utf8');

    // Simulate deletePath step effect
    await fs.promises.rm(targetDir, { recursive: true, force: true });
    assert.strictEqual(fs.existsSync(targetDir), false);

    const executor = new MutationPlanExecutor(tempDir);
    await executor.recover();

    assert.strictEqual(fs.existsSync(targetDir), true);
    assert.strictEqual(await fs.promises.readFile(targetFile, 'utf8'), 'original-content');
    assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), false);
  });

  test('#215 (Codex P1): recover rejects with RECOVERY_REQUIRED if directory backup contains a symlink', async () => {
    const targetDir = path.join(tempDir, 'symlink-backup-target');
    const interruptedOp = path.join(tempDir, '.cdt-journal', 'symlink-backup-op');
    const backupDir = path.join(interruptedOp, 'backups', '0');
    await fs.promises.mkdir(backupDir, { recursive: true });

    const symlinkTarget = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'symlink-backup-victim-'));
    try {
      await createDirectorySymlink(symlinkTarget, path.join(backupDir, 'nested-symlink'));
      await fs.promises.writeFile(path.join(interruptedOp, 'owner.json'), JSON.stringify({ pid: 999999, createdAt: Date.now() - 10000 }), 'utf8');
      await fs.promises.writeFile(path.join(interruptedOp, 'journal.json'), JSON.stringify({
        version: 1,
        operationId: 'symlink-backup-op',
        plan: { kind: 'test.symlinkBackup', steps: [], result: null },
        state: 'applying',
        appliedSteps: 1,
        snapshots: [{
          targetPath: targetDir,
          state: 'directory',
          backupName: '0',
          contentsBackedUp: true,
        }],
      }), 'utf8');

      const executor = new MutationPlanExecutor(tempDir);
      await assert.rejects(
        executor.recover(),
        (err: MutationPlanError) => err.code === 'RECOVERY_REQUIRED',
      );
    } finally {
      await fs.promises.rm(symlinkTarget, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test('#216: recover() fails closed and preserves external post-crash edit (A1 -> A2) instead of rolling back to A0', async () => {
    const targetA = path.join(tempDir, 'fileA.xml');
    await fs.promises.writeFile(targetA, 'A2-external-edit', 'utf8');

    const interruptedOp = path.join(tempDir, '.cdt-journal', 'interrupted-diverged-op');
    await fs.promises.mkdir(path.join(interruptedOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(interruptedOp, 'backups', '0'), 'A0-original', 'utf8');
    await fs.promises.writeFile(path.join(interruptedOp, 'owner.json'), JSON.stringify({ pid: 999999, createdAt: Date.now() - 10000 }), 'utf8');
    await fs.promises.writeFile(path.join(interruptedOp, 'journal.json'), JSON.stringify({
      version: 1,
      operationId: 'interrupted-diverged-op',
      plan: {
        kind: 'test.diverged',
        steps: [{
          type: 'writeFile',
          targetPath: targetA,
          content: 'A1-step-result',
          encoding: 'utf8',
          expected: { state: 'file', hash: hashContent('A0-original') },
        }],
        result: null,
      },
      state: 'applying',
      appliedSteps: 1,
      snapshots: [{
        targetPath: targetA,
        state: 'file',
        hash: hashContent('A0-original'),
        backupName: '0',
        contentsBackedUp: true,
      }],
    }), 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      executor.recover(),
      (err: MutationPlanError) => err.code === 'RECOVERY_REQUIRED' && err.message.includes('Post-state diverged'),
    );

    // Critical invariant: external edit A2 MUST NOT be overwritten with A0!
    assert.strictEqual(await fs.promises.readFile(targetA, 'utf8'), 'A2-external-edit');
    // Journal and backups must be preserved for manual inspection
    assert.strictEqual(fs.existsSync(interruptedOp), true);
  });

  test('#216: recover() rolls back normally when targetA is untouched post-crash (still A1)', async () => {
    const targetA = path.join(tempDir, 'fileA-clean.xml');
    await fs.promises.writeFile(targetA, 'A1-step-result', 'utf8');

    const interruptedOp = path.join(tempDir, '.cdt-journal', 'interrupted-clean-op');
    await fs.promises.mkdir(path.join(interruptedOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(interruptedOp, 'backups', '0'), 'A0-original', 'utf8');
    await fs.promises.writeFile(path.join(interruptedOp, 'owner.json'), JSON.stringify({ pid: 999999, createdAt: Date.now() - 10000 }), 'utf8');
    await fs.promises.writeFile(path.join(interruptedOp, 'journal.json'), JSON.stringify({
      version: 1,
      operationId: 'interrupted-clean-op',
      plan: {
        kind: 'test.clean',
        steps: [{
          type: 'writeFile',
          targetPath: targetA,
          content: 'A1-step-result',
          encoding: 'utf8',
          expected: { state: 'file', hash: hashContent('A0-original') },
        }],
        result: null,
      },
      state: 'applying',
      appliedSteps: 1,
      snapshots: [{
        targetPath: targetA,
        state: 'file',
        hash: hashContent('A0-original'),
        backupName: '0',
        contentsBackedUp: true,
      }],
    }), 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    await executor.recover();

    // Successfully rolled back to A0
    assert.strictEqual(await fs.promises.readFile(targetA, 'utf8'), 'A0-original');
    assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), false);
  });

  test('#216: recover() fails closed when external process creates file on a missing snapshot path', async () => {
    const foreignFile = path.join(tempDir, 'foreign-new-file.xml');
    await fs.promises.writeFile(foreignFile, 'user-created-this', 'utf8');

    const interruptedOp = path.join(tempDir, '.cdt-journal', 'interrupted-missing-op');
    await fs.promises.mkdir(path.join(interruptedOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(interruptedOp, 'owner.json'), JSON.stringify({ pid: 999999, createdAt: Date.now() - 10000 }), 'utf8');
    await fs.promises.writeFile(path.join(interruptedOp, 'journal.json'), JSON.stringify({
      version: 1,
      operationId: 'interrupted-missing-op',
      plan: {
        kind: 'test.missing',
        steps: [{
          type: 'writeFile',
          targetPath: foreignFile,
          content: 'planned-content',
          encoding: 'utf8',
          expected: { state: 'missing' },
        }],
        result: null,
      },
      state: 'prepared',
      appliedSteps: 0,
      snapshots: [{
        targetPath: foreignFile,
        state: 'missing',
        contentsBackedUp: false,
      }],
    }), 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      executor.recover(),
      (err: MutationPlanError) => err.code === 'RECOVERY_REQUIRED' && err.message.includes('Post-state diverged'),
    );

    // Critical invariant: foreign file must NOT be deleted as missing!
    assert.strictEqual(fs.existsSync(foreignFile), true);
    assert.strictEqual(await fs.promises.readFile(foreignFile, 'utf8'), 'user-created-this');
  });

  test('#216: recover() fails closed when external process re-creates deleted path post-crash', async () => {
    const deletedPath = path.join(tempDir, 'recreated-file.xml');
    await fs.promises.writeFile(deletedPath, 'recreated-by-external-actor', 'utf8');

    const interruptedOp = path.join(tempDir, '.cdt-journal', 'interrupted-delete-op');
    await fs.promises.mkdir(path.join(interruptedOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(interruptedOp, 'backups', '0'), 'initial-deleted-content', 'utf8');
    await fs.promises.writeFile(path.join(interruptedOp, 'owner.json'), JSON.stringify({ pid: 999999, createdAt: Date.now() - 10000 }), 'utf8');
    await fs.promises.writeFile(path.join(interruptedOp, 'journal.json'), JSON.stringify({
      version: 1,
      operationId: 'interrupted-delete-op',
      plan: {
        kind: 'test.delete',
        steps: [{
          type: 'deletePath',
          targetPath: deletedPath,
          expected: { state: 'file', hash: hashContent('initial-deleted-content') },
        }],
        result: null,
      },
      state: 'applying',
      appliedSteps: 1,
      snapshots: [{
        targetPath: deletedPath,
        state: 'file',
        hash: hashContent('initial-deleted-content'),
        backupName: '0',
        contentsBackedUp: true,
      }],
    }), 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      executor.recover(),
      (err: MutationPlanError) => err.code === 'RECOVERY_REQUIRED' && err.message.includes('Post-state diverged'),
    );

    // File must NOT be overwritten!
    assert.strictEqual(await fs.promises.readFile(deletedPath, 'utf8'), 'recreated-by-external-actor');
  });

  test('#216: recover() fails closed when move destination was edited post-crash', async () => {
    const sourcePath = path.join(tempDir, 'move-src.xml');
    const destPath = path.join(tempDir, 'move-dst.xml');
    await fs.promises.writeFile(destPath, 'dest-modified-by-user', 'utf8');

    const interruptedOp = path.join(tempDir, '.cdt-journal', 'interrupted-move-op');
    await fs.promises.mkdir(path.join(interruptedOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(interruptedOp, 'backups', '0'), 'original-source-content', 'utf8');
    await fs.promises.writeFile(path.join(interruptedOp, 'owner.json'), JSON.stringify({ pid: 999999, createdAt: Date.now() - 10000 }), 'utf8');
    await fs.promises.writeFile(path.join(interruptedOp, 'journal.json'), JSON.stringify({
      version: 1,
      operationId: 'interrupted-move-op',
      plan: {
        kind: 'test.move',
        steps: [{
          type: 'movePath',
          sourcePath,
          targetPath: destPath,
          expectedSource: { state: 'file', hash: hashContent('original-source-content') },
          expectedTarget: { state: 'missing' },
        }],
        result: null,
      },
      state: 'applying',
      appliedSteps: 1,
      snapshots: [
        {
          targetPath: sourcePath,
          state: 'file',
          hash: hashContent('original-source-content'),
          backupName: '0',
          contentsBackedUp: true,
        },
        {
          targetPath: destPath,
          state: 'missing',
          contentsBackedUp: false,
        },
      ],
    }), 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      executor.recover(),
      (err: MutationPlanError) => err.code === 'RECOVERY_REQUIRED' && err.message.includes('Post-state diverged'),
    );

    // Modified destination must NOT be overwritten or deleted!
    assert.strictEqual(await fs.promises.readFile(destPath, 'utf8'), 'dest-modified-by-user');
    assert.strictEqual(fs.existsSync(interruptedOp), true);
  });

  test('#216 (PR #225 review comment 1): recover() fails closed and preserves external changes inside moved directory post-crash', async () => {
    const sourceDir = path.join(tempDir, 'dir-src');
    const destDir = path.join(tempDir, 'dir-dst');

    // State on disk: destDir exists with moved file, plus an external user-added file!
    await fs.promises.mkdir(destDir, { recursive: true });
    await fs.promises.writeFile(path.join(destDir, 'item.txt'), 'item-content', 'utf8');
    await fs.promises.writeFile(path.join(destDir, 'user-added.txt'), 'user-added-file', 'utf8');

    const interruptedOp = path.join(tempDir, '.cdt-journal', 'interrupted-dir-move-op');
    const backupDir = path.join(interruptedOp, 'backups', '0');
    await fs.promises.mkdir(backupDir, { recursive: true });
    await fs.promises.writeFile(path.join(backupDir, 'item.txt'), 'item-content', 'utf8');
    const sourceFingerprint = await calculateDirectoryFingerprint(backupDir);

    await fs.promises.writeFile(path.join(interruptedOp, 'owner.json'), JSON.stringify({ pid: 999999, createdAt: Date.now() - 10000 }), 'utf8');
    await fs.promises.writeFile(path.join(interruptedOp, 'journal.json'), JSON.stringify({
      version: 1,
      operationId: 'interrupted-dir-move-op',
      plan: {
        kind: 'test.moveDir',
        steps: [{
          type: 'movePath',
          sourcePath: sourceDir,
          targetPath: destDir,
          expectedSource: { state: 'directory', fingerprint: sourceFingerprint },
          expectedTarget: { state: 'missing' },
        }],
        result: null,
      },
      state: 'applying',
      appliedSteps: 1,
      snapshots: [
        {
          targetPath: sourceDir,
          state: 'directory',
          fingerprint: sourceFingerprint,
          backupName: '0',
          contentsBackedUp: true,
        },
        {
          targetPath: destDir,
          state: 'missing',
          contentsBackedUp: false,
        },
      ],
    }), 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      executor.recover(),
      (err: MutationPlanError) => err.code === 'RECOVERY_REQUIRED' && err.message.includes('Post-state diverged'),
    );

    // External file inside moved directory must NOT be deleted!
    assert.strictEqual(fs.existsSync(path.join(destDir, 'user-added.txt')), true);
    assert.strictEqual(await fs.promises.readFile(path.join(destDir, 'user-added.txt'), 'utf8'), 'user-added-file');
    assert.strictEqual(fs.existsSync(interruptedOp), true);

    // Now test untouched moved directory: remove external file so destDir matches pre-crash fingerprint exactly
    await fs.promises.rm(path.join(destDir, 'user-added.txt'));
    await executor.recover();
    assert.strictEqual(fs.existsSync(destDir), false, 'destDir must be cleaned up on successful rollback');
    assert.strictEqual(fs.existsSync(path.join(sourceDir, 'item.txt')), true, 'sourceDir must be restored from backup');
    assert.strictEqual(fs.existsSync(interruptedOp), false, 'interrupted operation directory must be removed');
  });

  test('#216 (PR #225 review comment 3): recover() rolls back when crash occurred after step applied but before journal write (appliedSteps=0)', async () => {
    const filePath = path.join(tempDir, 'file-unrecorded-step.xml');
    // Step 0 was writeFile, and it completed on disk before crash!
    await fs.promises.writeFile(filePath, 'step-0-applied-content', 'utf8');

    const interruptedOp = path.join(tempDir, '.cdt-journal', 'interrupted-unrecorded-step-op');
    await fs.promises.mkdir(path.join(interruptedOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(interruptedOp, 'owner.json'), JSON.stringify({ pid: 999999, createdAt: Date.now() - 10000 }), 'utf8');
    await fs.promises.writeFile(path.join(interruptedOp, 'journal.json'), JSON.stringify({
      version: 1,
      operationId: 'interrupted-unrecorded-step-op',
      plan: {
        kind: 'test.writeFile',
        steps: [{
          type: 'writeFile',
          targetPath: filePath,
          content: 'step-0-applied-content',
          encoding: 'utf8',
          expected: { state: 'missing' },
        }],
        result: null,
      },
      state: 'applying',
      appliedSteps: 0, // crash window: step applied on disk, but journal still has 0!
      snapshots: [
        {
          targetPath: filePath,
          state: 'missing',
          contentsBackedUp: false,
        },
      ],
    }), 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    // Must recognize valid post-state of step 0 and rollback cleanly instead of throwing RECOVERY_REQUIRED!
    await executor.recover();

    assert.strictEqual(fs.existsSync(filePath), false, 'filePath must be rolled back to pre-state (missing)');
    assert.strictEqual(fs.existsSync(interruptedOp), false, 'operation directory must be removed after successful recovery');
  });

  test('#216 (PR #225 review comment 3): recover() fails closed when crash occurred with appliedSteps=0 and file is in third state', async () => {
    const filePath = path.join(tempDir, 'file-third-state.xml');
    // On disk: file has unexpected third-state content (neither pre-state missing nor step-0 content)
    await fs.promises.writeFile(filePath, 'unexpected-third-state-content', 'utf8');

    const interruptedOp = path.join(tempDir, '.cdt-journal', 'interrupted-third-state-op');
    await fs.promises.mkdir(path.join(interruptedOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(interruptedOp, 'owner.json'), JSON.stringify({ pid: 999999, createdAt: Date.now() - 10000 }), 'utf8');
    await fs.promises.writeFile(path.join(interruptedOp, 'journal.json'), JSON.stringify({
      version: 1,
      operationId: 'interrupted-third-state-op',
      plan: {
        kind: 'test.writeFile',
        steps: [{
          type: 'writeFile',
          targetPath: filePath,
          content: 'step-0-applied-content',
          encoding: 'utf8',
          expected: { state: 'missing' },
        }],
        result: null,
      },
      state: 'applying',
      appliedSteps: 0,
      snapshots: [
        {
          targetPath: filePath,
          state: 'missing',
          contentsBackedUp: false,
        },
      ],
    }), 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    // Must fail closed on third state!
    await assert.rejects(
      executor.recover(),
      (err: MutationPlanError) => err.code === 'RECOVERY_REQUIRED' && err.message.includes('Post-state diverged'),
    );

    assert.strictEqual(await fs.promises.readFile(filePath, 'utf8'), 'unexpected-third-state-content');
    assert.strictEqual(fs.existsSync(interruptedOp), true);
  });

  test('newly created directory rejects recovery and preserves post-crash added file (#216, PR #225 review comment 4229555124)', async () => {
    const journalRoot = path.join(tempDir, '.cdt-journal');
    const interruptedOp = path.join(journalRoot, 'interrupted-newdir-op');
    const newDirPath = path.join(tempDir, 'newFolder');

    await fs.promises.mkdir(newDirPath, { recursive: true });
    // Post-crash: user or external process adds a file to the newly created directory
    const addedFilePath = path.join(newDirPath, 'user-added-post-crash.txt');
    await fs.promises.writeFile(addedFilePath, 'important user data', 'utf8');

    await fs.promises.mkdir(path.join(interruptedOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(interruptedOp, 'owner.json'), JSON.stringify({ pid: 999999, createdAt: Date.now() - 10000 }), 'utf8');
    await fs.promises.writeFile(path.join(interruptedOp, 'journal.json'), JSON.stringify({
      version: 1,
      operationId: 'interrupted-newdir-op',
      plan: {
        kind: 'test.ensureDirectory',
        steps: [
          {
            type: 'ensureDirectory',
            targetPath: newDirPath,
          },
          {
            type: 'writeFile',
            targetPath: path.join(newDirPath, 'step-1-file.txt'),
            content: 'step 1 content',
            encoding: 'utf8',
            expected: { state: 'missing' },
          },
        ],
        result: null,
      },
      state: 'applying',
      appliedSteps: 1,
      snapshots: [
        {
          targetPath: newDirPath,
          state: 'missing',
          contentsBackedUp: false,
        },
      ],
    }), 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      executor.recover(),
      (err: MutationPlanError) => err.code === 'RECOVERY_REQUIRED',
    );

    // The user's file and directory must NOT be deleted!
    assert.strictEqual(fs.existsSync(addedFilePath), true, 'Post-crash added file must be preserved');
    assert.strictEqual(await fs.promises.readFile(addedFilePath, 'utf8'), 'important user data');
    assert.strictEqual(fs.existsSync(newDirPath), true, 'Directory must be preserved');
  });
});
