import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

import {
  buildConfigurationCompare,
  type ConfigurationCompareResult,
} from '../../../src/compareMerge/configurationCompareService';
import { createMergeMutationTestRuntime } from './mergeMutationTestSupport';
import {
  createExtensionCompareTempRoot,
  metadataObjectXml,
  pathExists,
  writeDesignerConfiguration,
  type ExtensionCompareObjectFixture,
} from '../../helpers/extensionCompareFixtures';

const ACCOUNTING_REGISTER = 'Ext_AccountingRegister';
const ACCOUNTING_REGISTER_UUID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const RECORDER_DOCUMENT_UUID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const REGISTER_RECORDS = '<RegisterRecords xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
  + '<xr:Item xsi:type="xr:MDObjectRef">AccountingRegister.Ext_AccountingRegister</xr:Item>'
  + '</RegisterRecords>';

suite('Extension register recorder compare integration (#336)', () => {
  test('blocks preview of an own AccountingRegister without a selected, target, or proven-base recorder', async function (this: Mocha.Context) {
    this.timeout(60000);
    await withTempRoot(async (tempRoot) => {
      const target = path.join(tempRoot, 'target-cf');
      const source = path.join(tempRoot, 'source-cfe');
      await writeDesignerConfiguration(target);
      await writeDesignerConfiguration(source, {
        purpose: 'Customization',
        namePrefix: 'Ext_',
        objects: [accountingRegister()],
      });

      const compare = await openCompare(tempRoot, target, source);
      try {
        const nodeIds = compare.result.workspace.listMergeableNodeIds();
        assert.strictEqual(nodeIds.length, 1, 'the register row should be selectable before registrar preflight');

        const created = await compare.result.workspace.createPreviewForNodeIds(nodeIds);
        assert.strictEqual(created.ok, false, 'the real compare preview must reject a recorder-less register');
        if (created.ok) {return;}
        const message = created.diagnostics.map((item) => item.suggestedAction ?? '').join('\n');
        assert.match(message, /AccountingRegister\.Ext_AccountingRegister/u);
        assert.match(message, /документ-регистратор/u);
      } finally {
        await compare.dispose();
      }
    });
  });

  test('accepts target, proven-base, and adopted target/base union recorders, then blocks stale execution', async function (this: Mocha.Context) {
    this.timeout(60000);
    for (const recorderLocation of ['target', 'base', 'adopted-target'] as const) {
      await withTempRoot(async (tempRoot) => {
        const base = path.join(tempRoot, 'base-cf');
        const target = path.join(tempRoot, recorderLocation === 'target' ? 'target-cf' : 'target-cfe');
        const source = path.join(tempRoot, 'source-cfe');
        const recorder = recorderDocument();

        await writeDesignerConfiguration(base, {
          objects: recorderLocation === 'target' ? [] : [recorder],
        });
        await writeDesignerConfiguration(target, recorderLocation === 'target'
          ? { objects: [recorder] }
          : {
            purpose: 'Customization',
            namePrefix: 'Ext_',
            ...(recorderLocation === 'adopted-target'
              ? { objects: [adoptedRecorderDocument(recorder)] }
              : {}),
          });
        await writeDesignerConfiguration(source, {
          purpose: 'Customization',
          namePrefix: 'Ext_',
          objects: [accountingRegister()],
        });

        const compareOptions: OpenCompareOptions = recorderLocation === 'target'
          ? {}
          : { extensionBaseRoots: { left: base } };
        const compare = await openCompare(tempRoot, target, source, compareOptions);
        try {
          const nodeIds = compare.result.workspace.listMergeableNodeIds();
          assert.strictEqual(nodeIds.length, 1, `${recorderLocation}: incoming register should be selectable`);
          const created = await compare.result.workspace.createPreviewForNodeIds(nodeIds);
          assert.strictEqual(created.ok, true,
            created.ok ? '' : `${recorderLocation}: valid recorder should permit preview: ${JSON.stringify(created.diagnostics)}`);
          if (!created.ok) {return;}

          const recorderRoot = recorderLocation === 'base' ? base : target;
          const recorderPath = path.join(recorderRoot, 'Documents', `${recorder.name}.xml`);
          const before = await fs.readFile(recorderPath, 'utf8');
          const changed = recorderLocation === 'adopted-target'
            ? metadataObjectXml({
              type: 'Document',
              name: recorder.name,
              uuid: 'dddddddd-4444-4444-8444-dddddddddddd',
              belonging: 'Own',
            })
            : before.replace('AccountingRegister.Ext_AccountingRegister', 'AccountingRegister.OtherRegister');
          assert.notStrictEqual(changed, before, `${recorderLocation}: test must change the captured RegisterRecords reference`);
          await fs.writeFile(recorderPath, changed, 'utf8');

          const targetAfterExternalEdit = await snapshotFiles(target);
          const approved = compare.result.workspace.approvePreview(created.preview.previewId);
          assert.strictEqual(approved.ok, true, `${recorderLocation}: approval should capture the existing preview`);
          const executed = await compare.result.workspace.executeApprovedPreview(created.preview.previewId, {
            destructiveConfirmed: true,
          });
          assert.strictEqual(executed.ok, false,
            `${recorderLocation}: changed recorder bytes must invalidate the preview before writes`);
          assert.deepStrictEqual(await snapshotFiles(target), targetAfterExternalEdit,
            `${recorderLocation}: failed recorder witness validation must leave the target unchanged`);
          assert.strictEqual(
            await pathExists(path.join(target, 'AccountingRegisters', `${ACCOUNTING_REGISTER}.xml`)),
            false,
            `${recorderLocation}: register descriptor must not be written after stale witness rejection`,
          );
        } finally {
          await compare.dispose();
        }
      });
    }
  });
});

