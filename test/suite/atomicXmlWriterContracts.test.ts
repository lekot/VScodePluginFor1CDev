import * as assert from 'assert';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { writeFormXml } from '../../src/formEditor/formXmlWriter';
import type { FormModel } from '../../src/formEditor/formModel';
import { setPredefinedCharacteristicType } from '../../src/agent/predefinedCharacteristicOperations';
import { MetadataType } from '../../src/models/treeNode';
import {
  ConfigurationMutationEngine,
  getConfigurationMutationEngine,
  setConfigurationMutationEngine,
} from '../../src/services/configurationSession/ConfigurationMutationEngine';
import {
  AtomicFileStorage,
  hashContent,
  type AtomicFileSystem,
} from '../../src/services/configurationSession/atomicFileStorage';
import { configureConfigurationMutationGateway } from '../../src/services/configurationSession/configurationMutationGateway';
import { MutationReceiptError } from '../../src/services/configurationSession/mutationReceiptError';
import { AgentPathError } from '../../src/agent/agentPathResolver';
import { appendPredefinedDesignerItem } from '../../src/utils/xml/predefinedDataAppender';
import { buildXmlString, writeUtf8FileWithBackup } from '../../src/utils/xml/xmlFileIo';
import { XMLWriter } from '../../src/utils/XMLWriter';

const SAMPLE_METADATA_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">
  <Catalog uuid="11111111-1111-1111-1111-111111111111">
    <Properties><Name>Products</Name></Properties>
    <ChildObjects/>
  </Catalog>
</MetaDataObject>`;

const SAMPLE_COT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<PredefinedData xmlns="http://v8.1c.ru/8.3/xcf/predef" xmlns:xs="http://www.w3.org/2001/XMLSchema" version="2.20">
  <Item><Name>Characteristic</Name><Type><xs:string/></Type></Item>
</PredefinedData>`;

const SAMPLE_FORM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20"></Form>`;
const FOREIGN_CONTENT = '<Foreign>writer</Foreign>';

type MutableReadFile = {
  readFile: (...args: unknown[]) => Promise<unknown>;
};

type MutableWriteFile = {
  writeFile: (...args: unknown[]) => Promise<void>;
};

function patchReadFile(
  replacement: (original: (...args: unknown[]) => Promise<unknown>, args: unknown[]) => Promise<unknown>,
): () => void {
  const mutable = fs.promises as unknown as MutableReadFile;
  const original = mutable.readFile;
  mutable.readFile = (...args) => replacement(original.bind(fs.promises), args);
  return () => { mutable.readFile = original; };
}

function createEngine(fileSystem?: AtomicFileSystem): ConfigurationMutationEngine {
  return new ConfigurationMutationEngine({
    fileSystem,
    runMutation: async (_resourcePath, _kind, operation) => operation(),
  });
}

function assertErrorCode(error: unknown, expectedCodes: string | readonly string[]): void {
  const allowed = Array.isArray(expectedCodes) ? expectedCodes : [expectedCodes];
  let current: unknown = error;
  while (current && typeof current === 'object') {
    if ('code' in current && allowed.includes(String((current as { code?: unknown }).code))) {
      return;
    }
    current = 'cause' in current ? (current as { cause?: unknown }).cause : undefined;
  }
  assert.fail(`Expected error chain to include one of: ${allowed.join(', ')}`);
}

function createFormModel(): FormModel {
  return {
    version: '2.20',
    childItemsRoot: [],
    attributes: [],
    commands: [],
    formEvents: [],
  };
}

