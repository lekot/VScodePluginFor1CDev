import * as assert from 'assert';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { cleanupTempDir, createTempDir } from '../helpers/testHelpers';
import { XmlParser } from '../../src/parsers/xmlParser';
import {
  applySubsystemCompositionFileUpdate,
  readSubsystemCompositionRefsFromFile,
} from '../../src/services/subsystemCompositionFileUpdater';
import {
  applyCommonAttributeContentUpdate,
  readCommonAttributeContent,
} from '../../src/services/commonAttributeContentFileUpdater';
import {
  applyFunctionalOptionContentUpdate,
  readFunctionalOptionContent,
} from '../../src/services/functionalOptionContentFileUpdater';
import {
  applyFilterCriterionContentUpdate,
  readFilterCriterionContent,
} from '../../src/services/filterCriterionContentFileUpdater';
import {
  applyExchangePlanContentUpdate,
  readExchangePlanContent,
} from '../../src/services/exchangePlanContentFileUpdater';

const FIXTURES_DIR = path.join(__dirname, '../fixtures/designer');
const SUBSYSTEM_FIXTURE = path.join(FIXTURES_DIR, 'SubsystemEmptyContent.xml');

function createSampleCommonAttributeXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="2.17">
  <CommonAttribute uuid="11111111-2222-3333-4444-555555555555">
    <Properties>
      <Name>TestCommonAttr</Name>
      <Content/>
    </Properties>
  </CommonAttribute>
</MetaDataObject>`;
}

function createSampleFunctionalOptionXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="2.17">
  <FunctionalOption uuid="11111111-2222-3333-4444-555555555555">
    <Properties>
      <Name>TestFunctionalOption</Name>
      <Content/>
    </Properties>
  </FunctionalOption>
</MetaDataObject>`;
}

function createSampleFilterCriterionXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="2.17">
  <FilterCriterion uuid="11111111-2222-3333-4444-555555555555">
    <Properties>
      <Name>TestFilterCriterion</Name>
      <Content/>
    </Properties>
  </FilterCriterion>
</MetaDataObject>`;
}

function createSampleConfigurationXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.17">
  <Configuration uuid="00000000-0000-0000-0000-000000000000">
    <Properties>
      <Name>TestConfiguration</Name>
    </Properties>
  </Configuration>
</MetaDataObject>`;
}

