import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

import { CompareSession } from '../../../src/compareMerge/domain/compareSession';
import { executeBslMergePreview } from '../../../src/compareMerge/merge/mergeExecutor';
import {
  createMergePreview,
  validateMergePreflight,
  type BackupPlan,
  type MergeCandidate,
  type PreflightResult,
  type RollbackPlan,
} from '../../../src/compareMerge/merge/mergePlanner';
import { hashText } from '../../../src/compareMerge/bsl/bslRoutineLogicalScanner';
import { MutationPlanError } from '../../../src/services/configurationSession/mutationPlan';
import type { ConfigurationMutationEngine } from '../../../src/services/configurationSession/ConfigurationMutationEngine';
import type { ConfigurationId } from '../../../src/services/configurationSession/types';
import { createMergeMutationTestRuntime } from './mergeMutationTestSupport';

const fsPromises = require('fs/promises') as any;

suite('Compare merge mutation engine (#264)', () => {
  const tempDirs: string[] = [];
  const coordinators: Array<{ dispose(): Promise<void> }> = [];

  teardown(async () => {
    await Promise.all(coordinators.splice(0).map((coordinator) => coordinator.dispose()));
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
    );
  });

  test('commits XML, binary, and recursive folder replacement through one journaled plan', async () => {
    const fixture = await createMixedFixture(tempDirs);
    const runtime = await runtimeFor(fixture.rootPath, coordinators);

    const receipt = await executeWithRuntime(fixture, runtime);

    assert.strictEqual(receipt.receipt?.status, 'committed', JSON.stringify(receipt));
    assert.strictEqual(receipt.failed.length, 0, JSON.stringify(receipt.failed));
    assert.strictEqual(receipt.applied.length, 3);
    assert.strictEqual(await readText(fixture.xmlTargetPath), fixture.nextXml);
    assert.deepStrictEqual(await fs.readFile(fixture.binaryTargetPath), fixture.incomingBinary);
    assert.strictEqual(await exists(path.join(fixture.folderTargetPath, 'old-only.xml')), false);
    assert.strictEqual(await exists(path.join(fixture.folderTargetPath, 'Legacy')), false);
    assert.strictEqual(await readText(path.join(fixture.folderTargetPath, 'incoming.xml')), '<Incoming/>');
    assert.strictEqual(await exists(path.join(fixture.folderTargetPath, 'Nested', 'Empty')), true);
    assert.deepStrictEqual(
      await fs.readFile(path.join(fixture.folderTargetPath, 'Nested', 'image.bin')),
      fixture.incomingBinary,
    );
    if (path.sep === '/') {
      const literalBackslashName = 'literal\\name.bin';
      const oldLiteralContent = Buffer.from([1, 3, 5, 7]);
      const incomingLiteralContent = Buffer.from([9, 0, 7, 255]);
      assert.deepStrictEqual(
        await fs.readFile(path.join(fixture.folderTargetPath, literalBackslashName)),
        incomingLiteralContent,
      );
      assert.deepStrictEqual(
        await fs.readFile(path.join(fixture.folderBackupPath, literalBackslashName)),
        oldLiteralContent,
      );
      assert.strictEqual(await exists(path.join(fixture.folderBackupPath, 'incoming.xml')), false);
    }
    assert.strictEqual(await readText(fixture.xmlBackupPath), fixture.oldXml);
    assert.deepStrictEqual(await fs.readFile(fixture.binaryBackupPath), fixture.oldBinary);
    assert.strictEqual(await readText(path.join(fixture.folderBackupPath, 'old-only.xml')), '<OldOnly/>');
    assert.strictEqual(await exists(path.join(fixture.folderBackupPath, 'Legacy', 'Empty')), true);
    const expectedBackups = await Promise.all([
      fixture.binaryBackupPath,
      fixture.folderBackupPath,
      fixture.xmlBackupPath,
    ].map((backupPath) => fs.realpath(backupPath)));
    const actualBackups = await Promise.all(receipt.backupPaths.map((backupPath) => fs.realpath(backupPath)));
    assert.deepStrictEqual(actualBackups.sort(), expectedBackups.sort());
  });

  test('preserves a foreign XML edit when a late plan write fails', async () => {
    const fixture = await createMixedFixture(tempDirs);
    const runtime = await runtimeFor(fixture.rootPath, coordinators);
    const foreignXml = '<Object><Name>External edit</Name></Object>';
    const canonicalRoot = await fs.realpath(fixture.rootPath);
    const canonicalBinaryTarget = path.join(canonicalRoot, path.relative(fixture.rootPath, fixture.binaryTargetPath));
    const canonicalXmlTarget = path.join(canonicalRoot, path.relative(fixture.rootPath, fixture.xmlTargetPath));
    const canonicalLateTarget = path.join(
      canonicalRoot,
      path.relative(fixture.rootPath, path.join(fixture.folderTargetPath, 'incoming.xml')),
    );
    const originalRename = fsPromises.rename;
    let externalEditWritten = false;
    let binaryWriteApplied = false;
    let lateFaultInjected = false;

    try {
      fsPromises.rename = async (sourcePath: string, targetPath: string) => {
        if (targetPath === canonicalBinaryTarget && !binaryWriteApplied) {
          await originalRename(sourcePath, targetPath);
          binaryWriteApplied = true;
          await fs.writeFile(canonicalXmlTarget, foreignXml, 'utf8');
          externalEditWritten = true;
          return;
        }
        if (targetPath === canonicalLateTarget && !lateFaultInjected) {
          lateFaultInjected = true;
          throw new Error('injected late plan write failure');
        }
        return originalRename(sourcePath, targetPath);
      };

      const result = await executeWithRuntime(fixture, runtime);

      assert.strictEqual(externalEditWritten, true, 'external edit hook ran after the binary write');
      assert.strictEqual(binaryWriteApplied, true, 'first binary write reached the real rename hook');
      assert.strictEqual(lateFaultInjected, true, 'late plan write hook ran');
      assert.strictEqual(result.receipt?.status, 'recoveryRequired', JSON.stringify(result));
      assert.strictEqual(result.mutationFailure?.effectPossible, true, JSON.stringify(result.mutationFailure));
      assert.strictEqual(await readText(fixture.xmlTargetPath), foreignXml);
      const mutationSession = await runtime.coordinator.resolveResource(canonicalRoot);
      await assert.rejects(
        () => mutationSession.mutations.recover(),
        (error: unknown) => error instanceof MutationPlanError && error.code === 'RECOVERY_REQUIRED',
      );
      assert.strictEqual(await readText(fixture.xmlTargetPath), foreignXml);
    } finally {
      fsPromises.rename = originalRename;
    }
  });

  test('recovers a merge interrupted after a write and its journal step are durable', async () => {
    const fixture = await createTwoFileFixture(tempDirs, { firstOnly: true });
    const runtime = await runtimeFor(fixture.rootPath, coordinators);
    const canonicalRoot = await fs.realpath(fixture.rootPath);
    const canonicalTarget = await fs.realpath(fixture.firstTargetPath);
    const journalRoot = path.join(canonicalRoot, '.cdt-journal');
    const leasePath = path.join(journalRoot, '.root-lease.json');
    const originalRename = fsPromises.rename;
    let targetWriteApplied = false;
    let appliedStepRecorded = false;
    let leaseRemoved = false;

    try {
      fsPromises.rename = async (sourcePath: string, targetPath: string) => {
        const resolvedTarget = path.resolve(String(targetPath));
        if (resolvedTarget === path.resolve(canonicalTarget) && !targetWriteApplied) {
          await originalRename(sourcePath, targetPath);
          targetWriteApplied = true;
          return;
        }

        if (targetWriteApplied && path.basename(resolvedTarget) === 'journal.json') {
          const pendingJournal = JSON.parse(await fs.readFile(String(sourcePath), 'utf8')) as {
            state?: string;
            appliedSteps?: number;
            plan?: { steps?: Array<{ type?: string }> };
          };
          const result = await originalRename(sourcePath, targetPath);
          const lastAppliedStep = pendingJournal.plan?.steps?.[(pendingJournal.appliedSteps ?? 0) - 1];
          if (
            pendingJournal.state === 'applying'
            && lastAppliedStep?.type === 'writeFile'
            && !leaseRemoved
          ) {
            appliedStepRecorded = true;
            await fs.rm(leasePath, { force: true });
            leaseRemoved = true;
          }
          return result;
        }

        return originalRename(sourcePath, targetPath);
      };

      const result = await executeWithRuntime(fixture, runtime);

      assert.strictEqual(targetWriteApplied, true, 'the real shared plan wrote the target');
      assert.strictEqual(appliedStepRecorded, true, 'the real journal recorded the completed write step');
      assert.strictEqual(leaseRemoved, true, 'the interruption removed the root lease');
      assert.strictEqual(result.receipt?.status, 'recoveryRequired', JSON.stringify(result));
      assert.deepStrictEqual(await fs.readFile(fixture.firstTargetPath), fixture.firstIncomingBytes);

      const operationNames = (await fs.readdir(journalRoot)).filter((name) => !name.startsWith('.'));
      assert.strictEqual(operationNames.length, 1, `expected one common journal operation, found ${operationNames.join(', ')}`);
      const operationPath = path.join(journalRoot, operationNames[0]!);
      const journal = JSON.parse(await fs.readFile(path.join(operationPath, 'journal.json'), 'utf8')) as {
        state?: string;
        appliedSteps?: number;
        plan?: { steps?: Array<{ type?: string }> };
      };
      assert.strictEqual(journal.state, 'applying');
      assert.strictEqual(journal.plan?.steps?.[(journal.appliedSteps ?? 0) - 1]?.type, 'writeFile');
      assert.ok((journal.appliedSteps ?? 0) > 0);

      // Model the process death boundary: the durable journal remains, its owner heartbeat is stale,
      // and the standard configuration recovery path replays its recorded snapshot.
      const ownerPath = path.join(operationPath, 'owner.json');
      const owner = JSON.parse(await fs.readFile(ownerPath, 'utf8')) as Record<string, unknown>;
      owner.heartbeatAt = 0;
      await fs.writeFile(ownerPath, JSON.stringify(owner), 'utf8');

      const mutationSession = await runtime.coordinator.resolveResource(canonicalRoot);
      await mutationSession.mutations.recover();

      assert.deepStrictEqual(await fs.readFile(fixture.firstTargetPath), fixture.firstOldBytes);
      await assert.rejects(() => fs.access(operationPath), (error: unknown) =>
        (error as { code?: unknown }).code === 'ENOENT'
      );
    } finally {
      fsPromises.rename = originalRename;
    }
  });

  test('reports already-created backup artifacts when a later backup export fails', async () => {
    const fixture = await createTwoFileFixture(tempDirs);
    const runtime = await runtimeFor(fixture.rootPath, coordinators);
    const canonicalWorkspace = await fs.realpath(path.dirname(fixture.rootPath));
    const canonicalFirstBackup = path.join(canonicalWorkspace, path.relative(path.dirname(fixture.rootPath), fixture.firstBackupPath));
    const canonicalSecondBackup = path.join(canonicalWorkspace, path.relative(path.dirname(fixture.rootPath), fixture.secondBackupPath));
    const originalWriteFile = fsPromises.writeFile;
    let secondArtifactFailureInjected = false;

    try {
      fsPromises.writeFile = async (filePath: string, ...args: any[]) => {
        if (path.resolve(String(filePath)) === path.resolve(canonicalSecondBackup)) {
          secondArtifactFailureInjected = true;
          throw new Error('injected second backup export failure');
        }
        return originalWriteFile(filePath, ...args);
      };

      const result = await executeWithRuntime(fixture, runtime);

      assert.strictEqual(secondArtifactFailureInjected, true, 'second backup write hook ran');
      assert.strictEqual(runtime.planRunnerCalls(), 0, 'configuration plan runner was never entered');
      assert.strictEqual(result.receipt?.status, 'rolledBack');
      assert.deepStrictEqual(result.backupPaths, [canonicalFirstBackup]);
      assert.deepStrictEqual(await fs.readFile(fixture.firstBackupPath), fixture.firstOldBytes);
      assert.strictEqual(await exists(fixture.secondBackupPath), false);
      assert.deepStrictEqual(await fs.readFile(fixture.firstTargetPath), fixture.firstOldBytes);
      assert.deepStrictEqual(await fs.readFile(fixture.secondTargetPath), fixture.oldBinary);
      assert.strictEqual(await exists(path.join(fixture.rootPath, '.cdt-journal')), false);
    } finally {
      fsPromises.writeFile = originalWriteFile;
    }
  });

  test('rechecks backup path segments after exclusive directory creation before writing', async () => {
    const fixture = await createMixedFixture(tempDirs);
    const runtime = await runtimeFor(fixture.rootPath, coordinators);
    const canonicalWorkspace = await fs.realpath(path.dirname(fixture.rootPath));
    const canonicalBackupRoot = path.join(canonicalWorkspace, path.relative(path.dirname(fixture.rootPath), fixture.backupRootPath));
    const originalMkdir = fsPromises.mkdir;
    let junctionSwapped = false;

    try {
      fsPromises.mkdir = async (directoryPath: string, ...args: any[]) => {
        const result = await originalMkdir(directoryPath, ...args);
        if (path.resolve(String(directoryPath)) === path.resolve(canonicalBackupRoot) && !junctionSwapped) {
          await fs.rm(fixture.backupRootPath, { recursive: true, force: true });
          await fs.symlink(fixture.rootPath, fixture.backupRootPath, process.platform === 'win32' ? 'junction' : 'dir');
          junctionSwapped = true;
        }
        return result;
      };

      const result = await executeWithRuntime(fixture, runtime);

      assert.strictEqual(junctionSwapped, true, 'artifact directory was replaced after creation');
      assert.strictEqual(runtime.planRunnerCalls(), 0);
      assert.notStrictEqual(result.receipt?.status, 'committed');
      assert.strictEqual(await exists(path.join(fixture.rootPath, 'Products.xml.bak')), false);
      assert.strictEqual(await readText(fixture.xmlTargetPath), fixture.oldXml);
    } finally {
      fsPromises.mkdir = originalMkdir;
    }
  });

  test('uses captured source bytes if the external source changes after materialization', async () => {
    const fixture = await createTwoFileFixture(tempDirs, { firstOnly: true });
    const runtime = await runtimeFor(fixture.rootPath, coordinators);
    const changedSource = Buffer.from('changed after capture');
    const originalReadFile = fsPromises.readFile;
    let sourceMutatedAfterRead = false;

    try {
      fsPromises.readFile = async (filePath: string, ...args: any[]) => {
        const captured = await originalReadFile(filePath, ...args);
        if (path.resolve(String(filePath)) === path.resolve(fixture.firstSourcePath) && !sourceMutatedAfterRead) {
          await fs.writeFile(fixture.firstSourcePath, changedSource);
          sourceMutatedAfterRead = true;
        }
        return captured;
      };

      const result = await executeWithRuntime(fixture, runtime);

      assert.strictEqual(sourceMutatedAfterRead, true);
      assert.strictEqual(result.receipt?.status, 'committed', JSON.stringify(result));
      assert.deepStrictEqual(await fs.readFile(fixture.firstTargetPath), fixture.firstIncomingBytes);
      assert.deepStrictEqual(await fs.readFile(fixture.firstSourcePath), changedSource);
    } finally {
      fsPromises.readFile = originalReadFile;
    }
  });

  test('rejects a source changed before materialization without creating artifacts', async () => {
    const fixture = await createTwoFileFixture(tempDirs, { firstOnly: true });
    const runtime = await runtimeFor(fixture.rootPath, coordinators);
    await fs.writeFile(fixture.firstSourcePath, 'changed before capture', 'utf8');

    const result = await executeWithRuntime(fixture, runtime);

    assert.strictEqual(result.failed[0]?.code, 'MERGE_SOURCE_HASH_MISMATCH');
    assert.strictEqual(result.backupPaths.length, 0);
    assert.deepStrictEqual(await fs.readFile(fixture.firstTargetPath), fixture.firstOldBytes);
    assert.strictEqual(await exists(fixture.firstBackupPath), false);
  });

  test('serializes a merge plan behind an ordinary writer in the real configuration FIFO', async function () {
    // Filesystem setup and journal recovery can be slower on Windows CI runners.
    // Keep enough time for the plan to reach the FIFO before releasing the writer.
    this.timeout(10000);
    const fixture = await createMixedFixture(tempDirs, { xmlOnly: true });
    const runtime = await runtimeFor(fixture.rootPath, coordinators);
    const canonicalRoot = await fs.realpath(fixture.rootPath);
    const ordinaryTargetPath = path.join(canonicalRoot, 'ordinary-writer.txt');
    const ordinaryEntered = deferred<void>();
    const releaseOrdinary = deferred<void>();
    const events: string[] = [];

    const ordinaryWrite = runtime.engine.transformFile(
      ordinaryTargetPath,
      {
        kind: 'compare-test.ordinary-writer',
        resourcePath: ordinaryTargetPath,
        expectedConfigurationId: runtime.configurationId,
      },
      async () => {
        events.push('ordinary-start');
        ordinaryEntered.resolve();
        await releaseOrdinary.promise;
        events.push('ordinary-finish');
        return { content: 'ordinary writer committed', result: undefined };
      },
    );
    const merge = executeWithRuntime(fixture, runtime);
    try {
      await ordinaryEntered.promise;
      const admission = await Promise.race([
        waitForPlanRunner(runtime).then(() => 'queued' as const),
        merge.then((result) => ({ kind: 'finished' as const, result })),
      ]);
      assert.strictEqual(
        admission,
        'queued',
        typeof admission === 'object' ? JSON.stringify(admission.result) : 'merge was not queued',
      );
      assert.strictEqual(await readText(fixture.xmlTargetPath), fixture.oldXml);
    } finally {
      releaseOrdinary.resolve();
    }
    const [ordinaryReceipt, mergeResult] = await Promise.all([ordinaryWrite, merge]);

    assert.strictEqual(ordinaryReceipt.status, 'committed');
    assert.strictEqual(mergeResult.receipt?.status, 'committed', JSON.stringify(mergeResult));
    assert.strictEqual(await readText(ordinaryTargetPath), 'ordinary writer committed');
    assert.strictEqual(await readText(fixture.xmlTargetPath), fixture.nextXml);
  });
});

