// test/suite/predefinedCharacteristicOperations.test.ts
// Unit tests for predefinedCharacteristicOperations

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  listPredefinedCharacteristics,
  getPredefinedCharacteristicType,
  setPredefinedCharacteristicType,
  getCharacteristicValueRegisters,
  normalizeCotAddress,
  resolveCotTarget,
} from '../../src/agent/predefinedCharacteristicOperations';
import { AgentPathError } from '../../src/agent/agentPathResolver';
import { createTempDir, cleanupTempDir } from '../helpers/testHelpers';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SAMPLE_PREDEFINED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<PredefinedData xmlns="http://v8.1c.ru/8.3/xcf/predef" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="PlanOfCharacteristicKindPredefinedItems" version="2.20">
\t<Item id="74f7f99c-ca92-431a-86d6-39f749ae3adb">
\t\t<Name>КатегорииЗакупок</Name>
\t\t<Code>000000010</Code>
\t\t<Description>Категории закупок</Description>
\t\t<Type>
\t\t\t<v8:Type xmlns:d4p1="http://v8.1c.ru/8.1/data/enterprise/current-config">d4p1:CatalogRef.КатегорииЗакупок</v8:Type>
\t\t</Type>
\t\t<IsFolder>false</IsFolder>
\t</Item>
\t<Item id="6ac9eab8-b733-42c3-93dd-84d106e9bd2e">
\t\t<Name>Номенклатура</Name>
\t\t<Code>000000003</Code>
\t\t<Description>Номенклатура</Description>
\t\t<Type>
\t\t\t<v8:Type xmlns:d4p1="http://v8.1c.ru/8.1/data/enterprise/current-config">d4p1:CatalogRef.Номенклатура</v8:Type>
\t\t</Type>
\t\t<IsFolder>false</IsFolder>
\t</Item>
</PredefinedData>`;

const IR_WITH_COT_REF = (cotName: string) => `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <InformationRegister>
    <Properties>
      <Name>РегистрСвязанный</Name>
    </Properties>
    <ChildObjects>
      <Resource>
        <Name>ЗначениеВида</Name>
        <Type>
          <v8:Type>cfg:ChartOfCharacteristicTypesRef.${cotName}</v8:Type>
        </Type>
      </Resource>
    </ChildObjects>
  </InformationRegister>
</MetaDataObject>`;

const IR_WITHOUT_COT_REF = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses">
  <InformationRegister>
    <Properties>
      <Name>РегистрБезСвязи</Name>
    </Properties>
  </InformationRegister>
</MetaDataObject>`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setupCotWorkspace(configRoot: string, cotName: string, xmlContent: string): void {
  const cotDir = path.join(configRoot, 'ChartsOfCharacteristicTypes', cotName, 'Ext');
  fs.mkdirSync(cotDir, { recursive: true });
  fs.writeFileSync(path.join(cotDir, 'Predefined.xml'), xmlContent, 'utf-8');
}

// ─── Suite: listPredefinedCharacteristics ─────────────────────────────────────

suite('predefinedCharacteristicOperations: listPredefinedCharacteristics', () => {
  let tmpDir: string;

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-cot-list-');
    setupCotWorkspace(tmpDir, 'РеквизитыЗакупки', SAMPLE_PREDEFINED_XML);
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  test('returns 2 entries for sample predefined', async () => {
    const entries = await listPredefinedCharacteristics(tmpDir, 'РеквизитыЗакупки');
    assert.strictEqual(entries.length, 2);
  });

  test('first entry has correct name and type', async () => {
    const entries = await listPredefinedCharacteristics(tmpDir, 'РеквизитыЗакупки');
    const first = entries.find((e) => e.name === 'КатегорииЗакупок');
    assert.ok(first, 'КатегорииЗакупок should be found');
    assert.ok(first!.type[0].includes('CatalogRef.КатегорииЗакупок'));
  });

  test('returns empty array when Predefined.xml does not exist', async () => {
    const entries = await listPredefinedCharacteristics(tmpDir, 'НесуществующийПВХ');
    assert.strictEqual(entries.length, 0);
  });

  test('accepts dot-separated path format', async () => {
    const entries = await listPredefinedCharacteristics(tmpDir, 'ChartOfCharacteristicTypes.РеквизитыЗакупки');
    assert.strictEqual(entries.length, 2);
  });
});