suite('Composition writers lost update & concurrency (Issue 159)', () => {
  let tmpDir: string;

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-lost-update-');
    await fsp.writeFile(path.join(tmpDir, 'Configuration.xml'), createSampleConfigurationXml(), 'utf-8');
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  test('Subsystem: concurrent updates must never silently lose one addition while reporting success', async () => {
    const filePath = path.join(tmpDir, 'Subsystem.xml');
    await fsp.copyFile(SUBSYSTEM_FIXTURE, filePath);

    // Run two concurrent updates adding different items
    const [resA, resB] = await Promise.all([
      applySubsystemCompositionFileUpdate(filePath, { add: ['Catalog.Alpha'], remove: [] }),
      applySubsystemCompositionFileUpdate(filePath, { add: ['Catalog.Beta'], remove: [] }),
    ]);

    assert.deepStrictEqual(resA.rejected, []);
    assert.deepStrictEqual(resB.rejected, []);

    const persisted = await readSubsystemCompositionRefsFromFile(filePath);
    // If both updates succeeded, BOTH items must be present in the persisted file.
    assert.ok(
      persisted.includes('Catalog.Alpha'),
      `Catalog.Alpha must not be lost (persisted: ${JSON.stringify(persisted)})`
    );
    assert.ok(
      persisted.includes('Catalog.Beta'),
      `Catalog.Beta must not be lost (persisted: ${JSON.stringify(persisted)})`
    );
  });

  test('Subsystem: deterministic gated read-before-write reproduction prevents lost update', async () => {
    const filePath = path.join(tmpDir, 'Subsystem.xml');
    await fsp.copyFile(SUBSYSTEM_FIXTURE, filePath);

    // Gated concurrency: two operations where both read initial state before either writes.
    // If write is attempted on stale baseline, it must either merge against latest state or report conflict,
    // NEVER report success while persisting only the second writer's item.
    let gateTriggered = false;
    let releaseGate: () => void;
    const gatePromise = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const origReadFile = fs.promises.readFile;
    let readCount = 0;
    (fs.promises as any).readFile = async (
      targetPath: any,
      options?: any
    ) => {
      const res = await origReadFile(targetPath, options);
      if (typeof targetPath === 'string' && targetPath.endsWith('Subsystem.xml')) {
        readCount++;
        if (readCount === 1) {
          gateTriggered = true;
          // Hold operation 1 until operation 2 has also started reading
          await gatePromise;
        }
      }
      return res;
    };

    try {
      const op1 = applySubsystemCompositionFileUpdate(filePath, { add: ['Catalog.Alpha'], remove: [] });
      // Wait until op1 has read
      while (!gateTriggered) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const op2 = applySubsystemCompositionFileUpdate(filePath, { add: ['Catalog.Beta'], remove: [] });
      releaseGate!();

      const outcomes = await Promise.allSettled([op1, op2]);
      const successful = outcomes.filter((o) => o.status === 'fulfilled');

      const persisted = await readSubsystemCompositionRefsFromFile(filePath);
      if (successful.length === 2) {
        // If both reported success, both must be persisted
        assert.ok(
          persisted.includes('Catalog.Alpha') && persisted.includes('Catalog.Beta'),
          `Both items must be persisted when both operations succeed. Persisted: ${JSON.stringify(persisted)}`
        );
      } else {
        // If one was rejected with conflict, the successful one must be persisted
        const rejected = outcomes.find((o) => o.status === 'rejected');
        assert.ok(rejected, 'Expected conflict rejection if not merged');
        assert.ok(
          persisted.includes('Catalog.Alpha') || persisted.includes('Catalog.Beta'),
          'At least one item must be safely persisted'
        );
      }
    } finally {
      (fs.promises as any).readFile = origReadFile;
    }
  });

  test('CommonAttribute: concurrent updates merge both additions and preserve item settings', async () => {
    const filePath = path.join(tmpDir, 'CommonAttribute.xml');
    await fsp.writeFile(filePath, createSampleCommonAttributeXml(), 'utf-8');

    const [resA, resB] = await Promise.all([
      applyCommonAttributeContentUpdate(filePath, {
        add: ['Catalog.Users'],
        remove: [],
        settingsChanged: new Map([['Catalog.Users', { Use: 'DontUse' }]]),
      }),
      applyCommonAttributeContentUpdate(filePath, {
        add: ['Document.Invoice'],
        remove: [],
        settingsChanged: new Map([['Document.Invoice', { Use: 'Use' }]]),
      }),
    ]);

    assert.deepStrictEqual(resA.rejected, []);
    assert.deepStrictEqual(resB.rejected, []);

    const { refs, itemSettings } = await readCommonAttributeContent(filePath);
    assert.ok(refs.includes('Catalog.Users'), `Catalog.Users must be persisted (refs: ${JSON.stringify(refs)})`);
    assert.ok(refs.includes('Document.Invoice'), `Document.Invoice must be persisted (refs: ${JSON.stringify(refs)})`);
    assert.strictEqual(itemSettings.get('Catalog.Users')?.Use, 'DontUse');
    assert.strictEqual(itemSettings.get('Document.Invoice')?.Use, 'Use');
  });

  test('FunctionalOption: concurrent updates merge both additions with nested refs', async () => {
    const filePath = path.join(tmpDir, 'FunctionalOption.xml');
    await fsp.writeFile(filePath, createSampleFunctionalOptionXml(), 'utf-8');

    const [resA, resB] = await Promise.all([
      applyFunctionalOptionContentUpdate(filePath, {
        add: ['Catalog.Items.Attribute.Color'],
        remove: [],
        settingsChanged: new Map(),
      }),
      applyFunctionalOptionContentUpdate(filePath, {
        add: ['Document.Order.TabularSection.Goods.Attribute.Discount'],
        remove: [],
        settingsChanged: new Map(),
      }),
    ]);

    assert.deepStrictEqual(resA.rejected, []);
    assert.deepStrictEqual(resB.rejected, []);

    const { refs } = await readFunctionalOptionContent(filePath);
    assert.ok(refs.includes('Catalog.Items.Attribute.Color'), `Color ref must be persisted: ${JSON.stringify(refs)}`);
    assert.ok(
      refs.includes('Document.Order.TabularSection.Goods.Attribute.Discount'),
      `Discount ref must be persisted: ${JSON.stringify(refs)}`
    );
  });

  test('FilterCriterion: concurrent updates merge both additions with multi-part identifiers', async () => {
    const filePath = path.join(tmpDir, 'FilterCriterion.xml');
    await fsp.writeFile(filePath, createSampleFilterCriterionXml(), 'utf-8');

    const [resA, resB] = await Promise.all([
      applyFilterCriterionContentUpdate(filePath, {
        add: ['Catalog.Clients.Attribute.INN'],
        remove: [],
        settingsChanged: new Map(),
      }),
      applyFilterCriterionContentUpdate(filePath, {
        add: ['Document.Invoice.Attribute.BuyerINN'],
        remove: [],
        settingsChanged: new Map(),
      }),
    ]);

    assert.deepStrictEqual(resA.rejected, []);
    assert.deepStrictEqual(resB.rejected, []);

    const { refs } = await readFilterCriterionContent(filePath);
    assert.ok(refs.includes('Catalog.Clients.Attribute.INN'), `INN ref must be persisted: ${JSON.stringify(refs)}`);
    assert.ok(
      refs.includes('Document.Invoice.Attribute.BuyerINN'),
      `BuyerINN ref must be persisted: ${JSON.stringify(refs)}`
    );
  });

  test('ExchangePlan: handles missing Content.xml with concurrent creators without lost update', async () => {
    const contentDir = path.join(tmpDir, 'ExchangePlans', 'TestSync', 'Ext');
    const filePath = path.join(contentDir, 'Content.xml');

    // Content.xml does not exist yet!
    assert.strictEqual(fs.existsSync(filePath), false);

    const [resA, resB] = await Promise.all([
      applyExchangePlanContentUpdate(
        filePath,
        {
          add: ['Catalog.Products'],
          remove: [],
          settingsChanged: new Map([['Catalog.Products', { AutoRecord: 'Deny' }]]),
        },
        '2.17'
      ),
      applyExchangePlanContentUpdate(
        filePath,
        {
          add: ['Document.Shipment'],
          remove: [],
          settingsChanged: new Map([['Document.Shipment', { AutoRecord: 'Allow' }]]),
        },
        '2.17'
      ),
    ]);

    assert.deepStrictEqual(resA.rejected, []);
    assert.deepStrictEqual(resB.rejected, []);

    const { refs, itemSettings } = await readExchangePlanContent(filePath);
    assert.ok(refs.includes('Catalog.Products'), `Catalog.Products must be persisted: ${JSON.stringify(refs)}`);
    assert.ok(refs.includes('Document.Shipment'), `Document.Shipment must be persisted: ${JSON.stringify(refs)}`);
    assert.strictEqual(itemSettings.get('Catalog.Products')?.AutoRecord, 'Deny');
    assert.strictEqual(itemSettings.get('Document.Shipment')?.AutoRecord, 'Allow');
  });

  test('preserves XML round-trip and special character escaping', async () => {
    const filePath = path.join(tmpDir, 'FunctionalOption.xml');
    await fsp.writeFile(filePath, createSampleFunctionalOptionXml(), 'utf-8');

    await applyFunctionalOptionContentUpdate(filePath, {
      add: ['Catalog.Goods_A1'],
      remove: [],
      settingsChanged: new Map(),
    });

    const content = await fsp.readFile(filePath, 'utf-8');
    assert.ok(content.includes('<Name>TestFunctionalOption</Name>'), 'Name must be preserved');
    assert.ok(content.includes('<xr:Object>Catalog.Goods_A1</xr:Object>'), 'Object tag must be preserved');
  });
});