interface Fixture {
  readonly rootPath: string;
  readonly rightRootPath: string;
  readonly backupRootPath: string;
  readonly session: CompareSession;
  readonly preflight: PreflightResult;
  readonly xmlTargetPath: string;
  readonly oldXml: string;
  readonly nextXml: string;
  readonly xmlBackupPath: string;
  readonly binaryTargetPath: string;
  readonly binaryBackupPath: string;
  readonly oldBinary: Buffer;
  readonly incomingBinary: Buffer;
  readonly folderTargetPath: string;
  readonly folderBackupPath: string;
  readonly firstTargetPath: string;
  readonly secondTargetPath: string;
  readonly firstSourcePath: string;
  readonly firstBackupPath: string;
  readonly secondBackupPath: string;
  readonly firstOldText: string;
  readonly secondOldText: string;
  readonly firstOldBytes: Buffer;
  readonly firstIncomingBytes: Buffer;
}

async function createMixedFixture(tempDirs: string[], options: { xmlOnly?: boolean } = {}): Promise<Fixture> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-mutation-engine-'));
  tempDirs.push(workspace);
  const rootPath = path.join(workspace, 'left');
  const rightRootPath = path.join(workspace, 'right');
  const backupRootPath = path.join(workspace, 'backups');
  const xmlTargetPath = path.join(rootPath, 'Catalogs', 'Products.xml');
  const binaryTargetPath = path.join(rootPath, 'Resources', 'logo.bin');
  const binarySourcePath = path.join(rightRootPath, 'Resources', 'logo.bin');
  const folderTargetPath = path.join(rootPath, 'Resources', 'Generated');
  const folderSourcePath = path.join(rightRootPath, 'Resources', 'Generated');
  const xmlBackupPath = path.join(backupRootPath, 'Products.xml.bak');
  const binaryBackupPath = path.join(backupRootPath, 'logo.bin.bak');
  const folderBackupPath = path.join(backupRootPath, 'Generated.bak');
  const oldXml = '<Object><Name>Old</Name></Object>';
  const nextXml = '<Object><Name>New</Name></Object>';
  const oldBinary = Buffer.from([1, 0, 2, 255]);
  const incomingBinary = Buffer.from([0, 255, 4, 128]);
  const oldFolderPath = path.join(folderTargetPath, 'old-only.xml');

  await fs.mkdir(path.dirname(xmlTargetPath), { recursive: true });
  await fs.writeFile(xmlTargetPath, oldXml, 'utf8');
  if (!options.xmlOnly) {
    await fs.mkdir(path.dirname(binaryTargetPath), { recursive: true });
    await fs.mkdir(path.dirname(oldFolderPath), { recursive: true });
    await fs.writeFile(binaryTargetPath, oldBinary);
    await fs.writeFile(oldFolderPath, '<OldOnly/>', 'utf8');
    await fs.mkdir(path.join(folderTargetPath, 'Legacy', 'Empty'), { recursive: true });
    if (path.sep === '/') {
      await fs.writeFile(path.join(folderTargetPath, 'literal\\name.bin'), Buffer.from([1, 3, 5, 7]));
    }
  }
  await fs.mkdir(path.dirname(binarySourcePath), { recursive: true });
  await fs.writeFile(binarySourcePath, incomingBinary);
  await fs.mkdir(path.join(folderSourcePath, 'Nested', 'Empty'), { recursive: true });
  await fs.writeFile(path.join(folderSourcePath, 'incoming.xml'), '<Incoming/>', 'utf8');
  await fs.writeFile(path.join(folderSourcePath, 'Nested', 'image.bin'), incomingBinary);
  if (path.sep === '/') {
    await fs.writeFile(path.join(folderSourcePath, 'literal\\name.bin'), Buffer.from([9, 0, 7, 255]));
  }

  const session = makeSession(rootPath, rightRootPath);
  const candidates: MergeCandidate[] = [xmlCandidate(xmlTargetPath, oldXml, nextXml)];
  if (!options.xmlOnly) {
    candidates.push(fileCopyCandidate(binarySourcePath, binaryTargetPath, oldBinary, incomingBinary));
    candidates.push(folderCopyCandidate(folderSourcePath, folderTargetPath));
  }
  const backupPaths = options.xmlOnly
    ? [xmlBackupPath]
    : [xmlBackupPath, binaryBackupPath, folderBackupPath];
  const result = buildPreflight(session, candidates, backupPaths, 'merge-mutation-engine-preview');

  return {
    rootPath,
    rightRootPath,
    backupRootPath,
    session,
    preflight: result.preflight,
    xmlTargetPath,
    oldXml,
    nextXml,
    xmlBackupPath,
    binaryTargetPath,
    binaryBackupPath,
    oldBinary,
    incomingBinary,
    folderTargetPath,
    folderBackupPath,
    firstTargetPath: xmlTargetPath,
    secondTargetPath: binaryTargetPath,
    firstSourcePath: binarySourcePath,
    firstBackupPath: xmlBackupPath,
    secondBackupPath: binaryBackupPath,
    firstOldText: oldXml,
    secondOldText: oldBinary.toString('base64'),
    firstOldBytes: Buffer.from(oldXml, 'utf8'),
    firstIncomingBytes: incomingBinary,
  };
}

