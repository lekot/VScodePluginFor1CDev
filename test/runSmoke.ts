import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { runTests } from '@vscode/test-electron';

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

async function main() {
  if (process.argv.includes('-await-user-close')) {
    process.env.SMOKE_AWAIT_USER_CLOSE = '1';
  }

  let temporaryWorkspace: string | undefined;
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/smoke/index');
    const requestedWorkspace = process.env.SMOKE_WORKSPACE?.trim();
    let workspaceFolder = requestedWorkspace
      ? path.resolve(requestedWorkspace)
      : path.resolve(extensionDevelopmentPath, 'test/fixtures/designer-config');
    if (!requestedWorkspace) {
      temporaryWorkspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-smoke-common-module-'));
      await fs.promises.cp(workspaceFolder, temporaryWorkspace, { recursive: true });
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

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: ['--folder-uri', pathToFileURL(workspaceFolder).toString()],
    });
  } catch (err) {
    console.error('Smoke tests failed', err);
    process.exitCode = 1;
  } finally {
    if (temporaryWorkspace) {
      assertPathIsWithin(os.tmpdir(), temporaryWorkspace);
      await fs.promises.rm(temporaryWorkspace, { recursive: true, force: true });
    }
  }
}

void main();
