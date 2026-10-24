import * as assert from 'assert';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as vscode from 'vscode';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const EXTENSION_ID = 'Lekot.1c-metadata-tree-vscode';
const LIST_CONFIGURATIONS_COMMAND = '1c-metadata-tree.agent.listConfigurations';
const CREATE_OBJECT_COMMAND = '1c-metadata-tree.agent.createObject';
const SET_PROPERTIES_COMMAND = '1c-metadata-tree.agent.setProperties';

interface Discovery {
  readonly schemaVersion: number;
  readonly token: string;
  readonly mcp: {
    readonly url: string;
    readonly transport: 'streamable-http';
    readonly authorization: 'bearer';
  };
}

interface AgentEnvelope<T = unknown> {
  readonly success: boolean;
  readonly code?: string;
  readonly error?: string;
  readonly configurationId?: string;
  readonly operationId?: string;
  readonly snapshotVersion?: number;
  readonly reconciliation?: { readonly status?: string; readonly code?: string };
  readonly data?: T;
}

interface ConfigurationDescriptor {
  readonly configurationId: string;
  readonly rootPath: string;
  readonly descriptorUri: string;
  readonly format: string;
}

interface McpClientLike {
  callTool(request: { readonly name: string; readonly arguments: Record<string, unknown> }): Promise<CallToolResult>;
  close(): Promise<void>;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readDiscovery(filePath: string, timeoutMs = 15000): Promise<Discovery> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as Discovery;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw new Error(`MCP discovery was not created at ${filePath}: ${String(lastError)}`);
}

function getEnvelope<T>(response: CallToolResult): AgentEnvelope<T> {
  assert.ok(response.structuredContent, 'Production MCP tool must return structured Agent content.');
  assert.strictEqual(response.content[0]?.type, 'text');
  const fromText = JSON.parse(response.content[0].type === 'text' ? response.content[0].text : '{}') as AgentEnvelope<T>;
  const structured = response.structuredContent as unknown as AgentEnvelope<T>;
  assert.deepStrictEqual(fromText, structured, 'MCP JSON text and structuredContent must agree.');
  return structured;
}

async function callOperation(
  client: McpClientLike,
  tool: 'cdt_read' | 'cdt_write',
  operation: string,
  args: Record<string, unknown>,
): Promise<{ readonly response: CallToolResult; readonly envelope: AgentEnvelope }> {
  const response = await client.callTool({ name: tool, arguments: { operation, arguments: args } });
  return { response, envelope: getEnvelope(response) };
}

function assertCommittedMutation<T>(
  result: AgentEnvelope<T>,
  context: string,
): asserts result is AgentEnvelope<T> & {
  readonly success: true;
  readonly operationId: string;
  readonly snapshotVersion: number;
} {
  assert.strictEqual(result.success, true, `${context}: ${result.error ?? 'Agent operation failed'}`);
  assert.ok(result.operationId, `${context}: committed mutation must include operationId.`);
  assert.ok(typeof result.snapshotVersion === 'number', `${context}: committed mutation must include snapshotVersion.`);
}

function assertSuccessfulMutation<T>(result: AgentEnvelope<T>, context: string): void {
  assertCommittedMutation(result, context);
  assert.strictEqual(result.reconciliation?.status, 'succeeded', `${context}: reconciliation must succeed.`);
}

function canonical(filePath: string): string {
  let resolved = path.resolve(filePath);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // Removed paths are compared lexically during workspace cleanup.
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSameOrNestedPath(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(canonical(rootPath), canonical(candidatePath));
  return relativePath === ''
    || (relativePath !== '..'
      && !relativePath.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relativePath));
}

