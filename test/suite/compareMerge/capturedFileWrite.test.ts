import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

import { CompareSession } from '../../../src/compareMerge/domain/compareSession';
import { captureMergePath, mergeSnapshotHash, mutationFingerprint } from '../../../src/compareMerge/merge/mergeSnapshot';
import { executeBslMergePreview } from '../../../src/compareMerge/merge/mergeExecutor';
import {
  createMergePreview,
  MISSING_TARGET_HASH,
  validateMergePreflight,
  type MergeCandidate,
  type MergeFileWitness,
  type MergePreview,
  type PreviewValidationResult,
  type PreflightResult,
  type RollbackPlan,
  type BackupPlan,
} from '../../../src/compareMerge/merge/mergePlanner';
import { installMutationPlanPublicationInterception } from '../../helpers/mutationPlanPublicationInterception';
import { createMergeMutationTestRuntime, executeMergeInputWithRuntime } from './mergeMutationTestSupport';

interface WriteSpec {
  readonly nodeId: string;
  readonly targetRelativePath: string;
  readonly capturedBytes: Buffer;
  readonly oldTargetBytes?: Buffer;
}

interface FixtureOptions {
  readonly additionalTargetWitnesses?: readonly { relativePath: string; kind: 'file' | 'directory' }[];
}

interface Fixture {
  readonly workspacePath: string;
  readonly targetRootPath: string;
  readonly rightRootPath: string;
  readonly baseRootPath: string;
  readonly backupRootPath: string;
  readonly session: CompareSession;
  readonly candidates: MergeCandidate[];
  readonly writes: readonly WriteSpec[];
  readonly targetPaths: readonly string[];
  readonly backupPaths: readonly string[];
}

interface ApprovedFixture extends Fixture {
  readonly preview: MergePreview;
  readonly preflight: PreflightResult;
}

const TEST_SNAPSHOT_TIME = '2026-10-27T00:00:00.000Z';
const mutableFsPromises = require('fs/promises') as {
  open: typeof fs.open;
  readFile: typeof fs.readFile;
};