async function createTwoFileFixture(
  tempDirs: string[],
  options: { firstOnly?: boolean } = {},
): Promise<Fixture> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-mutation-files-'));
  tempDirs.push(workspace);
  const rootPath = path.join(workspace, 'left');
  const rightRootPath = path.join(workspace, 'right');
  const backupRootPath = path.join(workspace, 'backups');
  const firstTargetPath = path.join(rootPath, 'Resources', 'first.bin');
  const secondTargetPath = path.join(rootPath, 'Resources', 'second.bin');
  const firstSourcePath = path.join(rightRootPath, 'Resources', 'first.bin');
  const secondSourcePath = path.join(rightRootPath, 'Resources', 'second.bin');
  const firstBackupPath = path.join(backupRootPath, 'first.bin.bak');
  const secondBackupPath = path.join(backupRootPath, 'second.bin.bak');
  const firstOldBytes = Buffer.from([4, 0, 5, 255]);
  const firstIncomingBytes = Buffer.from([9, 0, 8, 255]);
  const secondOldBytes = Buffer.from([6, 1, 2]);
  const secondIncomingBytes = Buffer.from([7, 3, 4]);
  const firstOldText = firstOldBytes.toString('base64');
  const secondOldText = secondOldBytes.toString('base64');

  await fs.mkdir(path.dirname(firstTargetPath), { recursive: true });
  await fs.writeFile(firstTargetPath, firstOldBytes);
  await fs.writeFile(secondTargetPath, secondOldBytes);
  await fs.mkdir(path.dirname(firstSourcePath), { recursive: true });
  await fs.writeFile(firstSourcePath, firstIncomingBytes);
  await fs.writeFile(secondSourcePath, secondIncomingBytes);

  const session = makeSession(rootPath, rightRootPath);
  const candidates: MergeCandidate[] = [
    fileCopyCandidate(firstSourcePath, firstTargetPath, firstOldBytes, firstIncomingBytes),
  ];
  const backupPaths = [firstBackupPath];
  if (!options.firstOnly) {
    candidates.push(fileCopyCandidate(secondSourcePath, secondTargetPath, secondOldBytes, secondIncomingBytes));
    backupPaths.push(secondBackupPath);
  }
  const result = buildPreflight(session, candidates, backupPaths, 'merge-mutation-files-preview');

  return {
    rootPath,
    rightRootPath,
    backupRootPath,
    session,
    preflight: result.preflight,
    xmlTargetPath: firstTargetPath,
    oldXml: firstOldText,
    nextXml: firstIncomingBytes.toString('base64'),
    xmlBackupPath: firstBackupPath,
    binaryTargetPath: secondTargetPath,
    binaryBackupPath: secondBackupPath,
    oldBinary: secondOldBytes,
    incomingBinary: secondIncomingBytes,
    folderTargetPath: path.join(rootPath, 'unused-folder'),
    folderBackupPath: path.join(backupRootPath, 'unused-folder.bak'),
    firstTargetPath,
    secondTargetPath,
    firstSourcePath,
    firstBackupPath,
    secondBackupPath,
    firstOldText,
    secondOldText,
    firstOldBytes,
    firstIncomingBytes,
  };
}