async function createDesignerRoot(root: string): Promise<void> {
  const languageUuid = randomUUID();
  const configurationUuid = randomUUID();
  await fs.promises.mkdir(path.join(root, 'Languages'), { recursive: true });
  await fs.promises.writeFile(
    path.join(root, 'Configuration.xml'),
    `<?xml version="1.0" encoding="UTF-8"?><MetaDataObject version="2.20"><Configuration uuid="${configurationUuid}"><Properties><DefaultLanguage>Language.English</DefaultLanguage><ScriptVariant>English</ScriptVariant><ConfigurationExtensionCompatibilityMode>Version8_3_24</ConfigurationExtensionCompatibilityMode><InterfaceCompatibilityMode>TaxiEnableVersion8_2</InterfaceCompatibilityMode></Properties><ChildObjects><Language>English</Language></ChildObjects></Configuration></MetaDataObject>`,
    'utf8',
  );
  await fs.promises.writeFile(
    path.join(root, 'Languages', 'English.xml'),
    `<?xml version="1.0" encoding="UTF-8"?><MetaDataObject version="2.20"><Language uuid="${languageUuid}"><Properties><LanguageCode>en</LanguageCode></Properties></Language></MetaDataObject>`,
    'utf8',
  );
}

async function snapshotFiles(
  root: string,
  excludedRelativePaths: readonly string[] = [],
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const exclusions = excludedRelativePaths.map((relativePath) => relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''));
  const isExcluded = (relativePath: string): boolean => {
    const normalized = relativePath.replace(/\\/g, '/');
    return exclusions.some((excluded) => normalized === excluded || normalized.startsWith(`${excluded}/`));
  };
  const visit = async (directory: string, relative: string): Promise<void> => {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const childRelative = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        if (!isExcluded(childRelative)) {
          await visit(absolutePath, childRelative);
        }
      } else if (entry.isFile() && !isExcluded(childRelative)) {
        const contents = await fs.promises.readFile(absolutePath);
        result[childRelative.replace(/\\/g, '/')] = createHash('sha256').update(contents).digest('hex');
      }
    }
  };
  await visit(root, '');
  return result;
}