suite('Captured file-write merge mutation engine (#336)', () => {
  const tempDirs: string[] = [];

  teardown(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) =>
        fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      ),
    );
  });

  test('creates and replaces files from captured binary bytes while checking file, directory, and missing witnesses', async () => {
    const replaceBytes = Buffer.from([0xef, 0xbb, 0xbf, 0x00, 0xff, 0x80, 0x41]);
    const createBytes = Buffer.from([0x00, 0xef, 0xbb, 0xbf, 0x10, 0x00]);
    const oldBytes = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const fixture = await createFixture(
      tempDirs,
      [
        { nodeId: 'replace', targetRelativePath: 'Assets/replace.bin', capturedBytes: replaceBytes, oldTargetBytes: oldBytes },
        { nodeId: 'create', targetRelativePath: 'Assets/create.bin', capturedBytes: createBytes },
      ],
      { additionalTargetWitnesses: [{ relativePath: 'Assets', kind: 'directory' }] },
    );
    const approved = approveFixture(fixture);

    const result = await executeMergeInputWithRuntime({ session: fixture.session, preflight: approved.preflight });

    assert.strictEqual(result.receipt?.status, 'committed', JSON.stringify(result));
    assert.deepStrictEqual(
      await Promise.all(fixture.targetPaths.map((targetPath) => fs.readFile(targetPath))),
      [replaceBytes, createBytes],
      'the approved captured bytes, including BOM and opaque binary data, reach both targets exactly',
    );
    assert.deepStrictEqual(await fs.readFile(fixture.backupPaths[0]!), oldBytes);
    assert.strictEqual(await exists(fixture.backupPaths[1]!), false, 'a create has no prior file to back up');
    assert.deepStrictEqual(await fs.readFile(path.join(fixture.rightRootPath, 'Incoming', 'replace.bin')), replaceBytes);
    assert.deepStrictEqual(await fs.readFile(path.join(fixture.rightRootPath, 'Incoming', 'create.bin')), createBytes);
    assert.deepStrictEqual(await fs.readFile(path.join(fixture.baseRootPath, 'Reference.xml')), Buffer.from('<Base/>'));
    assert.strictEqual(await exists(path.join(fixture.baseRootPath, 'Absent.xml')), false);
    assert.deepStrictEqual(result.applied.map((item) => item.kind), ['fileWrite', 'fileWrite']);
    assert.ok(
      approved.preview.operations.every((operation) => operation.previewPath && operation.previewEffect),
      'preview retains the relative target path and create/replace effect for each captured write',
    );
  });

  test('accepts portable POSIX relative paths for nested captured file witnesses', async () => {
    const fixture = await createFixture(tempDirs, [singleWrite()]);
    const nestedSourcePath = path.join(fixture.rightRootPath, 'Incoming', 'nested', 'source.bin');
    await fs.mkdir(path.dirname(nestedSourcePath), { recursive: true });
    await fs.writeFile(nestedSourcePath, singleWrite().capturedBytes);
    fixture.candidates[0]!.fileWrite!.witnesses[0]!.relativePath = 'Incoming/nested/source.bin';

    const preview = createPreview(fixture, fixture.candidates, 'preview-posix-nested-witness');
    assert.strictEqual(preview.ok, true, JSON.stringify(preview));
    const approved = approveFixture(fixture, preview.preview);
    const result = await executeMergeInputWithRuntime({ session: fixture.session, preflight: approved.preflight });

    assert.strictEqual(result.receipt?.status, 'committed', JSON.stringify(result));
    assert.deepStrictEqual(await fs.readFile(fixture.targetPaths[0]!), singleWrite().capturedBytes);
  });

  test('rejects a source witness changed after approval before entering the mutation engine', async () => {
    const fixture = await createFixture(tempDirs, [singleWrite()]);
    const approved = approveFixture(fixture);
    const changedSource = Buffer.from('source changed after approval');
    await fs.writeFile(path.join(fixture.rightRootPath, 'Incoming', 'write.bin'), changedSource);
    const runtime = await createMergeMutationTestRuntime(fixture.targetRootPath);

    try {
      const result = await executeBslMergePreview({
        session: fixture.session,
        preflight: approved.preflight,
        mutationEngine: runtime.engine,
        configurationId: runtime.configurationId,
      });

      assert.strictEqual(result.failed[0]?.code, 'MERGE_WITNESS_MISMATCH');
      assert.strictEqual(result.receipt, undefined);
      assert.strictEqual(runtime.planRunnerCalls(), 0, 'the shared plan runner is not entered for a stale source');
      assert.deepStrictEqual(await fs.readFile(fixture.targetPaths[0]!), oldTargetBytes());
      assert.strictEqual(await exists(fixture.backupPaths[0]!), false);
      assert.deepStrictEqual(await fs.readFile(path.join(fixture.rightRootPath, 'Incoming', 'write.bin')), changedSource);
    } finally {
      await runtime.coordinator.dispose();
    }
  });

  test('rechecks a base directory witness after an admitted merge waits behind the configuration FIFO', async function () {
    this.timeout(10000);
    const fixture = await createFixture(tempDirs, [singleWrite()]);
    const approved = approveFixture(fixture);
    const runtime = await createMergeMutationTestRuntime(fixture.targetRootPath);
    const baseTreePath = path.join(fixture.baseRootPath, 'BaseTree');
    const sourceChangePath = path.join(baseTreePath, 'late-added.xml');

    try {
      const result = await executeBehindWriterLock(runtime, fixture, approved.preflight, async () => {
        await fs.writeFile(sourceChangePath, '<Late/>');
      });

      assert.strictEqual(result.receipt?.status, 'conflict', JSON.stringify(result));
      assert.strictEqual(result.failed[0]?.code, 'PLAN_CONFLICT');
      assert.deepStrictEqual(await fs.readFile(fixture.targetPaths[0]!), oldTargetBytes());
      assert.strictEqual(await exists(fixture.backupPaths[0]!), false);
      assert.strictEqual(await exists(sourceChangePath), true, 'the externally added base file remains untouched');
    } finally {
      await runtime.coordinator.dispose();
    }
  });

  test('rechecks incoming source bytes after an admitted merge waits behind the configuration FIFO', async function () {
    this.timeout(10000);
    const fixture = await createFixture(tempDirs, [singleWrite()]);
    const approved = approveFixture(fixture);
    const runtime = await createMergeMutationTestRuntime(fixture.targetRootPath);
    const sourcePath = path.join(fixture.rightRootPath, 'Incoming', 'write.bin');
    const changedSource = Buffer.from('source changed while merge waited');

    try {
      const result = await executeBehindWriterLock(runtime, fixture, approved.preflight, async () => {
        await fs.writeFile(sourcePath, changedSource);
      });

      assert.strictEqual(result.receipt?.status, 'conflict', JSON.stringify(result));
      assert.strictEqual(result.failed[0]?.code, 'PLAN_CONFLICT');
      assert.deepStrictEqual(await fs.readFile(fixture.targetPaths[0]!), oldTargetBytes());
      assert.strictEqual(await exists(fixture.backupPaths[0]!), false);
      assert.deepStrictEqual(await fs.readFile(sourcePath), changedSource, 'the external source edit remains untouched');
    } finally {
      await runtime.coordinator.dispose();
    }
  });

  test('uses target file and directory witnesses as CAS assertions after a merge waits in the FIFO', async function () {
    this.timeout(10000);
    const fileGuard = await createFixture(
      tempDirs,
      [singleWrite()],
      { additionalTargetWitnesses: [{ relativePath: 'Guards/identity.bin', kind: 'file' }] },
    );
    const fileApproved = approveFixture(fileGuard);
    const fileRuntime = await createMergeMutationTestRuntime(fileGuard.targetRootPath);
    try {
      const result = await executeBehindWriterLock(fileRuntime, fileGuard, fileApproved.preflight, async () => {
        await fs.writeFile(path.join(fileGuard.targetRootPath, 'Guards', 'identity.bin'), 'late-file-change');
      });

      assert.strictEqual(result.receipt?.status, 'conflict', JSON.stringify(result));
      assert.strictEqual(result.failed[0]?.code, 'PLAN_CONFLICT');
      assert.deepStrictEqual(await fs.readFile(fileGuard.targetPaths[0]!), oldTargetBytes());
      assert.strictEqual(
        await fs.readFile(path.join(fileGuard.targetRootPath, 'Guards', 'identity.bin'), 'utf8'),
        'late-file-change',
      );
    } finally {
      await fileRuntime.coordinator.dispose();
    }

    const directoryGuard = await createFixture(
      tempDirs,
      [singleWrite()],
      { additionalTargetWitnesses: [{ relativePath: 'Guards', kind: 'directory' }] },
    );
    const directoryApproved = approveFixture(directoryGuard);
    const directoryRuntime = await createMergeMutationTestRuntime(directoryGuard.targetRootPath);
    try {
      const result = await executeBehindWriterLock(directoryRuntime, directoryGuard, directoryApproved.preflight, async () => {
        await fs.writeFile(path.join(directoryGuard.targetRootPath, 'Guards', 'orphan.xml'), '<Orphan/>');
      });

      assert.strictEqual(result.receipt?.status, 'conflict', JSON.stringify(result));
      assert.strictEqual(result.failed[0]?.code, 'PLAN_CONFLICT');
      assert.deepStrictEqual(await fs.readFile(directoryGuard.targetPaths[0]!), oldTargetBytes());
      assert.deepStrictEqual(
        await fs.readFile(path.join(directoryGuard.targetRootPath, 'Guards', 'orphan.xml'), 'utf8'),
        '<Orphan/>',
      );
    } finally {
      await directoryRuntime.coordinator.dispose();
    }
  });

  test('does not let returned candidate, preview, or preflight payload mutations change trusted captured bytes', async () => {
    const fixture = await createFixture(tempDirs, [singleWrite()]);
    const candidate = fixture.candidates[0]!;
    const previewResult = createPreview(fixture, fixture.candidates, 'preview-captured-clone');
    assert.strictEqual(previewResult.ok, true, JSON.stringify(previewResult));
    const preview = previewResult.preview;

    candidate.fileWrite!.contentBase64 = Buffer.from('candidate mutation').toString('base64');
    candidate.fileWrite!.witnesses[0]!.expectedHash = '0'.repeat(64);
    preview.operations[0]!.fileWrite!.contentBase64 = Buffer.from('returned preview mutation').toString('base64');
    preview.operations[0]!.fileWrite!.witnesses[0]!.expectedHash = '1'.repeat(64);
    const returnedPayload = preview.payload as { operations: MergePreview['operations'] };
    returnedPayload.operations[0]!.fileWrite!.contentBase64 = Buffer.from('returned payload mutation').toString('base64');
    returnedPayload.operations[0]!.previewPath = '..';

    fixture.session.approvePreview(preview.previewId);
    const stored = fixture.session.requireExecutablePreview(preview.previewId) as {
      payload?: { operations?: MergePreview['operations'] };
    };
    const trustedOperation = stored.payload?.operations?.[0];
    assert.strictEqual(trustedOperation?.previewPath, path.normalize('Assets/write.bin'));
    assert.strictEqual(trustedOperation?.previewEffect, 'replace');
    assert.deepStrictEqual(
      Buffer.from(trustedOperation?.fileWrite?.contentBase64 ?? '', 'base64'),
      singleWrite().capturedBytes,
    );
    const preflight = makePreflight(fixture, preview);
    assert.strictEqual(preflight.ok, true, JSON.stringify(preflight.diagnostics));
    preflight.operations[0]!.fileWrite!.contentBase64 = Buffer.from('returned preflight mutation').toString('base64');

    const result = await executeMergeInputWithRuntime({ session: fixture.session, preflight });

    assert.strictEqual(result.receipt?.status, 'committed', JSON.stringify(result));
    assert.deepStrictEqual(await fs.readFile(fixture.targetPaths[0]!), singleWrite().capturedBytes);
    assert.deepStrictEqual(await fs.readFile(fixture.backupPaths[0]!), oldTargetBytes());
  });

  test('blocks malformed payloads, hashes, source ids, and noncanonical witness paths at preview creation', async () => {
    const fixture = await createFixture(tempDirs, [singleWrite()]);
    const original = fixture.candidates[0]!;
    const cases: Array<{ name: string; change(candidate: MergeCandidate): void }> = [
      {
        name: 'wrong new hash',
        change: (candidate) => { candidate.newHash = '0'.repeat(64); },
      },
      {
        name: 'noncanonical base64',
        change: (candidate) => { candidate.fileWrite!.contentBase64 = 'YWI==='; },
      },
      {
        name: 'missing witnesses array',
        change: (candidate) => { (candidate.fileWrite as unknown as { witnesses?: unknown }).witnesses = undefined; },
      },
      {
        name: 'unknown witness source',
        change: (candidate) => { candidate.fileWrite!.witnesses[0]!.sourceId = 'not-in-this-session'; },
      },
      {
        name: 'path traversal',
        change: (candidate) => { candidate.fileWrite!.witnesses[0]!.relativePath = path.join('..', 'outside.bin'); },
      },
      {
        name: 'Windows absolute witness path',
        change: (candidate) => { candidate.fileWrite!.witnesses[0]!.relativePath = 'C:\\outside.bin'; },
      },
      {
        name: 'UNC witness path',
        change: (candidate) => { candidate.fileWrite!.witnesses[0]!.relativePath = '\\\\server\\share\\outside.bin'; },
      },
      {
        name: 'mixed-separator traversal',
        change: (candidate) => { candidate.fileWrite!.witnesses[0]!.relativePath = 'Incoming/../outside.bin'; },
      },
      {
        name: 'duplicate path separator',
        change: (candidate) => { candidate.fileWrite!.witnesses[0]!.relativePath = 'Incoming//write.bin'; },
      },
      {
        name: 'dot path segment',
        change: (candidate) => { candidate.fileWrite!.witnesses[0]!.relativePath = 'Incoming/./write.bin'; },
      },
      {
        name: 'journal witness path',
        change: (candidate) => {
          candidate.fileWrite!.witnesses[0]!.relativePath = path.join('.cdt-journal', 'journal.json');
        },
      },
      {
        name: 'missing witness hash',
        change: (candidate) => {
          (candidate.fileWrite!.witnesses[0] as { expectedHash?: string }).expectedHash = undefined;
        },
      },
      {
        name: 'missing expected old target hash',
        change: (candidate) => { candidate.expectedOldHash = undefined; },
      },
      {
        name: 'missing captured new hash',
        change: (candidate) => { candidate.newHash = undefined; },
      },
    ];

    for (const [index, invalidCase] of cases.entries()) {
      const candidate = cloneCandidate(original);
      invalidCase.change(candidate);
      const result = createPreview(fixture, [candidate], `preview-invalid-${index}`);
      assert.strictEqual(result.ok, false, `${invalidCase.name} unexpectedly created a preview`);
      assert.ok(
        result.diagnostics.some((diagnostic) => diagnostic.code === 'MERGE_FILE_WRITE_PAYLOAD_INVALID'),
        `${invalidCase.name}: ${JSON.stringify(result.diagnostics)}`,
      );
    }

    assert.deepStrictEqual(await fs.readFile(fixture.targetPaths[0]!), oldTargetBytes());
    assert.strictEqual(await exists(fixture.backupPaths[0]!), false);
  });

  test('rejects symlink witnesses at host validation before any target write', async () => {
    const fixture = await createFixture(tempDirs, [singleWrite()]);
    const outsidePath = path.join(fixture.workspacePath, 'outside-tree');
    const linkPath = path.join(fixture.rightRootPath, 'Incoming', 'linked-tree');
    await fs.mkdir(outsidePath, { recursive: true });
    await fs.writeFile(path.join(outsidePath, 'payload.bin'), 'outside');
    await fs.symlink(outsidePath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    fixture.candidates[0]!.fileWrite!.witnesses = [
      ...fixture.candidates[0]!.fileWrite!.witnesses,
      { sourceId: 'right-source', relativePath: path.join('Incoming', 'linked-tree'), expectedHash: MISSING_TARGET_HASH, kind: 'directory' },
    ];
    const result = createPreview(fixture, fixture.candidates, 'preview-symlink-witness');
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    const approved = approveFixture(fixture, result.preview);

    const execution = await executeMergeInputWithRuntime({ session: fixture.session, preflight: approved.preflight });

    assert.strictEqual(execution.failed[0]?.code, 'MERGE_WITNESS_READ_FAILED');
    assert.strictEqual(execution.receipt, undefined);
    assert.deepStrictEqual(await fs.readFile(fixture.targetPaths[0]!), oldTargetBytes());
    assert.strictEqual(await exists(fixture.backupPaths[0]!), false);
  });

  test('blocks an unsupported operation mixed with a valid captured write before creating any preview', async () => {
    const fixture = await createFixture(tempDirs, [singleWrite()]);
    const unsupported: MergeCandidate = {
      kind: 'metadataObjectCopy',
      sourceId: 'right-source',
      snapshotId: 'snapshot-right',
      nodeId: 'unsupported-metadata-copy',
      targetUri: pathToFileURL(fixture.targetPaths[0]!).toString(),
      expectedOldHash: hashBytes(oldTargetBytes()),
      newHash: hashBytes(Buffer.from('unsupported')),
    };
    const result = createPreview(fixture, [...fixture.candidates, unsupported], 'preview-mixed-unsupported');

    assert.strictEqual(result.ok, false);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'MERGE_UNSUPPORTED_OPERATION'));
    assert.strictEqual(fixture.session.state.previews.some((preview) => preview.previewId === 'preview-mixed-unsupported'), false);
    assert.deepStrictEqual(await fs.readFile(fixture.targetPaths[0]!), oldTargetBytes());
    assert.strictEqual(await exists(fixture.backupPaths[0]!), false);
  });

  test('rolls back a captured-write batch when a later file publication fails', async () => {
    const firstOriginal = Buffer.from('first-original');
    const secondOriginal = Buffer.from('second-original');
    const fixture = await createFixture(tempDirs, [
      { nodeId: 'first', targetRelativePath: 'Assets/first.bin', capturedBytes: Buffer.from('first-incoming'), oldTargetBytes: firstOriginal },
      { nodeId: 'second', targetRelativePath: 'Assets/second.bin', capturedBytes: Buffer.from('second-incoming'), oldTargetBytes: secondOriginal },
    ]);
    const approved = approveFixture(fixture);
    const runtime = await createMergeMutationTestRuntime(fixture.targetRootPath);
    let injected = false;
    const publication = installMutationPlanPublicationInterception([
      {
        targetPath: fixture.targetPaths[1]!,
        before: async () => {
          injected = true;
          throw new Error('injected captured file-write publication failure');
        },
      },
    ]);

    try {
      const result = await executeBslMergePreview({
        session: fixture.session,
        preflight: approved.preflight,
        mutationEngine: runtime.engine,
        configurationId: runtime.configurationId,
      });

      assert.strictEqual(injected, true, 'the second captured write reached the shared plan publication');
      assert.strictEqual(result.receipt?.status, 'rolledBack', JSON.stringify(result));
      assert.deepStrictEqual(await fs.readFile(fixture.targetPaths[0]!), firstOriginal);
      assert.deepStrictEqual(await fs.readFile(fixture.targetPaths[1]!), secondOriginal);
      assert.deepStrictEqual(await fs.readFile(fixture.backupPaths[0]!), firstOriginal);
      assert.deepStrictEqual(await fs.readFile(fixture.backupPaths[1]!), secondOriginal);
    } finally {
      publication.restore();
      await runtime.coordinator.dispose();
    }
  });

  test('preserves a foreign target edit when rollback of a captured-write batch cannot safely restore it', async () => {
    const firstOriginal = Buffer.from('first-original');
    const secondOriginal = Buffer.from('second-original');
    const fixture = await createFixture(tempDirs, [
      { nodeId: 'first', targetRelativePath: 'Assets/first.bin', capturedBytes: Buffer.from('first-incoming'), oldTargetBytes: firstOriginal },
      { nodeId: 'second', targetRelativePath: 'Assets/second.bin', capturedBytes: Buffer.from('second-incoming'), oldTargetBytes: secondOriginal },
    ]);
    const approved = approveFixture(fixture);
    const runtime = await createMergeMutationTestRuntime(fixture.targetRootPath);
    const foreignEdit = Buffer.from('foreign writer edit');
    let firstWritePublished = false;
    let lateFailureInjected = false;
    const publication = installMutationPlanPublicationInterception([
      {
        targetPath: fixture.targetPaths[0]!,
        after: async () => {
          firstWritePublished = true;
          await fs.writeFile(fixture.targetPaths[0]!, foreignEdit);
        },
      },
      {
        targetPath: fixture.targetPaths[1]!,
        before: async () => {
          lateFailureInjected = true;
          throw new Error('injected late captured write failure');
        },
      },
    ]);

    try {
      const result = await executeBslMergePreview({
        session: fixture.session,
        preflight: approved.preflight,
        mutationEngine: runtime.engine,
        configurationId: runtime.configurationId,
      });

      assert.strictEqual(firstWritePublished, true);
      assert.strictEqual(lateFailureInjected, true);
      assert.ok(
        result.receipt?.status === 'recoveryRequired' || result.receipt?.status === 'inDoubt',
        JSON.stringify(result),
      );
      assert.deepStrictEqual(await fs.readFile(fixture.targetPaths[0]!), foreignEdit);
      assert.deepStrictEqual(await fs.readFile(fixture.targetPaths[1]!), secondOriginal);
      assert.strictEqual(result.mutationFailure?.effectPossible, true, JSON.stringify(result.mutationFailure));
    } finally {
      publication.restore();
      await runtime.coordinator.dispose();
    }
  });
});