function buildPreflight(
  session: CompareSession,
  candidates: readonly MergeCandidate[],
  backupPaths: readonly string[],
  previewId: string,
): { readonly previewId: string; readonly preflight: PreflightResult } {
  const preview = createMergePreview({
    session,
    previewId,
    targetSourceId: 'left-source',
    snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
    createdAt: '2026-10-13T00:00:00.000Z',
    candidates,
    currentTargetHashes: Object.fromEntries(candidates.map((candidate) => [
      candidate.targetUri!,
      candidate.expectedOldHash!,
    ])),
  });
  assert.strictEqual(preview.ok, true, JSON.stringify(preview.diagnostics));
  session.approvePreview(previewId);
  const backupPlan: BackupPlan = {
    previewId,
    strategy: 'copyBeforeWrite',
    items: preview.preview.operations.map((operation, index) => ({
      operationId: operation.operationId,
      targetUri: operation.targetUri!,
      backupUri: pathToFileURL(backupPaths[index]!).toString(),
      expectedOldHash: operation.expectedOldHash!,
    })),
  };
  const rollbackPlan: RollbackPlan = {
    previewId,
    strategy: 'restoreBackups',
    items: backupPlan.items.map((item) => ({
      operationId: item.operationId,
      targetUri: item.targetUri,
      backupUri: item.backupUri,
      restoreHash: item.expectedOldHash,
    })),
  };
  const preflight = validateMergePreflight({
    session,
    previewId,
    approvedPreviewId: previewId,
    currentTargetHashes: Object.fromEntries(candidates.map((candidate) => [
      candidate.targetUri!,
      candidate.expectedOldHash!,
    ])),
    backupPlan,
    rollbackPlan,
  });
  assert.strictEqual(preflight.ok, true, JSON.stringify(preflight.diagnostics));
  return { previewId, preflight };
}

