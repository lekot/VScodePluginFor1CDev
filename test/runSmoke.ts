import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {
  downloadAndUnzipVSCode,
  runTests,
  TestRunFailedError,
  type DownloadOptions,
  type TestOptions,
} from '@vscode/test-electron';

interface FixtureDirectoryCopier {
  copyRegularDirectory(sourcePath: string, destinationPath: string): void;
}

const { copyRegularDirectory } = require(path.resolve(__dirname, '../../scripts/copy-test-fixtures.js')) as FixtureDirectoryCopier;

function assertPathIsWithin(parentPath: string, targetPath: string): void {
  const parent = path.resolve(parentPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(parent, target);
  if (
    relative === ''
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error(`Refusing to remove path outside its expected parent: ${target}`);
  }
}

function logSmokeDiagnostic(marker: string, details: Record<string, unknown>): void {
  console.log(`${marker} ${JSON.stringify({ timestamp: new Date().toISOString(), ...details })}`);
}

function formatError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const details: Record<string, unknown> = {
      name: error.name,
      message: error.message,
    };
    if (error instanceof TestRunFailedError) {
      details.exitCode = error.code;
      details.signal = error.signal;
    }
    return details;
  }
  return { message: String(error) };
}

async function main() {
  if (process.argv.includes('-await-user-close')) {
    process.env.SMOKE_AWAIT_USER_CLOSE = '1';
  }

  let temporaryWorkspace: string | undefined;
  let exitCode = 0;
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/smoke/index');
    const requestedWorkspace = process.env.SMOKE_WORKSPACE?.trim();
    let workspaceFolder = requestedWorkspace
      ? path.resolve(requestedWorkspace)
      : path.resolve(extensionDevelopmentPath, 'test/fixtures/designer-config');
    if (!requestedWorkspace) {
      temporaryWorkspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-smoke-common-module-'));
      copyRegularDirectory(workspaceFolder, temporaryWorkspace);
      workspaceFolder = temporaryWorkspace;
      const commonModulesPath = path.join(workspaceFolder, 'CommonModules');
      await fs.promises.mkdir(commonModulesPath, { recursive: true });
      const moduleTemplate = await fs.promises.readFile(
        path.join(extensionDevelopmentPath, 'test/fixtures/designer-config/CommonModules/FlatOnlyModule.xml'),
        'utf8',
      );
      const commonModuleName = 'мойМодульэ';
      const moduleXml = moduleTemplate
        .replace(/FlatOnlyModule/gu, commonModuleName)
        .replace('b0000000-0000-0000-0000-000000000088', 'c0000000-0000-0000-0000-000000000077');
      await fs.promises.writeFile(path.join(commonModulesPath, `${commonModuleName}.xml`), moduleXml, 'utf8');
    }

    const vscodeTestDirectory = path.join(extensionDevelopmentPath, '.vscode-test');
    const userDataDirectory = path.join(vscodeTestDirectory, 'user-data');
    const extensionsDirectory = path.join(vscodeTestDirectory, 'extensions');
    const launchArgs = [
      '--folder-uri',
      pathToFileURL(workspaceFolder).toString(),
      `--user-data-dir=${userDataDirectory}`,
      `--extensions-dir=${extensionsDirectory}`,
    ];

    logSmokeDiagnostic('SMOKE_LAUNCH_REQUESTED', {
      versionPolicy: 'extension-engines',
      cachePath: vscodeTestDirectory,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs,
    });

    let vscodeExecutablePath: string;
    try {
      vscodeExecutablePath = await downloadAndUnzipVSCode({
        cachePath: vscodeTestDirectory,
        extensionDevelopmentPath,
      } satisfies Partial<DownloadOptions>);
    } catch (err) {
      logSmokeDiagnostic('SMOKE_LAUNCH_FAILED', {
        stage: 'downloadAndUnzipVSCode',
        error: formatError(err),
      });
      throw err;
    }

    logSmokeDiagnostic('SMOKE_LAUNCH_RESOLVED', {
      vscodeExecutablePath,
      launchArgs,
    });

    const runOptions: TestOptions = {
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs,
    };
    let runnerExitCode: number;
    try {
      runnerExitCode = await runTests(runOptions);
    } catch (err) {
      logSmokeDiagnostic('SMOKE_RUNNER_FAILED', {
        error: formatError(err),
      });
      throw err;
    }

    if (runnerExitCode !== 0) {
      const runnerError = new TestRunFailedError(runnerExitCode, undefined);
      logSmokeDiagnostic('SMOKE_RUNNER_FAILED', {
        error: formatError(runnerError),
      });
      throw runnerError;
    }
    logSmokeDiagnostic('SMOKE_RUNNER_COMPLETED', { exitCode: runnerExitCode });
  } catch (err) {
    console.error('Smoke tests failed', err);
    exitCode = err instanceof TestRunFailedError && typeof err.code === 'number' ? err.code : 1;
  } finally {
    if (temporaryWorkspace) {
      try {
        assertPathIsWithin(os.tmpdir(), temporaryWorkspace);
        await fs.promises.rm(temporaryWorkspace, { recursive: true, force: true });
      } catch (err) {
        console.error('Failed to clean temporary smoke workspace', err);
        if (exitCode === 0) exitCode = 1;
      }
    }
  }

  process.exitCode = exitCode;
}

if (require.main === module) {
  void main();
}