suite('Atomic XML writer migration contracts (#374)', () => {
  let tempDir: string;
  let previousEngine: ConfigurationMutationEngine;
  let disposeGateway: (() => void) | undefined;

  suiteSetup(() => {
    previousEngine = getConfigurationMutationEngine();
    disposeGateway = configureConfigurationMutationGateway(
      async (_resourcePath, _kind, operation) => operation(),
    ).dispose;
    setConfigurationMutationEngine(createEngine());
  });

  suiteTeardown(() => {
    setConfigurationMutationEngine(previousEngine);
    disposeGateway?.();
  });

  setup(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atomic-xml-writers-'));
    setConfigurationMutationEngine(createEngine());
  });

  teardown(async () => {
    setConfigurationMutationEngine(createEngine());
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  test('legacy XML adapter rejects a deleted expected target instead of recreating it', async () => {
    const target = path.join(tempDir, 'Metadata.xml');
    await fsp.writeFile(target, SAMPLE_METADATA_XML, 'utf8');
    const restoreRead = patchReadFile(async (original, args) => {
      const result = await original(...args);
      if (path.resolve(String(args[0])) === path.resolve(target)) {
        await fsp.rm(target, { force: true });
      }
      return result;
    });
    try {
      let caught: unknown;
      try {
        await writeUtf8FileWithBackup(target, SAMPLE_METADATA_XML, '<Changed/>');
      } catch (error) {
        caught = error;
      }
      assert.ok(caught, 'A deleted expected target must surface a conflict');
      assertErrorCode(caught, ['STALE_TARGET_REVISION', 'STALE_TARGET_HASH']);
      await assert.rejects(fsp.readFile(target), { code: 'ENOENT' });
    } finally {
      restoreRead();
    }
  });

  test('failed legacy write does not roll back over a foreign edit', async () => {
    const target = path.join(tempDir, 'Metadata.xml');
    await fsp.writeFile(target, SAMPLE_METADATA_XML, 'utf8');
    let injected = false;
    const originalOpen = fsp.open;
    const failingAtomicFileSystem: AtomicFileSystem = {
      readFile: (filePath) => fsp.readFile(filePath),
      open: async (filePath, flags) => {
        const handle = await originalOpen(filePath, flags);
        if (!path.basename(filePath).startsWith('.cdt-')) {
          return handle;
        }
        return {
          writeFile: async () => {
            injected = true;
            await fsp.writeFile(target, FOREIGN_CONTENT, 'utf8');
            throw new Error('injected temp write failure after foreign edit');
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
      link: (existingPath, newPath) => fsp.link(existingPath, newPath),
      rename: (oldPath, newPath) => fsp.rename(oldPath, newPath),
      rm: (filePath, options) => fsp.rm(filePath, options),
    };
    setConfigurationMutationEngine(createEngine(failingAtomicFileSystem));
    const mutable = fs.promises as unknown as MutableWriteFile;
    const originalWrite = mutable.writeFile;
    mutable.writeFile = async (...args) => {
      const filePath = args[0];
      if (!injected && typeof filePath === 'string' && path.resolve(filePath) === path.resolve(target)) {
        injected = true;
        await originalWrite.call(fs.promises, target, FOREIGN_CONTENT, 'utf8');
        throw new Error('injected target write failure after foreign edit');
      }
      return originalWrite.apply(fs.promises, args);
    };
    try {
      await assert.rejects(writeUtf8FileWithBackup(target, SAMPLE_METADATA_XML, '<Changed/>'));
      assert.ok(injected, 'Failure injection must trigger through the active legacy or atomic write seam');
      assert.strictEqual(await fsp.readFile(target, 'utf8'), FOREIGN_CONTENT);
    } finally {
      mutable.writeFile = originalWrite;
      setConfigurationMutationEngine(createEngine());
    }
  });

  test('a real child-process crash during publication leaves the target entirely old or new', async () => {
    const target = path.join(tempDir, 'Metadata.xml');
    await fsp.writeFile(target, SAMPLE_METADATA_XML, 'utf8');
    const helperPath = path.resolve(__dirname, '../../src/utils/xml/xmlFileIo.js');
    const enginePath = path.resolve(__dirname, '../../src/services/configurationSession/ConfigurationMutationEngine.js');
    const script = `
      const fs = require('fs');
      const fsp = require('fs/promises');
      const path = require('path');
      const target = process.argv[1];
      const helperPath = process.argv[2];
      const enginePath = process.argv[3];
      const original = process.argv[4];
      const updated = process.argv[5];
      const originalWriteFile = fs.promises.writeFile.bind(fs.promises);
      const originalOpen = fsp.open.bind(fsp);
      fs.promises.writeFile = async (filePath, data, options) => {
        if (path.resolve(String(filePath)) === path.resolve(target)) {
          await originalWriteFile(filePath, 'partial-target', 'utf8');
          process.exit(73);
        }
        return originalWriteFile(filePath, data, options);
      };
      const atomicOpen = async (filePath, flags) => {
        const handle = await originalOpen(filePath, flags);
        if (path.basename(filePath).endsWith('.tmp')) {
          return {
            writeFile: async () => {
              await handle.writeFile(Buffer.from('partial-temp'));
              process.exit(73);
            },
            sync: () => handle.sync(),
            close: () => handle.close(),
          };
        }
        return handle;
      };
      fsp.open = atomicOpen;
      fs.promises.open = atomicOpen;
      const engineModule = require(enginePath);
      engineModule.setConfigurationMutationEngine(new engineModule.ConfigurationMutationEngine({
        runMutation: async (_resourcePath, _kind, operation) => operation(),
      }));
      const write = require(helperPath).writeUtf8FileWithBackup;
      write(target, original, updated).then(() => process.exit(0), () => process.exit(2));
    `;
    const child = spawn(process.execPath, [
      '-e', script, target, helperPath, enginePath, SAMPLE_METADATA_XML, '<Changed/>',
    ], { stdio: 'ignore' });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.strictEqual(exitCode, 73, 'The subprocess must die at the injected in-flight write');
    const afterCrash = await fsp.readFile(target, 'utf8');
    assert.ok(
      afterCrash === SAMPLE_METADATA_XML || afterCrash === '<Changed/>',
      `Crash must preserve one complete version of the target, got: ${afterCrash}`,
    );
  });

  test('a real child-process crash after atomic rename leaves the complete new target', async () => {
    const target = path.join(tempDir, 'Metadata.xml');
    await fsp.writeFile(target, SAMPLE_METADATA_XML, 'utf8');
    const helperPath = path.resolve(__dirname, '../../src/utils/xml/xmlFileIo.js');
    const enginePath = path.resolve(__dirname, '../../src/services/configurationSession/ConfigurationMutationEngine.js');
    const script = `
      const fs = require('fs');
      const fsp = require('fs/promises');
      const path = require('path');
      const target = process.argv[1];
      const helperPath = process.argv[2];
      const enginePath = process.argv[3];
      const original = process.argv[4];
      const updated = process.argv[5];
      const originalWriteFile = fs.promises.writeFile.bind(fs.promises);
      const originalRename = fsp.rename.bind(fsp);
      fs.promises.writeFile = async (filePath, data, options) => {
        if (path.resolve(String(filePath)) === path.resolve(target)) {
          await originalWriteFile(filePath, 'partial-target', 'utf8');
          process.exit(74);
        }
        return originalWriteFile(filePath, data, options);
      };
      fsp.rename = async (source, destination) => {
        await originalRename(source, destination);
        process.exit(74);
      };
      fs.promises.rename = fsp.rename;
      const engineModule = require(enginePath);
      engineModule.setConfigurationMutationEngine(new engineModule.ConfigurationMutationEngine({
        runMutation: async (_resourcePath, _kind, operation) => operation(),
      }));
      const write = require(helperPath).writeUtf8FileWithBackup;
      write(target, original, updated).then(() => process.exit(0), () => process.exit(2));
    `;
    const child = spawn(process.execPath, [
      '-e', script, target, helperPath, enginePath, SAMPLE_METADATA_XML, '<Changed/>',
    ], { stdio: 'ignore' });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.strictEqual(exitCode, 74, 'The subprocess must die immediately after the rename effect');
    assert.strictEqual(await fsp.readFile(target, 'utf8'), '<Changed/>');
  });

  test('Form.xml snapshot is not recreated after deletion before publication', async () => {
    const target = path.join(tempDir, 'Form.xml');
    await fsp.writeFile(target, SAMPLE_FORM_XML, 'utf8');
    const restoreRead = patchReadFile(async (original, args) => {
      const result = await original(...args);
      if (path.resolve(String(args[0])) === path.resolve(target)) {
        await fsp.rm(target, { force: true });
      }
      return result;
    });
    try {
      let caught: unknown;
      try {
        await writeFormXml(target, createFormModel());
      } catch (error) {
        caught = error;
      }
      assert.ok(caught, 'Form save must reject a stale snapshot');
      assertErrorCode(caught, ['STALE_TARGET_REVISION', 'STALE_TARGET_HASH']);
      await assert.rejects(fsp.readFile(target), { code: 'ENOENT' });
    } finally {
      restoreRead();
    }
  });

  test('XMLWriter snapshot is not recreated after deletion before publication', async () => {
    const target = path.join(tempDir, 'Catalog.xml');
    await fsp.writeFile(target, SAMPLE_METADATA_XML, 'utf8');
    const restoreRead = patchReadFile(async (original, args) => {
      const result = await original(...args);
      if (path.resolve(String(args[0])) === path.resolve(target)) {
        await fsp.rm(target, { force: true });
      }
      return result;
    });
    try {
      let caught: unknown;
      try {
        await XMLWriter.addNestedElement(target, 'Attribute', 'NewField');
      } catch (error) {
        caught = error;
      }
      assert.ok(caught, 'XMLWriter must reject a stale snapshot');
      assertErrorCode(caught, ['STALE_TARGET_REVISION', 'STALE_TARGET_HASH']);
      await assert.rejects(fsp.readFile(target), { code: 'ENOENT' });
    } finally {
      restoreRead();
    }
  });

  test('XMLWriter create refuses to overwrite an existing target', async () => {
    const target = path.join(tempDir, 'Existing.xml');
    const foreignContent = '<Foreign>must remain</Foreign>';
    await fsp.writeFile(target, foreignContent, 'utf8');

    await assert.rejects(
      XMLWriter.createMinimalElementFile(target, 'Catalog', 'Replacement', '2.20'),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assertErrorCode(error, 'STALE_TARGET_REVISION');
        return true;
      },
    );
    assert.strictEqual(await fsp.readFile(target, 'utf8'), foreignContent);
  });

  test('CoT type transform does not recreate a deleted Predefined.xml snapshot', async () => {
    const target = path.join(tempDir, 'ChartsOfCharacteristicTypes', 'Kinds', 'Ext', 'Predefined.xml');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, SAMPLE_COT_XML, 'utf8');
    const originalReplace = AtomicFileStorage.prototype.replace;
    AtomicFileStorage.prototype.replace = async function (targetPath, content, expectedHash) {
      await fsp.rm(target, { force: true });
      return originalReplace.call(this, targetPath, content, expectedHash);
    };
    try {
      let caught: unknown;
      try {
        await setPredefinedCharacteristicType(tempDir, 'Kinds', 'Characteristic', ['xs:dateTime']);
      } catch (error) {
        caught = error;
      }
      assert.ok(caught, 'CoT setter must reject a deleted target');
      assertErrorCode(caught, ['STALE_TARGET_REVISION', 'STALE_TARGET_HASH']);
      await assert.rejects(fsp.readFile(target), { code: 'ENOENT' });
    } finally {
      AtomicFileStorage.prototype.replace = originalReplace;
    }
  });

  test('CoT transform preserves its semantic validation error outside mutation receipt projection', async () => {
    const target = path.join(tempDir, 'ChartsOfCharacteristicTypes', 'Kinds', 'Ext', 'Predefined.xml');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, SAMPLE_COT_XML, 'utf8');

    await assert.rejects(
      setPredefinedCharacteristicType(tempDir, 'Kinds', 'Missing', ['xs:string']),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!(error instanceof MutationReceiptError), 'Domain validation must remain outside receipt mapping');
        assert.match(error.message, /Missing.*not found/i);
        return true;
      },
    );
    assert.strictEqual(await fsp.readFile(target, 'utf8'), SAMPLE_COT_XML);
  });

  test('CoT transform preserves a typed path-boundary failure when its namespace changes', async function () {
    const configRoot = path.join(tempDir, 'config');
    const cotDirectory = path.join(configRoot, 'ChartsOfCharacteristicTypes', 'Kinds');
    const extDirectory = path.join(cotDirectory, 'Ext');
    const target = path.join(extDirectory, 'Predefined.xml');
    const outsideDirectory = path.join(tempDir, 'outside');
    const probeLink = path.join(tempDir, 'symlink-probe');
    await fsp.mkdir(extDirectory, { recursive: true });
    await fsp.mkdir(outsideDirectory, { recursive: true });
    await fsp.writeFile(target, SAMPLE_COT_XML, 'utf8');
    await fsp.writeFile(path.join(outsideDirectory, 'Predefined.xml'), FOREIGN_CONTENT, 'utf8');

    try {
      await fsp.symlink(outsideDirectory, probeLink, process.platform === 'win32' ? 'junction' : 'dir');
      await fsp.rm(probeLink, { recursive: true, force: true });
    } catch {
      this.skip();
      return;
    }

    const originalReadFile = (fs.promises as unknown as MutableReadFile).readFile;
    const mutable = fs.promises as unknown as MutableReadFile;
    const movedExtDirectory = `${extDirectory}-original`;
    let replacedNamespace = false;
    mutable.readFile = async (...args) => {
      const result = await originalReadFile.apply(fs.promises, args);
      if (!replacedNamespace && path.basename(String(args[0])) === 'Predefined.xml') {
        replacedNamespace = true;
        await fsp.rename(extDirectory, movedExtDirectory);
        await fsp.symlink(outsideDirectory, extDirectory, process.platform === 'win32' ? 'junction' : 'dir');
      }
      return result;
    };

    try {
      await assert.rejects(
        setPredefinedCharacteristicType(configRoot, 'Kinds', 'Characteristic', ['xs:string']),
        (error: unknown) => error instanceof AgentPathError && error.code === 'INVALID_AGENT_PATH',
      );
      assert.ok(replacedNamespace, 'The namespace must be replaced between the engine read and domain transform');
      assert.strictEqual(await fsp.readFile(path.join(outsideDirectory, 'Predefined.xml'), 'utf8'), FOREIGN_CONTENT);
      assert.strictEqual(await fsp.readFile(path.join(movedExtDirectory, 'Predefined.xml'), 'utf8'), SAMPLE_COT_XML);
    } finally {
      mutable.readFile = originalReadFile;
    }
  });

  test('Predefined.xml create-if-absent preserves a concurrent creator', async () => {
    const target = path.join(tempDir, 'Catalogs', 'Products', 'Ext', 'Predefined.xml');
    let injected = false;
    const restoreRead = patchReadFile(async (original, args) => {
      try {
        return await original(...args);
      } catch (error) {
        if (
          !injected && path.resolve(String(args[0])) === path.resolve(target) &&
          (error as NodeJS.ErrnoException).code === 'ENOENT'
        ) {
          injected = true;
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await fsp.writeFile(target, FOREIGN_CONTENT, 'utf8');
        }
        throw error;
      }
    });
    try {
      let caught: unknown;
      try {
        await appendPredefinedDesignerItem(
          target,
          MetadataType.Catalog,
          'ConcurrentItem',
          'ConcurrentItem',
          undefined,
          '2.20',
        );
      } catch (error) {
        caught = error;
      }
      assert.ok(caught, 'A competing creator must be reported as a conflict');
      assert.strictEqual(await fsp.readFile(target, 'utf8'), FOREIGN_CONTENT);
    } finally {
      restoreRead();
    }
  });

  test('Predefined.xml append merges into a valid concurrent creator without losing its data', async () => {
    const target = path.join(tempDir, 'Catalogs', 'Products', 'Ext', 'Predefined.xml');
    const concurrentContent = `<?xml version="1.0" encoding="UTF-8"?>
<PredefinedData xmlns="http://v8.1c.ru/8.3/xcf/predef" version="2.20">
  <Item><Name>ConcurrentItem</Name><Code>42</Code><Description>Created elsewhere</Description></Item>
  <UnknownPayload><Value>preserve-me</Value></UnknownPayload>
</PredefinedData>`;
    let injected = false;
    const fileSystem: AtomicFileSystem = {
      readFile: (filePath) => fsp.readFile(filePath),
      open: (filePath, flags) => fsp.open(filePath, flags),
      link: async (existingPath, newPath) => {
        if (!injected && path.basename(newPath) === 'Predefined.xml' && path.basename(path.dirname(newPath)) === 'Ext') {
          injected = true;
          await fsp.writeFile(target, concurrentContent, 'utf8');
        }
        return fsp.link(existingPath, newPath);
      },
      rename: (oldPath, newPath) => fsp.rename(oldPath, newPath),
      rm: (filePath, options) => fsp.rm(filePath, options),
    };
    setConfigurationMutationEngine(createEngine(fileSystem));
    try {
      await appendPredefinedDesignerItem(
        target,
        MetadataType.Catalog,
        'OurItem',
        'Added by this operation',
        undefined,
        '2.20',
      );

      assert.ok(injected, 'A valid competing creator must win the initial atomic create');
      const finalContent = await fsp.readFile(target, 'utf8');
      assert.match(finalContent, /<Name>ConcurrentItem<\/Name>/);
      assert.match(finalContent, /<Name>OurItem<\/Name>/);
      assert.match(finalContent, /<UnknownPayload>\s*<Value>preserve-me<\/Value>\s*<\/UnknownPayload>/);
    } finally {
      setConfigurationMutationEngine(createEngine());
    }
  });

  test('mutable XML transforms retain the latest state after engine admission', async () => {
    const target = path.join(tempDir, 'Current.xml');
    const foreignXml = SAMPLE_METADATA_XML.replace('Products', 'Foreign');
    await fsp.writeFile(target, foreignXml, 'utf8');
    const receipt = await createEngine().transformFile(
      target,
      { kind: 'test.mutable-transform', resourcePath: target },
      (state) => ({
        content: buildXmlString({ Root: { Name: state.content.includes('Foreign') ? 'ForeignUpdated' : 'WrongBase' } }),
        result: undefined,
      }),
    );
    assert.strictEqual(receipt.status, 'committed');
    assert.ok((await fsp.readFile(target, 'utf8')).includes('ForeignUpdated'));
  });
});