function makeSession(rootPath: string, rightRootPath: string): CompareSession {
  const session = CompareSession.create({
    sessionId: `merge-${path.basename(rootPath)}`,
    createdAt: '2026-10-13T00:00:00.000Z',
    sources: [
      {
        sourceId: 'left-source',
        side: 'left',
        kind: 'workspace',
        displayName: 'Текущая конфигурация',
        rootUri: pathToFileURL(rootPath).toString(),
        writable: true,
      },
      {
        sourceId: 'right-source',
        side: 'right',
        kind: 'snapshot',
        displayName: 'Внешний источник',
        rootUri: pathToFileURL(rightRootPath).toString(),
        writable: false,
      },
    ],
  });
  session.registerSnapshot(snapshotContract('snapshot-left-1', 'left-source', rootPath, false));
  session.registerSnapshot(snapshotContract('snapshot-right-1', 'right-source', rightRootPath, true));
  return session;
}

function xmlCandidate(targetPath: string, oldXml: string, nextXml: string): MergeCandidate {
  const targetUri = pathToFileURL(targetPath).toString();
  return {
    kind: 'xmlNodeReplace',
    sourceId: 'right-source',
    snapshotId: 'snapshot-right-1',
    nodeId: 'xml:name',
    targetUri,
    expectedOldHash: hashText(oldXml),
    newHash: hashText(nextXml),
    xmlPatch: {
      kind: 'replaceNode',
      target: { filePath: targetUri, pointer: '/Object/Name', displayPath: 'Object/Name' },
      expectedOldHash: hashText(oldXml),
      newHash: hashText(nextXml),
      replacementXml: '<Name>New</Name>',
    },
  } as MergeCandidate;
}

