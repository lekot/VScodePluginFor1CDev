// test/suite/agentOptimisticLocking.test.ts
// Unit tests for Agent API Issue #134: Optimistic locking (rev / ifRev) and dryRun planning for metadata mutations.

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { AgentOperations } from '../../src/agent/agentOperations';
import { calculateRevision, validateIfRev } from '../../src/agent/agentRevision';
import { registerAgentCommands } from '../../src/agent/agentCommands';
import { DebugSessionRegistry } from '../../src/agent/debugSessionRegistry';
import { WorkspaceRegistry } from '../../src/services/configurationSession/WorkspaceRegistry';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';
import type { AgentResult, CreateObjectResult, MutationResultData } from '../../src/agent/types';
import { createTempDir, cleanupTempDir } from '../helpers/testHelpers';

const MINIMAL_CONFIG_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject version="2.20" xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <Configuration uuid="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee">
    <Properties>
      <Name>TestConfig</Name>
    </Properties>
    <ChildObjects>
    </ChildObjects>
  </Configuration>
</MetaDataObject>`;

function writeConfigXml(dir: string): void {
  fs.writeFileSync(path.join(dir, 'Configuration.xml'), MINIMAL_CONFIG_XML, 'utf-8');
}

suite('Agent API — Issue #134 calculateRevision & validateIfRev', () => {
  let tmpDir: string;

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-agent-rev-');
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  test('calculateRevision returns 64-char hex SHA-256 for existing file', async () => {
    const filePath = path.join(tmpDir, 'test.xml');
    fs.writeFileSync(filePath, '<test>content</test>', 'utf-8');

    const rev = await calculateRevision(filePath);
    assert.strictEqual(typeof rev, 'string');
    assert.strictEqual(rev.length, 64);
    assert.ok(/^[a-f0-9]{64}$/.test(rev), 'Revision must be lowercase 64 hex characters');

    // Deterministic: same file produces identical revision
    const rev2 = await calculateRevision(filePath);
    assert.strictEqual(rev, rev2);
  });

  test('calculateRevision produces different hash when file content changes', async () => {
    const filePath = path.join(tmpDir, 'test.xml');
    fs.writeFileSync(filePath, '<test>content A</test>', 'utf-8');
    const revA = await calculateRevision(filePath);

    fs.writeFileSync(filePath, '<test>content B</test>', 'utf-8');
    const revB = await calculateRevision(filePath);

    assert.notStrictEqual(revA, revB);
  });

  test('calculateRevision handles missing file gracefully with zero-hash', async () => {
    const missingPath = path.join(tmpDir, 'does-not-exist.xml');
    const rev = await calculateRevision(missingPath);
    assert.strictEqual(rev, '0'.repeat(64));
  });

  test('calculateRevision throws error for non-ENOENT file system errors (e.g. EACCES)', async () => {
    const filePath = path.join(tmpDir, 'test-eacces.xml');
    fs.writeFileSync(filePath, '<test/>', 'utf-8');

    const origReadFile = fs.promises.readFile;
    try {
      (fs.promises as any).readFile = async () => {
        const err = new Error('EACCES: permission denied');
        (err as any).code = 'EACCES';
        throw err;
      };

      await assert.rejects(
        () => calculateRevision(filePath),
        /EACCES/
      );
    } finally {
      fs.promises.readFile = origReadFile;
    }
  });

  test('calculateRevision throws error when child of existing directory throws ENOENT', async () => {
    const dirPath = path.join(tmpDir, 'existing-dir');
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'child.xml'), '<child/>', 'utf-8');

    const origReadFile = fs.promises.readFile;
    try {
      (fs.promises as any).readFile = async (p: string) => {
        if (p.includes('child.xml')) {
          const err = new Error('ENOENT: no such file or directory');
          (err as any).code = 'ENOENT';
          throw err;
        }
        return origReadFile(p);
      };

      await assert.rejects(
        () => calculateRevision(dirPath),
        /ENOENT/
      );
    } finally {
      fs.promises.readFile = origReadFile;
    }
  });

  test('validateIfRev returns ok: true when ifRev matches current revision', async () => {
    const filePath = path.join(tmpDir, 'test.xml');
    fs.writeFileSync(filePath, '<test>content</test>', 'utf-8');
    const rev = await calculateRevision(filePath);

    const validation = await validateIfRev(filePath, rev);
    assert.strictEqual(validation.ok, true);
    assert.strictEqual(validation.currentRev, rev);
  });

  test('calculateRevision rejects symbolic links with an explicit error instead of ZERO_REVISION', async () => {
    const targetFile = path.join(tmpDir, 'symlink-target.xml');
    fs.writeFileSync(targetFile, '<target/>', 'utf-8');
    const linkPath = path.join(tmpDir, 'symlink-link.xml');
    let hasSymlink = false;
    try {
      fs.symlinkSync(targetFile, linkPath);
      hasSymlink = true;
    } catch {
      // unprivileged Windows
    }

    if (hasSymlink) {
      await assert.rejects(
        () => calculateRevision(linkPath),
        /символические ссылки|symlink/i
      );
    } else {
      const origLstat = fs.promises.lstat;
      try {
        (fs.promises as any).lstat = async () => ({
          isFile: () => false,
          isDirectory: () => false,
          isSymbolicLink: () => true,
        });
        await assert.rejects(
          () => calculateRevision(targetFile),
          /символические ссылки|symlink/i
        );
      } finally {
        fs.promises.lstat = origLstat;
      }
    }
  });

  test('calculateRevision rejects broken symbolic links with an explicit error instead of ZERO_REVISION', async () => {
    const missingTarget = path.join(tmpDir, 'nonexistent-target.xml');
    const brokenLink = path.join(tmpDir, 'broken-link.xml');
    try {
      fs.symlinkSync(missingTarget, brokenLink);
    } catch {
      return; // Windows unprivileged symlink fallback
    }
    await assert.rejects(
      () => calculateRevision(brokenLink),
      /символические ссылки|symlink/i
    );
  });

  test('calculateRevision rejects non-file non-directory entries with explicit error', async () => {
    const fakePath = path.join(tmpDir, 'special-device.xml');
    fs.writeFileSync(fakePath, '<fake/>', 'utf-8');
    const origLstat = fs.promises.lstat;
    try {
      (fs.promises as any).lstat = async () => ({
        isFile: () => false,
        isDirectory: () => false,
        isSymbolicLink: () => false,
      });
      await assert.rejects(
        () => calculateRevision(fakePath),
        /неподдерживаемый тип|unsupported/i
      );
    } finally {
      fs.promises.lstat = origLstat;
    }
  });
});

suite('Agent API — Issue #134 dryRun for metadata mutations', () => {
  let tmpDir: string;
  let ops: AgentOperations;

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-agent-dryrun-');
    writeConfigXml(tmpDir);
    ops = new AgentOperations(tmpDir);
    // Create base object to mutate
    await ops.createObject({ type: 'Catalog', name: 'Goods', synonym: 'Товары' });
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  test('setProperties with dryRun: true computes rev and plannedChanges without writing to disk', async () => {
    const catalogPath = path.join(tmpDir, 'Catalogs', 'Goods.xml');
    const beforeContent = fs.readFileSync(catalogPath, 'utf-8');
    const beforeRev = await calculateRevision(catalogPath);

    const result = await ops.setProperties({
      path: 'Catalog.Goods',
      properties: { DescriptionLength: 50 },
      dryRun: true,
    });

    assert.strictEqual(result.success, true);
    const data = result.data as any;
    assert.ok(data, 'Must return data payload');
    assert.strictEqual(data.dryRun, true);
    assert.strictEqual(data.rev, beforeRev);
    assert.strictEqual(data.target, 'Catalog.Goods');
    assert.ok(data.plannedChanges, 'Must include plannedChanges');
    assert.ok(Array.isArray(data.plannedChanges.files));
    assert.ok(data.plannedChanges.files.length > 0);
    assert.ok(typeof data.plannedChanges.summary === 'string');

    // Verify file on disk was NOT modified
    const afterContent = fs.readFileSync(catalogPath, 'utf-8');
    assert.strictEqual(afterContent, beforeContent, 'File content on disk must remain unchanged during dryRun');
  });

  test('addAttribute with dryRun: true computes rev and plannedChanges without writing to disk', async () => {
    const catalogPath = path.join(tmpDir, 'Catalogs', 'Goods.xml');
    const beforeContent = fs.readFileSync(catalogPath, 'utf-8');
    const beforeRev = await calculateRevision(catalogPath);

    const result = await ops.addAttribute({
      path: 'Catalog.Goods',
      name: 'SKU',
      dryRun: true,
    });

    assert.strictEqual(result.success, true);
    const data = result.data as any;
    assert.strictEqual(data.dryRun, true);
    assert.strictEqual(data.rev, beforeRev);
    assert.strictEqual(data.target, 'Catalog.Goods');
    assert.ok(data.plannedChanges.summary.includes('SKU'));

    // Verify file on disk does NOT contain SKU
    const afterContent = fs.readFileSync(catalogPath, 'utf-8');
    assert.strictEqual(afterContent, beforeContent);
    assert.ok(!afterContent.includes('SKU'));
  });

  test('addTabularSection and addTabularSectionColumn with dryRun: true do not modify file', async () => {
    const catalogPath = path.join(tmpDir, 'Catalogs', 'Goods.xml');
    const beforeContent = fs.readFileSync(catalogPath, 'utf-8');

    const result = await ops.addTabularSection({
      path: 'Catalog.Goods',
      name: 'Composition',
      dryRun: true,
    });

    assert.strictEqual(result.success, true);
    const data = result.data as any;
    assert.strictEqual(data.dryRun, true);
    assert.ok(data.plannedChanges.summary.includes('Composition'));

    const afterContent = fs.readFileSync(catalogPath, 'utf-8');
    assert.strictEqual(afterContent, beforeContent);
  });

  test('createObject with dryRun: true returns plannedChanges without creating files or updating config', async () => {
    const configPath = path.join(tmpDir, 'Configuration.xml');
    const beforeConfig = fs.readFileSync(configPath, 'utf-8');
    const targetFile = path.join(tmpDir, 'Catalogs', 'Orders.xml');

    const result = await ops.createObject({
      type: 'Catalog',
      name: 'Orders',
      dryRun: true,
    });

    assert.strictEqual(result.success, true);
    const data = result.data as any;
    assert.strictEqual(data.dryRun, true);
    assert.ok(data.plannedChanges);

    // Verify target file was NOT created and config was NOT modified
    assert.strictEqual(fs.existsSync(targetFile), false);
    const afterConfig = fs.readFileSync(configPath, 'utf-8');
    assert.strictEqual(afterConfig, beforeConfig);
  });

  test('deleteObject with dryRun: true returns plannedChanges without deleting file', async () => {
    const catalogPath = path.join(tmpDir, 'Catalogs', 'Goods.xml');
    assert.ok(fs.existsSync(catalogPath));

    const result = await ops.deleteObject({
      path: 'Catalog.Goods',
      dryRun: true,
    });

    assert.strictEqual(result.success, true);
    const data = result.data as any;
    assert.strictEqual(data.dryRun, true);

    // Verify file still exists on disk
    assert.ok(fs.existsSync(catalogPath));
  });

  test('renameObject with dryRun: true returns plannedChanges without renaming file', async () => {
    const catalogPath = path.join(tmpDir, 'Catalogs', 'Goods.xml');
    const newPath = path.join(tmpDir, 'Catalogs', 'Products.xml');

    const result = await ops.renameObject({
      path: 'Catalog.Goods',
      newName: 'Products',
      dryRun: true,
    });

    assert.strictEqual(result.success, true);
    const data = result.data as any;
    assert.strictEqual(data.dryRun, true);

    assert.ok(fs.existsSync(catalogPath));
    assert.ok(!fs.existsSync(newPath));
  });
});

suite('Agent API — Issue #134 ifRev optimistic locking', () => {
  let tmpDir: string;
  let ops: AgentOperations;

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-agent-ifrev-');
    writeConfigXml(tmpDir);
    ops = new AgentOperations(tmpDir);
    await ops.createObject({ type: 'Catalog', name: 'Goods', synonym: 'Товары' });
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  test('mutation succeeds when ifRev matches current revision on disk', async () => {
    const catalogPath = path.join(tmpDir, 'Catalogs', 'Goods.xml');
    const initialRev = await calculateRevision(catalogPath);

    const result = await ops.addAttribute({
      path: 'Catalog.Goods',
      name: 'Barcode',
      ifRev: initialRev,
    });

    assert.strictEqual(result.success, true);
    const data = result.data as any;
    assert.ok(data.rev, 'Must return new revision after successful mutation');
    assert.notStrictEqual(data.rev, initialRev, 'New revision must differ from initial');

    // Disk verify
    const currentRevOnDisk = await calculateRevision(catalogPath);
    assert.strictEqual(data.rev, currentRevOnDisk);
    const content = fs.readFileSync(catalogPath, 'utf-8');
    assert.ok(content.includes('Barcode'));
  });

  test('mutation is rejected with CONCURRENT_MODIFICATION_ERROR when ifRev mismatches', async () => {
    const catalogPath = path.join(tmpDir, 'Catalogs', 'Goods.xml');
    const currentRev = await calculateRevision(catalogPath);
    const staleRev = 'f'.repeat(64);

    const result = await ops.addAttribute({
      path: 'Catalog.Goods',
      name: 'Barcode',
      ifRev: staleRev,
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.code, 'CONCURRENT_MODIFICATION_ERROR');
    assert.ok(result.error && result.error.includes('изменился'));
    const data = result.data as any;
    assert.ok(data);
    assert.strictEqual(data.currentRev, currentRev);

    // Verify file on disk was NOT modified
    const currentContent = fs.readFileSync(catalogPath, 'utf-8');
    assert.ok(!currentContent.includes('Barcode'));
  });

  test('two-phase mutation workflow: dryRun gets rev -> apply with ifRev succeeds', async () => {
    // Phase 1: dryRun
    const dryRunRes = await ops.setProperties({
      path: 'Catalog.Goods',
      properties: { DescriptionLength: 100 },
      dryRun: true,
    });

    assert.strictEqual(dryRunRes.success, true);
    const rev1 = (dryRunRes.data as any).rev;
    assert.ok(rev1);

    // Phase 2: apply with ifRev
    const applyRes = await ops.setProperties({
      path: 'Catalog.Goods',
      properties: { DescriptionLength: 100 },
      ifRev: rev1,
    });

    assert.strictEqual(applyRes.success, true);
    const rev2 = (applyRes.data as any).rev;
    assert.notStrictEqual(rev1, rev2);

    // Phase 3: subsequent apply with old rev1 fails
    const secondApply = await ops.setProperties({
      path: 'Catalog.Goods',
      properties: { DescriptionLength: 120 },
      ifRev: rev1,
    });

    assert.strictEqual(secondApply.success, false);
    assert.strictEqual(secondApply.code, 'CONCURRENT_MODIFICATION_ERROR');
    assert.strictEqual((secondApply.data as any).currentRev, rev2);
  });

  test('invalid ifRev format (not 64-char hex) returns validation error', async () => {
    const result = await ops.addAttribute({
      path: 'Catalog.Goods',
      name: 'Weight',
      ifRev: 'invalid-rev-token',
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.code, 'INVALID_REVISION_FORMAT');
  });

  test('dryRun returns error if object does not exist', async () => {
    const result = await ops.addAttribute({
      path: 'Catalog.NonExistent',
      name: 'Weight',
      dryRun: true,
    });

    assert.strictEqual(result.success, false);
  });

  test('createObject with ifRev: ZERO_REVISION succeeds and with stale ifRev fails', async () => {
    const staleResult = await ops.createObject({
      type: 'Catalog',
      name: 'Customers',
      ifRev: '1'.repeat(64),
    });
    assert.strictEqual(staleResult.success, false);
    assert.strictEqual(staleResult.code, 'CONCURRENT_MODIFICATION_ERROR');

    const successResult = await ops.createObject({
      type: 'Catalog',
      name: 'Customers',
      ifRev: '0'.repeat(64),
    });
    assert.strictEqual(successResult.success, true);
    assert.ok(successResult.rev);
    assert.notStrictEqual(successResult.rev, '0'.repeat(64));
  });

  test('setType with dryRun and ifRev workflow', async () => {
    await ops.addAttribute({ path: 'Catalog.Goods', name: 'Price' });
    const catalogPath = path.join(tmpDir, 'Catalogs', 'Goods.xml');
    const revBefore = await calculateRevision(catalogPath);

    // dryRun
    const dryRunRes = await ops.setType({
      path: 'Catalog.Goods.Attribute.Price',
      types: ['xs:decimal'],
      dryRun: true,
    });
    assert.strictEqual(dryRunRes.success, true);
    assert.strictEqual((dryRunRes.data as any).dryRun, true);
    assert.strictEqual((dryRunRes.data as any).rev, revBefore);

    // Mismatched ifRev fails
    const failRes = await ops.setType({
      path: 'Catalog.Goods.Attribute.Price',
      types: ['xs:decimal'],
      ifRev: 'e'.repeat(64),
    });
    assert.strictEqual(failRes.success, false);
    assert.strictEqual(failRes.code, 'CONCURRENT_MODIFICATION_ERROR');

    // Matching ifRev succeeds
    const okRes = await ops.setType({
      path: 'Catalog.Goods.Attribute.Price',
      types: ['xs:decimal'],
      ifRev: revBefore,
    });
    assert.strictEqual(okRes.success, true);
    assert.notStrictEqual(okRes.rev, revBefore);
  });

  test('setType with dryRun: true rejects invalid types with identical error to live mutation', async () => {
    await ops.addAttribute({ path: 'Catalog.Goods', name: 'Discount' });

    const dryRunRes = await ops.setType({
      path: 'Catalog.Goods.Attribute.Discount',
      types: ['invalid:unknown:type'],
      dryRun: true,
    });
    assert.strictEqual(dryRunRes.success, false, 'dryRun must fail on invalid type');
    assert.ok(
      dryRunRes.error?.includes('Неизвестный тип') || dryRunRes.error?.includes('Некорректный формат'),
      `dryRun error was: ${dryRunRes.error}`
    );

    const liveRes = await ops.setType({
      path: 'Catalog.Goods.Attribute.Discount',
      types: ['invalid:unknown:type'],
      dryRun: false,
    });
    assert.strictEqual(liveRes.success, false, 'live execution must fail on invalid type');
    assert.strictEqual(dryRunRes.error, liveRes.error, 'dryRun and live execution must yield identical validation error');
  });

  test('deleteObject with ifRev succeeds and returns ZERO_REVISION', async () => {
    const catalogPath = path.join(tmpDir, 'Catalogs', 'Goods.xml');
    const revBefore = await calculateRevision(catalogPath);

    const failRes = await ops.deleteObject({
      path: 'Catalog.Goods',
      ifRev: 'd'.repeat(64),
    });
    assert.strictEqual(failRes.success, false);
    assert.strictEqual(failRes.code, 'CONCURRENT_MODIFICATION_ERROR');

    const okRes = await ops.deleteObject({
      path: 'Catalog.Goods',
      ifRev: revBefore,
    });
    assert.strictEqual(okRes.success, true);
    assert.strictEqual(okRes.rev, '0'.repeat(64));
    assert.strictEqual(fs.existsSync(catalogPath), false);
  });

  test('renameObject with ifRev succeeds and returns new file revision', async () => {
    const catalogPath = path.join(tmpDir, 'Catalogs', 'Goods.xml');
    const revBefore = await calculateRevision(catalogPath);

    const failRes = await ops.renameObject({
      path: 'Catalog.Goods',
      newName: 'RenamedGoods',
      ifRev: 'c'.repeat(64),
    });
    assert.strictEqual(failRes.success, false);
    assert.strictEqual(failRes.code, 'CONCURRENT_MODIFICATION_ERROR');

    const okRes = await ops.renameObject({
      path: 'Catalog.Goods',
      newName: 'RenamedGoods',
      ifRev: revBefore,
    });
    assert.strictEqual(okRes.success, true);
    assert.ok(okRes.rev);
    assert.notStrictEqual(okRes.rev, revBefore);
  });

  test('deleteAttribute and deleteTabularSection with ifRev validation', async () => {
    await ops.addAttribute({ path: 'Catalog.Goods', name: 'TempAttr' });
    await ops.addTabularSection({ path: 'Catalog.Goods', name: 'TempTS' });

    const catalogPath = path.join(tmpDir, 'Catalogs', 'Goods.xml');
    const revAfterAdd = await calculateRevision(catalogPath);

    // deleteAttribute with mismatched ifRev
    const delAttrFail = await ops.deleteAttribute({
      path: 'Catalog.Goods.Attribute.TempAttr',
      ifRev: 'b'.repeat(64),
    });
    assert.strictEqual(delAttrFail.success, false);
    assert.strictEqual(delAttrFail.code, 'CONCURRENT_MODIFICATION_ERROR');

    // deleteAttribute with valid ifRev
    const delAttrOk = await ops.deleteAttribute({
      path: 'Catalog.Goods.Attribute.TempAttr',
      ifRev: revAfterAdd,
    });
    assert.strictEqual(delAttrOk.success, true);
    const revAfterDelAttr = delAttrOk.rev!;
    assert.notStrictEqual(revAfterDelAttr, revAfterAdd);

    // deleteTabularSection with valid ifRev
    const delTsOk = await ops.deleteTabularSection({
      path: 'Catalog.Goods.TabularSection.TempTS',
      ifRev: revAfterDelAttr,
    });
    assert.strictEqual(delTsOk.success, true);
    assert.notStrictEqual(delTsOk.rev, revAfterDelAttr);
  });

  test('concurrent setProperties mutations with same ifRev result in exactly 1 success and 1 conflict', async () => {
    const catalogPath = path.join(tmpDir, 'Catalogs', 'Goods.xml');
    const revBefore = await calculateRevision(catalogPath);

    const [res1, res2] = await Promise.all([
      ops.setProperties({ path: 'Catalog.Goods', properties: { Synonym: 'Value1' }, ifRev: revBefore }),
      ops.setProperties({ path: 'Catalog.Goods', properties: { Synonym: 'Value2' }, ifRev: revBefore }),
    ]);

    const successes = [res1, res2].filter((r) => r.success);
    const conflicts = [res1, res2].filter((r) => !r.success && r.code === 'CONCURRENT_MODIFICATION_ERROR');

    assert.strictEqual(successes.length, 1, 'Exactly one concurrent mutation must succeed');
    assert.strictEqual(conflicts.length, 1, 'Exactly one concurrent mutation must receive CONCURRENT_MODIFICATION_ERROR conflict');
  });

  test('concurrent createAttribute mutations with same ifRev result in exactly 1 success and 1 conflict', async () => {
    const catalogPath = path.join(tmpDir, 'Catalogs', 'Goods.xml');
    const revBefore = await calculateRevision(catalogPath);

    const [res1, res2] = await Promise.all([
      ops.addAttribute({ path: 'Catalog.Goods', name: 'RaceAttr1', ifRev: revBefore }),
      ops.addAttribute({ path: 'Catalog.Goods', name: 'RaceAttr2', ifRev: revBefore }),
    ]);

    const successes = [res1, res2].filter((r) => r.success);
    const conflicts = [res1, res2].filter((r) => !r.success && r.code === 'CONCURRENT_MODIFICATION_ERROR');

    assert.strictEqual(successes.length, 1, 'Exactly one concurrent attribute addition must succeed');
    assert.strictEqual(conflicts.length, 1, 'Exactly one concurrent attribute addition must receive conflict');
  });
});

suite('Agent API — Registered Commands dryRun & ifRev dispatch', () => {
  let tmpDir: string;
  let registry: WorkspaceRegistry;
  let configId: string;

  setup(async () => {
    resetVscodeTestState();
    tmpDir = await createTempDir('1cviewer-agent-cmd-lock-');
    writeConfigXml(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'Catalogs'), { recursive: true });

    registry = new WorkspaceRegistry();
    await registry.refresh([{ configPath: tmpDir }]);
    configId = registry.list()[0].configurationId;

    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    registerAgentCommands(
      context as never,
      () => null,
      async () => registry,
      new DebugSessionRegistry()
    );
  });

  teardown(async () => {
    await registry.dispose();
    await cleanupTempDir(tmpDir);
    resetVscodeTestState();
  });

  test('createObject command with dryRun: true plans creation without writing to disk', async () => {
    const handler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.createObject')!;
    const newFilePath = path.join(tmpDir, 'Catalogs', 'DryCatalog.xml');

    const result = await handler({
      configurationId: configId,
      type: 'Catalog',
      name: 'DryCatalog',
      dryRun: true,
    }) as AgentResult<CreateObjectResult>;

    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(result.dryRun, true);
    assert.ok(result.data?.plannedChanges);
    assert.strictEqual(fs.existsSync(newFilePath), false, 'Dry-run must not create XML file on disk');

    const configXml = fs.readFileSync(path.join(tmpDir, 'Configuration.xml'), 'utf-8');
    assert.strictEqual(configXml.includes('DryCatalog'), false, 'Dry-run must not update Configuration.xml');
  });

  test('createObject command with mismatched ifRev fails with conflict', async () => {
    const handler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.createObject')!;
    const newFilePath = path.join(tmpDir, 'Catalogs', 'StaleCatalog.xml');

    const result = await handler({
      configurationId: configId,
      type: 'Catalog',
      name: 'StaleCatalog',
      ifRev: '1'.repeat(64), // Mismatched revision for non-existent target (expected ZERO_REVISION)
    }) as AgentResult;

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.code, 'CONCURRENT_MODIFICATION_ERROR');
    assert.strictEqual(fs.existsSync(newFilePath), false, 'Failed ifRev must not create file on disk');
  });

  test('deleteObject command with dryRun: true plans deletion without modifying disk', async () => {
    const handlerCreate = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.createObject')!;
    await handlerCreate({ configurationId: configId, type: 'Catalog', name: 'ItemToDelete' });

    const objPath = path.join(tmpDir, 'Catalogs', 'ItemToDelete.xml');
    assert.strictEqual(fs.existsSync(objPath), true);
    const revBefore = await calculateRevision(objPath);

    const handlerDelete = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.deleteObject')!;
    const dryResult = await handlerDelete({
      configurationId: configId,
      path: 'Catalog.ItemToDelete',
      ifRev: revBefore,
      dryRun: true,
    }) as AgentResult<MutationResultData>;

    assert.strictEqual(dryResult.success, true, dryResult.error);
    assert.strictEqual(dryResult.dryRun, true);
    assert.ok(dryResult.data?.plannedChanges);
    assert.strictEqual(fs.existsSync(objPath), true, 'File must remain on disk after dryRun delete');

    // Mismatched ifRev fails
    const failResult = await handlerDelete({
      configurationId: configId,
      path: 'Catalog.ItemToDelete',
      ifRev: 'f'.repeat(64),
    }) as AgentResult;
    assert.strictEqual(failResult.success, false);
    assert.strictEqual(failResult.code, 'CONCURRENT_MODIFICATION_ERROR');
    assert.strictEqual(fs.existsSync(objPath), true, 'File must remain after mismatched ifRev');
  });

  test('renameObject command with dryRun: true plans rename without modifying disk', async () => {
    const handlerCreate = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.createObject')!;
    await handlerCreate({ configurationId: configId, type: 'Catalog', name: 'ItemToRename' });

    const oldPath = path.join(tmpDir, 'Catalogs', 'ItemToRename.xml');
    const newPath = path.join(tmpDir, 'Catalogs', 'ItemRenamed.xml');
    assert.strictEqual(fs.existsSync(oldPath), true);
    const revBefore = await calculateRevision(oldPath);

    const handlerRename = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.renameObject')!;
    const dryResult = await handlerRename({
      configurationId: configId,
      path: 'Catalog.ItemToRename',
      newName: 'ItemRenamed',
      ifRev: revBefore,
      dryRun: true,
    }) as AgentResult<CreateObjectResult>;

    assert.strictEqual(dryResult.success, true, dryResult.error);
    assert.strictEqual(dryResult.dryRun, true);
    assert.ok(dryResult.data?.plannedChanges);
    assert.strictEqual(fs.existsSync(oldPath), true, 'Old file must still exist after dryRun');
    assert.strictEqual(fs.existsSync(newPath), false, 'New file must not exist after dryRun');

    // Mismatched ifRev fails
    const failResult = await handlerRename({
      configurationId: configId,
      path: 'Catalog.ItemToRename',
      newName: 'ItemRenamed',
      ifRev: 'e'.repeat(64),
    }) as AgentResult;
    assert.strictEqual(failResult.success, false);
    assert.strictEqual(failResult.code, 'CONCURRENT_MODIFICATION_ERROR');
  });

  test('mutation commands with dryRun: true route as read, without operationId or snapshotVersion increment', async () => {
    // Setup rich fixture with Catalog.Goods and EventSubscription.OnWrite
    const goodsDir = path.join(tmpDir, 'Catalogs');
    fs.mkdirSync(goodsDir, { recursive: true });
    const goodsPath = path.join(goodsDir, 'Goods.xml');
    fs.writeFileSync(goodsPath, `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject version="2.20" xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <Catalog uuid="11111111-1111-4111-8111-111111111111">
    <Properties>
      <Name>Goods</Name>
      <DescriptionLength>25</DescriptionLength>
    </Properties>
    <ChildObjects>
      <Attribute uuid="22222222-2222-4222-8222-222222222222">
        <Properties>
          <Name>ExistingAttr</Name>
          <Type><v8:Type>xs:string</v8:Type></Type>
        </Properties>
      </Attribute>
      <TabularSection uuid="33333333-3333-4333-8333-333333333333">
        <Properties>
          <Name>ExistingTS</Name>
        </Properties>
        <ChildObjects>
          <Attribute uuid="44444444-4444-4444-8444-444444444444">
            <Properties>
              <Name>ExistingCol</Name>
              <Type><v8:Type>xs:decimal</v8:Type></Type>
            </Properties>
          </Attribute>
        </ChildObjects>
      </TabularSection>
    </ChildObjects>
  </Catalog>