function singleWrite(): WriteSpec {
  return {
    nodeId: 'write',
    targetRelativePath: 'Assets/write.bin',
    capturedBytes: Buffer.from([0xef, 0xbb, 0xbf, 0x00, 0x81, 0x42]),
    oldTargetBytes: oldTargetBytes(),
  };
}

function oldTargetBytes(): Buffer {
  return Buffer.from([0x09, 0x08, 0x00, 0x07]);
}

async function createFixture(
  tempDirs: string[],
  writes: readonly WriteSpec[],
  options: FixtureOptions = {},
): Promise<Fixture> {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'issue336-captured-write-'));
  tempDirs.push(workspacePath);
  const targetRootPath = path.join(workspacePath, 'target');
  const rightRootPath = path.join(workspacePath, 'incoming');
  const baseRootPath = path.join(workspacePath, 'base');
  const backupRootPath = path.join(workspacePath, 'backups');
  await Promise.all([
    fs.mkdir(targetRootPath, { recursive: true }),
    fs.mkdir(rightRootPath, { recursive: true }),
    fs.mkdir(baseRootPath, { recursive: true }),
  ]);

  await fs.mkdir(path.join(baseRootPath, 'BaseTree'), { recursive: true });
  await fs.writeFile(path.join(baseRootPath, 'Reference.xml'), '<Base/>', 'utf8');
  await fs.writeFile(path.join(baseRootPath, 'BaseTree', 'root.bin'), Buffer.from([0x10, 0x00, 0xfe]));
  await fs.mkdir(path.join(targetRootPath, 'Assets'), { recursive: true });
  for (const write of writes) {
    const targetPath = path.join(targetRootPath, write.targetRelativePath);
    const incomingPath = path.join(rightRootPath, 'Incoming', `${write.nodeId}.bin`);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.mkdir(path.dirname(incomingPath), { recursive: true });
    if (write.oldTargetBytes) {
      await fs.writeFile(targetPath, write.oldTargetBytes);
    }
    await fs.writeFile(incomingPath, write.capturedBytes);
  }

  for (const witness of options.additionalTargetWitnesses ?? []) {
    const absolutePath = path.join(targetRootPath, witness.relativePath);
    if (witness.kind === 'directory') {
      await fs.mkdir(absolutePath, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, 'target-witness');
    }
  }

  const session = CompareSession.create({
    sessionId: `session-${path.basename(workspacePath)}`,
    createdAt: TEST_SNAPSHOT_TIME,
    sources: [
      {
        sourceId: 'left-source',
        side: 'left',
        kind: 'workspace',
        displayName: 'Target configuration',
        rootUri: pathToFileURL(targetRootPath).toString(),
        writable: true,
      },
      {
        sourceId: 'right-source',
        side: 'right',
        kind: 'snapshot',
        displayName: 'Incoming configuration',
        rootUri: pathToFileURL(rightRootPath).toString(),
        writable: false,
      },
      {
        sourceId: 'base-source',
        side: 'right',
        role: 'base',
        kind: 'file',
        displayName: 'Bound base configuration',
        rootUri: pathToFileURL(baseRootPath).toString(),
        writable: false,
      },
    ],
  });
  session.registerSnapshot(snapshotContract('snapshot-left', 'left-source', targetRootPath, false));
  session.registerSnapshot(snapshotContract('snapshot-right', 'right-source', rightRootPath, true));

  const targetPaths = writes.map((write) => path.join(targetRootPath, write.targetRelativePath));
  const backupPaths = writes.map((write) => path.join(backupRootPath, `${write.nodeId}.bak`));
  const sourceWitnesses: MergeFileWitness[] = [];
  for (const write of writes) {
    sourceWitnesses.push({
      sourceId: 'right-source',
      relativePath: path.join('Incoming', `${write.nodeId}.bin`),
      expectedHash: hashBytes(write.capturedBytes),
    });
  }
  sourceWitnesses.push(
    {
      sourceId: 'base-source',
      relativePath: 'Reference.xml',
      expectedHash: hashBytes(Buffer.from('<Base/>')),
      kind: 'file',
    },
    {
      sourceId: 'base-source',
      relativePath: 'BaseTree',
      expectedHash: await directoryHash(path.join(baseRootPath, 'BaseTree')),
      kind: 'directory',
    },
    {
      sourceId: 'base-source',
      relativePath: 'Absent.xml',
      expectedHash: MISSING_TARGET_HASH,
    },
  );
  const targetWitnesses: MergeFileWitness[] = [];
  for (const write of writes) {
    targetWitnesses.push({
      sourceId: 'left-source',
      relativePath: path.normalize(write.targetRelativePath),
      expectedHash: write.oldTargetBytes ? hashBytes(write.oldTargetBytes) : MISSING_TARGET_HASH,
    });
  }
  for (const witness of options.additionalTargetWitnesses ?? []) {
    const absolutePath = path.join(targetRootPath, witness.relativePath);
    targetWitnesses.push({
      sourceId: 'left-source',
      relativePath: path.normalize(witness.relativePath),
      expectedHash: await pathHash(absolutePath),
      kind: witness.kind,
    });
  }
  const allWitnesses = [...sourceWitnesses, ...targetWitnesses];
  const candidates: MergeCandidate[] = writes.map((write) => ({
    kind: 'fileWrite',
    sourceId: 'right-source',
    snapshotId: 'snapshot-right',
    nodeId: write.nodeId,
    targetUri: pathToFileURL(path.join(targetRootPath, write.targetRelativePath)).toString(),
    previewPath: path.normalize(write.targetRelativePath),
    previewEffect: write.oldTargetBytes ? 'replace' : 'create',
    expectedOldHash: write.oldTargetBytes ? hashBytes(write.oldTargetBytes) : MISSING_TARGET_HASH,
    newHash: hashBytes(write.capturedBytes),
    fileWrite: {
      contentBase64: write.capturedBytes.toString('base64'),
      witnesses: allWitnesses.map((witness) => ({ ...witness })),
    },
  }));

  return {
    workspacePath,
    targetRootPath,
    rightRootPath,
    baseRootPath,
    backupRootPath,
    session,
    candidates,
    writes,
    targetPaths,
    backupPaths,
  };
}

