import * as assert from 'assert';
import * as fs from 'fs/promises';
import fsPromises = require('fs/promises');
import * as os from 'os';
import * as path from 'path';

import { indexMetadataFile, indexMetadataFolder } from '../../../src/compareMerge/metadata/metadataIndexer';

suite('MetadataIndexer', () => {
  test('extracts qualified name and uuid from Designer XML Properties', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-indexer-'));
    const filePath = path.join(tempRoot, 'Catalogs', 'Products.xml');
    await writeFile(
      filePath,
      `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject uuid="catalog-root-uuid">
  <Catalog uuid="catalog-object-uuid">
    <Properties>
      <Name>Products</Name>
    </Properties>
  </Catalog>
</MetaDataObject>`
    );

    const identity = await indexMetadataFile({
      sourceId: 'left-source',
      side: 'left',
      filePath,
      metadataType: 'Catalog',
    });

    assert.strictEqual(identity.sourceId, 'left-source');
    assert.strictEqual(identity.side, 'left');
    assert.strictEqual(identity.metadataType, 'Catalog');
    assert.strictEqual(identity.qualifiedName, 'Catalog.Products');
    assert.strictEqual(identity.uuid, 'catalog-object-uuid');
    assert.strictEqual(identity.filePath, filePath);
    assert.strictEqual(identity.containerPath, path.dirname(filePath));
    assert.strictEqual(identity.objectPath, 'Catalog.Products');
    assert.strictEqual(identity.nameSource, 'xmlPropertiesName');
    assert.strictEqual(identity.uuidSource, 'xmlAttribute');
    assert.strictEqual(identity.confidence, 'strong');
  });

  test('falls back to path name and folder type when XML omits identity fields', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-indexer-'));
    const filePath = path.join(tempRoot, 'Documents', 'SalesOrder.xml');
    await writeFile(
      filePath,
      `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject>
  <Document>
    <Properties>
      <Synonym>Sales order</Synonym>
    </Properties>
  </Document>
</MetaDataObject>`
    );

    const identity = await indexMetadataFile({
      sourceId: 'right-source',
      side: 'right',
      filePath,
    });

    assert.strictEqual(identity.metadataType, 'Document');
    assert.strictEqual(identity.qualifiedName, 'Document.SalesOrder');
    assert.strictEqual(identity.uuid, undefined);
    assert.strictEqual(identity.nameSource, 'fileName');
    assert.strictEqual(identity.uuidSource, 'missing');
    assert.strictEqual(identity.confidence, 'nameOnly');
  });

  test('indexes XML files in a metadata type folder', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-indexer-'));
    const catalogsPath = path.join(tempRoot, 'Catalogs');
    await writeFile(
      path.join(catalogsPath, 'Products.xml'),
      '<MetaDataObject><Catalog uuid="uuid-products"><Properties><Name>Products</Name></Properties></Catalog></MetaDataObject>'
    );
    await writeFile(
      path.join(catalogsPath, 'Services.xml'),
      '<MetaDataObject><Catalog><Properties><Name>Services</Name></Properties></Catalog></MetaDataObject>'
    );
    await writeFile(path.join(catalogsPath, 'ObjectModule.bsl'), 'procedure Test()');

    const identities = await indexMetadataFolder({
      sourceId: 'left-source',
      side: 'left',
      folderPath: catalogsPath,
    });

    assert.deepStrictEqual(
      identities.map((identity) => identity.qualifiedName).sort(),
      ['Catalog.Products', 'Catalog.Services']
    );
    assert.deepStrictEqual(
      identities.map((identity) => identity.metadataType),
      ['Catalog', 'Catalog']
    );
  });

  test('indexes Designer folder-style top-level metadata without duplicating object name', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-indexer-'));
    const catalogsPath = path.join(tempRoot, 'Catalogs');
    await writeFile(
      path.join(catalogsPath, 'Products', 'Products.xml'),
      '<MetaDataObject><Catalog uuid="uuid-products"><Properties><Name>Products</Name></Properties></Catalog></MetaDataObject>'
    );

    const identities = await indexMetadataFolder({
      sourceId: 'left-source',
      side: 'left',
      folderPath: catalogsPath,
    });

    assert.deepStrictEqual(
      identities.map((identity) => identity.qualifiedName),
      ['Catalog.Products']
    );
    assert.deepStrictEqual(
      identities.map((identity) => identity.objectPath),
      ['Catalog.Products']
    );
  });

  test('skips service XML files when indexing a configuration root', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-indexer-'));
    await writeFile(
      path.join(tempRoot, 'Configuration.xml'),
      '<MetaDataObject><Configuration uuid="configuration-uuid"><Properties><Name>MainConfiguration</Name></Properties></Configuration></MetaDataObject>'
    );
    await writeFile(
      path.join(tempRoot, 'ConfigDumpInfo.xml'),
      '<ConfigDumpInfo><Format>1</Format></ConfigDumpInfo>'
    );
    await writeFile(
      path.join(tempRoot, 'Catalogs', 'Products', 'Products.xml'),
      '<MetaDataObject><Catalog uuid="uuid-products"><Properties><Name>Products</Name></Properties></Catalog></MetaDataObject>'
    );

    const identities = await indexMetadataFolder({
      sourceId: 'left-source',
      side: 'left',
      folderPath: tempRoot,
    });

    assert.deepStrictEqual(
      identities.map((identity) => identity.qualifiedName),
      ['Catalog.Products']
    );
  });

  test('includes owner context for same-name nested metadata objects', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-indexer-'));
    const documentsPath = path.join(tempRoot, 'Documents');
    await writeFile(
      path.join(documentsPath, 'SalesOrder', 'SalesOrder.xml'),
      '<MetaDataObject><Document><Properties><Name>SalesOrder</Name></Properties></Document></MetaDataObject>'
    );
    await writeFile(
      path.join(documentsPath, 'ReturnOrder', 'ReturnOrder.xml'),
      '<MetaDataObject><Document><Properties><Name>ReturnOrder</Name></Properties></Document></MetaDataObject>'
    );
    await writeFile(
      path.join(documentsPath, 'SalesOrder', 'Forms', 'MainForm', 'MainForm.xml'),
      '<MetaDataObject><Form uuid="sales-main-form"><Properties><Name>MainForm</Name></Properties></Form></MetaDataObject>'
    );
    await writeFile(
      path.join(documentsPath, 'ReturnOrder', 'Forms', 'MainForm', 'MainForm.xml'),
      '<MetaDataObject><Form uuid="return-main-form"><Properties><Name>MainForm</Name></Properties></Form></MetaDataObject>'
    );

    const identities = await indexMetadataFolder({
      sourceId: 'left-source',
      side: 'left',
      folderPath: documentsPath,
    });
    const formIdentities = identities
      .filter((identity) => identity.metadataType === 'Form')
      .sort((left, right) => left.qualifiedName.localeCompare(right.qualifiedName));

    assert.deepStrictEqual(
      formIdentities.map((identity) => identity.qualifiedName),
      ['Document.ReturnOrder.Form.MainForm', 'Document.SalesOrder.Form.MainForm']
    );
    assert.strictEqual(new Set(formIdentities.map((identity) => identity.qualifiedName)).size, 2);
  });

  test('indexes Designer form descriptor but skips Ext form structure XML', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-indexer-'));
    await writeFile(
      path.join(tempRoot, 'Documents', 'SalesOrder', 'SalesOrder.xml'),
      '<MetaDataObject><Document><Properties><Name>SalesOrder</Name></Properties></Document></MetaDataObject>'
    );
    await writeFile(
      path.join(tempRoot, 'Documents', 'SalesOrder', 'Forms', 'MainForm.xml'),
      '<MetaDataObject><Form uuid="sales-main-form"><Properties><Name>MainForm</Name></Properties></Form></MetaDataObject>'
    );
    await writeFile(
      path.join(tempRoot, 'Documents', 'SalesOrder', 'Forms', 'MainForm', 'Ext', 'Form.xml'),
      '<Form><AutoCommandBar name="FormCommandBar"/></Form>'
    );

    const identities = await indexMetadataFolder({
      sourceId: 'left-source',
      side: 'left',
      folderPath: tempRoot,
    });
    const formIdentities = identities.filter((identity) => identity.metadataType === 'Form');

    assert.deepStrictEqual(
      formIdentities.map((identity) => identity.qualifiedName),
      ['Document.SalesOrder.Form.MainForm']
    );
    assert.strictEqual(formIdentities[0]?.filePath, path.join(tempRoot, 'Documents', 'SalesOrder', 'Forms', 'MainForm.xml'));
  });

  test('indexes InformationRegisters from configuration root', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-indexer-'));
    await writeFile(
      path.join(tempRoot, 'InformationRegisters', 'Prices.xml'),
      '<MetaDataObject><InformationRegister><Properties><Name>Prices</Name></Properties></InformationRegister></MetaDataObject>'
    );

    const identities = await indexMetadataFolder({
      sourceId: 'left-source',
      side: 'left',
      folderPath: tempRoot,
    });

    assert.deepStrictEqual(
      identities.map((identity) => identity.qualifiedName),
      ['InformationRegister.Prices']
    );
    assert.deepStrictEqual(
      identities.map((identity) => identity.metadataType),
      ['InformationRegister']
    );
  });

  test('indexes InformationRegisters folder directly', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-indexer-'));
    const registersPath = path.join(tempRoot, 'InformationRegisters');
    await writeFile(
      path.join(registersPath, 'Prices.xml'),
      '<MetaDataObject><InformationRegister><Properties><Name>Prices</Name></Properties></InformationRegister></MetaDataObject>'
    );

    const identities = await indexMetadataFolder({
      sourceId: 'left-source',
      side: 'left',
      folderPath: registersPath,
    });

    assert.deepStrictEqual(
      identities.map((identity) => identity.qualifiedName),
      ['InformationRegister.Prices']
    );
    assert.deepStrictEqual(
      identities.map((identity) => identity.metadataType),
      ['InformationRegister']
    );
  });

  test('uses bounded parallel reads for queued Designer metadata folders', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-indexer-directory-parallel-'));
    const catalogsPath = path.join(tempRoot, 'Catalogs');
    for (let index = 0; index < 8; index += 1) {
      const name = `Item${index}`;
      await writeFile(
        path.join(catalogsPath, name, `${name}.xml`),
        `<MetaDataObject><Catalog uuid="${name}"><Properties><Name>${name}</Name></Properties></Catalog></MetaDataObject>`
      );
    }

    const mutableFs = fsPromises;
    const originalReaddir = mutableFs.readdir;
    const firstChildRead = deferred();
    const releaseChildReads = deferred();
    let activeChildReads = 0;
    let maximumChildReads = 0;
    let childReadCount = 0;
    let traversal: Promise<Awaited<ReturnType<typeof indexMetadataFolder>>> | undefined;
    const instrumentedReaddir = (async (...args: Parameters<typeof originalReaddir>) => {
      const requestedPath = path.resolve(String(args[0]));
      if (path.dirname(requestedPath) !== path.resolve(catalogsPath)) {
        return Reflect.apply(originalReaddir, mutableFs, args);
      }

      childReadCount += 1;
      activeChildReads += 1;
      maximumChildReads = Math.max(maximumChildReads, activeChildReads);
      firstChildRead.resolve();
      try {
        await releaseChildReads.promise;
        return await Reflect.apply(originalReaddir, mutableFs, args);
      } finally {
        activeChildReads -= 1;
      }
    }) as typeof originalReaddir;
    Object.defineProperty(mutableFs, 'readdir', { configurable: true, value: instrumentedReaddir });

    try {
      traversal = indexMetadataFolder({
        sourceId: 'left-source',
        side: 'left',
        folderPath: tempRoot,
        directoryConcurrency: 3,
      });
      await firstChildRead.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.ok(maximumChildReads >= 2, 'queued child folders should be read concurrently');
      assert.ok(maximumChildReads <= 3, `directory concurrency exceeded 3: ${maximumChildReads}`);
      releaseChildReads.resolve();
      const identities = await traversal;
      assert.deepStrictEqual(
        identities.map((identity) => identity.qualifiedName),
        Array.from({ length: 8 }, (_, index) => `Catalog.Item${index}`)
      );
      assert.strictEqual(childReadCount, 8);
    } finally {
      releaseChildReads.resolve();
      if (traversal) {
        await traversal;
      }
      Object.defineProperty(mutableFs, 'readdir', { configurable: true, value: originalReaddir });
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('drains nested directory reads after cancellation without dispatching queued folders', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-indexer-cancel-directories-'));
    const catalogsPath = path.join(tempRoot, 'Catalogs');
    for (let index = 0; index < 8; index += 1) {
      const name = `Item${index}`;
      await writeFile(
        path.join(catalogsPath, name, `${name}.xml`),
        `<MetaDataObject><Catalog uuid="${name}" /></MetaDataObject>`
      );
    }

    const mutableFs = fsPromises;
    const originalReaddir = mutableFs.readdir;
    const firstChildRead = deferred();
    const firstChildDrained = deferred();
    const releaseFirstChild = deferred();
    const releaseSecondChild = deferred();
    const cancellation = { isCancellationRequested: false };
    const childPaths: string[] = [];
    let activeChildReads = 0;
    let settled = false;
    let outcome: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
    const instrumentedReaddir = (async (...args: Parameters<typeof originalReaddir>) => {
      const requestedPath = path.resolve(String(args[0]));
      if (path.dirname(requestedPath) !== path.resolve(catalogsPath)) {
        return Reflect.apply(originalReaddir, mutableFs, args);
      }

      const index = childPaths.push(requestedPath) - 1;
      activeChildReads += 1;
      firstChildRead.resolve();
      try {
        await (index === 0 ? releaseFirstChild.promise : releaseSecondChild.promise);
        return await Reflect.apply(originalReaddir, mutableFs, args);
      } finally {
        activeChildReads -= 1;
        if (index === 0) {
          firstChildDrained.resolve();
        }
      }
    }) as typeof originalReaddir;
    Object.defineProperty(mutableFs, 'readdir', { configurable: true, value: instrumentedReaddir });

    try {
      outcome = indexMetadataFolder({
        sourceId: 'left-source',
        side: 'left',
        folderPath: tempRoot,
        directoryConcurrency: 2,
        cancellation,
      }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error })
      ).finally(() => {
        settled = true;
      });

      await firstChildRead.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(childPaths.length, 2, 'the bounded queue should keep two directory reads active');
      assert.strictEqual(activeChildReads, 2);

      cancellation.isCancellationRequested = true;
      releaseFirstChild.resolve();
      await firstChildDrained.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(settled, false, 'the traversal must drain the remaining directory read');
      assert.strictEqual(activeChildReads, 1);
      assert.strictEqual(childPaths.length, 2, 'cancellation must stop dispatching queued directories');

      releaseSecondChild.resolve();
      const result = await outcome;
      assert.strictEqual(result.ok, false);
      assert.strictEqual((result as { error: { code?: string } }).error.code, 'CONFIGURATION_COMPARE_CANCELLED');
      assert.strictEqual(activeChildReads, 0);
      assert.strictEqual(childPaths.length, 2);
    } finally {
      cancellation.isCancellationRequested = true;
      releaseFirstChild.resolve();
      releaseSecondChild.resolve();
      if (outcome) {
        await outcome;
      }
      Object.defineProperty(mutableFs, 'readdir', { configurable: true, value: originalReaddir });
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('drains nested directory reads after an error and stops dispatching queued folders', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-indexer-error-directories-'));
    const catalogsPath = path.join(tempRoot, 'Catalogs');
    for (let index = 0; index < 8; index += 1) {
      const name = `Item${index}`;
      await writeFile(
        path.join(catalogsPath, name, `${name}.xml`),
        `<MetaDataObject><Catalog uuid="${name}" /></MetaDataObject>`
      );
    }

    const mutableFs = fsPromises;
    const originalReaddir = mutableFs.readdir;
    const firstChildRead = deferred();
    const bothChildReadsStarted = deferred();
    const firstChildFailed = deferred();
    const releaseSecondChild = deferred();
    const directoryFailure = new Error('simulated nested metadata directory failure');
    const childPaths: string[] = [];
    let activeChildReads = 0;
    let settled = false;
    let outcome: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
    const instrumentedReaddir = (async (...args: Parameters<typeof originalReaddir>) => {
      const requestedPath = path.resolve(String(args[0]));
      if (path.dirname(requestedPath) !== path.resolve(catalogsPath)) {
        return Reflect.apply(originalReaddir, mutableFs, args);
      }

      const index = childPaths.push(requestedPath) - 1;
      activeChildReads += 1;
      if (index === 0) {
        firstChildRead.resolve();
      } else if (index === 1) {
        bothChildReadsStarted.resolve();
      }
      try {
        if (index === 0) {
          await bothChildReadsStarted.promise;
          firstChildFailed.resolve();
          throw directoryFailure;
        }
        if (index === 1) {
          await releaseSecondChild.promise;
        }
        return await Reflect.apply(originalReaddir, mutableFs, args);
      } finally {
        activeChildReads -= 1;
      }
    }) as typeof originalReaddir;
    Object.defineProperty(mutableFs, 'readdir', { configurable: true, value: instrumentedReaddir });

    try {
      outcome = indexMetadataFolder({
        sourceId: 'left-source',
        side: 'left',
        folderPath: tempRoot,
        directoryConcurrency: 2,
      }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error })
      ).finally(() => {
        settled = true;
      });

      await firstChildRead.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(childPaths.length, 2, 'the bounded queue should have started a second directory read');
      await bothChildReadsStarted.promise;
      await firstChildFailed.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(settled, false, 'a directory error must wait for the other in-flight read');
      assert.strictEqual(activeChildReads, 1);
      assert.strictEqual(childPaths.length, 2, 'a directory error must stop dispatching queued work');

      releaseSecondChild.resolve();
      const result = await outcome;
      assert.strictEqual(result.ok, false);
      assert.strictEqual((result as { error: unknown }).error, directoryFailure);
      assert.strictEqual(activeChildReads, 0);
      assert.strictEqual(childPaths.length, 2);
    } finally {
      bothChildReadsStarted.resolve();
      releaseSecondChild.resolve();
      if (outcome) {
        await outcome;
      }
      Object.defineProperty(mutableFs, 'readdir', { configurable: true, value: originalReaddir });
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('drains metadata reads after cancellation without scheduling additional files', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-indexer-cancel-reads-'));
    const catalogsPath = path.join(tempRoot, 'Catalogs');
    const firstPath = path.join(catalogsPath, 'A.xml');
    const secondPath = path.join(catalogsPath, 'B.xml');
    await writeFile(firstPath, '<MetaDataObject><Catalog uuid="a" /></MetaDataObject>');
    await writeFile(secondPath, '<MetaDataObject><Catalog uuid="b" /></MetaDataObject>');
    await writeFile(path.join(catalogsPath, 'C.xml'), '<MetaDataObject><Catalog uuid="c" /></MetaDataObject>');

    const mutableFs = fsPromises;
    const originalOpen = mutableFs.open;
    const bothStarted = deferred();
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    const secondReadClosed = deferred();
    const cancellation = { isCancellationRequested: false };
    const openedPaths: string[] = [];
    let activeOpens = 0;
    let settled = false;
    let outcome: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
    const instrumentedOpen = (async (...args: Parameters<typeof originalOpen>) => {
      const filePath = String(args[0]);
      openedPaths.push(filePath);
      activeOpens += 1;
      if (openedPaths.length === 2) {
        bothStarted.resolve();
      }
      try {
        if (path.resolve(filePath) === path.resolve(firstPath)) {
          await releaseFirst.promise;
        } else if (path.resolve(filePath) === path.resolve(secondPath)) {
          await releaseSecond.promise;
        }
        const handle = await Reflect.apply(originalOpen, mutableFs, args);
        if (path.resolve(filePath) !== path.resolve(secondPath)) {
          return handle;
        }
        return new Proxy(handle, {
          get(target, property, receiver) {
            const member = Reflect.get(target, property, receiver);
            if (property === 'close') {
              return async (...closeArgs: Parameters<typeof handle.close>) => {
                try {
                  return await Reflect.apply(member as (...items: unknown[]) => unknown, target, closeArgs);
                } finally {
                  secondReadClosed.resolve();
                }
              };
            }
            return typeof member === 'function' ? member.bind(target) : member;
          },
        });
      } finally {
        activeOpens -= 1;
      }
    }) as typeof originalOpen;
    Object.defineProperty(mutableFs, 'open', { configurable: true, value: instrumentedOpen });

    try {
      outcome = indexMetadataFolder({
        sourceId: 'left-source',
        side: 'left',
        folderPath: catalogsPath,
        concurrency: 2,
        cancellation,
      }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error })
      ).finally(() => {
        settled = true;
      });

      await bothStarted.promise;
      cancellation.isCancellationRequested = true;
      releaseSecond.resolve();
      await secondReadClosed.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.strictEqual(settled, false, 'cancellation must wait for the other in-flight metadata read');
      assert.strictEqual(activeOpens, 1);
      releaseFirst.resolve();
      const result = await outcome;
      assert.strictEqual(result.ok, false);
      assert.strictEqual((result as { error: { code?: string } }).error.code, 'CONFIGURATION_COMPARE_CANCELLED');
      assert.strictEqual(activeOpens, 0);
      assert.deepStrictEqual(openedPaths.map((filePath) => path.basename(filePath)), ['A.xml', 'B.xml']);
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
      if (outcome) {
        await outcome;
      }
      Object.defineProperty(mutableFs, 'open', { configurable: true, value: originalOpen });
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('drains metadata reads after a file failure and stops dispatching new files', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-indexer-failed-read-'));
    const catalogsPath = path.join(tempRoot, 'Catalogs');
    const firstPath = path.join(catalogsPath, 'A.xml');
    const secondPath = path.join(catalogsPath, 'B.xml');
    await writeFile(firstPath, '<MetaDataObject><Catalog uuid="a" /></MetaDataObject>');
    await writeFile(secondPath, '<MetaDataObject><Catalog uuid="b" /></MetaDataObject>');
    await writeFile(path.join(catalogsPath, 'C.xml'), '<MetaDataObject><Catalog uuid="c" /></MetaDataObject>');

    const mutableFs = fsPromises;
    const originalOpen = mutableFs.open;
    const bothStarted = deferred();
    const releaseSecond = deferred();
    const fileFailure = new Error('simulated metadata read failure');
    const openedPaths: string[] = [];
    let activeOpens = 0;
    let firstFailed = false;
    let settled = false;
    let outcome: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
    const instrumentedOpen = (async (...args: Parameters<typeof originalOpen>) => {
      const filePath = String(args[0]);
      openedPaths.push(filePath);
      activeOpens += 1;
      if (openedPaths.length === 2) {
        bothStarted.resolve();
      }
      try {
        await bothStarted.promise;
        if (path.resolve(filePath) === path.resolve(firstPath)) {
          firstFailed = true;
          throw fileFailure;
        }
        if (path.resolve(filePath) === path.resolve(secondPath)) {
          await releaseSecond.promise;
        }
        return await Reflect.apply(originalOpen, mutableFs, args);
      } finally {
        activeOpens -= 1;
      }
    }) as typeof originalOpen;
    Object.defineProperty(mutableFs, 'open', { configurable: true, value: instrumentedOpen });

    try {
      outcome = indexMetadataFolder({
        sourceId: 'left-source',
        side: 'left',
        folderPath: catalogsPath,
        concurrency: 2,
      }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error })
      ).finally(() => {
        settled = true;
      });

      await bothStarted.promise;
      while (!firstFailed) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(settled, false, 'a file failure must wait for the other in-flight metadata read');
      assert.strictEqual(activeOpens, 1);
      releaseSecond.resolve();
      const result = await outcome;
      assert.strictEqual(result.ok, false);
      assert.strictEqual((result as { error: unknown }).error, fileFailure);
      assert.strictEqual(activeOpens, 0);
      assert.deepStrictEqual(openedPaths.map((filePath) => path.basename(filePath)), ['A.xml', 'B.xml']);
    } finally {
      releaseSecond.resolve();
      if (outcome) {
        await outcome;
      }
      Object.defineProperty(mutableFs, 'open', { configurable: true, value: originalOpen });
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('waits for a cancelled directory read before rejecting and does not descend', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-indexer-cancel-directory-'));
    const childPath = path.join(tempRoot, 'Catalogs', 'Products', 'Products.xml');
    await writeFile(childPath, '<MetaDataObject><Catalog uuid="products" /></MetaDataObject>');

    const mutableFs = fsPromises;
    const originalReaddir = mutableFs.readdir;
    const readStarted = deferred();
    const releaseRead = deferred();
    const cancellation = { isCancellationRequested: false };
    let readdirCalls = 0;
    let activeReaddirs = 0;
    let settled = false;
    let outcome: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
    const instrumentedReaddir = (async (...args: Parameters<typeof originalReaddir>) => {
      readdirCalls += 1;
      activeReaddirs += 1;
      readStarted.resolve();
      try {
        await releaseRead.promise;
        return await Reflect.apply(originalReaddir, mutableFs, args);
      } finally {
        activeReaddirs -= 1;
      }
    }) as unknown as typeof originalReaddir;
    Object.defineProperty(mutableFs, 'readdir', { configurable: true, value: instrumentedReaddir });

    try {
      outcome = indexMetadataFolder({
        sourceId: 'left-source',
        side: 'left',
        folderPath: tempRoot,
        cancellation,
        directoryConcurrency: 4,
      }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error })
      ).finally(() => {
        settled = true;
      });

      await readStarted.promise;
      cancellation.isCancellationRequested = true;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(settled, false, 'the traversal must own the current directory read');
      releaseRead.resolve();
      const result = await outcome;
      assert.strictEqual(result.ok, false);
      assert.strictEqual((result as { error: { code?: string } }).error.code, 'CONFIGURATION_COMPARE_CANCELLED');
      assert.strictEqual(readdirCalls, 1, 'cancellation must prevent descending into queued child directories');
      assert.strictEqual(activeReaddirs, 0);
    } finally {
      releaseRead.resolve();
      if (outcome) {
        await outcome;
      }
      Object.defineProperty(mutableFs, 'readdir', { configurable: true, value: originalReaddir });
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('preserves directory read failures after the delayed read drains', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-indexer-failed-directory-'));
    const mutableFs = fsPromises;
    const originalReaddir = mutableFs.readdir;
    const readStarted = deferred();
    const releaseRead = deferred();
    const directoryFailure = new Error('simulated metadata directory failure');
    let activeReaddirs = 0;
    const instrumentedReaddir = (async (..._args: Parameters<typeof originalReaddir>) => {
      activeReaddirs += 1;
      readStarted.resolve();
      try {
        await releaseRead.promise;
        throw directoryFailure;
      } finally {
        activeReaddirs -= 1;
      }
    }) as unknown as typeof originalReaddir;
    Object.defineProperty(mutableFs, 'readdir', { configurable: true, value: instrumentedReaddir });

    try {
      const outcome = indexMetadataFolder({
        sourceId: 'left-source',
        side: 'left',
        folderPath: tempRoot,
      }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error })
      );

      await readStarted.promise;
      releaseRead.resolve();
      const result = await outcome;
      assert.strictEqual(result.ok, false);
      assert.strictEqual((result as { error: unknown }).error, directoryFailure);
      assert.strictEqual(activeReaddirs, 0);
    } finally {
      releaseRead.resolve();
      Object.defineProperty(mutableFs, 'readdir', { configurable: true, value: originalReaddir });
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