// ─── Suite: getPredefinedCharacteristicType ───────────────────────────────────

suite('predefinedCharacteristicOperations: getPredefinedCharacteristicType', () => {
  let tmpDir: string;

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-cot-gettype-');
    setupCotWorkspace(tmpDir, 'РеквизитыЗакупки', SAMPLE_PREDEFINED_XML);
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  test('returns type array for existing predefined', async () => {
    const types = await getPredefinedCharacteristicType(tmpDir, 'РеквизитыЗакупки', 'Номенклатура');
    assert.ok(types.length >= 1, 'should return at least 1 type');
    assert.ok(types[0].includes('CatalogRef.Номенклатура'), `Got: ${types[0]}`);
  });

  test('returns empty array for unknown predefined name', async () => {
    const types = await getPredefinedCharacteristicType(tmpDir, 'РеквизитыЗакупки', 'НесуществующийВид');
    assert.strictEqual(types.length, 0);
  });
});

// ─── Suite: setPredefinedCharacteristicType ───────────────────────────────────

suite('predefinedCharacteristicOperations: setPredefinedCharacteristicType', () => {
  let tmpDir: string;

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-cot-settype-');
    setupCotWorkspace(tmpDir, 'РеквизитыЗакупки', SAMPLE_PREDEFINED_XML);
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  test('set then get returns updated type', async () => {
    await setPredefinedCharacteristicType(
      tmpDir, 'РеквизитыЗакупки', 'Номенклатура', ['xs:string']
    );
    const types = await getPredefinedCharacteristicType(tmpDir, 'РеквизитыЗакупки', 'Номенклатура');
    assert.ok(types.some((t) => t.includes('string')), `Expected xs:string, got: ${JSON.stringify(types)}`);
  });

  test('set cfg: reference type and read back', async () => {
    await setPredefinedCharacteristicType(
      tmpDir, 'РеквизитыЗакупки', 'КатегорииЗакупок', ['cfg:CatalogRef.Номенклатура']
    );
    const types = await getPredefinedCharacteristicType(tmpDir, 'РеквизитыЗакупки', 'КатегорииЗакупок');
    assert.ok(
      types.some((t) => t.includes('CatalogRef.Номенклатура')),
      `Expected CatalogRef.Номенклатура in types, got: ${JSON.stringify(types)}`
    );
  });

  test('throws for unknown predefined name', async () => {
    await assert.rejects(
      () => setPredefinedCharacteristicType(tmpDir, 'РеквизитыЗакупки', 'НесуществующийВид', ['xs:string']),
      /not found/i
    );
  });
});

// ─── Suite: getCharacteristicValueRegisters ───────────────────────────────────

suite('predefinedCharacteristicOperations: getCharacteristicValueRegisters', () => {
  let tmpDir: string;
  const COT_NAME = 'РеквизитыЗакупки';

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-cot-regs-');
    const irDir = path.join(tmpDir, 'InformationRegisters');
    fs.mkdirSync(irDir, { recursive: true });

    // Register that references the COT
    fs.writeFileSync(
      path.join(irDir, 'РегистрСвязанный.xml'),
      IR_WITH_COT_REF(COT_NAME),
      'utf-8'
    );
    // Register that does NOT reference the COT
    fs.writeFileSync(
      path.join(irDir, 'РегистрБезСвязи.xml'),
      IR_WITHOUT_COT_REF,
      'utf-8'
    );
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  test('returns only registers that reference the COT', async () => {
    const regs = await getCharacteristicValueRegisters(tmpDir, COT_NAME);
    assert.ok(regs.includes('InformationRegister.РегистрСвязанный'), `Expected РегистрСвязанный, got: ${JSON.stringify(regs)}`);
    assert.ok(!regs.includes('InformationRegister.РегистрБезСвязи'), `Unexpected РегистрБезСвязи in: ${JSON.stringify(regs)}`);
    assert.strictEqual(regs.length, 1);
  });

  test('returns empty array when InformationRegisters dir missing', async () => {
    const regs = await getCharacteristicValueRegisters(tmpDir, 'НесуществующийПВХ');
    // No IR dir issue + no matches — just no results expected for unknown COT
    assert.ok(Array.isArray(regs));
  });

  test('returns empty array when no registers reference the COT', async () => {
    const regs = await getCharacteristicValueRegisters(tmpDir, 'ПВХКоторыйНиктоНеИспользует');
    assert.strictEqual(regs.length, 0);
  });

  test('result is sorted alphabetically', async () => {
    // Add another register that also references the COT
    const irDir = path.join(tmpDir, 'InformationRegisters');
    fs.writeFileSync(
      path.join(irDir, 'АаРегистр.xml'),
      IR_WITH_COT_REF(COT_NAME),
      'utf-8'
    );
    const regs = await getCharacteristicValueRegisters(tmpDir, COT_NAME);
    assert.strictEqual(regs.length, 2);
    // Sorted: АаРегистр before РегистрСвязанный
    assert.ok(regs[0] <= regs[1], `Expected sorted, got: ${JSON.stringify(regs)}`);
  });
});