function accountingRegister(): ExtensionCompareObjectFixture {
  return {
    type: 'AccountingRegister',
    name: ACCOUNTING_REGISTER,
    uuid: ACCOUNTING_REGISTER_UUID,
    belonging: 'Own',
  };
}

function recorderDocument(): ExtensionCompareObjectFixture {
  return {
    type: 'Document',
    name: 'Ext_Recorder',
    uuid: RECORDER_DOCUMENT_UUID,
    belonging: 'Own',
    propertiesXml: REGISTER_RECORDS,
  };
}

function adoptedRecorderDocument(baseDocument: ExtensionCompareObjectFixture): ExtensionCompareObjectFixture {
  return {
    ...baseDocument,
    uuid: 'cccccccc-3333-4333-8333-cccccccccccc',
    belonging: 'Adopted',
    anchorUuid: baseDocument.uuid,
    propertiesXml: '<RegisterRecords xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
      + '<xr:Item xsi:type="xr:MDObjectRef">CalculationRegister.OtherRegister</xr:Item>'
      + '</RegisterRecords>',
  };
}

interface OpenCompareOptions {
  readonly extensionBaseRoots?: { readonly left?: string; readonly right?: string };
}

interface OpenCompareHandle {
  readonly result: ConfigurationCompareResult;
  dispose(): Promise<void>;
}

async function openCompare(
  tempRoot: string,
  leftRootPath: string,
  rightRootPath: string,
  options: OpenCompareOptions = {},
): Promise<OpenCompareHandle> {
  const runtime = await createMergeMutationTestRuntime(leftRootPath);
  try {
    const result = await buildConfigurationCompare({
      leftRootPath,
      rightRootPath,
      backupRootPath: path.join(tempRoot, 'backups'),
      extensionBaseRoots: options.extensionBaseRoots,
      mutationEngine: runtime.engine,
      configurationId: runtime.configurationId,
    });
    return {
      result,
      dispose: async () => {
        result.workspace.dispose();
        await runtime.coordinator.dispose();
      },
    };
  } catch (error) {
    await runtime.coordinator.dispose();
    throw error;
  }
}

async function withTempRoot<T>(callback: (tempRoot: string) => Promise<T>): Promise<T> {
  const tempRoot = await createExtensionCompareTempRoot('issue336-register-recorder-');
  try {
    return await callback(tempRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function snapshotFiles(rootPath: string): Promise<readonly (readonly [string, string])[]> {
  const files: [string, string][] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        const bytes = await fs.readFile(absolutePath);
        files.push([path.relative(rootPath, absolutePath).split(path.sep).join('/'), createHash('sha256').update(bytes).digest('hex')]);
      }
    }
  };
  await visit(rootPath);
  return files.sort(([left], [right]) => left.localeCompare(right));
}
