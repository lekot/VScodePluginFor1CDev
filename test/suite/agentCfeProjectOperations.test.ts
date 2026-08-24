import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import { AgentCfeProjectOperations } from '../../src/agent/agentCfeProjectOperations';
import { CfeProjectError, CfeProjectServiceFactory } from '../../src/extensionSupport/cfeProject';
import { CfeProjectService } from '../../src/extensionSupport/cfeProject/createProject';
import { WorkspaceRegistry, WorkspaceRegistryError } from '../../src/services/configurationSession/WorkspaceRegistry';

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
      createProject: CfeProjectService.prototype.createProject,
      listProjects: CfeProjectService.prototype.listProjects,
      getContext: CfeProjectService.prototype.getContext,
      getContextByExtension: CfeProjectService.prototype.getContextByExtension,
      validate: CfeProjectService.prototype.validate,
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

      const implicitSelection = await operations.createInterceptor({
        ...requests[0],
        extensionConfigurationId: undefined as never,
      });
      assert.strictEqual(implicitSelection.success, true, 'single-root Agent calls retain legacy selector support');

      const session = registry.require(configurationId);
      const originalIdentity = session.identity;
      session.updateIdentity({
        ...originalIdentity,
        capabilities: { ...originalIdentity.capabilities, write: false },
      });
      const readOnlyFailure = await operations.createInterceptor(requests[0]);
      assert.deepStrictEqual(
        { success: readOnlyFailure.success, code: readOnlyFailure.code },
        { success: false, code: 'CFE_OPERATION_FAILED' },
      );
      session.updateIdentity(originalIdentity);

      CfeProjectService.prototype.getContext = async () => {
        throw new CfeProjectError('CFE_PROJECT_NOT_FOUND', 'not a base configuration');
      };
      CfeProjectService.prototype.getContextByExtension = async () => ({
        baseSession: session,
        extensionSession: session,
        extensionName: 'Extension',
        purpose: 'Customization',
        namePrefix: 'Ext_',
        formatVersion: '2.20',
        compatibilityMode: 'Version8_3_24',
        baseConfigurationUuid: UUID_A,
        baseFingerprint: 'fingerprint',
      }) as never;
      const extensionContext = await operations.getContext({ configurationId });
      assert.strictEqual(extensionContext.success, true, 'extension configuration falls back to its CFE context');

      const projectContext = {
        baseSession: session,
        extensionSession: session,
        extensionName: 'Extension',
        purpose: 'Customization',
        namePrefix: 'Ext_',
        formatVersion: '2.20',
        compatibilityMode: 'Version8_3_24',
        baseConfigurationUuid: UUID_A,
        baseFingerprint: 'fingerprint',
      };
      CfeProjectService.prototype.listProjects = async () => [projectContext] as never;
      const projects = await operations.listProjects({ configurationId });
      assert.strictEqual(projects.data!.projects[0]!.extensionName, 'Extension');

      CfeProjectService.prototype.validate = async () => undefined;
      const validation = await operations.validate({ configurationId });
      assert.deepStrictEqual(validation.data, { valid: true });

      CfeProjectService.prototype.getContext = async () => {
        throw new Error('context unavailable');
      };
      const unavailableContext = await operations.getContext({ configurationId });
      assert.deepStrictEqual(
        { success: unavailableContext.success, code: unavailableContext.code, error: unavailableContext.error },
        { success: false, code: 'CFE_OPERATION_FAILED', error: 'context unavailable' },
      );

      CfeProjectService.prototype.createProject = async () => ({
        status: 'outcome-unknown',
        code: 'CFE_OUTCOME_UNKNOWN',
        recoveryJournalPath: path.join(workspace, '..', 'outside-recovery.json'),
      }) as never;
      const unknownProject = await operations.createProject({
        baseConfigurationId: configurationId,
        extensionName: 'Extension',
        purpose: 'Customization',
        namePrefix: 'Ext_',
        compatibilityMode: 'Version8_3_24',
      });
      assert.deepStrictEqual(unknownProject.data, {
        status: 'outcome-unknown',
        code: 'CFE_OUTCOME_UNKNOWN',
        recoveryJournalPath: '.vscode/cfe-project-recovery.json',
      });

      const serviceRoot = new CfeProjectServiceFactory(registry).forConfiguration(configurationId).workspaceRoot;
      CfeProjectService.prototype.createProject = async () => ({
        status: 'created',
        recoveryJournalPath: path.join(serviceRoot, 'recovery.json'),
        context: projectContext,
      }) as never;
      const createdProject = await operations.createProject({
        baseConfigurationId: configurationId,
        extensionName: 'Extension',
        purpose: 'Customization',
        namePrefix: 'Ext_',
        compatibilityMode: 'Version8_3_24',
      });
      assert.deepStrictEqual(createdProject.data, {
        status: 'created',
        recoveryJournalPath: 'recovery.json',
        context: {
          baseConfigurationId: configurationId,
          extensionConfigurationId: configurationId,
          extensionName: 'Extension',
          purpose: 'Customization',
          namePrefix: 'Ext_',
          formatVersion: '2.20',
          compatibilityMode: 'Version8_3_24',
          baseConfigurationUuid: UUID_A,
          baseFingerprint: 'fingerprint',
        },
      });

      CfeProjectService.prototype.createInterceptor = async () => {
        throw new CfeProjectError('CFE_INTERCEPTOR_CONFLICT', 'conflict');
      };
      const failed = await operations.createInterceptor(requests[0]);
      assert.deepStrictEqual(
        { success: failed.success, code: failed.code, error: failed.error },
        { success: false, code: 'CFE_INTERCEPTOR_CONFLICT', error: 'conflict' },
      );
      assert.strictEqual(refreshes, 5, 'failed mutation must not refresh the tree');

      CfeProjectService.prototype.createInterceptor = async () => {
        throw { code: 'CFE_SYNTHETIC' };
      };
      const cfeShapedFailure = await operations.createInterceptor(requests[0]);
      assert.deepStrictEqual(
        { success: cfeShapedFailure.success, code: cfeShapedFailure.code, error: cfeShapedFailure.error },
        { success: false, code: 'CFE_SYNTHETIC', error: '[object Object]' },
      );

      CfeProjectService.prototype.createInterceptor = async () => {
        throw new WorkspaceRegistryError('CONFIGURATION_ID_UNKNOWN', 'unknown configuration');
      };
      const registryFailure = await operations.createInterceptor(requests[0]);
      assert.deepStrictEqual(
        { success: registryFailure.success, code: registryFailure.code, error: registryFailure.error },
        { success: false, code: 'CONFIGURATION_ID_UNKNOWN', error: 'unknown configuration' },
      );

      const unavailable = new AgentCfeProjectOperations(async () => null, async () => undefined);
      const unavailableResult = await unavailable.createOwnForm(requests[1]);
      assert.deepStrictEqual(
        { success: unavailableResult.success, code: unavailableResult.code },
        { success: false, code: 'CFE_OPERATION_FAILED' },
      );

      const refreshFailure = new AgentCfeProjectOperations(async () => registry, async () => {
        throw new Error('refresh unavailable');
      });
      const refreshFailureResult = await refreshFailure.createOwnForm(requests[1]);
      assert.strictEqual(refreshFailureResult.success, true, 'a completed mutation must tolerate a refresh failure');
    } finally {
      CfeProjectService.prototype.createInterceptor = original.createInterceptor;
      CfeProjectService.prototype.createOwnForm = original.createOwnForm;
      CfeProjectService.prototype.borrowForm = original.borrowForm;
      CfeProjectService.prototype.extendForm = original.extendForm;
      CfeProjectService.prototype.createProject = original.createProject;
      CfeProjectService.prototype.listProjects = original.listProjects;
      CfeProjectService.prototype.getContext = original.getContext;
      CfeProjectService.prototype.getContextByExtension = original.getContextByExtension;
      CfeProjectService.prototype.validate = original.validate;
      await registry.dispose();
      await fs.promises.rm(workspace, { recursive: true, force: true });
    }
  });
});