function createPreview(
  fixture: Fixture,
  candidates: readonly MergeCandidate[],
  previewId: string,
): PreviewValidationResult {
  return createMergePreview({
    session: fixture.session,
    previewId,
    targetSourceId: 'left-source',
    snapshotIds: { left: 'snapshot-left', right: 'snapshot-right' },
    createdAt: TEST_SNAPSHOT_TIME,
    candidates,
    currentTargetHashes: Object.fromEntries(
      candidates.flatMap((candidate) => candidate.targetUri && candidate.expectedOldHash
        ? [[candidate.targetUri, candidate.expectedOldHash]]
        : []),
    ),
  });
}

function approveFixture(fixture: Fixture, preview?: MergePreview): ApprovedFixture {
  const result = preview
    ? { ok: true as const, preview, diagnostics: [] as [] }
    : createPreview(fixture, fixture.candidates, `preview-${path.basename(fixture.workspacePath)}`);
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  fixture.session.approvePreview(result.preview.previewId);
  const preflight = makePreflight(fixture, result.preview);
  assert.strictEqual(preflight.ok, true, JSON.stringify(preflight.diagnostics));
  return { ...fixture, preview: result.preview, preflight };
}

function makePreflight(fixture: Fixture, preview: MergePreview): PreflightResult {
  const backupPlan: BackupPlan = {
    previewId: preview.previewId,
    strategy: 'copyBeforeWrite',
    items: preview.operations.map((operation, index) => ({
      operationId: operation.operationId,
      targetUri: operation.targetUri!,
      backupUri: pathToFileURL(fixture.backupPaths[index]!).toString(),
      expectedOldHash: operation.expectedOldHash!,
    })),
  };
  const rollbackPlan: RollbackPlan = {
    previewId: preview.previewId,
    strategy: 'restoreBackups',
    items: backupPlan.items.map((item) => ({
      operationId: item.operationId,
      targetUri: item.targetUri,
      backupUri: item.backupUri,
      restoreHash: item.expectedOldHash,
    })),
  };
  return validateMergePreflight({
    session: fixture.session,
    previewId: preview.previewId,
    approvedPreviewId: preview.previewId,
    currentTargetHashes: Object.fromEntries(
      preview.operations.map((operation) => [operation.targetUri!, operation.expectedOldHash!]),
    ),
    backupPlan,
    rollbackPlan,
  });
}