function fileCopyCandidate(
  sourcePath: string,
  targetPath: string,
  oldContent: Buffer,
  incomingContent: Buffer,
): MergeCandidate {
  const targetUri = pathToFileURL(targetPath).toString();
  const sourceUri = pathToFileURL(sourcePath).toString();
  const expectedOldHash = hashBuffer(oldContent);
  const sourceHash = hashBuffer(incomingContent);
  return {
    kind: 'fileCopy',
    sourceId: 'right-source',
    snapshotId: 'snapshot-right-1',
    nodeId: `file:${path.basename(targetPath)}`,
    targetUri,
    expectedOldHash,
    newHash: sourceHash,
    fileOperation: {
      kind: 'fileCopy',
      sourcePath: sourceUri,
      targetPath: targetUri,
      expectedOldHash,
      sourceHash,
      destructive: false,
    },
  } as MergeCandidate;
}

function folderCopyCandidate(sourcePath: string, targetPath: string): MergeCandidate {
  const targetUri = pathToFileURL(targetPath).toString();
  const sourceHash = hashDirectoryForPreview(sourcePath);
  const expectedOldHash = hashDirectoryForPreview(targetPath);
  return {
    kind: 'folderCopy',
    sourceId: 'right-source',
    snapshotId: 'snapshot-right-1',
    nodeId: 'folder:generated',
    targetUri,
    expectedOldHash,
    newHash: sourceHash,
    fileOperation: {
      kind: 'folderCopy',
      sourcePath: pathToFileURL(sourcePath).toString(),
      targetPath: targetUri,
      expectedOldHash,
      sourceHash,
      destructive: true,
    },
  } as MergeCandidate;
}

