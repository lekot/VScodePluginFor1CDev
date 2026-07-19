import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const EXTENSION_ID = '1c-dev.1c-metadata-tree-vscode';

interface Discovery {
  readonly schemaVersion: number;
  readonly token: string;
  readonly mcp: {
    readonly url: string;
    readonly transport: 'streamable-http';
    readonly authorization: 'bearer';
  };
}

async function readDiscovery(filePath: string, timeoutMs = 15000): Promise<Discovery> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as Discovery;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`MCP discovery was not created at ${filePath}: ${String(lastError)}`);
}

suite('Smoke: production MCP Agent Bridge', () => {
  test('activated extension serves registered Agent command through official MCP client', async function () {
    this.timeout(30000);

    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `Extension ${EXTENSION_ID} must be loaded by the smoke runner`);
    if (!extension.isActive) {
      await extension.activate();
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, 'Smoke fixture workspace must be open');
    const discoveryPath = path.join(
      workspaceFolder.uri.fsPath,
      '.vscode',
      'cdt-agent-bridge.json',
    );
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
    const client = new Client({ name: 'cdt-vscode-smoke', version: '1.0.0' });

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assert.deepStrictEqual(listed.tools.map((tool) => tool.name), [
        'cdt_list_configurations',
        'cdt_list_objects',
        'cdt_get_yaml',
        'cdt_get_properties',
        'cdt_list_bindings',
        'cdt_export_status',
      ]);

      const direct = await vscode.commands.executeCommand(
        '1c-metadata-tree.agent.listConfigurations',
        {},
      );
      const viaMcp = await client.callTool({
        name: 'cdt_list_configurations',
        arguments: {},
      });
      assert.deepStrictEqual(viaMcp.structuredContent, direct);
      assert.strictEqual(
        (viaMcp.structuredContent as { success?: boolean } | undefined)?.success,
        true,
      );

      await transport.terminateSession();
      assert.strictEqual(transport.sessionId, undefined);
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