async function executeBehindWriterLock(
  runtime: Awaited<ReturnType<typeof createMergeMutationTestRuntime>>,
  fixture: Fixture,
  preflight: PreflightResult,
  mutateWhileQueued: () => Promise<void>,
) {
  const canonicalRoot = await fs.realpath(fixture.targetRootPath);
  const engineDependencies = (runtime.engine as unknown as {
    deps: { runMutation?: (...args: any[]) => Promise<any> };
  }).deps;
  const originalRunMutation = engineDependencies.runMutation;
  assert.ok(originalRunMutation, 'shared test runtime exposes its real mutation runner');
  const mergeAdmissionRequested = deferred<void>();
  const allowMergeAdmission = deferred<void>();
  const mergeEnqueued = deferred<void>();
  engineDependencies.runMutation = async (resourcePath: string, kind: string, operation: () => Promise<any>, options?: unknown) => {
    if (kind !== 'configuration-compare-merge') {
      return originalRunMutation(resourcePath, kind, operation, options);
    }

    mergeAdmissionRequested.resolve();
    await allowMergeAdmission.promise;

    const mutationSession = await runtime.coordinator.resolveResource(resourcePath);
    const originalRunExclusive = mutationSession.runExclusive.bind(mutationSession);
    mutationSession.runExclusive = ((request: Parameters<typeof mutationSession.runExclusive>[0]) => {
      const queued = originalRunExclusive(request);
      mergeEnqueued.resolve();
      return queued;
    }) as typeof mutationSession.runExclusive;
    try {
      return await originalRunMutation(resourcePath, kind, operation, options);
    } finally {
      mutationSession.runExclusive = originalRunExclusive;
    }
  };

  const writerEntered = deferred<void>();
  const releaseWriter = deferred<void>();
  const merge = executeBslMergePreview({
    session: fixture.session,
    preflight,
    mutationEngine: runtime.engine,
    configurationId: runtime.configurationId,
  });
  try {
    const admitted = await Promise.race([
      mergeAdmissionRequested.promise.then(() => 'admission-paused' as const),
      merge.then((result) => ({ kind: 'finished' as const, result })),
    ]);
    assert.strictEqual(
      admitted,
      'admission-paused',
      typeof admitted === 'object' ? JSON.stringify(admitted.result) : 'merge did not reach runMutation admission',
    );

    const ordinaryTarget = path.join(canonicalRoot, 'queue-barrier.txt');
    const ordinaryWrite = runtime.engine.transformFile(
      ordinaryTarget,
      {
        kind: 'issue336.test.queue-barrier',
        resourcePath: ordinaryTarget,
        expectedConfigurationId: runtime.configurationId,
      },
      async () => {
        writerEntered.resolve();
        await releaseWriter.promise;
        return { content: 'queue barrier released', result: undefined };
      },
    );
    const writerAdmission = await Promise.race([
      writerEntered.promise.then(() => 'entered' as const),
      ordinaryWrite.then((receipt) => ({ kind: 'finished' as const, receipt })),
    ]);
    assert.strictEqual(
      writerAdmission,
      'entered',
      typeof writerAdmission === 'object' ? JSON.stringify(writerAdmission.receipt) : 'writer did not enter the queue',
    );

    allowMergeAdmission.resolve();
    const admission = await Promise.race([
      mergeEnqueued.promise.then(() => 'queued' as const),
      merge.then((result) => ({ kind: 'finished' as const, result })),
    ]);
    assert.strictEqual(
      admission,
      'queued',
      typeof admission === 'object' ? JSON.stringify(admission.result) : 'merge did not enter the configuration FIFO',
    );
    await mutateWhileQueued();
    releaseWriter.resolve();
    const [ordinaryReceipt, result] = await Promise.all([ordinaryWrite, merge]);
    assert.strictEqual(ordinaryReceipt.status, 'committed');
    return result;
  } finally {
    releaseWriter.resolve();
    allowMergeAdmission.resolve();
    engineDependencies.runMutation = originalRunMutation;
  }
}