suite('predefinedCharacteristicOperations: semantic address boundary and cross-type safety (#266)', () => {
  let tmpDir: string;
  const COT_NAME = 'Shared';

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-cot-boundary-');
    // Coexisting Catalog.Shared and ChartOfCharacteristicTypes.Shared
    const catalogDir = path.join(tmpDir, 'Catalogs');
    await fs.promises.mkdir(catalogDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(catalogDir, 'Shared.xml'),
      '<Catalog><Properties><Name>Shared</Name></Properties></Catalog>',
      'utf-8',
    );

    setupCotWorkspace(tmpDir, COT_NAME, SAMPLE_PREDEFINED_XML);
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  test('setPredefinedCharacteristicType rejects Catalog.Shared and does NOT mutate ChartOfCharacteristicTypes.Shared', async () => {
    const predefinedPath = path.join(tmpDir, 'ChartsOfCharacteristicTypes', COT_NAME, 'Ext', 'Predefined.xml');
    const contentBefore = await fs.promises.readFile(predefinedPath, 'utf-8');

    await assert.rejects(
      async () => setPredefinedCharacteristicType(tmpDir, 'Catalog.Shared', 'Номенклатура', ['xs:string']),
      (err: unknown) => err instanceof AgentPathError && err.code === 'INVALID_AGENT_PATH',
      'Must reject Catalog.Shared with INVALID_AGENT_PATH',
    );

    const contentAfter = await fs.promises.readFile(predefinedPath, 'utf-8');
    assert.strictEqual(contentAfter, contentBefore, 'Predefined.xml must not be modified when target is Catalog.Shared');
  });

  test('setter rejects forged COT targets that escape or disagree with the selected configuration', async () => {
    const selectedRoot = path.join(tmpDir, 'selected-config');
    const outsideRoot = path.join(tmpDir, 'other-config');
    setupCotWorkspace(selectedRoot, COT_NAME, SAMPLE_PREDEFINED_XML);
    setupCotWorkspace(outsideRoot, COT_NAME, SAMPLE_PREDEFINED_XML);

    const selectedPredefinedPath = path.join(
      selectedRoot,
      'ChartsOfCharacteristicTypes',
      COT_NAME,
      'Ext',
      'Predefined.xml',
    );
    const outsidePredefinedPath = path.join(
      outsideRoot,
      'ChartsOfCharacteristicTypes',
      COT_NAME,
      'Ext',
      'Predefined.xml',
    );
    const selectedBefore = await fs.promises.readFile(selectedPredefinedPath, 'utf-8');
    const outsideBefore = await fs.promises.readFile(outsidePredefinedPath, 'utf-8');
    const forgedTargets = [
      {
        configRoot: selectedRoot,
        cotName: COT_NAME,
        cotDir: path.dirname(path.dirname(outsidePredefinedPath)),
      },
      {
        configRoot: outsideRoot,
        cotName: COT_NAME,
        cotDir: path.dirname(path.dirname(selectedPredefinedPath)),
      },
    ];

    for (const target of forgedTargets) {
      await assert.rejects(
        async () => setPredefinedCharacteristicType(
          selectedRoot,
          target,
          'Номенклатура',
          ['xs:string'],
        ),
        (err: unknown) => err instanceof AgentPathError && err.code === 'INVALID_AGENT_PATH',
        'Setter must reject a cotDir or configRoot outside the selected configuration',
      );
      assert.strictEqual(await fs.promises.readFile(selectedPredefinedPath, 'utf-8'), selectedBefore);
      assert.strictEqual(await fs.promises.readFile(outsidePredefinedPath, 'utf-8'), outsideBefore);
    }
  });

  for (const linkSegment of ['cot-directory', 'ext-directory'] as const) {
    test(`setter rejects a ${linkSegment} symlink and leaves the external Predefined.xml untouched`, async function () {
      const fixture = await createSymlinkedCotFixture(tmpDir, COT_NAME, linkSegment);
      try {
        await fs.promises.symlink(
          fixture.externalDirectory,
          fixture.linkPath,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } catch (error) {
        if (isSymlinkUnavailable(error)) {
          this.skip();
          return;
        }
        throw error;
      }

      const outsideBefore = await fs.promises.readFile(fixture.externalPredefinedPath, 'utf-8');
      const outcome = await setPredefinedCharacteristicType(
          fixture.selectedRoot,
          COT_NAME,
          'ВнешняяХарактеристика',
          ['xs:string'],
        ).then(() => ({ status: 'fulfilled' as const }), (reason: unknown) => ({ status: 'rejected' as const, reason }));
      assert.strictEqual(
        await fs.promises.readFile(fixture.externalPredefinedPath, 'utf-8'),
        outsideBefore,
        'a COT symlink must never let the setter modify the external configuration',
      );
      assert.strictEqual(outcome.status, 'rejected', 'the setter must reject the symlinked COT namespace');
      if (outcome.status === 'rejected') {
        assert.ok(outcome.reason instanceof AgentPathError);
        assert.strictEqual(outcome.reason.code, 'INVALID_AGENT_PATH');
      }
    });

    test(`list and get reject a ${linkSegment} symlink instead of exposing external metadata`, async function () {
      const fixture = await createSymlinkedCotFixture(tmpDir, COT_NAME, linkSegment);
      try {
        await fs.promises.symlink(
          fixture.externalDirectory,
          fixture.linkPath,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } catch (error) {
        if (isSymlinkUnavailable(error)) {
          this.skip();
          return;
        }
        throw error;
      }

      const results = await Promise.allSettled([
        listPredefinedCharacteristics(fixture.selectedRoot, COT_NAME),
        getPredefinedCharacteristicType(fixture.selectedRoot, COT_NAME, 'ВнешняяХарактеристика'),
      ]);
      assert.deepStrictEqual(
        results.map((result) => result.status),
        ['rejected', 'rejected'],
        'read APIs must reject a symlinked COT namespace instead of following it',
      );
      for (const result of results) {
        if (result.status === 'rejected') {
          assert.ok(result.reason instanceof AgentPathError);
          assert.strictEqual(result.reason.code, 'INVALID_AGENT_PATH');
        }
      }
    });
  }

  test('setter rechecks the canonical COT namespace after reading and before writing', async function () {
    const symlinkProbeTarget = path.join(tmpDir, 'symlink-race-probe-target');
    const symlinkProbe = path.join(tmpDir, 'symlink-race-probe');
    await fs.promises.mkdir(symlinkProbeTarget, { recursive: true });
    try {
      await fs.promises.symlink(
        symlinkProbeTarget,
        symlinkProbe,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if (isSymlinkUnavailable(error)) {
        this.skip();
        return;
      }
      throw error;
    } finally {
      await fs.promises.rm(symlinkProbe, { recursive: true, force: true });
    }

    const selectedRoot = path.join(tmpDir, 'selected-race');
    const externalRoot = path.join(tmpDir, 'external-race');
    setupCotWorkspace(selectedRoot, COT_NAME, SAMPLE_PREDEFINED_XML);
    setupCotWorkspace(externalRoot, COT_NAME, SAMPLE_PREDEFINED_XML);
    const selectedCotDir = path.join(selectedRoot, 'ChartsOfCharacteristicTypes', COT_NAME);
    const selectedExtDir = path.join(selectedCotDir, 'Ext');
    const savedExtDir = path.join(selectedCotDir, 'Ext.saved');
    const externalExtDir = path.join(externalRoot, 'ChartsOfCharacteristicTypes', COT_NAME, 'Ext');
    const externalPredefinedPath = path.join(externalExtDir, 'Predefined.xml');
    const outsideBefore = await fs.promises.readFile(externalPredefinedPath, 'utf-8');
    const mutableFsPromises = fs.promises as unknown as {
      readFile: (...args: unknown[]) => Promise<unknown>;
    };
    const originalReadFile = mutableFsPromises.readFile;
    let replacedAfterRead = false;

    mutableFsPromises.readFile = async (...args: unknown[]) => {
      const content = await originalReadFile.apply(fs.promises, args);
      if (!replacedAfterRead && path.basename(String(args[0])).toLocaleLowerCase() === 'predefined.xml') {
        await fs.promises.rename(selectedExtDir, savedExtDir);
        try {
          await fs.promises.symlink(
            externalExtDir,
            selectedExtDir,
            process.platform === 'win32' ? 'junction' : 'dir',
          );
        } catch (error) {
          await fs.promises.rename(savedExtDir, selectedExtDir);
          throw error;
        }
        replacedAfterRead = true;
      }
      return content;
    };

    let outcome: { status: 'fulfilled' } | { status: 'rejected'; reason: unknown };
    try {
      outcome = await setPredefinedCharacteristicType(
        selectedRoot,
        COT_NAME,
        'Номенклатура',
        ['xs:string'],
      ).then(() => ({ status: 'fulfilled' as const }), (reason: unknown) => ({ status: 'rejected' as const, reason }));
    } finally {
      mutableFsPromises.readFile = originalReadFile;
      if (replacedAfterRead) {
        await fs.promises.rm(selectedExtDir, { recursive: true, force: true });
        await fs.promises.rename(savedExtDir, selectedExtDir);
      }
    }

    assert.strictEqual(replacedAfterRead, true, 'the race hook must replace Ext after the initial read');
    assert.strictEqual(
      await fs.promises.readFile(externalPredefinedPath, 'utf-8'),
      outsideBefore,
      'the pre-write boundary check must prevent publication through a newly linked Ext directory',
    );
    assert.strictEqual(outcome.status, 'rejected', 'a namespace replaced after the read must be rejected');
    if (outcome.status === 'rejected') {
      assert.ok(outcome.reason instanceof AgentPathError);
      assert.strictEqual(outcome.reason.code, 'INVALID_AGENT_PATH');
    }
  });

  test('read and write APIs reject a Predefined.xml file reported as a symlink within the configuration', async () => {
    const configRoot = path.join(tmpDir, 'selected-file-symlink');
    setupCotWorkspace(configRoot, COT_NAME, SAMPLE_PREDEFINED_XML);
    const predefinedPath = path.join(
      configRoot,
      'ChartsOfCharacteristicTypes',
      COT_NAME,
      'Ext',
      'Predefined.xml',
    );
    const contentBefore = await fs.promises.readFile(predefinedPath, 'utf-8');
    const mutableFsPromises = fs.promises as unknown as {
      lstat: (...args: unknown[]) => Promise<unknown>;
    };
    const originalLstat = mutableFsPromises.lstat;
    mutableFsPromises.lstat = async (...args: unknown[]) => {
      const filePath = String(args[0]);
      if (
        path.basename(filePath).toLocaleLowerCase() === 'predefined.xml'
        && filePath.includes('ChartsOfCharacteristicTypes')
      ) {
        return { isSymbolicLink: () => true };
      }
      return originalLstat.apply(fs.promises, args);
    };

    let results: PromiseSettledResult<unknown>[];
    try {
      results = await Promise.allSettled([
        listPredefinedCharacteristics(configRoot, COT_NAME),
        getPredefinedCharacteristicType(configRoot, COT_NAME, 'Номенклатура'),
        setPredefinedCharacteristicType(configRoot, COT_NAME, 'Номенклатура', ['xs:string']),
      ]);
    } finally {
      mutableFsPromises.lstat = originalLstat;
    }
    assert.deepStrictEqual(
      results.map((result) => result.status),
      ['rejected', 'rejected', 'rejected'],
      'no operation should follow a linked Predefined.xml file, even within the selected root',
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        assert.ok(result.reason instanceof AgentPathError);
        assert.strictEqual(result.reason.code, 'INVALID_AGENT_PATH');
      }
    }
    assert.strictEqual(await fs.promises.readFile(predefinedPath, 'utf-8'), contentBefore);
  });

  test('read boundary fails closed when the filesystem cannot verify Predefined.xml', async () => {
    const configRoot = path.join(tmpDir, 'selected-unverifiable-file');
    setupCotWorkspace(configRoot, COT_NAME, SAMPLE_PREDEFINED_XML);
    const predefinedPath = path.join(
      configRoot,
      'ChartsOfCharacteristicTypes',
      COT_NAME,
      'Ext',
      'Predefined.xml',
    );
    const mutableFsPromises = fs.promises as unknown as {
      lstat: (...args: unknown[]) => Promise<unknown>;
    };
    const originalLstat = mutableFsPromises.lstat;
    mutableFsPromises.lstat = async (...args: unknown[]) => {
      const filePath = String(args[0]);
      if (
        path.basename(filePath).toLocaleLowerCase() === 'predefined.xml'
        && filePath.includes('ChartsOfCharacteristicTypes')
      ) {
        throw Object.assign(new Error('injected lstat failure'), { code: 'EACCES' });
      }
      return originalLstat.apply(fs.promises, args);
    };

    try {
      await assert.rejects(
        () => listPredefinedCharacteristics(configRoot, COT_NAME),
        /injected lstat failure/,
      );
    } finally {
      mutableFsPromises.lstat = originalLstat;
    }
  });

  test('read operations reject Catalog.Shared with INVALID_AGENT_PATH', async () => {
    await assert.rejects(
      async () => listPredefinedCharacteristics(tmpDir, 'Catalog.Shared'),
      (err: unknown) => err instanceof AgentPathError && err.code === 'INVALID_AGENT_PATH',
    );

    await assert.rejects(
      async () => getPredefinedCharacteristicType(tmpDir, 'Catalog.Shared', 'Номенклатура'),
      (err: unknown) => err instanceof AgentPathError && err.code === 'INVALID_AGENT_PATH',
    );

    await assert.rejects(
      async () => getCharacteristicValueRegisters(tmpDir, 'Catalog.Shared'),
      (err: unknown) => err instanceof AgentPathError && err.code === 'INVALID_AGENT_PATH',
    );
  });

  test('accepts plain name shorthand and canonical ChartOfCharacteristicTypes.Shared', async () => {
    // Plain name
    const listPlain = await listPredefinedCharacteristics(tmpDir, 'Shared');
    assert.strictEqual(listPlain.length, 2);

    // Canonical 2-segment
    const listCanonical = await listPredefinedCharacteristics(tmpDir, 'ChartOfCharacteristicTypes.Shared');
    assert.strictEqual(listCanonical.length, 2);
  });

  test('normalizes COT aliases, prefixes, empty input, and already-qualified addresses', () => {
    assert.strictEqual(normalizeCotAddress('Shared'), 'ChartOfCharacteristicTypes.Shared');
    assert.strictEqual(normalizeCotAddress('ext: Shared '), 'ext:ChartOfCharacteristicTypes.Shared');
    assert.strictEqual(normalizeCotAddress('ext:ChartOfCharacteristicTypes.Shared'), 'ext:ChartOfCharacteristicTypes.Shared');
    assert.strictEqual(normalizeCotAddress('Catalog.Shared'), 'Catalog.Shared');
    assert.strictEqual(normalizeCotAddress('   '), '');
    assert.strictEqual(normalizeCotAddress(undefined as unknown as string), '');
  });

  test('resolveCotTarget validates typed targets, configuration ownership, and malformed names', () => {
    const asTarget = (value: unknown): Parameters<typeof resolveCotTarget>[1] =>
      value as Parameters<typeof resolveCotTarget>[1];
    const expectedCotDir = path.join(tmpDir, 'ChartsOfCharacteristicTypes', COT_NAME);
    const resolvedTarget = resolveCotTarget(tmpDir, asTarget({
      configRoot: tmpDir,
      cotName: COT_NAME,
      cotDir: expectedCotDir,
    }));
    assert.deepStrictEqual(resolvedTarget, { configRoot: tmpDir, cotName: COT_NAME, cotDir: expectedCotDir });

    const validResolvedPath = { rootTag: 'ChartOfCharacteristicTypes', objectName: COT_NAME };
    assert.deepStrictEqual(
      resolveCotTarget(tmpDir, asTarget({ configRoot: tmpDir, resolvedPath: validResolvedPath })),
      { configRoot: tmpDir, cotName: COT_NAME, cotDir: expectedCotDir },
    );
    assert.deepStrictEqual(
      resolveCotTarget(tmpDir, asTarget(validResolvedPath)),
      { configRoot: tmpDir, cotName: COT_NAME, cotDir: expectedCotDir },
    );
    assert.deepStrictEqual(
      resolveCotTarget(tmpDir, 'ext:Shared'),
      { configRoot: tmpDir, cotName: COT_NAME, cotDir: expectedCotDir },
    );

    const invalidTypedTargets: unknown[] = [
      { cotDir: expectedCotDir, cotName: COT_NAME },
      { configRoot: 42, cotDir: expectedCotDir, cotName: COT_NAME },
      { configRoot: path.join(tmpDir, 'other-config'), cotDir: expectedCotDir, cotName: COT_NAME },
      { configRoot: tmpDir, cotDir: path.join(tmpDir, 'outside', COT_NAME), cotName: COT_NAME },
      { configRoot: tmpDir, cotDir: expectedCotDir, cotName: ' Shared' },
      { configRoot: tmpDir, cotDir: expectedCotDir, cotName: '.' },
      { configRoot: tmpDir, cotDir: expectedCotDir, cotName: '..' },
      { configRoot: tmpDir, cotDir: expectedCotDir, cotName: 'Bad\0Name' },
      { configRoot: tmpDir, cotDir: expectedCotDir, cotName: 'Bad/Name' },
      { configRoot: tmpDir, cotDir: expectedCotDir, cotName: 'Bad\\Name' },
      { configRoot: tmpDir, resolvedPath: { ...validResolvedPath, rootTag: 'Catalog' } },
      { configRoot: path.join(tmpDir, 'other-config'), resolvedPath: validResolvedPath },
      { configRoot: 42, resolvedPath: validResolvedPath },
      { rootTag: 'Catalog', objectName: COT_NAME },
      { rootTag: 'ChartOfCharacteristicTypes', objectName: '' },
      { rootTag: 'ChartOfCharacteristicTypes', objectName: 'Bad/Name' },
      { rootTag: 'ChartOfCharacteristicTypes', objectName: 42 },
    ];
    for (const target of invalidTypedTargets) {
      assert.throws(
        () => resolveCotTarget(tmpDir, asTarget(target)),
        (error: unknown) => error instanceof AgentPathError && error.code === 'INVALID_AGENT_PATH',
        `expected typed target to be rejected: ${JSON.stringify(target)}`,
      );
    }

    const invalidStrings = [
      '',
      '   ',
      'Catalog.Shared',
      'ChartOfCharacteristicTypes.',
      'ChartOfCharacteristicTypes.A.B',
      'ChartOfCharacteristicTypes.A/B',
      'ChartOfCharacteristicTypes.A\\B',
      'ChartOfCharacteristicTypes.A\0B',
    ];
    for (const target of invalidStrings) {
      assert.throws(
        () => resolveCotTarget(tmpDir, target),
        (error: unknown) => error instanceof AgentPathError && error.code === 'INVALID_AGENT_PATH',
        `expected string target to be rejected: ${JSON.stringify(target)}`,
      );
    }
  });
});

async function createSymlinkedCotFixture(
  tempRoot: string,
  cotName: string,
  linkSegment: 'cot-directory' | 'ext-directory',
): Promise<{
  selectedRoot: string;
  externalDirectory: string;
  externalPredefinedPath: string;
  linkPath: string;
}> {
  const selectedRoot = path.join(tempRoot, `selected-${linkSegment}`);
  const externalRoot = path.join(tempRoot, `external-${linkSegment}`);
  const externalXml = SAMPLE_PREDEFINED_XML.replace(/Номенклатура/g, 'ВнешняяХарактеристика');
  setupCotWorkspace(selectedRoot, cotName, SAMPLE_PREDEFINED_XML);
  setupCotWorkspace(externalRoot, cotName, externalXml);

  const selectedCotDir = path.join(selectedRoot, 'ChartsOfCharacteristicTypes', cotName);
  const externalCotDir = path.join(externalRoot, 'ChartsOfCharacteristicTypes', cotName);
  const linkPath = linkSegment === 'cot-directory'
    ? selectedCotDir
    : path.join(selectedCotDir, 'Ext');
  const externalDirectory = linkSegment === 'cot-directory'
    ? externalCotDir
    : path.join(externalCotDir, 'Ext');
  await fs.promises.rm(linkPath, { recursive: true, force: true });

  return {
    selectedRoot,
    externalDirectory,
    externalPredefinedPath: path.join(externalCotDir, 'Ext', 'Predefined.xml'),
    linkPath,
  };
}

function isSymlinkUnavailable(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && ['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(String(error.code)),
  );
}
