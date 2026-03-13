import * as path from 'path';
import * as vscode from 'vscode';
import Mocha from 'mocha';
import * as glob from 'glob';
import { writeArtifacts } from './smokeArtifacts';

export function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
  });

  const testsRoot = path.resolve(__dirname, '.');

  return new Promise((resolve, reject) => {
    const testFiles = glob.sync('**/*.test.js', { cwd: testsRoot });
    testFiles.forEach((file) => mocha.addFile(path.resolve(testsRoot, file)));

    try {
      mocha.run((failures: number) => {
        writeArtifacts()
          .then(() => {
            if (failures > 0) {
              reject(new Error(`${failures} smoke test(s) failed.`));
              return;
            }
            if (process.env.SMOKE_AWAIT_USER_CLOSE === '1') {
              void vscode.window.showInformationMessage(
                'Smoke finished. Close this window when done (e.g. to inspect or trigger errors).'
              );
              return;
            }
            resolve();
          })
          .catch((err) => {
            console.error('Failed to write smoke artifacts', err);
            if (failures > 0) reject(new Error(`${failures} smoke test(s) failed.`));
            else reject(err);
          });
      });
    } catch (err) {
      console.error(err);
      reject(err);
    }
  });
}