function cloneCandidate(candidate: MergeCandidate): MergeCandidate {
  return {
    ...candidate,
    fileWrite: candidate.fileWrite
      ? {
          contentBase64: candidate.fileWrite.contentBase64,
          witnesses: candidate.fileWrite.witnesses.map((witness) => ({ ...witness })),
        }
      : undefined,
  };
}

function snapshotContract(snapshotId: string, sourceId: string, rootPath: string, readOnly: boolean) {
  const rootUri = pathToFileURL(rootPath).toString();
  return {
    snapshotId,
    sourceId,
    snapshotRoot: rootUri,
    origin: rootUri,
    createdAt: TEST_SNAPSHOT_TIME,
    retentionUntil: '2026-10-28T00:00:00.000Z',
    sourceRevision: `test:${sourceId}`,
    readOnly,
    cleanupPolicy: 'manual' as const,
    contentHash: `sha256:${sourceId}`,
  };
}

async function pathHash(absolutePath: string): Promise<string> {
  const snapshot = await captureMergePath(absolutePath, { retainContent: false });
  return snapshot.state === 'missing' ? MISSING_TARGET_HASH : mergeSnapshotHash(snapshot);
}

async function directoryHash(absolutePath: string): Promise<string> {
  return mergeSnapshotHash(await captureMergePath(absolutePath, { retainContent: false }));
}

function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