async function hashFileOrNull(filePath: string): Promise<string | null> {
  try {
    const contents = await fs.promises.readFile(filePath);
    return createHash('sha256').update(contents).digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function waitForConfigurations(
  client: McpClientLike,
  predicate: (configurations: readonly ConfigurationDescriptor[]) => boolean,
  timeoutMs = 15000,
): Promise<readonly ConfigurationDescriptor[]> {
  const deadline = Date.now() + timeoutMs;
  let latest: readonly ConfigurationDescriptor[] = [];
  while (Date.now() < deadline) {
    const { envelope } = await callOperation(client, 'cdt_read', 'cdt_list_configurations', {});
    assert.strictEqual(envelope.success, true, envelope.error);
    const data = envelope.data as { configurations?: readonly ConfigurationDescriptor[] } | undefined;
    latest = data?.configurations ?? [];
    if (predicate(latest)) {
      return latest;
    }
    await delay(150);
  }
  throw new Error(`Timed out waiting for production configuration discovery. Last descriptors: ${JSON.stringify(latest)}`);
}

async function waitForWorkspaceRestore(
  originalFolderCount: number,
  temporaryRoots: readonly string[],
  timeoutMs = 15000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (
      folders.length === originalFolderCount
      && temporaryRoots.every((root) => !folders.some((folder) => canonical(folder.uri.fsPath) === canonical(root)))
    ) {
      const listed = await vscode.commands.executeCommand<AgentEnvelope<{ configurations: readonly ConfigurationDescriptor[] }>>(
        LIST_CONFIGURATIONS_COMMAND,
      );
      const paths = listed?.data?.configurations?.map((entry) => canonical(entry.rootPath)) ?? [];
      if (
        listed?.success === true
        && temporaryRoots.every((root) => !paths.some((listedRoot) => isSameOrNestedPath(root, listedRoot)))
      ) {
        return;
      }
    }
    await delay(100);
  }
  throw new Error('Temporary roots were not removed from the workspace registry during cleanup.');
}

suite('Smoke: real host architecture acceptance matrix', () => {
  test('routes multi-root CRUD and CFE operations through production Agent commands and MCP', async function () {
    this.timeout(120000);

    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `Extension ${EXTENSION_ID} must be loaded by the smoke runner`);
    if (!extension.isActive) {
      await extension.activate();
    }

    const originalFolders = [...(vscode.workspace.workspaceFolders ?? [])];
    assert.ok(originalFolders.length > 0, 'Smoke runner must open its fixture workspace.');
    const discoveryPath = path.join(originalFolders[0]!.uri.fsPath, '.vscode', 'cdt-agent-bridge.json');
    const discovery = await readDiscovery(discoveryPath);
    assert.strictEqual(discovery.schemaVersion, 2);
    assert.strictEqual(discovery.mcp.transport, 'streamable-http');
    assert.strictEqual(discovery.mcp.authorization, 'bearer');
    assert.ok(discovery.token.length > 0);

    const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    ]);
    const transport = new StreamableHTTPClientTransport(new URL(discovery.mcp.url), {
      requestInit: { headers: { Authorization: `Bearer ${discovery.token}` } },
    });
    const client = new Client({ name: 'cdt-architecture-acceptance-smoke', version: '1.0.0' });
    const smokeClient = client as unknown as McpClientLike;

    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cdt-architecture-acceptance-'));
    const rootA = path.join(tempRoot, 'root-a');
    const rootB = path.join(tempRoot, 'root-b');
    const temporaryRoots = [rootA, rootB];
    let workspaceFoldersAdded = false;
    let primaryFailure: unknown;
    let cleanupFailure: Error | undefined;
    try {
      await createDesignerRoot(rootA);
      await createDesignerRoot(rootB);
      await client.connect(transport);

      const initial = await waitForConfigurations(smokeClient, () => true);
      const protectedFiles = new Map<string, string | null>();
      for (const configuration of initial) {
        const descriptorPath = fileURLToPath(configuration.descriptorUri);
        const formatDescriptor = configuration.format === 'EDT'
          ? path.join(configuration.rootPath, 'src', 'Configuration', 'Configuration.mdo')
          : path.join(configuration.rootPath, 'Configuration.xml');
        assert.strictEqual(
          canonical(descriptorPath),
          canonical(formatDescriptor),
          `Production registry descriptor must match the ${configuration.format} root.`,
        );
        protectedFiles.set(descriptorPath, await hashFileOrNull(descriptorPath));
      }
      for (const folder of originalFolders) {
        const cfeManifest = path.join(folder.uri.fsPath, '.vscode', 'cfe-projects.json');
        protectedFiles.set(cfeManifest, await hashFileOrNull(cfeManifest));
      }

      const added = vscode.workspace.updateWorkspaceFolders(
        originalFolders.length,
        0,
        { uri: vscode.Uri.file(rootA), name: 'Architecture Root A' },
        { uri: vscode.Uri.file(rootB), name: 'Architecture Root B' },
      );
      assert.strictEqual(added, true, 'VS Code must accept two temporary workspace roots.');
      workspaceFoldersAdded = true;

      const descriptors = await waitForConfigurations(smokeClient, (items) =>
        items.some((item) => canonical(item.rootPath) === canonical(rootA))
        && items.some((item) => canonical(item.rootPath) === canonical(rootB)));
      const baseA = descriptors.find((item) => canonical(item.rootPath) === canonical(rootA));
      const baseB = descriptors.find((item) => canonical(item.rootPath) === canonical(rootB));
      assert.ok(baseA?.configurationId, 'Root A ID must come from production listConfigurations.');
      assert.ok(baseB?.configurationId, 'Root B ID must come from production listConfigurations.');

      const rootABeforeAmbiguous = await snapshotFiles(rootA);
      const rootBBeforeAmbiguous = await snapshotFiles(rootB);
      const ambiguousCreate = await callOperation(smokeClient, 'cdt_write', 'cdt_create_object', {
        type: 'Catalog',
        name: 'AmbiguousCatalogMustNotExist',
      });
      assert.strictEqual(ambiguousCreate.response.isError, true);
      assert.strictEqual(ambiguousCreate.envelope.success, false);
      assert.strictEqual(ambiguousCreate.envelope.code, 'CONFIGURATION_SELECTION_REQUIRED');
      const unknownIdCreate = await vscode.commands.executeCommand<AgentEnvelope>(CREATE_OBJECT_COMMAND, {
        configurationId: 'unknown-architecture-smoke-configuration',
        type: 'Catalog',
        name: 'UnknownCatalogMustNotExist',
      });
      assert.strictEqual(unknownIdCreate?.success, false);
      assert.strictEqual(unknownIdCreate?.code, 'CONFIGURATION_ID_UNKNOWN');
      assert.deepStrictEqual(await snapshotFiles(rootA), rootABeforeAmbiguous);
      assert.deepStrictEqual(await snapshotFiles(rootB), rootBBeforeAmbiguous);

      const hostCreate = await callOperation(smokeClient, 'cdt_write', 'cdt_create_object', {
        configurationId: baseA.configurationId,
        type: 'Catalog',
        name: 'ArchitectureRootCatalog',
      });
      assertCommittedMutation(hostCreate.envelope, 'MCP createObject on Root A');
      assert.strictEqual(hostCreate.envelope.reconciliation?.status, 'failed');
      assert.strictEqual(hostCreate.envelope.reconciliation?.code, 'CONFIGURATION_NOT_LOADED');
      const hostCreateData = hostCreate.envelope.data as { filePath?: string } | undefined;
      const rootObjectPath = path.join(rootA, 'Catalogs', 'ArchitectureRootCatalog.xml');
      assert.strictEqual(canonical(hostCreateData?.filePath ?? ''), canonical(rootObjectPath));
      assert.ok(await fs.promises.readFile(rootObjectPath, 'utf8').then((xml) => xml.includes('ArchitectureRootCatalog')));

      await vscode.commands.executeCommand('1c-metadata-tree.openPanel');

      const hostSet = await vscode.commands.executeCommand<AgentEnvelope>(SET_PROPERTIES_COMMAND, {
        configurationId: baseA.configurationId,
        path: 'Catalog.ArchitectureRootCatalog',
        properties: { Synonym: 'Root A updated through registered command' },
      });
      assert.ok(hostSet);
      assertSuccessfulMutation(hostSet, 'Registered setProperties on Root A');
      assert.ok(await fs.promises.readFile(rootObjectPath, 'utf8').then((xml) => xml.includes('Root A updated through registered command')));

      const hostDelete = await callOperation(smokeClient, 'cdt_write', 'cdt_delete_object', {
        configurationId: baseA.configurationId,
        path: 'Catalog.ArchitectureRootCatalog',
      });
      assertSuccessfulMutation(hostDelete.envelope, 'MCP deleteObject on Root A');
      await assert.rejects(fs.promises.access(rootObjectPath));
      assert.deepStrictEqual(await snapshotFiles(rootB), rootBBeforeAmbiguous, 'Root B must remain byte-for-byte unchanged.');

      await vscode.commands.executeCommand('1c-metadata-tree.openPanel');
      const cfeCreate = await callOperation(smokeClient, 'cdt_write', 'cdt_cfe_create_project', {
        baseConfigurationId: baseA.configurationId,
        extensionName: 'ArchitectureExtension',
        purpose: 'Customization',
        namePrefix: 'Arch_',
        compatibilityMode: 'Version8_3_24',
        includeDefaultRole: true,
      });
      assert.strictEqual(cfeCreate.response.isError, undefined);
      assert.strictEqual(cfeCreate.envelope.success, true, cfeCreate.envelope.error);
      const cfeCreateData = cfeCreate.envelope.data as { status?: string } | undefined;
      assert.strictEqual(cfeCreateData?.status, 'created');

      const extensionRoot = path.join(rootA, 'ConfigurationExtensions', 'ArchitectureExtension');
      const withExtension = await waitForConfigurations(smokeClient, (items) =>
        items.some((item) => canonical(item.rootPath) === canonical(extensionRoot)));
      const extension = withExtension.find((item) => canonical(item.rootPath) === canonical(extensionRoot));
      assert.ok(extension?.configurationId, 'Extension ID must come from production listConfigurations.');

      await vscode.commands.executeCommand('1c-metadata-tree.openPanel');

      const mcpContext = await callOperation(smokeClient, 'cdt_read', 'cdt_cfe_get_context', {
        configurationId: baseA.configurationId,
      });
      assert.strictEqual(mcpContext.envelope.success, true, mcpContext.envelope.error);
      const directContext = await vscode.commands.executeCommand<AgentEnvelope>(
        '1c-metadata-tree.agent.cfe.getContext',
        { configurationId: extension.configurationId },
      );
      assert.strictEqual(directContext?.success, true, directContext?.error);
      const relation = mcpContext.envelope.data as {
        baseConfigurationId?: string;
        extensionConfigurationId?: string;
        extensionName?: string;
        namePrefix?: string;
      } | undefined;
      assert.strictEqual(relation?.baseConfigurationId, baseA.configurationId);
      assert.strictEqual(relation?.extensionConfigurationId, extension.configurationId);
      assert.strictEqual(relation?.extensionName, 'ArchitectureExtension');
      assert.strictEqual(relation?.namePrefix, 'Arch_');
      assert.deepStrictEqual(directContext?.data, relation);

      const baseFilesBeforeExtensionCrud = await snapshotFiles(rootA, ['ConfigurationExtensions/ArchitectureExtension']);
      const extensionObjectPath = path.join(extensionRoot, 'Catalogs', 'Arch_OwnCatalog.xml');
      const extensionCreate = await callOperation(smokeClient, 'cdt_write', 'cdt_create_object', {
        configurationId: extension.configurationId,
        type: 'Catalog',
        name: 'Arch_OwnCatalog',
      });
      assertSuccessfulMutation(extensionCreate.envelope, 'MCP CFE-owned Catalog create');
      assert.strictEqual(
        canonical((extensionCreate.envelope.data as { filePath?: string } | undefined)?.filePath ?? ''),
        canonical(extensionObjectPath),
      );
      assert.ok(await fs.promises.readFile(extensionObjectPath, 'utf8').then((xml) => xml.includes('Arch_OwnCatalog')));
      assert.strictEqual(await fs.promises.access(path.join(rootA, 'Catalogs', 'Arch_OwnCatalog.xml')).then(() => true, () => false), false);

      const extensionSet = await vscode.commands.executeCommand<AgentEnvelope>(SET_PROPERTIES_COMMAND, {
        configurationId: extension.configurationId,
        path: 'Catalog.Arch_OwnCatalog',
        properties: { Synonym: 'CFE-owned Catalog' },
      });
      assert.ok(extensionSet);
      assertSuccessfulMutation(extensionSet, 'Registered CFE-owned setProperties');
      assert.ok(await fs.promises.readFile(extensionObjectPath, 'utf8').then((xml) => xml.includes('CFE-owned Catalog')));

      const extensionDelete = await callOperation(smokeClient, 'cdt_write', 'cdt_delete_object', {
        configurationId: extension.configurationId,
        path: 'Catalog.Arch_OwnCatalog',
      });
      assertSuccessfulMutation(extensionDelete.envelope, 'MCP CFE-owned Catalog delete');
      await assert.rejects(fs.promises.access(extensionObjectPath));
      assert.deepStrictEqual(
        await snapshotFiles(rootA, ['ConfigurationExtensions/ArchitectureExtension']),
        baseFilesBeforeExtensionCrud,
        'CFE-owned CRUD must leave all base configuration files unchanged.',
      );
      assert.deepStrictEqual(await snapshotFiles(rootB), rootBBeforeAmbiguous, 'CFE work must not change Root B.');

      for (const [filePath, expectedHash] of protectedFiles) {
        assert.strictEqual(await hashFileOrNull(filePath), expectedHash, `Original workspace file changed: ${filePath}`);
      }
    } catch (error) {
      primaryFailure = error;
    } finally {
      const cleanupErrors: unknown[] = [];
      try {
        await transport.terminateSession();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await client.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (workspaceFoldersAdded) {
        try {
          const removed = vscode.workspace.updateWorkspaceFolders(originalFolders.length, temporaryRoots.length);
          if (!removed) {
            cleanupErrors.push(new Error('VS Code refused to remove the temporary architecture smoke roots.'));
          } else {
            await waitForWorkspaceRestore(originalFolders.length, temporaryRoots);
          }
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        await fs.promises.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        const message = `Smoke cleanup failed: ${cleanupErrors.map(String).join('; ')}`;
        if (primaryFailure !== undefined) {
          console.error(`${message}. Original test failure: ${String(primaryFailure)}`);
        } else {
          cleanupFailure = new Error(message);
        }
      }
    }
    if (primaryFailure !== undefined) {
      throw primaryFailure;
    }
    if (cleanupFailure) {
      throw cleanupFailure;
    }
  });
});
