import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import { AgentCfeProjectOperations } from '../../src/agent/agentCfeProjectOperations';
import { CfeProjectError } from '../../src/extensionSupport/cfeProject';
import { CfeProjectService } from '../../src/extensionSupport/cfeProject/createProject';
import { WorkspaceRegistry } from '../../src/services/configurationSession/WorkspaceRegistry';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

suite('Agent CFE interceptor and form operations', () => {
  test('forwards each request exactly, refreshes after success, and maps CFE errors', async () => {
    const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-cfe-operations-'));
    const root = path.join(workspace, 'extension');
    const registry = new WorkspaceRegistry();
    const original = {
      createInterceptor: CfeProjectService.prototype.createInterceptor,
      createOwnForm: CfeProjectService.prototype.createOwnForm,
      borrowForm: CfeProjectService.prototype.borrowForm,
      extendForm: CfeProjectService.prototype.extendForm,
    };
    try {
      await fs.promises.mkdir(root, { recursive: true });
      await fs.promises.writeFile(
        path.join(root, 'Configuration.xml'),
        `<MetaDataObject version="2.20"><Configuration uuid="${UUID_A}"><ChildObjects/></Configuration></MetaDataObject>`,
        'utf8',
      );
      await registry.refresh([{ configPath: root, workspaceFolderPath: workspace }]);
      const configurationId = registry.list()[0]!.configurationId;
      const calls: unknown[] = [];
      CfeProjectService.prototype.createInterceptor = async (request) => {
        calls.push(request);
        return { status: 'created' } as never;
      };
      CfeProjectService.prototype.createOwnForm = async (request) => {
        calls.push(request);
        return { status: 'created' } as never;
      };
      CfeProjectService.prototype.borrowForm = async (request) => {
        calls.push(request);
        return { status: 'borrowed' } as never;
      };
      CfeProjectService.prototype.extendForm = async (request) => {
        calls.push(request);
        return { status: 'extended' } as never;
      };
      let refreshes = 0;
      const operations = new AgentCfeProjectOperations(async () => registry, async () => { refreshes += 1; });
      const requests = [
        { extensionConfigurationId: configurationId, targetSourceUuid: UUID_A, moduleKind: 'ObjectModule' as const, methodName: 'OnWrite', kind: 'before' as const },
        { extensionConfigurationId: configurationId, ownerDotPath: 'Catalog.Goods', formName: 'Ext_Form', formType: 'Managed' as const },
        { extensionConfigurationId: configurationId, ownerSourceUuid: UUID_A, sourceFormUuid: UUID_B },
        { extensionConfigurationId: configurationId, sourceFormUuid: UUID_B, expectedFormHash: 'a'.repeat(64), operations: [{ kind: 'addAttribute' as const, name: 'Ext_Value', type: { typeName: 'xs:string' } }] },
      ] as const;

      const results = [
        await operations.createInterceptor(requests[0]),
        await operations.createOwnForm(requests[1]),
        await operations.borrowForm(requests[2]),
        await operations.extendForm(requests[3]),
      ];
      assert.deepStrictEqual(calls, requests);
      assert.strictEqual(refreshes, 4);
      assert.deepStrictEqual(results.map((result) => result.success), [true, true, true, true]);

      CfeProjectService.prototype.createInterceptor = async () => {
        throw new CfeProjectError('CFE_INTERCEPTOR_CONFLICT', 'conflict');
      };
      const failed = await operations.createInterceptor(requests[0]);
      assert.deepStrictEqual(
        { success: failed.success, code: failed.code, error: failed.error },
        { success: false, code: 'CFE_INTERCEPTOR_CONFLICT', error: 'conflict' },
      );
      assert.strictEqual(refreshes, 4, 'failed mutation must not refresh the tree');
    } finally {
      CfeProjectService.prototype.createInterceptor = original.createInterceptor;
      CfeProjectService.prototype.createOwnForm = original.createOwnForm;
      CfeProjectService.prototype.borrowForm = original.borrowForm;
      CfeProjectService.prototype.extendForm = original.extendForm;
      await registry.dispose();
      await fs.promises.rm(workspace, { recursive: true, force: true });
    }
  });
});
