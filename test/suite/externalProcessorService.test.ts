import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { InfobaseCanonicalIdentity } from '../../src/infobases/infobaseCanonicalIdentity';
import { InfobaseConfigurationOperationQueue } from '../../src/infobases/infobaseConfigurationOperationQueue';
import type { ConfiguratorProcessOutcome } from '../../src/services/configurator/configuratorProcessRunner';
import type { ConfiguratorProcessRunnerOptions } from '../../src/services/configurator/configuratorProcessRunner';
import {
  ExternalProcessorService,
  type ExternalProcessorServiceDependencies,
} from '../../src/services/externalProcessor/externalProcessorService';
import { resolveExternalProcessorResourceIdentity } from '../../src/services/externalProcessor/externalProcessorResourceIdentity';

const ROOT = path.resolve('C:\\issue99-tests');
const EPF = path.join(ROOT, 'Processor.epf');
const ERF = path.join(ROOT, 'Report.erf');
const EPF_XML = path.join(ROOT, 'Processor_src', 'Processor.xml');
const ERF_XML = path.join(ROOT, 'Report_src', 'Report.xml');
const DB = path.join(ROOT, 'db');
const DB_FILE = path.join(DB, '1Cv8.1CD');

suite('externalProcessorService contract', () => {
  test('dump EPF/ERF publishes XML, preserves redacted log and uses exact format', async () => {
    for (const [input, format, rootKind] of [
      [EPF, 'Plain', 'ExternalDataProcessor'],
      [ERF, 'Hierarchical', 'ExternalReport'],
    ] as const) {
      const harness = createHarness();
      harness.fs.addFile(input, 'binary');
      harness.produceDumpRoot = rootKind;
      const output = path.join(ROOT, `${path.basename(input, path.extname(input))}_src`);

      const result = await harness.service.dump({
        externalFilePath: input,
        outputDirectory: output,
        format,
        context: { kind: 'standalone', acknowledgeTypeLoss: true },
      });

      assert.strictEqual(result.state, 'completed');
      if (result.state !== 'completed') {
        continue;
      }
      assert.strictEqual(result.artifactPath, output);
      assert.strictEqual(
        result.rootXmlPath,
        path.join(output, `${path.basename(input, path.extname(input))}.xml`),
      );
      assert.match(result.warning ?? '', /reference types/iu);
      assert.strictEqual(result.combinedLog, 'safe <redacted>');
      assert.ok(harness.fs.has(output));
      assert.ok(harness.fs.removed.includes(harness.stagingRoot!), 'staging root must be removed after publish');
      const argv = harness.processCalls[0].batchArguments.executionArgs;
      assert.deepStrictEqual(argv.slice(-5), [
        '/DumpExternalDataProcessorOrReportToFiles',
        path.join(harness.stagingRoot!, path.basename(input, path.extname(input))),
        input,
        '-Format',
        format,
      ]);
      assert.strictEqual(argv.includes('/F'), false);
    }
  });

  test('build detects namespaced/versioned EPF and ERF roots and derives destination', async () => {
    for (const [rootXml, kind, extension] of [
      [EPF_XML, 'ExternalDataProcessor', '.epf'],
      [ERF_XML, 'ExternalReport', '.erf'],
    ] as const) {
      const harness = createHarness();
      harness.fs.addFile(rootXml, metadataXml(kind));
      harness.produceBuildFile = true;

      const result = await harness.service.build({
        rootXmlPath: rootXml,
        context: { kind: 'standalone', acknowledgeTypeLoss: true },
      });

      assert.strictEqual(result.state, 'completed');
      if (result.state !== 'completed') {
        continue;
      }
      const expected = path.join(ROOT, `${path.basename(path.dirname(rootXml)).replace(/_src$/iu, '')}_built${extension}`);
      assert.strictEqual(result.artifactPath, expected);
      const argv = harness.processCalls[0].batchArguments.executionArgs;
      const operation = argv.indexOf('/LoadExternalDataProcessorOrReportFromFiles');
      assert.ok(operation > 0);
      assert.strictEqual(argv[operation + 1], rootXml);
      assert.strictEqual(argv[operation + 2], harness.stagingArtifact);
      assert.strictEqual(argv.some((token) => token.toLocaleLowerCase() === '-format'), false);
    }
  });

  test('rejects invalid context, missing/non-file input, unsupported root and existing output before process', async () => {
    const harness = createHarness();
    harness.fs.addDirectory(EPF);
    const notFile = await harness.service.dump({
      externalFilePath: EPF,
      outputDirectory: path.join(ROOT, 'out'),
      format: 'Plain',
      context: { kind: 'standalone', acknowledgeTypeLoss: true },
    });
    assertResultCode(notFile, 'EXTERNAL_INPUT_NOT_FILE');

    const missing = await harness.service.dump({
      externalFilePath: path.join(ROOT, 'missing.epf'),
      outputDirectory: path.join(ROOT, 'out'),
      format: 'Plain',
      context: { kind: 'standalone', acknowledgeTypeLoss: true },
    });
    assertResultCode(missing, 'EXTERNAL_INPUT_MISSING');

    harness.fs.addFile(EPF_XML, '<MetaDataObject version="2.0"><Catalog/></MetaDataObject>');
    const unsupported = await harness.service.build({
      rootXmlPath: EPF_XML,
      context: { kind: 'standalone', acknowledgeTypeLoss: true },
    });
    assertResultCode(unsupported, 'EXTERNAL_ROOT_UNSUPPORTED');

    const invalidContext = await harness.service.dump({
      externalFilePath: path.join(ROOT, 'valid.epf'),
      outputDirectory: path.join(ROOT, 'out'),
      format: 'Plain',
      context: { kind: 'standalone', acknowledgeTypeLoss: false } as never,
    });
    assert.ok(
      invalidContext.state === 'failed'
      && ['EXTERNAL_INPUT_MISSING', 'EXTERNAL_CONTEXT_INVALID'].includes(invalidContext.code),
    );

    const overwriteHarness = createHarness();
    overwriteHarness.fs.addFile(EPF, 'binary');
    overwriteHarness.fs.addDirectory(path.join(ROOT, 'existing'));
    const overwrite = await overwriteHarness.service.dump({
      externalFilePath: EPF,
      outputDirectory: path.join(ROOT, 'existing'),
      format: 'Plain',
      context: { kind: 'standalone', acknowledgeTypeLoss: true },
    });
    assertResultCode(overwrite, 'EXTERNAL_OUTPUT_EXISTS');
    assert.strictEqual(harness.processCalls.length + overwriteHarness.processCalls.length, 0);
  });

  test('file-infobase context contributes canonical queue key and redacts password diagnostics', async () => {
    const harness = createHarness();
    harness.fs.addFile(EPF, 'binary');
    harness.produceDumpRoot = 'ExternalDataProcessor';
    harness.infobaseIdentity = fileIdentity();

    const result = await harness.service.dump({
      externalFilePath: EPF,
      outputDirectory: path.join(ROOT, 'db-dump'),
      format: 'Hierarchical',
      context: {
        kind: 'infobase',
        infobasePath: DB,
        credentials: { user: 'operator', password: 'secret' },
      },
    });

    assert.strictEqual(result.state, 'completed');
    assert.strictEqual(harness.queueCalls.length, 1);
    assert.deepStrictEqual(harness.queueCalls[0], [
      `resource:${EPF}`,
      `resource:${path.join(ROOT, 'db-dump')}`,
      fileIdentity().canonicalTargetId,
    ]);
    const args = harness.processCalls[0].batchArguments;
    assert.ok(args.executionArgs.includes('/F'));
    assert.ok(args.executionArgs.includes('secret'));
    assert.strictEqual(args.diagnosticArgs.includes('secret'), false);
    assert.ok(args.diagnosticArgs.includes('<redacted>'));
  });

  test('shared composite queue serializes operations that read the same canonical input', async () => {
    const harness = createHarness(new InfobaseConfigurationOperationQueue());
    harness.fs.addFile(EPF, 'binary');
    harness.produceDumpRoot = 'ExternalDataProcessor';
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    let invocation = 0;
    harness.processHook = async () => {
      invocation += 1;
      if (invocation === 1) {
        firstStarted();
        await firstGate;
      }
    };

    const first = harness.service.dump({
      externalFilePath: EPF,
      outputDirectory: path.join(ROOT, 'serialized-a'),
      format: 'Plain',
      context: { kind: 'standalone', acknowledgeTypeLoss: true },
    });
    await started;
    const second = harness.service.dump({
      externalFilePath: EPF,
      outputDirectory: path.join(ROOT, 'serialized-b'),
      format: 'Plain',
      context: { kind: 'standalone', acknowledgeTypeLoss: true },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(harness.processCalls.length, 1, 'second process must wait for the shared input key');
    releaseFirst();
    const results = await Promise.all([first, second]);
    assert.deepStrictEqual(results.map(({ state }) => state), ['completed', 'completed']);
    assert.strictEqual(harness.processCalls.length, 2);
  });

  test('failed process cleans staging while inDoubt preserves it and returns staging path', async () => {
    const failedHarness = createHarness();
    failedHarness.fs.addFile(EPF, 'binary');
    failedHarness.outcome = failedOutcome();
    const failed = await failedHarness.service.dump({
      externalFilePath: EPF,
      outputDirectory: path.join(ROOT, 'failed'),
      format: 'Plain',
      context: { kind: 'standalone', acknowledgeTypeLoss: true },
    });
    assertResultCode(failed, 'CONFIGURATOR_FAILED');
    assert.ok(failedHarness.fs.removed.includes(failedHarness.stagingRoot!));

    const doubtfulHarness = createHarness();
    doubtfulHarness.fs.addFile(EPF, 'binary');
    doubtfulHarness.outcome = inDoubtOutcome();
    const doubtful = await doubtfulHarness.service.dump({
      externalFilePath: EPF,
      outputDirectory: path.join(ROOT, 'doubtful'),
      format: 'Plain',
      context: { kind: 'standalone', acknowledgeTypeLoss: true },
    });
    assert.strictEqual(doubtful.state, 'inDoubt');
    if (doubtful.state === 'inDoubt') {
      assert.strictEqual(doubtful.stagingPath, doubtfulHarness.stagingRoot);
      assert.strictEqual(doubtful.combinedLog, 'safe <redacted>');
    }
    assert.strictEqual(doubtfulHarness.fs.removed.includes(doubtfulHarness.stagingRoot!), false);
    assert.ok(doubtfulHarness.fs.has(doubtfulHarness.stagingRoot!));
  });

  test('acknowledged process without artifact fails postcondition and cleans staging', async () => {
    const harness = createHarness();
    harness.fs.addFile(EPF_XML, metadataXml('ExternalDataProcessor'));
    const result = await harness.service.build({
      rootXmlPath: EPF_XML,
      destinationPath: path.join(ROOT, 'missing-artifact.epf'),
      context: { kind: 'standalone', acknowledgeTypeLoss: true },
    });

    assertResultCode(result, 'EXTERNAL_POSTCONDITION_FAILED');
    assert.ok(harness.fs.removed.includes(harness.stagingRoot!));
  });

  test('build publication race fails closed and never replaces the racer artifact', async () => {
    const harness = createHarness();
    harness.fs.addFile(EPF_XML, metadataXml('ExternalDataProcessor'));
    harness.produceBuildFile = true;
    const destination = path.join(ROOT, 'race.epf');
    harness.fs.beforeLink = (_source, target) => {
      if (path.resolve(target) === path.resolve(destination)) {
        harness.fs.addFile(destination, 'racer-artifact');
      }
    };

    const result = await harness.service.build({
      rootXmlPath: EPF_XML,
      destinationPath: destination,
      context: { kind: 'standalone', acknowledgeTypeLoss: true },
    });

    assertResultCode(result, 'EXTERNAL_PUBLISH_CONFLICT');
    assert.strictEqual(await harness.fs.readFile(destination, 'utf8'), 'racer-artifact');
  });

  test('POSIX dump reports a partially visible destination as inDoubt without replacement', async () => {
    const harness = createHarness(undefined, { platform: 'linux' });
    harness.fs.addFile(EPF, 'binary');
    harness.produceDumpRoot = 'ExternalDataProcessor';
    const output = path.join(ROOT, 'partial-posix');
    harness.fs.linkFailure = (source, target) => path.dirname(path.resolve(target)) === path.resolve(output)
      ? ioFailure('copy failed after destination claim')
      : undefined;

    const result = await harness.service.dump({
      externalFilePath: EPF,
      outputDirectory: output,
      format: 'Plain',
      context: { kind: 'standalone', acknowledgeTypeLoss: true },
    });

    assert.strictEqual(result.state, 'inDoubt');
    if (result.state === 'inDoubt') {
      assert.strictEqual(result.publishedArtifactPath, output);
      assert.strictEqual(result.stagingPath, harness.stagingRoot);
    }
    assert.ok(harness.fs.has(output), 'the claimed destination may already be visible');
  });

  test('lost process outcome quarantines all resource keys and rejects the next same-resource request', async () => {
    const queue = new InfobaseConfigurationOperationQueue();
    const harness = createHarness(queue);
    harness.fs.addFile(EPF, 'binary');
    harness.processHook = async () => { throw new Error('runner transport lost'); };

    const first = await harness.service.dump({
      externalFilePath: EPF,
      outputDirectory: path.join(ROOT, 'runner-lost-a'),
      format: 'Plain',
      context: { kind: 'standalone', acknowledgeTypeLoss: true },
    });
    assert.strictEqual(first.state, 'inDoubt');
    const callsAfterFirst = harness.processCalls.length;

    const second = await harness.service.dump({
      externalFilePath: EPF,
      outputDirectory: path.join(ROOT, 'runner-lost-b'),
      format: 'Plain',
      context: { kind: 'standalone', acknowledgeTypeLoss: true },
    });
    assertResultCode(second, 'EXTERNAL_RECOVERY_REQUIRED');
    assert.strictEqual(harness.processCalls.length, callsAfterFirst);
  });

  test('unsafe process-tree termination quarantines future operations on the same resource', async () => {
    const queue = new InfobaseConfigurationOperationQueue();
    const harness = createHarness(queue);
    harness.fs.addFile(EPF, 'binary');
    harness.produceDumpRoot = 'ExternalDataProcessor';
    harness.outcome = {
      ...acknowledgedOutcome(),
      termination: { terminated: false, hardKillUsed: true, survivingPids: [4242], errors: [] },
    };

    const first = await harness.service.dump({
      externalFilePath: EPF,
      outputDirectory: path.join(ROOT, 'unsafe-termination-a'),
      format: 'Plain',
      context: { kind: 'standalone', acknowledgeTypeLoss: true },
    });
    assert.strictEqual(first.state, 'completed');
    const callsAfterFirst = harness.processCalls.length;
    const second = await harness.service.dump({
      externalFilePath: EPF,
      outputDirectory: path.join(ROOT, 'unsafe-termination-b'),
      format: 'Plain',
      context: { kind: 'standalone', acknowledgeTypeLoss: true },
    });
    assertResultCode(second, 'EXTERNAL_RECOVERY_REQUIRED');
    assert.strictEqual(harness.processCalls.length, callsAfterFirst);
  });

  test('log scrub failure is inDoubt and never returns raw log content', async () => {
    const harness = createHarness();
    harness.fs.addFile(EPF, 'binary');
    harness.produceDumpRoot = 'ExternalDataProcessor';
    harness.fs.rmFailure = (target) => path.basename(target) === 'configurator.log'
      ? ioFailure('remove denied')
      : undefined;
    harness.fs.writeFailure = (target) => path.basename(target) === 'configurator.log'
      ? ioFailure('truncate denied')
      : undefined;

    const result = await harness.service.dump({
      externalFilePath: EPF,
      outputDirectory: path.join(ROOT, 'scrub-failure'),
      format: 'Plain',
      context: { kind: 'standalone', acknowledgeTypeLoss: true },
    });

    assert.strictEqual(result.state, 'inDoubt');
    if (result.state === 'inDoubt') {
      assert.strictEqual(result.code, 'EXTERNAL_POSTCONDITION_IN_DOUBT');
      assert.strictEqual(result.combinedLog.includes('raw-secret'), false);
      assert.strictEqual(result.stagingPath, harness.stagingRoot);
    }
  });

  test('post-publication verification and cleanup failures identify both destination and staging', async () => {
    for (const failureKind of ['verify', 'cleanup'] as const) {
      const harness = createHarness();
      harness.fs.addFile(EPF_XML, metadataXml('ExternalDataProcessor'));
      harness.produceBuildFile = true;
      const destination = path.join(ROOT, `published-${failureKind}.epf`);
      harness.fs.afterLink = (_source, target) => {
        if (path.resolve(target) !== path.resolve(destination)) {
          return;
        }
        if (failureKind === 'verify') {
          harness.fs.statFailure = (candidate) => path.resolve(candidate) === path.resolve(destination)
            ? ioFailure('published verification denied')
            : undefined;
        } else {
          harness.fs.rmFailure = (candidate) => path.resolve(candidate) === path.resolve(harness.stagingRoot!)
            ? ioFailure('staging cleanup denied')
            : undefined;
        }
      };

      const result = await harness.service.build({
        rootXmlPath: EPF_XML,
        destinationPath: destination,
        context: { kind: 'standalone', acknowledgeTypeLoss: true },
      });

      assert.strictEqual(result.state, 'inDoubt', failureKind);
      if (result.state === 'inDoubt') {
        assert.strictEqual(result.publishedArtifactPath, destination);
        assert.strictEqual(result.stagingPath, harness.stagingRoot);
      }
    }
  });

  test('dump rejects a root kind that does not match the EPF/ERF extension', async () => {
    const harness = createHarness();
    harness.fs.addFile(EPF, 'binary');
    harness.produceDumpRoot = 'ExternalReport';

    const result = await harness.service.dump({
      externalFilePath: EPF,
      outputDirectory: path.join(ROOT, 'wrong-dump-kind'),
      format: 'Plain',
      context: { kind: 'standalone', acknowledgeTypeLoss: true },
    });

    assertResultCode(result, 'EXTERNAL_POSTCONDITION_FAILED');
  });

  test('resolver, resource identity and queue dependency exceptions return closed results', async () => {
    const cases: Array<{
      readonly name: string;
      readonly dependencies: Partial<ExternalProcessorServiceDependencies>;
      readonly expectedCode: string;
    }> = [
      {
        name: 'identity',
        dependencies: { resolveResourceIdentity: async () => { throw ioFailure('identity unavailable'); } },
        expectedCode: 'EXTERNAL_IO_FAILED',
      },
      {
        name: 'resolver',
        dependencies: { resolveExecutable: () => { throw ioFailure('resolver unavailable'); } },
        expectedCode: 'CONFIGURATOR_UNAVAILABLE',
      },
      {
        name: 'queue',
        dependencies: { queue: { runComposite: async () => { throw ioFailure('queue unavailable'); } } },
        expectedCode: 'EXTERNAL_IO_FAILED',
      },
    ];
    for (const scenario of cases) {
      const harness = createHarness(undefined, scenario.dependencies);
      harness.fs.addFile(EPF, 'binary');
      const result = await harness.service.dump({
        externalFilePath: EPF,
        outputDirectory: path.join(ROOT, `dependency-${scenario.name}`),
        format: 'Plain',
        context: { kind: 'standalone', acknowledgeTypeLoss: true },
      });
      assertResultCode(result, scenario.expectedCode);
    }
  });

  test('resource identity resolves symlinks and missing descendants through their real parent', async function () {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cdt-issue99-identity-'));
    try {
      const realDirectory = path.join(tempRoot, 'real');
      const aliasDirectory = path.join(tempRoot, 'alias');
      fs.mkdirSync(realDirectory);
      fs.symlinkSync(realDirectory, aliasDirectory, 'junction');
      const existing = path.join(realDirectory, 'Processor.epf');
      fs.writeFileSync(existing, 'binary');

      assert.strictEqual(
        await resolveExternalProcessorResourceIdentity(path.join(aliasDirectory, 'Processor.epf'), true),
        await resolveExternalProcessorResourceIdentity(existing, true),
      );
      const physicalRealDirectory = await fs.promises.realpath(realDirectory);
      assert.strictEqual(
        await resolveExternalProcessorResourceIdentity(path.join(aliasDirectory, 'missing', 'result.epf'), false),
        `external-resource:${normalizeIdentityPath(path.join(physicalRealDirectory, 'missing', 'result.epf'))}`,
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

interface Entry {
  kind: 'file' | 'directory';
  content: string;
  size: number;
}

class FakeFileSystem {
  private entries = new Map<string, Entry>();
  readonly removed: string[] = [];
  beforeLink?: (sourcePath: string, destinationPath: string) => void;
  afterLink?: (sourcePath: string, destinationPath: string) => void;
  linkFailure?: (sourcePath: string, destinationPath: string) => Error | undefined;
  rmFailure?: (targetPath: string) => Error | undefined;
  writeFailure?: (targetPath: string) => Error | undefined;
  statFailure?: (targetPath: string) => Error | undefined;

  addFile(filePath: string, content: string): void {
    this.entries.set(path.resolve(filePath), { kind: 'file', content, size: Buffer.byteLength(content) || 1 });
  }

  addDirectory(directoryPath: string): void {
    this.entries.set(path.resolve(directoryPath), { kind: 'directory', content: '', size: 0 });
  }

  has(filePath: string): boolean {
    return this.entries.has(path.resolve(filePath));
  }

  async stat(filePath: string): Promise<fs.Stats> {
    const fault = this.statFailure?.(path.resolve(filePath));
    if (fault) {
      throw fault;
    }
    const entry = this.entries.get(path.resolve(filePath));
    if (!entry) {
      throw missing();
    }
    return {
      size: entry.size,
      isFile: () => entry.kind === 'file',
      isDirectory: () => entry.kind === 'directory',
    } as fs.Stats;
  }

  async readFile(filePath: string, _encoding: BufferEncoding): Promise<string> {
    const entry = this.entries.get(path.resolve(filePath));
    if (!entry || entry.kind !== 'file') {
      throw missing();
    }
    return entry.content;
  }

  async readdir(directoryPath: string, _options: { withFileTypes: true }): Promise<fs.Dirent[]> {
    const directory = path.resolve(directoryPath);
    if (!this.entries.has(directory)) {
      throw missing();
    }
    return [...this.entries.entries()]
      .filter(([candidate]) => path.dirname(candidate) === directory)
      .map(([candidate, entry]) => ({
        name: path.basename(candidate),
        isFile: () => entry.kind === 'file',
        isDirectory: () => entry.kind === 'directory',
      } as fs.Dirent));
  }

  async mkdir(directoryPath: string): Promise<void> {
    const resolved = path.resolve(directoryPath);
    if (this.entries.has(resolved)) {
      throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    }
    this.addDirectory(resolved);
  }

  async rename(sourcePath: string, destinationPath: string): Promise<void> {
    const source = path.resolve(sourcePath);
    const destination = path.resolve(destinationPath);
    const sourceEntry = this.entries.get(source);
    if (!sourceEntry) {
      throw missing();
    }
    if (this.entries.has(destination)) {
      throw exists();
    }
    const moves = [...this.entries.entries()]
      .filter(([candidate]) => candidate === source || candidate.startsWith(`${source}${path.sep}`));
    for (const [candidate] of moves) {
      this.entries.delete(candidate);
    }
    for (const [candidate, entry] of moves) {
      this.entries.set(destination + candidate.slice(source.length), entry);
    }
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    const source = path.resolve(existingPath);
    const destination = path.resolve(newPath);
    const sourceEntry = this.entries.get(source);
    if (!sourceEntry || sourceEntry.kind !== 'file') {
      throw missing();
    }
    this.beforeLink?.(source, destination);
    const fault = this.linkFailure?.(source, destination);
    if (fault) {
      throw fault;
    }
    if (this.entries.has(destination)) {
      throw exists();
    }
    this.entries.set(destination, { ...sourceEntry });
    this.afterLink?.(source, destination);
  }

  async unlink(filePath: string): Promise<void> {
    const resolved = path.resolve(filePath);
    const entry = this.entries.get(resolved);
    if (!entry || entry.kind !== 'file') {
      throw missing();
    }
    this.entries.delete(resolved);
  }

  async writeFile(filePath: string, data: string, _encoding: BufferEncoding): Promise<void> {
    const resolved = path.resolve(filePath);
    const fault = this.writeFailure?.(resolved);
    if (fault) {
      throw fault;
    }
    this.addFile(resolved, data);
  }

  async rm(targetPath: string, _options: { recursive: true; force: true }): Promise<void> {
    const target = path.resolve(targetPath);
    const fault = this.rmFailure?.(target);
    if (fault) {
      throw fault;
    }
    this.removed.push(target);
    for (const candidate of [...this.entries.keys()]) {
      if (candidate === target || candidate.startsWith(`${target}${path.sep}`)) {
        this.entries.delete(candidate);
      }
    }
  }
}

interface Harness {
  readonly service: ExternalProcessorService;
  readonly fs: FakeFileSystem;
  readonly processCalls: ConfiguratorProcessRunnerOptions[];
  readonly queueCalls: string[][];
  outcome: ConfiguratorProcessOutcome;
  produceDumpRoot?: 'ExternalDataProcessor' | 'ExternalReport';
  produceBuildFile: boolean;
  processHook?: (options: ConfiguratorProcessRunnerOptions) => Promise<void>;
  infobaseIdentity?: InfobaseCanonicalIdentity;
  stagingRoot?: string;
  stagingArtifact?: string;
}

function createHarness(
  queue?: InfobaseConfigurationOperationQueue,
  overrides: Partial<ExternalProcessorServiceDependencies> = {}
): Harness {
  const fileSystem = new FakeFileSystem();
  const processCalls: ConfiguratorProcessRunnerOptions[] = [];
  const queueCalls: string[][] = [];
  const harness = {
    fs: fileSystem,
    processCalls,
    queueCalls,
    outcome: acknowledgedOutcome(),
    produceBuildFile: false,
  } as Harness;
  const dependencies: ExternalProcessorServiceDependencies = {
    fileSystem,
    queue: queue ?? {
      runComposite: async (identities, operation) => {
        queueCalls.push(identities.map((identity) =>
          typeof identity === 'string' ? identity : identity.canonicalTargetId));
        return operation();
      },
    },
    resolveInfobaseIdentity: async () => harness.infobaseIdentity ?? fileIdentity(),
    resolveExecutable: () => ({
      status: 'resolved',
      path: 'C:\\1C\\1cv8.exe',
      version: '8.3.27.1859',
      source: 'discovery',
    }),
    resolveResourceIdentity: async (resourcePath) => `resource:${path.resolve(resourcePath)}`,
    createStagingName: () => '.stage',
    runProcess: async (options) => {
      processCalls.push(options);
      await harness.processHook?.(options);
      const operation = options.batchArguments.executionArgs;
      const dumpIndex = operation.indexOf('/DumpExternalDataProcessorOrReportToFiles');
      const loadIndex = operation.indexOf('/LoadExternalDataProcessorOrReportFromFiles');
      const configuratorArtifact = dumpIndex >= 0 ? operation[dumpIndex + 1] : operation[loadIndex + 2];
      harness.stagingRoot = path.dirname(configuratorArtifact);
      harness.stagingArtifact = dumpIndex >= 0 ? harness.stagingRoot : configuratorArtifact;
      if (harness.outcome.status === 'acknowledged') {
        if (dumpIndex >= 0 && harness.produceDumpRoot) {
          fileSystem.addFile(`${configuratorArtifact}.xml`, metadataXml(harness.produceDumpRoot));
          fileSystem.addFile(`${configuratorArtifact}.bin`, 'plain auxiliary data');
          if (operation[operation.indexOf('-Format') + 1] === 'Hierarchical') {
            fileSystem.addDirectory(configuratorArtifact);
            fileSystem.addFile(path.join(configuratorArtifact, 'child.xml'), '<child/>');
          }
        }
        if (loadIndex >= 0 && harness.produceBuildFile) {
          fileSystem.addFile(configuratorArtifact, 'compiled-binary');
        }
      }
      return harness.outcome;
    },
    ...overrides,
  };
  (harness as { service: ExternalProcessorService }).service = new ExternalProcessorService(dependencies);
  return harness;
}

function metadataXml(kind: 'ExternalDataProcessor' | 'ExternalReport'): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<md:MetaDataObject xmlns:md="urn:test" version="2.17">',
    `  <md:${kind}><md:Name>Object</md:Name></md:${kind}>`,
    '</md:MetaDataObject>',
  ].join('');
}

function fileIdentity(): InfobaseCanonicalIdentity {
  return {
    kind: 'file',
    connectionKind: 'databasePath',
    canonicalTargetId: 'file:databasePath:c:/issue99-tests/db/1cv8.1cd',
    key: 'file:databasePath:c:/issue99-tests/db/1cv8.1cd',
    resolvedPath: DB,
    databaseFilePath: DB_FILE,
    exists: true,
  };
}

function acknowledgedOutcome(): ConfiguratorProcessOutcome {
  return {
    status: 'acknowledged',
    started: true,
    effectPossible: true,
    exitCode: 0,
    signal: null,
    combinedLog: 'safe <redacted>',
    logTruncated: false,
    diagnostic: { executablePath: 'C:\\1C\\1cv8.exe', args: [] },
  };
}

function failedOutcome(): ConfiguratorProcessOutcome {
  return {
    status: 'failed',
    errorCode: 'CONFIGURATOR_SPAWN_FAILED',
    retryable: true,
    started: false,
    effectPossible: false,
    exitCode: null,
    signal: null,
    combinedLog: 'safe <redacted>',
    logTruncated: false,
    diagnostic: { executablePath: 'C:\\1C\\1cv8.exe', args: [] },
  };
}

function inDoubtOutcome(): ConfiguratorProcessOutcome {
  return {
    status: 'inDoubt',
    errorCode: 'CONFIGURATOR_TIMED_OUT_AFTER_START',
    started: true,
    effectPossible: true,
    exitCode: null,
    signal: null,
    combinedLog: 'safe <redacted>',
    logTruncated: false,
    diagnostic: { executablePath: 'C:\\1C\\1cv8.exe', args: [] },
  };
}

function assertResultCode(result: Awaited<ReturnType<ExternalProcessorService['dump']>>, code: string): void {
  assert.strictEqual(result.state, 'failed');
  if (result.state === 'failed') {
    assert.strictEqual(result.code, code);
  }
}

function missing(): NodeJS.ErrnoException {
  return Object.assign(new Error('missing'), { code: 'ENOENT' });
}

function exists(): NodeJS.ErrnoException {
  return Object.assign(new Error('exists'), { code: 'EEXIST' });
}

function ioFailure(message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: 'EIO' });
}

function normalizeIdentityPath(value: string): string {
  const normalized = path.normalize(value).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