suite('Hash-only merge snapshots', () => {
  const tempDirs: string[] = [];

  teardown(async () => {
    await Promise.all(tempDirs.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
    ));
  });

  test('streams raw bytes for large, empty, and binary files without readFile', async () => {
    const rootPath = await createSnapshotWorkspace(tempDirs);
    const largeBytes = Buffer.alloc(2 * 64 * 1024 + 37);
    for (let index = 0; index < largeBytes.length; index += 1) {
      largeBytes[index] = (index * 47 + 13) & 0xff;
    }
    largeBytes.set([0xef, 0xbb, 0xbf, 0x00, 0xff, 0x80], 31);
    const largePath = path.join(rootPath, 'large.bin');
    const emptyPath = path.join(rootPath, 'empty.bin');
    await Promise.all([fs.writeFile(largePath, largeBytes), fs.writeFile(emptyPath, Buffer.alloc(0))]);

    const fsWithReadFile = mutableFsPromises;
    const originalReadFile = fsWithReadFile.readFile;
    fsWithReadFile.readFile = (async () => { throw new Error('readFile used by hash-only capture'); }) as typeof fs.readFile;
    try {
      const [large, empty] = await Promise.all([
        captureMergePath(largePath, { retainContent: false }),
        captureMergePath(emptyPath, { retainContent: false }),
      ]);

      assert.strictEqual(large.state, 'file');
      assert.strictEqual(large.hash, createHash('sha256').update(largeBytes).digest('hex'));
      assert.strictEqual(large.contentBase64, undefined);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(large, 'contentBase64'), true);
      assert.strictEqual(empty.state, 'file');
      assert.strictEqual(empty.hash, createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
      assert.strictEqual(empty.contentBase64, undefined);
    } finally {
      fsWithReadFile.readFile = originalReadFile;
    }
  });

  test('probes the XML prefix after short reads split a UTF-8 character', async () => {
    const rootPath = await createSnapshotWorkspace(tempDirs);
    const filePath = path.join(rootPath, 'rights.xml');
    const bytes = Buffer.from(`<!--x😀y--><Rights xmlns="urn:test"/>${' '.repeat(2 * 64 * 1024)}`, 'utf8');
    await fs.writeFile(filePath, bytes);
    const emojiOffset = bytes.indexOf(Buffer.from('😀', 'utf8'));
    const shortReadSizes = [emojiOffset + 1, 1, 1, 1, 7];
    let readCount = 0;
    let maxReadSize = 0;
    const restore = interceptSnapshotOpen((absolutePath, handle) => absolutePath === filePath
      ? wrapSnapshotHandle(handle, {
          read: (buffer, offset, length, position) => {
            maxReadSize = Math.max(maxReadSize, length);
            const nextSize = shortReadSizes[readCount++] ?? 4096;
            return handle.read(buffer, offset, Math.min(length, nextSize), position);
          },
        })
      : handle);
    try {
      const snapshot = await captureMergePath(filePath, { retainContent: false, probeXmlRootNames: true });

      assert.strictEqual(snapshot.state, 'file');
      assert.strictEqual(snapshot.rootExpandedName, '{urn:test}Rights');
      assert.ok(readCount > shortReadSizes.length, 'capture continued reading through the complete file');
      assert.ok(maxReadSize <= 64 * 1024, 'each stream read is bounded to one chunk');
      assert.strictEqual(snapshot.hash, createHash('sha256').update(bytes).digest('hex'));

      const boundaryPath = path.join(rootPath, 'template.xml');
      await fs.writeFile(boundaryPath, Buffer.from(`<!--${'x'.repeat(64 * 1024)}--><Template/>`, 'utf8'));
      const boundarySnapshot = await captureMergePath(boundaryPath, { retainContent: false, probeXmlRootNames: true });
      assert.strictEqual(boundarySnapshot.state, 'file');
      assert.strictEqual(boundarySnapshot.rootExpandedName, undefined, 'XML probe stops at the first 64 KiB');
    } finally {
      restore();
    }
  });

  test('retains legacy base64 and sequential ordering by default', async () => {
    const rootPath = await createSnapshotWorkspace(tempDirs);
    const contents = new Map([
      ['a.bin', Buffer.from([0xef, 0xbb, 0xbf, 0x00, 0xff])],
      ['b.bin', Buffer.from('second')],
      ['c.bin', Buffer.alloc(0)],
    ]);
    await Promise.all([...contents].map(([name, bytes]) => fs.writeFile(path.join(rootPath, name), bytes)));
    const fsWithReadFile = mutableFsPromises;
    const originalReadFile = fsWithReadFile.readFile;
    const readOrder: string[] = [];
    let activeReads = 0;
    let maxActiveReads = 0;
    fsWithReadFile.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
      const inputPath = String(args[0]);
      readOrder.push(path.basename(inputPath));
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        return await originalReadFile(...args);
      } finally {
        activeReads -= 1;
      }
    }) as typeof fs.readFile;
    try {
      const snapshot = await captureMergePath(rootPath);

      assert.strictEqual(snapshot.state, 'directory');
      assert.deepStrictEqual(snapshot.children.map((entry) => path.basename(entry.relativePath)), ['a.bin', 'b.bin', 'c.bin']);
      assert.deepStrictEqual(snapshot.children.map((entry) => entry.type === 'file' ? entry.contentBase64 : undefined), [...contents.values()].map((bytes) => bytes.toString('base64')));
      assert.deepStrictEqual(readOrder, ['a.bin', 'b.bin', 'c.bin']);
      assert.strictEqual(maxActiveReads, 1);

      fsWithReadFile.readFile = originalReadFile;
      const hashOnly = await captureMergePath(rootPath, { retainContent: false });
      assert.strictEqual(mergeSnapshotHash(hashOnly), mergeSnapshotHash(snapshot));
      assert.strictEqual(mutationFingerprint(hashOnly), mutationFingerprint(snapshot));
    } finally {
      fsWithReadFile.readFile = originalReadFile;
    }
  });

  test('reads adjacent files in pairs and drains each pair before serial recursion', async () => {
    const rootPath = await createSnapshotWorkspace(tempDirs);
    await fs.writeFile(path.join(rootPath, 'a.bin'), 'a');
    await fs.writeFile(path.join(rootPath, 'b.bin'), 'b');
    await fs.mkdir(path.join(rootPath, 'm-nested'));
    await fs.writeFile(path.join(rootPath, 'm-nested', 'nested.bin'), 'nested');
    await fs.writeFile(path.join(rootPath, 'z1.bin'), 'z1');
    await fs.writeFile(path.join(rootPath, 'z2.bin'), 'z2');

    const pairGate = deferred<void>();
    const pairReadsStarted = deferred<void>();
    const events: string[] = [];
    let firstPairReads = 0;
    let activeHandles = 0;
    let maxActiveHandles = 0;
    const restore = interceptSnapshotOpen((absolutePath, handle) => {
      const relativePath = path.relative(rootPath, absolutePath).replace(/\\/gu, '/');
      events.push(`open:${relativePath}`);
      activeHandles += 1;
      maxActiveHandles = Math.max(maxActiveHandles, activeHandles);
      let firstRead = true;
      return wrapSnapshotHandle(handle, {
        read: async (buffer, offset, length, position) => {
          if (firstRead) {
            firstRead = false;
            if (relativePath === 'a.bin' || relativePath === 'b.bin') {
              firstPairReads += 1;
              if (firstPairReads === 2) { pairReadsStarted.resolve(); }
              await pairGate.promise;
            }
          }
          return handle.read(buffer, offset, length, position);
        },
        close: async () => {
          events.push(`close:${relativePath}`);
          activeHandles -= 1;
          await handle.close();
        },
      });
    });
    const capture = captureMergePath(rootPath, { retainContent: false });
    try {
      const pairStarted = await Promise.race([
        pairReadsStarted.promise.then(() => true),
        capture.then(() => false),
      ]);
      assert.strictEqual(pairStarted, true, 'the first two neighboring files were opened together');
      assert.deepStrictEqual(events.filter((event) => event.startsWith('open:')).slice(0, 2).sort(), ['open:a.bin', 'open:b.bin']);
      assert.strictEqual(events.some((event) => event.startsWith('open:m-nested/')), false);
      pairGate.resolve();
      const snapshot = await capture;

      assert.strictEqual(snapshot.state, 'directory');
      assert.deepStrictEqual(snapshot.children.map((entry) => path.basename(entry.relativePath)), ['a.bin', 'b.bin', 'm-nested', 'z1.bin', 'z2.bin']);
      assert.ok(maxActiveHandles <= 2);
      assert.ok(events.indexOf('open:m-nested/nested.bin') > events.indexOf('close:a.bin'));
      assert.ok(events.indexOf('open:m-nested/nested.bin') > events.indexOf('close:b.bin'));
      assert.ok(events.indexOf('open:z1.bin') > events.indexOf('close:m-nested/nested.bin'));
      assert.strictEqual(mergeSnapshotHash(snapshot), mergeSnapshotHash(await captureMergePath(rootPath)));
    } finally {
      pairGate.resolve();
      restore();
      await capture.catch(() => undefined);
    }
  });

  test('drains a batch, closes handles, and chooses the first input path error', async () => {
    const rootPath = await createSnapshotWorkspace(tempDirs);
    await fs.writeFile(path.join(rootPath, 'a.bin'), 'a');
    await fs.writeFile(path.join(rootPath, 'b.bin'), 'b');
    const releaseA = deferred<void>();
    const releaseB = deferred<void>();
    const bothStarted = deferred<void>();
    const bFailed = deferred<void>();
    const closed: string[] = [];
    let started = 0;
    const restore = interceptSnapshotOpen((absolutePath, handle) => {
      const name = path.basename(absolutePath);
      let firstRead = true;
      return wrapSnapshotHandle(handle, {
        read: async () => {
          if (firstRead) {
            firstRead = false;
            started += 1;
            if (started === 2) { bothStarted.resolve(); }
            await (name === 'a.bin' ? releaseA.promise : releaseB.promise);
            if (name === 'b.bin') {
              bFailed.resolve();
              throw new Error('error from b');
            }
            throw new Error('error from a');
          }
          throw new Error('unexpected read');
        },
        close: async () => {
          closed.push(name);
          await handle.close();
        },
      });
    });
    const capture = captureMergePath(rootPath, { retainContent: false });
    try {
      const bothStartedOrDone = await Promise.race([bothStarted.promise.then(() => true), capture.then(() => false, () => false)]);
      assert.strictEqual(bothStartedOrDone, true);
      releaseB.resolve();
      await bFailed.promise;
      releaseA.resolve();
      await assert.rejects(capture, /error from a/u);
      assert.deepStrictEqual(closed.sort(), ['a.bin', 'b.bin']);
    } finally {
      releaseA.resolve();
      releaseB.resolve();
      restore();
      await capture.catch(() => undefined);
    }
  });

  test('drains and closes a batch before reporting cancellation', async () => {
    const rootPath = await createSnapshotWorkspace(tempDirs);
    await fs.writeFile(path.join(rootPath, 'a.bin'), 'a');
    await fs.writeFile(path.join(rootPath, 'b.bin'), 'b');
    const readGate = deferred<void>();
    const bothStarted = deferred<void>();
    const closed: string[] = [];
    let cancelled = false;
    let started = 0;
    const restore = interceptSnapshotOpen((absolutePath, handle) => {
      const name = path.basename(absolutePath);
      let firstRead = true;
      return wrapSnapshotHandle(handle, {
        read: async (buffer, offset, length, position) => {
          if (firstRead) {
            firstRead = false;
            started += 1;
            if (started === 2) { bothStarted.resolve(); }
            await readGate.promise;
          }
          return handle.read(buffer, offset, length, position);
        },
        close: async () => {
          closed.push(name);
          await handle.close();
        },
      });
    });
    const capture = captureMergePath(rootPath, {
      retainContent: false,
      cancellation: { get isCancellationRequested() { return cancelled; } },
    });
    try {
      const bothStartedOrDone = await Promise.race([bothStarted.promise.then(() => true), capture.then(() => false, () => false)]);
      assert.strictEqual(bothStartedOrDone, true);
      cancelled = true;
      readGate.resolve();
      await assert.rejects(capture, /comparison cancelled/iu);
      assert.deepStrictEqual(closed.sort(), ['a.bin', 'b.bin']);
    } finally {
      readGate.resolve();
      restore();
      await capture.catch(() => undefined);
    }
  });

  test('reports cancellation requested while closing a direct hash-only file', async () => {
    const rootPath = await createSnapshotWorkspace(tempDirs);
    const filePath = path.join(rootPath, 'a.bin');
    await fs.writeFile(filePath, 'a');
    let cancelled = false;
    const restore = interceptSnapshotOpen((absolutePath, handle) => absolutePath === filePath
      ? wrapSnapshotHandle(handle, {
          close: async () => {
            cancelled = true;
            await handle.close();
          },
        })
      : handle);
    try {
      await assert.rejects(
        captureMergePath(filePath, { retainContent: false, cancellation: { get isCancellationRequested() { return cancelled; } } }),
        /comparison cancelled/iu,
      );
    } finally {
      restore();
    }
  });
});