</MetaDataObject>`, 'utf-8');

    const subsDir = path.join(tmpDir, 'EventSubscriptions');
    fs.mkdirSync(subsDir, { recursive: true });
    const subPath = path.join(subsDir, 'OnWrite.xml');
    fs.writeFileSync(subPath, `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject version="2.20" xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <EventSubscription uuid="55555555-5555-4555-8555-555555555555">
    <Properties>
      <Name>OnWrite</Name>
      <Source>
        <v8:Type>cfg:CatalogObject.Goods</v8:Type>
      </Source>
      <Event>BeforeWrite</Event>
      <Handler>CommonModule.Handler</Handler>
    </Properties>
    <ChildObjects/>
  </EventSubscription>
</MetaDataObject>`, 'utf-8');

    fs.writeFileSync(path.join(tmpDir, 'Configuration.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject version="2.20" xmlns="http://v8.1c.ru/8.3/MDClasses">
  <Configuration uuid="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee">
    <Properties><Name>TestConfig</Name></Properties>
    <ChildObjects>
      <Catalog>Goods</Catalog>
      <EventSubscription>OnWrite</EventSubscription>
    </ChildObjects>
  </Configuration>
</MetaDataObject>`, 'utf-8');

    const goodsBefore = fs.readFileSync(goodsPath, 'utf-8');
    const subBefore = fs.readFileSync(subPath, 'utf-8');
    const initialSnapshot = registry.require(configId).snapshotVersion;

    const testCases: Array<{ commandId: string; params: Record<string, unknown> }> = [
      {
        commandId: '1c-metadata-tree.agent.addAttribute',
        params: { configurationId: configId, path: 'Catalog.Goods', name: 'NewAttr', dryRun: true },
      },
      {
        commandId: '1c-metadata-tree.agent.addTabularSection',
        params: { configurationId: configId, path: 'Catalog.Goods', name: 'NewTS', dryRun: true },
      },
      {
        commandId: '1c-metadata-tree.agent.addTabularSectionColumn',
        params: { configurationId: configId, path: 'Catalog.Goods.TabularSection.ExistingTS', name: 'NewCol', dryRun: true },
      },
      {
        commandId: '1c-metadata-tree.agent.deleteAttribute',
        params: { configurationId: configId, path: 'Catalog.Goods.Attribute.ExistingAttr', dryRun: true },
      },
      {
        commandId: '1c-metadata-tree.agent.deleteTabularSection',
        params: { configurationId: configId, path: 'Catalog.Goods.TabularSection.ExistingTS', dryRun: true },
      },
      {
        commandId: '1c-metadata-tree.agent.setProperties',
        params: { configurationId: configId, path: 'Catalog.Goods', properties: { DescriptionLength: 100 }, dryRun: true },
      },
      {
        commandId: '1c-metadata-tree.agent.setType',
        params: { configurationId: configId, path: 'Catalog.Goods.Attribute.ExistingAttr', types: ['xs:decimal'], dryRun: true },
      },
      {
        commandId: '1c-metadata-tree.agent.setSource',
        params: { configurationId: configId, path: 'EventSubscription.OnWrite', types: ['cfg:DocumentObject.Invoice'], dryRun: true },
      },
    ];

    for (const tc of testCases) {
      const handler = vscodeTestState.registeredCommandHandlers.get(tc.commandId);
      assert.ok(handler, `Handler for ${tc.commandId} must be registered`);

      const res = await handler(tc.params) as AgentResult<MutationResultData>;
      assert.strictEqual(res.success, true, `${tc.commandId} error: ${res.error}`);
      assert.strictEqual(res.dryRun, true, `${tc.commandId} must report dryRun: true`);
      assert.strictEqual(res.operationId, undefined, `${tc.commandId} dryRun must not return operationId`);
      assert.strictEqual(
        registry.require(configId).snapshotVersion,
        initialSnapshot,
        `${tc.commandId} dryRun must not increment snapshotVersion`
      );
      assert.ok(res.data?.plannedChanges, `${tc.commandId} dryRun must include plannedChanges`);
    }

    // Disk contents must remain completely unmodified
    assert.strictEqual(fs.readFileSync(goodsPath, 'utf-8'), goodsBefore, 'Goods.xml must not be modified after dryRuns');
    assert.strictEqual(fs.readFileSync(subPath, 'utf-8'), subBefore, 'OnWrite.xml must not be modified after dryRuns');
  });
});


