import * as assert from 'assert';
import '../helpers/vscodeStubRegister';
import {
  DeployService,
  type DeployRunSummary,
} from '../../src/bindings/deployService';
import type { ConfigurationBinding } from '../../src/bindings/models/configurationBinding';
import type { InfobaseEntry } from '../../src/infobases/models/infobaseEntry';

suite('Agent deploy partial result projection', () => {
  test('partial UI summary stays unsuccessful and preserves skipped files in Agent data', async () => {
    const original = DeployService.prototype.deployChangedFiles;
    const summary: DeployRunSummary = {
      results: [{
        infobaseId: 'ib-1',
        name: 'Base',
        status: 'skipped',
        message: 'partially applied',
        skippedFiles: ['CommonModules/Locked.xml'],
      }],
      successCount: 0,
      errorCount: 0,
      skippedCount: 1,
      hasPartial: true,
      cancelledMidChain: false,
    };
    DeployService.prototype.deployChangedFiles = async () => summary;
    try {
      const { AgentDeployOperations } = await import('../../src/agent/agentDeployOperations');
      const binding: ConfigurationBinding = {
        workspaceFolder: 'ws',
        configRelativePath: 'Configuration.xml',
        infobaseIds: ['ib-1'],
        massDeployment: false,
      };
      const catalog: InfobaseEntry[] = [{
        id: 'ib-1',
        name: 'Base',
        type: 'file',
        filePath: 'C:/base',
        hasStoredPassword: false,
        createdAt: '2026-07-29T00:00:00.000Z',
      }];
      const operations = new AgentDeployOperations({
        bindingManager: {} as never,
        infobaseStorage: {} as never,
        getConfigPath: () => null,
      });
      Reflect.set(operations, 'resolveDeployContext', async () => ({
        success: true,
        data: {
          configRoot: 'C:/configuration',
          binding,
          entries: catalog,
          catalog,
          workspaceFolderRoot: 'C:/workspace',
        },
      }));

      const result = await operations.deploySelectedObjects({
        files: ['CommonModules/Locked.xml'],
      });

      assert.strictEqual(result.success, false);
      assert.ok(result.data, result.error);
      assert.strictEqual(result.data?.summary.hasPartial, true);
      assert.strictEqual(result.data?.summary.skipped, 1);
      assert.deepStrictEqual(
        result.data?.results[0]?.skippedFiles,
        ['CommonModules/Locked.xml'],
      );
      assert.ok(result.error);
    } finally {
      DeployService.prototype.deployChangedFiles = original;
    }
  });
});