function hashDirectoryForPreview(directoryPath: string): string {
  const entries = require('fs').readdirSync(directoryPath, { withFileTypes: true }) as Array<{
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }>;
  const parts: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      parts.push(`dir:${entry.name}:${hashDirectoryForPreview(entryPath)}`);
    } else if (entry.isFile()) {
      parts.push(`file:${entry.name}:${hashBuffer(require('fs').readFileSync(entryPath) as Buffer)}`);
    }
  }
  return hashText(parts.join('\n'));
}

function snapshotContract(snapshotId: string, sourceId: string, rootPath: string, readOnly: boolean) {
  const rootUri = pathToFileURL(rootPath).toString();
  return {
    snapshotId,
    sourceId,
    snapshotRoot: rootUri,
    origin: rootUri,
    createdAt: '2026-10-13T00:00:00.000Z',
    retentionUntil: '2026-10-14T00:00:00.000Z',
    sourceRevision: `test:${sourceId}`,
    readOnly,
    cleanupPolicy: 'manual' as const,
    contentHash: `sha256:${sourceId}`,
  };
}

async function runtimeFor(rootPath: string, coordinators: Array<{ dispose(): Promise<void> }>) {
  const runtime = await createMergeMutationTestRuntime(rootPath);
  coordinators.push(runtime.coordinator);
  return runtime;
}

async function executeWithRuntime(
  fixture: Fixture,
  runtime: { engine: ConfigurationMutationEngine; configurationId: ConfigurationId },
) {
  return executeBslMergePreview({
    session: fixture.session,
    preflight: fixture.preflight,
    mutationEngine: runtime.engine,
    configurationId: runtime.configurationId,
  });
}

async function waitForPlanRunner(runtime: { planRunnerCalls: () => number }): Promise<void> {
  const deadline = Date.now() + 8000;
  while (runtime.planRunnerCalls() === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.strictEqual(runtime.planRunnerCalls(), 1, 'merge plan reached the shared plan runner');
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function hashBuffer(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
