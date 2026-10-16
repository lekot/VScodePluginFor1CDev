import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import { SKD_TOOLS } from '../../src/agent/mcpAdapter/catalog/skdTools';
import { SkdOperations } from '../../src/agent/agentSkdOperations';
import { SKD_EDIT_OPERATIONS, type SkdEditOperation } from '../../src/agent/agentSkdTypes';

suite('SKD edit operations parity — #246', () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const skdEditScriptPath = path.join(repoRoot, 'resources', 'skd', 'skd-edit.ps1');

    async function parsePowerShellValidateSet(): Promise<string[]> {
        const content = await fs.readFile(skdEditScriptPath, 'utf8');
        const match = content.match(/\[ValidateSet\(([^)]+)\)\]\s*\[string\]\$Operation/s);
        assert.ok(match, 'Failed to locate [ValidateSet(...)] for $Operation in skd-edit.ps1');
        const rawItems = match[1];
        const operations = rawItems
            .split(',')
            .map((s) => s.trim().replace(/^["']|["']$/g, ''))
            .filter(Boolean);
        return operations;
    }

    test('all operations from skd-edit.ps1 ValidateSet match SKD_EDIT_OPERATIONS exactly', async () => {
        const psOperations = await parsePowerShellValidateSet();
        assert.strictEqual(
            psOperations.length,
            SKD_EDIT_OPERATIONS.length,
            `Expected ${SKD_EDIT_OPERATIONS.length} operations in skd-edit.ps1, got ${psOperations.length}`,
        );

        const psSet = new Set(psOperations);
        const tsSet = new Set<string>(SKD_EDIT_OPERATIONS);

        assert.deepStrictEqual(
            [...tsSet].filter((op) => !psSet.has(op)),
            [],
            'Operations present in TypeScript but missing in PowerShell ValidateSet',
        );
        assert.deepStrictEqual(
            [...psSet].filter((op) => !tsSet.has(op)),
            [],
            'Operations present in PowerShell ValidateSet but missing in TypeScript SKD_EDIT_OPERATIONS',
        );

        const editTool = SKD_TOOLS.find((t) => t.name === 'cdt_skd_edit');
        assert.ok(editTool, 'cdt_skd_edit tool not found in SKD_TOOLS');

        const schema = editTool.inputSchema;
        for (const op of psOperations) {
            const parseResult = schema.safeParse({
                templatePath: '/dummy/Template.xml',
                operation: op,
                value: '{}',
            });
            assert.ok(
                parseResult.success,
                `Operation "${op}" from skd-edit.ps1 ValidateSet must be accepted by MCP schema: ${JSON.stringify(parseResult.error)}`,
            );
        }
    });

    test('all 8 previously missing operations pass SkdOperations.skdEdit and forward to script', async () => {
        const newOperations: SkdEditOperation[] = [
            'add-drilldown',
            'patch-query',
            'modify-parameter',
            'modify-structure',
            'set-field-role',
            'rename-parameter',
            'reorder-parameters',
            'clear-conditionalAppearance',
        ];

        for (const op of newOperations) {
            let capturedArgs: string[] | undefined;
            const ops = new SkdOperations({
                extensionPath: repoRoot,
                runPowerShellScript: async (options) => {
                    capturedArgs = options.args;
                    return {
                        stdout: `[OK] Saved /dummy/Template.xml\n`,
                        stderr: '',
                        exitCode: 0,
                    };
                },
            });

            const result = await ops.skdEdit({
                templatePath: '/dummy/Template.xml',
                operation: op,
                value: 'test-value',
            });

            assert.strictEqual(result.success, true, `Operation ${op} failed: ${result.error}`);
            assert.ok(capturedArgs, `Runner was not called for operation ${op}`);
            const opIdx = capturedArgs.indexOf('-Operation');
            assert.ok(opIdx !== -1 && capturedArgs[opIdx + 1] === op, `Args must contain -Operation ${op}`);
        }
    });
});
