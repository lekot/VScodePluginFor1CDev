import * as assert from 'assert';
import * as vscode from 'vscode';
import type { AgentResult } from '../../../src/agent/types';
import type {
  FormsDiscoverResult,
  FormsLaunchFailureResult,
  FormsLaunchResult,
  FormsStopResult,
  NativeFormsActionResult,
  FormsOperationInDoubtResult,
} from '../../../src/agent/agentFormsTypes';
import { inspectNativeTestClientPortOwnersWithDependencies } from '../../../src/services/forms/nativeScreenshot';

const DISCOVER_COMMAND = '1c-metadata-tree.agent.forms.discover';
const LAUNCH_COMMAND = '1c-metadata-tree.agent.forms.launch';
const NATIVE_COMMAND = '1c-metadata-tree.agent.forms.native';
const STOP_COMMAND = '1c-metadata-tree.agent.forms.stop';

suite('Smoke: native TestClient lifecycle (opt-in)', () => {
  test('discovers, launches, inspects, disconnects, and stops only its own TestClient', async function () {
    const dbPath = process.env.TESTCLIENT_LIVE_DB_PATH?.trim();
    const platformPath = process.env.TESTCLIENT_LIVE_EXE?.trim();
    if (!dbPath || !platformPath) {
      this.skip();
    }
    this.timeout(180_000);

    let ownedProcess: { pid: number; port: number; createdTicks?: string } | undefined;
    let primaryError: unknown;
    try {
      const discovery = await vscode.commands.executeCommand<AgentResult<FormsDiscoverResult>>(
        DISCOVER_COMMAND,
        {},
      );
      assert.strictEqual(discovery?.success, true, `forms.discover failed: ${discovery?.error ?? 'no result'}`);

      const launch = await vscode.commands.executeCommand<AgentResult<FormsLaunchResult | FormsLaunchFailureResult>>(
        LAUNCH_COMMAND,
        { dbPath, platformPath, background: false, waitTimeoutMs: 120_000 },
      );
      if (launch?.data && isLaunchedProcess(launch.data)) {
        ownedProcess = { pid: launch.data.pid, port: launch.data.port };
      }
      assert.strictEqual(launch?.success, true, `forms.launch failed: ${launch?.code ?? 'no result'} ${launch?.error ?? ''}`);
      assert.ok(ownedProcess, 'forms.launch did not return the spawned PID and port');
      const identity = await inspectNativeTestClientPortOwnersWithDependencies(
        15_000,
        {},
        undefined,
        ownedProcess.port,
      );
      const launchedClient = identity.find((owner) =>
        owner.pid === ownedProcess!.pid && owner.port === ownedProcess!.port && owner.testClient,
      );
      assert.ok(launchedClient?.createdTicks, `Could not verify the launched TestClient identity for PID ${ownedProcess.pid}.`);
      ownedProcess.createdTicks = launchedClient.createdTicks;

      const overview = await vscode.commands.executeCommand<AgentResult<NativeFormsActionResult | FormsOperationInDoubtResult>>(
        NATIVE_COMMAND,
        { action: 'overview', background: false, timeoutMs: 30_000 },
      );
      assert.strictEqual(overview?.success, true, `forms.native overview failed: ${overview?.error ?? 'no result'}`);
      assert.ok(overview.data && 'activeWindow' in overview.data, 'forms.native overview did not return the active window');
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      const cleanupErrors: string[] = [];
      try {
        const stop = await vscode.commands.executeCommand<AgentResult<FormsStopResult>>(STOP_COMMAND, {});
        if (!stop?.success) {
          cleanupErrors.push(`forms.stop failed: ${stop?.error ?? 'no result'}`);
        }
      } catch (error) {
        cleanupErrors.push(`forms.stop threw: ${errorMessage(error)}`);
      }

      if (ownedProcess && isProcessRunning(ownedProcess.pid)) {
        try {
          if (!ownedProcess.createdTicks) {
            throw new Error(`Cannot verify creation identity for launched PID ${ownedProcess.pid}; left it untouched.`);
          }
          await stopOwnedProcessAfterIdentityCheck({ ...ownedProcess, createdTicks: ownedProcess.createdTicks });
        } catch (error) {
          cleanupErrors.push(errorMessage(error));
        }
      }
      if (cleanupErrors.length > 0) {
        const cleanupError = new Error(cleanupErrors.join('; '));
        if (primaryError instanceof Error) {
          primaryError.message += ` Cleanup failed: ${cleanupError.message}`;
        } else {
          throw cleanupError;
        }
      }
    }
  });
});

function isLaunchedProcess(
  value: FormsLaunchResult | FormsLaunchFailureResult,
): value is (FormsLaunchResult | FormsLaunchFailureResult) & { pid: number; port: number } {
  return typeof value.pid === 'number' && Number.isInteger(value.pid) && value.pid > 0
    && typeof value.port === 'number' && Number.isInteger(value.port) && value.port > 0;
}

async function stopOwnedProcessAfterIdentityCheck(endpoint: { pid: number; port: number; createdTicks: string }): Promise<void> {
  if (!isProcessRunning(endpoint.pid)) {
    return;
  }
  const owners = await inspectNativeTestClientPortOwnersWithDependencies(
    15_000,
    {},
    undefined,
    endpoint.port,
  );
  const identityMatches = owners.some((owner) =>
    owner.pid === endpoint.pid && owner.port === endpoint.port
      && owner.testClient && owner.createdTicks === endpoint.createdTicks,
  );
  if (!identityMatches) {
    if (isProcessRunning(endpoint.pid)) {
      throw new Error(`PID ${endpoint.pid} still runs, but no longer matches the launched TestClient on port ${endpoint.port}; left it untouched.`);
    }
    return;
  }

  process.kill(endpoint.pid);
  const deadline = Date.now() + 5_000;
  while (isProcessRunning(endpoint.pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.strictEqual(isProcessRunning(endpoint.pid), false, `Launched TestClient PID ${endpoint.pid} did not stop after termination.`);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
