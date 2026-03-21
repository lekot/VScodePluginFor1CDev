import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
  if (process.argv.includes('-await-user-close')) {
    process.env.SMOKE_AWAIT_USER_CLOSE = '1';
  }

  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/smoke/index');
    const workspaceFolder = path.resolve(extensionDevelopmentPath, 'test/fixtures/designer-config');
    const workspaceUri = `file:///${workspaceFolder.replace(/\\/g, '/')}`;

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: ['--folder-uri', workspaceUri],
    });
  } catch (err) {
    console.error('Smoke tests failed');
    process.exit(1);
  }
}

main();
