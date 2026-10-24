import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import { cleanupTempDir, createTempDir } from '../helpers/testHelpers';

interface MutationSitePolicy {
  file: string;
  owner: string;
  method: string;
  target: string;
  count: number;
  reason: string;
  responsibility: string;
}

interface MutationInventory {
  kind: string;
  sites: Array<Pick<MutationSitePolicy, 'file' | 'owner' | 'method' | 'target' | 'count'>>;
}

interface TwoPathMutationFixture {
  label: string;
  method: string;
  sourceForDestination: (destination: string) => string;
}

suite('Mutation writer architecture guard', () => {
  let tmpDir: string;
  let sourceRoot: string;
  let policyPath: string;
  const repoRoot = path.resolve(__dirname, '../../..');
  const guardPath = path.join(repoRoot, 'scripts', 'check-mutation-writer-baseline.js');

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-mutation-writer-guard-');
    sourceRoot = path.join(tmpDir, 'src');
    policyPath = path.join(tmpDir, 'approved-policy.json');
    await fs.promises.mkdir(sourceRoot, { recursive: true });
    await writePolicy([]);
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  async function writePolicy(sites: readonly Partial<MutationSitePolicy>[]): Promise<void> {
    await fs.promises.writeFile(policyPath, JSON.stringify({ version: 2, sites }, null, 2), 'utf8');
  }

  async function writeSource(source: string, relativePath = 'writer.ts'): Promise<string> {
    const filePath = path.join(sourceRoot, relativePath);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, source, 'utf8');
    return filePath;
  }

  function runGuard(...args: string[]): SpawnSyncReturns<string> {
    return spawnSync(
      process.execPath,
      [guardPath, '--source-root', sourceRoot, '--baseline', policyPath, ...args],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );
  }

  function outputOf(result: SpawnSyncReturns<string>): string {
    assert.ifError(result.error);
    assert.notStrictEqual(result.status, null, 'the guard process must exit normally');
    return `${result.stdout}${result.stderr}`;
  }

  function assertBlocked(result: SpawnSyncReturns<string>, expectedSites: readonly string[] = []): void {
    const output = outputOf(result);
    assert.notStrictEqual(result.status, 0, `unapproved mutation unexpectedly passed:\n${output}`);
    for (const expectedSite of expectedSites) {
      assert.ok(output.includes(expectedSite), `missing diagnostic for ${expectedSite}:\n${output}`);
    }
  }

  function assertClean(result: SpawnSyncReturns<string>): void {
    const output = outputOf(result);
    assert.strictEqual(result.status, 0, output);
  }

  function approvedSite(overrides: Partial<MutationSitePolicy> = {}): MutationSitePolicy {
    return {
      file: 'src/writer.ts',
      owner: 'save',
      method: 'writeFile',
      target: 'target',
      count: 1,
      reason: 'Fixture models a reviewed external output boundary.',
      responsibility: 'External output owner',
      ...overrides,
    };
  }

  const basicWriter = `import * as fs from 'fs';
export async function save(target: string): Promise<void> {
  await fs.promises.writeFile(target, 'content', 'utf8');
}
`;

  const twoPathMutationFixtures: readonly TwoPathMutationFixture[] = [
    {
      label: 'async rename through fs.promises namespace',
      method: 'rename',
      sourceForDestination: (destination) => `import * as fs from 'node:fs';
export async function performMutation(source: string, destination: string, alternateDestination: string): Promise<void> {
  await fs.promises.rename(source, ${destination});
}
`,
    },
    {
      label: 'sync rename through a named import alias',
      method: 'renameSync',
      sourceForDestination: (destination) => `import { renameSync as moveNow } from 'fs';
export function performMutation(source: string, destination: string, alternateDestination: string): void {
  moveNow(source, ${destination});
}
`,
    },
    {
      label: 'async copyFile through a promises alias',
      method: 'copyFile',
      sourceForDestination: (destination) => `import { promises as io } from 'node:fs';
export async function performMutation(source: string, destination: string, alternateDestination: string): Promise<void> {
  await io.copyFile(source, ${destination});
}
`,
    },
    {
      label: 'sync copyFile through fs namespace',
      method: 'copyFileSync',
      sourceForDestination: (destination) => `import * as fs from 'node:fs';
export function performMutation(source: string, destination: string, alternateDestination: string): void {
  fs.copyFileSync(source, ${destination});
}
`,
    },
    {
      label: 'async link through a named import alias',
      method: 'link',
      sourceForDestination: (destination) => `import { link as createHardLink } from 'node:fs/promises';
export async function performMutation(source: string, destination: string, alternateDestination: string): Promise<void> {
  await createHardLink(source, ${destination});
}
`,
    },
    {
      label: 'sync link through a named import alias',
      method: 'linkSync',
      sourceForDestination: (destination) => `import { linkSync as createHardLinkNow } from 'fs';
export function performMutation(source: string, destination: string, alternateDestination: string): void {
  createHardLinkNow(source, ${destination});
}
`,
    },
    {
      label: 'async symlink through fs.promises namespace',
      method: 'symlink',
      sourceForDestination: (destination) => `import * as fs from 'fs';
export async function performMutation(source: string, destination: string, alternateDestination: string): Promise<void> {
  await fs.promises.symlink(source, ${destination}, 'file');
}
`,
    },
    {
      label: 'sync symlink through a named import alias',
      method: 'symlinkSync',
      sourceForDestination: (destination) => `import { symlinkSync as createSymlinkNow } from 'node:fs';
export function performMutation(source: string, destination: string, alternateDestination: string): void {
  createSymlinkNow(source, ${destination}, 'file');
}
`,
    },
    {
      label: 'async cp through a named import alias',
      method: 'cp',
      sourceForDestination: (destination) => `import { cp as copyTree } from 'node:fs/promises';
export async function performMutation(source: string, destination: string, alternateDestination: string): Promise<void> {
  await copyTree(source, ${destination});
}
`,
    },
    {
      label: 'sync cp through fs namespace',
      method: 'cpSync',
      sourceForDestination: (destination) => `import * as fs from 'node:fs';
export function performMutation(source: string, destination: string, alternateDestination: string): void {
  fs.cpSync(source, ${destination});
}
`,
    },
  ];

  for (const fixture of twoPathMutationFixtures) {
    test(`${fixture.label} approval changes when only the destination expression changes`, async () => {
      await writeSource(fixture.sourceForDestination('destination'));
      const inventoryPath = path.join(tmpDir, `${fixture.method}-inventory.json`);
      assertClean(runGuard('--write-inventory', inventoryPath));

      const inventory = JSON.parse(await fs.promises.readFile(inventoryPath, 'utf8')) as MutationInventory;
      assert.strictEqual(inventory.kind, 'observed-inventory');
      const [site] = inventory.sites.filter((candidate) => candidate.file === 'src/writer.ts'
        && candidate.owner === 'performMutation'
        && candidate.method === fixture.method);
      assert.ok(site, `the scanner must recognize ${fixture.method} in this alias form`);

      await writePolicy([approvedSite({
        file: site.file,
        owner: site.owner,
        method: site.method,
        target: site.target,
        count: site.count,
      })]);
      assertClean(runGuard());

      await writeSource(fixture.sourceForDestination('alternateDestination'));
      assertBlocked(runGuard(), ['Unapproved direct filesystem mutation', fixture.method]);
    });
  }

  test('paired mutation scanner keeps shadowed aliases and read-only calls outside the policy', async () => {
    await writeSource(`
import * as fs from 'node:fs';
import { copyFileSync as copyFileNow, readFileSync } from 'node:fs';
export async function readAsync(source: string): Promise<Buffer> {
  return fs.promises.readFile(source);
}
export function readSync(source: string): Buffer {
  return readFileSync(source);
}
export function shadowedNamespace(
  fs: { promises: { copyFile(source: string, destination: string): Promise<void> } },
  source: string,
  destination: string,
): Promise<void> {
  return fs.promises.copyFile(source, destination);
}
export function shadowedNamedAlias(
  copyFileNow: (source: string, destination: string) => void,
  source: string,
  destination: string,
): void {
  copyFileNow(source, destination);
}
export function unrelatedObject(source: string, destination: string): void {
  const storage = { copyFile: (_source: string, _destination: string): void => undefined };
  storage.copyFile(source, destination);
}
`, 'shadow-and-read-only.ts');

    assertClean(runGuard());
  });

  test('an empty source scan passes against an empty version 2 policy', () => {
    assertClean(runGuard());
  });

  test('a new raw writer in any production source path fails by default', async () => {
    await writeSource(basicWriter, 'agent/newRawWriter.ts');

    assertBlocked(runGuard(), ['newRawWriter.ts', 'writeFile']);
  });

  test('recognizes default, namespace, named, promises and require aliases', async () => {
    await writeSource(`
import defaultFs, {
  promises as namedPromises,
  writeFile as namedWriteFile,
  createWriteStream as namedStream,
} from 'node:fs';
import { writeFile as namedPromiseWriteFile } from 'node:fs/promises';
import * as namespaceFs from 'fs';
import * as promiseNamespace from 'node:fs/promises';

const requiredFs = require('node:fs');
const { promises: destructuredPromises } = require('fs');
const requiredPromises = require('node:fs/promises');
const { writeFile: requiredWriteFile } = require('fs');

export async function viaDefaultPromises(target: string): Promise<void> {
  await defaultFs.promises.writeFile(target, 'default');
}
export async function viaNamespacePromises(target: string): Promise<void> {
  await namespaceFs.promises.writeFile(target, 'namespace');
}
export async function viaNamedPromises(target: string): Promise<void> {
  await namedPromises.writeFile(target, 'named promises');
}
export async function viaNamedFunction(target: string): Promise<void> {
  await namedWriteFile(target, 'named function');
}
export async function viaNamedPromiseFunction(target: string): Promise<void> {
  await namedPromiseWriteFile(target, 'named promise function');
}
export async function viaPromisesNamespace(target: string): Promise<void> {
  await promiseNamespace.writeFile(target, 'promises namespace');
}
export async function viaRequiredNamespace(target: string): Promise<void> {
  await requiredFs.promises.writeFile(target, 'require namespace');
}
export async function viaRequiredDestructure(target: string): Promise<void> {
  await destructuredPromises.writeFile(target, 'require destructuring');
}
export async function viaRequiredPromisesModule(target: string): Promise<void> {
  await requiredPromises.writeFile(target, 'require promises');
}
export async function viaRequiredFunction(target: string): Promise<void> {
  await requiredWriteFile(target, 'require direct function');
}
export function viaNamedStream(target: string): unknown {
  return namedStream(target);
}
`, 'aliases.ts');

    const result = runGuard();
    assertBlocked(result, [
      'viaDefaultPromises',
      'viaNamespacePromises',
      'viaNamedPromises',
      'viaNamedFunction',
      'viaNamedPromiseFunction',
      'viaPromisesNamespace',
      'viaRequiredNamespace',
      'viaRequiredDestructure',
      'viaRequiredPromisesModule',
      'viaRequiredFunction',
      'viaNamedStream',
    ]);
  });

  test('tracks chained aliases from fs namespace to fs.promises', async () => {
    await writeSource(`
const requiredFs = require('fs');
const firstAlias = requiredFs.promises;
const secondAlias = firstAlias;
export async function persistThroughChain(target: string): Promise<void> {
  await secondAlias.writeFile(target, 'content');
}
`, 'chained-alias.ts');

    assertBlocked(runGuard(), ['persistThroughChain', 'writeFile']);
  });

  test('tracks partially bound copyFile and rename through chained aliases and keys both paths', async () => {
    const sourceForDestination = (destination: string): string => `
import { copyFile as copyFileFromFs, rename as renameFromFs } from 'node:fs/promises';
export async function copyBound(source: string, destination: string, alternateDestination: string): Promise<void> {
  const boundCopy = copyFileFromFs.bind(undefined, source);
  const copyAlias = boundCopy;
  const copyAliasAgain = copyAlias;
  await copyAliasAgain(${destination});
}
export async function renameBound(source: string, destination: string, alternateDestination: string): Promise<void> {
  const boundRename = renameFromFs.bind(undefined, source);
  const renameAlias = boundRename;
  const renameAliasAgain = renameAlias;
  await renameAliasAgain(${destination});
}
export async function copyBoundByChainedBind(source: string, destination: string): Promise<void> {
  const copyWithSource = copyFileFromFs.bind(undefined, source);
  const copyWithBothPaths = copyWithSource.bind(undefined, ${destination});
  await copyWithBothPaths();
}
export async function renameBoundByChainedBind(source: string, destination: string): Promise<void> {
  const renameWithSource = renameFromFs.bind(undefined, source);
  const renameWithBothPaths = renameWithSource.bind(undefined, ${destination});
  await renameWithBothPaths();
}
`;

    await writeSource(sourceForDestination('destination'));
    const inventoryPath = path.join(tmpDir, 'bound-two-path-inventory.json');
    assertClean(runGuard('--write-inventory', inventoryPath));

    const inventory = JSON.parse(await fs.promises.readFile(inventoryPath, 'utf8')) as MutationInventory;
    const expectedSites = inventory.sites.filter((site) => site.file === 'src/writer.ts'
      && (site.owner === 'copyBound'
        || site.owner === 'renameBound'
        || site.owner === 'copyBoundByChainedBind'
        || site.owner === 'renameBoundByChainedBind'));
    assert.deepStrictEqual(expectedSites.map((site) => [site.owner, site.method]).sort(), [
      ['copyBound', 'copyFile'],
      ['copyBoundByChainedBind', 'copyFile'],
      ['renameBound', 'rename'],
      ['renameBoundByChainedBind', 'rename'],
    ]);
    assert.ok(expectedSites.every((site) => site.target === JSON.stringify(['source', 'destination'])),
      'partially bound source and destination arguments must both remain in the mutation identity');

    await writePolicy(expectedSites.map((site) => approvedSite({
      file: site.file,
      owner: site.owner,
      method: site.method,
      target: site.target,
      count: site.count,
    })));
    assertClean(runGuard());

    await writeSource(sourceForDestination('alternateDestination'));
    assertBlocked(runGuard(), ['Unapproved direct filesystem mutation', 'copyFile', 'rename']);
  });

  test('tracks bound filesystem opens and FileHandle writers while excluding read-only opens and unused binds', async () => {
    const sourceWithTarget = (target: string): string => `
import * as fs from 'node:fs';
interface FakeFileHandle {
  writeFile(content: string): Promise<void>;
  close(): Promise<void>;
}
export async function copyWithBoundFallback(
  options: { copyFile?: typeof fs.promises.copyFile },
  source: string,
  target: string,
): Promise<void> {
  const copyFile = options.copyFile ?? fs.promises.copyFile.bind(fs.promises);
  const copyFileAlias = copyFile;
  await copyFileAlias(source, ${target});
}
export async function writeWithBoundOpen(
  options: { open?: typeof fs.promises.open },
  target: string,
  alternateTarget: string,
): Promise<void> {
  const selectedOpen = options.open ?? fs.promises.open.bind(fs.promises, ${target});
  const openAlias = selectedOpen;
  const handle = await openAlias('w');
  const fileWriter = handle.writeFile.bind(handle);
  const fileWriterAlias = fileWriter;
  const bufferWriter = handle.write.bind(handle);
  await fileWriterAlias('content');
  await bufferWriter(Buffer.from('more content'));
  await handle.close();
}
export async function writeWithReboundOpen(target: string): Promise<void> {
  const openWithPath = fs.promises.open.bind(fs.promises, ${target});
  const openWithPathAndMode = openWithPath.bind(undefined, 'wx');
  const handle = await openWithPathAndMode();
  const writeFile = handle.writeFile.bind(handle, 'prebound content');
  await writeFile();
  await handle.close();
}
export async function readWithBoundOpen(target: string): Promise<void> {
  const openForRead = fs.promises.open.bind(fs.promises, ${target}, 'r');
  const handle = await openForRead();
  await handle.close();
}
export function allocateBindingsWithoutInvoking(target: string): void {
  const unusedOpen = fs.promises.open.bind(fs.promises, target, 'w');
  const unusedWriter = fs.promises.writeFile.bind(fs.promises, target, 'unused content');
}
export async function shadowedBoundOpen(
  fs: { promises: { open(target: string, flags: string): Promise<FakeFileHandle> } },
  target: string,
): Promise<void> {
  const openAlias = fs.promises.open.bind(fs.promises, target, 'w');
  const handle = await openAlias();
  await handle.writeFile('shadowed namespace');
  await handle.close();
}
export async function unrelatedBoundWriter(target: string): Promise<void> {
  const storage = { writeFile: async (_target: string, _content: string): Promise<void> => undefined };
  const writer = storage.writeFile.bind(storage, target);
  await writer('unrelated content');
}
`;

    await writeSource(sourceWithTarget('target'), 'bound-open.ts');

    const inventoryPath = path.join(tmpDir, 'bound-open-inventory.json');
    assertClean(runGuard('--write-inventory', inventoryPath));
    const inventory = JSON.parse(await fs.promises.readFile(inventoryPath, 'utf8')) as MutationInventory;
    const observedSites = inventory.sites.filter((site) => site.file === 'src/bound-open.ts');
    assert.deepStrictEqual(observedSites.map((site) => [site.owner, site.method, site.target]).sort(), [
      ['copyWithBoundFallback', 'copyFile', JSON.stringify(['source', 'target'])],
      ['writeWithBoundOpen', 'open', 'target'],
      ['writeWithBoundOpen', 'write', 'target'],
      ['writeWithBoundOpen', 'writeFile', 'target'],
      ['writeWithReboundOpen', 'open', 'target'],
      ['writeWithReboundOpen', 'writeFile', 'target'],
    ]);

    await writePolicy(observedSites.map((site) => approvedSite({
      file: site.file,
      owner: site.owner,
      method: site.method,
      target: site.target,
      count: site.count,
    })));
    assertClean(runGuard());

    await writeSource(sourceWithTarget('alternateTarget'), 'bound-open.ts');
    assertBlocked(runGuard(), ['Unapproved direct filesystem mutation', 'copyFile', 'open', 'writeFile', 'write']);
  });

  test('tracks bound named writeFile fallbacks while excluding shadowed and unrelated bound functions', async () => {
    const sourceWithBoundTarget = (boundTarget: string): string => `
import { writeFile as writeFileFromFs } from 'node:fs/promises';
type Writer = (target: string, content: string) => Promise<void>;
export async function nullishBoundWriter(deps: { write?: Writer }, target: string, alternateTarget: string): Promise<void> {
  const selectedWriter = deps.write ?? writeFileFromFs.bind(undefined, ${boundTarget});
  const writerAlias = selectedWriter;
  await writerAlias('nullish content');
}
export async function logicalBoundWriter(deps: { write?: Writer }, target: string, alternateTarget: string): Promise<void> {
  const selectedWriter = deps.write || writeFileFromFs.bind(undefined, ${boundTarget});
  const writerAlias = selectedWriter;
  await writerAlias('logical content');
}
export async function shadowedBoundWriter(writeFileFromFs: Writer, target: string): Promise<void> {
  const boundWriter = writeFileFromFs.bind(undefined, target);
  await boundWriter('injected content');
}
export async function unrelatedBoundWriter(target: string): Promise<void> {
  const storage = { writeFile: async (_target: string, _content: string): Promise<void> => undefined };
  const boundWriter = storage.writeFile.bind(storage, target);
  await boundWriter('unrelated content');
}
`;

    await writeSource(sourceWithBoundTarget('target'), 'bound-writer.ts');

    const inventoryPath = path.join(tmpDir, 'bound-write-inventory.json');
    assertClean(runGuard('--write-inventory', inventoryPath));
    const inventory = JSON.parse(await fs.promises.readFile(inventoryPath, 'utf8')) as MutationInventory;
    const observedSites = inventory.sites.filter((site) => site.file === 'src/bound-writer.ts');
    assert.deepStrictEqual(observedSites.map((site) => [site.owner, site.method]).sort(), [
      ['logicalBoundWriter', 'writeFile'],
      ['nullishBoundWriter', 'writeFile'],
    ], 'filesystem-bound fallbacks must be recognized without attributing shadowed methods');
    assert.ok(observedSites.every((site) => site.target !== "'nullish content'"
      && site.target !== "'logical content'"), 'the bound target must remain the write target');

    await writePolicy(observedSites.map((site) => approvedSite({
      file: site.file,
      owner: site.owner,
      method: site.method,
      target: site.target,
      count: site.count,
    })));
    assertClean(runGuard());

    await writeSource(sourceWithBoundTarget('alternateTarget'), 'bound-writer.ts');
    assertBlocked(runGuard(), ['Unapproved direct filesystem mutation', 'writeFile']);
  });

  test('tracks FileHandle writes through aliases derived from write-capable open', async () => {
    await writeSource(`
import { promises as io } from 'fs';
export async function persistWithHandle(target: string): Promise<void> {
  const opened = await io.open(target, 'w');
  const firstAlias = opened;
  const secondAlias = firstAlias;
  await secondAlias.writeFile('content');
  await secondAlias.write(Buffer.from('more content'));
  await secondAlias.close();
}
`, 'file-handle.ts');

    assertBlocked(runGuard(), ['persistWithHandle', 'open', 'writeFile', 'write']);
  });

  test('tracks filesystem FileHandles through coalesced open fallbacks and aliases', async () => {
    await writeSource(`
import * as fs from 'node:fs/promises';
const deps: { open?: typeof fs.open } = {};
export async function persistThroughNullishFallback(target: string, content: string): Promise<void> {
  const openWithFallback = deps.open ?? fs.open;
  const openAlias = openWithFallback;
  const handle = await openAlias(target, 'wx');
  await handle.writeFile(content);
  await handle.close();
}
export async function persistThroughLogicalFallback(target: string, content: string): Promise<void> {
  const openWithFallback = deps.open || fs.open;
  const handle = await openWithFallback(target, 'a');
  await handle.writeFile(content);
  await handle.close();
}
export async function persistThroughInlineFallback(target: string, content: string): Promise<void> {
  const handle = await (deps.open ?? fs.open)(target, 'wx');
  await handle.writeFile(content);
  await handle.close();
}
export async function readThroughFallback(target: string): Promise<void> {
  const openWithFallback = deps.open ?? fs.open;
  const handle = await openWithFallback(target, 'r');
  await handle.close();
}
`, 'coalesced-open-fallback.ts');

    const result = runGuard();
    assertBlocked(result, [
      'persistThroughNullishFallback',
      'persistThroughLogicalFallback',
      'persistThroughInlineFallback',
      'writeFile',
    ]);
    assert.ok(!outputOf(result).includes('readThroughFallback'), 'read-only fallback must remain allowed');
  });

  test('does not attribute coalesced opens to shadowed or non-filesystem values', async () => {
    await writeSource(`
import * as fs from 'node:fs';
interface FakeHandle { writeFile(value: string): Promise<void>; close(): Promise<void>; }
interface FakeFs { promises: { open(target: string, flags: string): Promise<FakeHandle> }; }
export async function shadowedNamespace(
  fs: FakeFs,
  deps: { open?: FakeFs['promises']['open'] },
  target: string,
): Promise<void> {
  const openWithFallback = deps.open ?? fs.promises.open;
  const handle = await openWithFallback(target, 'wx');
  await handle.writeFile('fake namespace');
  await handle.close();
}
export async function nonFilesystemFallback(
  deps: { open?: (target: string, flags: string) => Promise<FakeHandle> },
  fallback: (target: string, flags: string) => Promise<FakeHandle>,
  target: string,
): Promise<void> {
  const openWithFallback = deps.open ?? fallback;
  const handle = await openWithFallback(target, 'wx');
  await handle.writeFile('non-filesystem producers');
  await handle.close();
}
export async function shadowedAlias(
  target: string,
): Promise<void> {
  const fs = { promises: { open: async (_path: string, _flags: string): Promise<FakeHandle> => ({
    writeFile: async () => undefined,
    close: async () => undefined,
  }) } };
  const deps = { open: undefined as undefined | typeof fs.promises.open };
  const openWithFallback = deps.open ?? fs.promises.open;
  const handle = await openWithFallback(target, 'wx');
  await handle.writeFile('shadowed local namespace');
  await handle.close();
}
`, 'coalesced-open-shadowing.ts');

    assertClean(runGuard());
  });

  test('does not flag read-only open calls through namespace or named aliases', async () => {
    await writeSource(`
import * as fs from 'fs';
import { open as openFile, openSync as openFileSync } from 'node:fs';
export async function readNamespace(target: string): Promise<void> {
  await fs.open(target, 'r', () => undefined);
}
export async function readNamed(target: string): Promise<void> {
  await openFile(target, 'r', () => undefined);
}
export function readSyncNamespace(target: string): number {
  return fs.openSync(target, 'r');
}
export function readSyncNamed(target: string): number {
  return openFileSync(target, 'r');
}
`, 'read-only-open.ts');

    assertClean(runGuard());
  });

  test('blocks write-capable open flags, sync writers and stream creation', async () => {
    await writeSource(`
import * as fs from 'node:fs';
import {
  open as openFile,
  openSync as openFileSync,
  writeSync as writeDescriptorSync,
  writeFileSync as writeFileNow,
  createWriteStream as createStream,
} from 'fs';
export async function openNamespaceForWrite(target: string): Promise<void> {
  await fs.open(target, 'wx', () => undefined);
}
export async function openWithRuntimeFlags(target: string, flags: string): Promise<void> {
  await fs.open(target, flags, () => undefined);
}
export async function openNamedForAppend(target: string): Promise<void> {
  await openFile(target, 'a', () => undefined);
}
export function openNamespaceSyncForWrite(target: string): number {
  return fs.openSync(target, 'w');
}
export function openNamedSyncForWrite(target: string): number {
  return openFileSync(target, 'wx');
}
export function writeSynchronously(target: string): void {
  writeFileNow(target, 'content');
}
export function writeDescriptorSynchronously(fd: number): void {
  writeDescriptorSync(fd, Buffer.from('content'), 0, 7, 0);
}
export function streamNamespace(target: string): unknown {
  return fs.createWriteStream(target);
}
export function streamNamed(target: string): unknown {
  return createStream(target);
}
`, 'open-sync-stream.ts');

    assertBlocked(runGuard(), [
      'openNamespaceForWrite',
      'openWithRuntimeFlags',
      'openNamedForAppend',
      'openNamespaceSyncForWrite',
      'openNamedSyncForWrite',
      'writeSynchronously',
      'writeDescriptorSynchronously',
      'streamNamespace',
      'streamNamed',
    ]);
  });

  test('conservatively flags unknown dynamic methods on a known fs receiver', async () => {
    await writeSource(`
import * as fs from 'fs';
export async function dispatchFsMethod(target: string, method: string): Promise<void> {
  await fs.promises[method](target, 'content');
}
export async function dispatchDestructuredFsMethod(target: string, method: string): Promise<void> {
  const { [method]: dispatch } = fs.promises;
  await dispatch(target, 'content');
}
`, 'dynamic-method.ts');

    assertBlocked(runGuard(), ['dispatchFsMethod', 'dispatchDestructuredFsMethod', 'target']);
  });

  test('does not flag non-fs methods or values that shadow filesystem aliases', async () => {
    await writeSource(`
import * as fs from 'fs';
import { writeFile as importedWriteFile } from 'node:fs';
export async function fakeNamespace(target: string): Promise<void> {
  const fs = { promises: { writeFile: async () => undefined } };
  await fs.promises.writeFile(target, 'not filesystem');
}
export async function fakeFileHandle(target: string): Promise<void> {
  const handle = { writeFile: async () => undefined };
  await handle.writeFile(target, 'not a FileHandle');
}
export async function fakeNamedAlias(importedWriteFile: (target: string, data: string) => Promise<void>, target: string): Promise<void> {
  await importedWriteFile(target, 'shadowed parameter');
}
export async function unrelatedObject(target: string): Promise<void> {
  const storage = { writeFile: async () => undefined };
  await storage.writeFile(target, 'not filesystem');
}
`, 'shadowing.ts');

    assertClean(runGuard());
  });

  test('an exact reviewed site is allowed only with reason and responsibility', async () => {
    await writeSource(basicWriter);
    await writePolicy([approvedSite()]);

    assertClean(runGuard());
  });

  test('strict XML enforcement blocks approved raw writes and accepts clean protected files', async () => {
    const protectedXmlFile = 'src/services/XMLWriter.ts';
    await writeSource(basicWriter, 'services/XMLWriter.ts');
    await writePolicy([approvedSite({ file: protectedXmlFile })]);

    const approvedRawWriter = runGuard('--enforce-files', protectedXmlFile);
    assertBlocked(approvedRawWriter, ['XML writer boundary failed', protectedXmlFile, 'writeFile']);

    await writeSource('export function serialize(): string { return "<Element/>"; }', 'services/XMLWriter.ts');
    await writePolicy([]);

    assertClean(runGuard('--enforce-files', protectedXmlFile));
  });

  test('rejects a policy entry without a nonempty reason and responsible owner', async () => {
    await writeSource(basicWriter);
    await writePolicy([approvedSite({ reason: '  ', responsibility: '' })]);

    assertBlocked(runGuard(), ['reason', 'responsibility']);
  });

  test('rejects policy fields outside the reviewed exception contract', async () => {
    await writeSource(basicWriter);
    await fs.promises.writeFile(policyPath, JSON.stringify({
      version: 2,
      sites: [{ ...approvedSite(), autoApproved: true }],
    }), 'utf8');

    assertBlocked(runGuard(), ['exactly']);
  });

  test('rejects policy-level fields outside version and sites', async () => {
    await fs.promises.writeFile(policyPath, JSON.stringify({ version: 2, sites: [], allowAll: true }), 'utf8');

    assertBlocked(runGuard(), ['exactly version and sites']);
  });

  test('rejects an unapproved site instead of creating an exception automatically', async () => {
    await writeSource(basicWriter);

    assertBlocked(runGuard(), ['save', 'writeFile']);
  });

  test('rejects an increased occurrence count for an approved site', async () => {
    await writeSource(`import * as fs from 'fs';
export async function save(target: string): Promise<void> {
  await fs.promises.writeFile(target, 'first');
  await fs.promises.writeFile(target, 'second');
}
`);
    await writePolicy([approvedSite()]);

    assertBlocked(runGuard(), ['save', 'writeFile']);
  });

  test('rejects a reduced occurrence count and a stale approved site', async () => {
    await writeSource(basicWriter);
    await writePolicy([approvedSite({ count: 2 })]);
    assertBlocked(runGuard(), ['save', 'writeFile']);

    await writeSource('export function noWrite(): void {}');
    await writePolicy([approvedSite()]);
    assertBlocked(runGuard(), ['save', 'writeFile']);
  });

  test('inventory generation is separate and cannot be used as approved policy', async () => {
    await writeSource(basicWriter);
    const policyBefore = await fs.promises.readFile(policyPath, 'utf8');
    const inventoryPath = path.join(tmpDir, 'observed-inventory.json');

    assertClean(runGuard('--write-inventory', inventoryPath));
    const inventory = JSON.parse(await fs.promises.readFile(inventoryPath, 'utf8')) as {
      kind?: unknown;
      sites?: Array<{ file?: unknown; owner?: unknown; method?: unknown; target?: unknown; count?: unknown }>;
    };
    assert.strictEqual(inventory.kind, 'observed-inventory');
    assert.ok(inventory.sites?.some((site) => site.file === 'src/writer.ts'
      && site.owner === 'save'
      && site.method === 'writeFile'
      && site.target === 'target'));
    assert.strictEqual(await fs.promises.readFile(policyPath, 'utf8'), policyBefore);

    assertBlocked(runGuard('--write-inventory', policyPath), ['must differ from the approved policy path']);
    assert.strictEqual(await fs.promises.readFile(policyPath, 'utf8'), policyBefore);

    assertBlocked(runGuard('--baseline', inventoryPath), ['policy']);
  });

  test('refuses the legacy auto-approval option without changing policy', async () => {
    await writeSource(basicWriter);
    const policyBefore = await fs.promises.readFile(policyPath, 'utf8');

    assertBlocked(runGuard('--write-baseline'));
    assert.strictEqual(await fs.promises.readFile(policyPath, 'utf8'), policyBefore);
  });
});