type SnapshotHandle = Awaited<ReturnType<typeof fs.open>>;

function interceptSnapshotOpen(
  wrap: (filePath: string, handle: SnapshotHandle) => SnapshotHandle | Promise<SnapshotHandle>,
): () => void {
  const fsWithOpen = mutableFsPromises;
  const originalOpen = fsWithOpen.open;
  fsWithOpen.open = (async (...args: Parameters<typeof fs.open>) => {
    const filePath = String(args[0]);
    const handle = await originalOpen(...args);
    return wrap(filePath, handle);
  }) as typeof fs.open;
  return () => { fsWithOpen.open = originalOpen; };
}

function wrapSnapshotHandle(
  handle: SnapshotHandle,
  hooks: {
    readonly read?: (buffer: Buffer, offset: number, length: number, position: number | null) => Promise<{ bytesRead: number; buffer: Buffer }>;
    readonly close?: () => Promise<void>;
  },
): SnapshotHandle {
  return new Proxy(handle, {
    get(target, property, receiver) {
      if (property === 'read' && hooks.read) { return hooks.read; }
      if (property === 'close' && hooks.close) { return hooks.close; }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

async function createSnapshotWorkspace(tempDirs: string[]): Promise<string> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-snapshot-'));
  tempDirs.push(rootPath);
  return rootPath;
}