suite('AtomicFileStorage reports pre-effect target deletion as stale hash (#374)', () => {
  let tempDir: string;

  setup(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atomic-xml-enoent-'));
  });

  teardown(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  test('initial compare-and-swap read returns a typed stale-target conflict on ENOENT', async () => {
    const target = path.join(tempDir, 'Metadata.xml');
    await fsp.writeFile(target, 'old', 'utf8');
    let reads = 0;
    const fileSystem: AtomicFileSystem = {
      readFile: async (filePath) => {
        if (path.basename(filePath) === path.basename(target) && reads++ === 0) {
          await fsp.rm(target, { force: true });
          throw Object.assign(new Error('target was deleted'), { code: 'ENOENT' });
        }
        return fsp.readFile(filePath);
      },
      open: (filePath, flags) => fsp.open(filePath, flags),
      link: (existingPath, newPath) => fsp.link(existingPath, newPath),
      rename: (oldPath, newPath) => fsp.rename(oldPath, newPath),
      rm: (filePath, options) => fsp.rm(filePath, options),
    };
    const outcome = await new AtomicFileStorage(tempDir, fileSystem)
      .replace(target, 'new', hashContent('old'));
    assert.strictEqual(outcome.status, 'conflict');
    assert.strictEqual(outcome.code, 'STALE_TARGET_HASH');
    await assert.rejects(fsp.readFile(target), { code: 'ENOENT' });
  });

  test('pre-rename compare-and-swap read returns stale-target conflict without recreating target', async () => {
    const target = path.join(tempDir, 'Metadata.xml');
    await fsp.writeFile(target, 'old', 'utf8');
    let targetReads = 0;
    const fileSystem: AtomicFileSystem = {
      readFile: async (filePath) => {
        if (path.basename(filePath) === path.basename(target) && ++targetReads === 2) {
          await fsp.rm(target, { force: true });
          throw Object.assign(new Error('target was deleted before rename'), { code: 'ENOENT' });
        }
        return fsp.readFile(filePath);
      },
      open: (filePath, flags) => fsp.open(filePath, flags),
      link: (existingPath, newPath) => fsp.link(existingPath, newPath),
      rename: (oldPath, newPath) => fsp.rename(oldPath, newPath),
      rm: (filePath, options) => fsp.rm(filePath, options),
    };
    const outcome = await new AtomicFileStorage(tempDir, fileSystem)
      .replace(target, 'new', hashContent('old'));
    assert.strictEqual(outcome.status, 'conflict');
    assert.strictEqual(outcome.code, 'STALE_TARGET_HASH');
    await assert.rejects(fsp.readFile(target), { code: 'ENOENT' });
    assert.deepStrictEqual((await fsp.readdir(tempDir)).filter((name) => name.endsWith('.tmp')), []);
  });
});
