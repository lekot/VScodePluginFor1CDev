import * as path from 'path';
import Mocha from 'mocha';
import * as glob from 'glob';

export function run(): Promise<void> {
  // Create the mocha test
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
  });

  // Some test artifacts may still reference bdd-style globals (`describe`/`it`).
  // With `ui: tdd` Mocha doesn't define them, so we alias to keep the runner robust.
  const g = global as unknown as { describe?: unknown; suite?: unknown; it?: unknown; test?: unknown };
  if (g && typeof g.describe === 'undefined' && typeof g.suite !== 'undefined') {
    g.describe = g.suite;
  }
  if (g && typeof g.it === 'undefined' && typeof g.test !== 'undefined') {
    g.it = g.test;
  }

  const testsRoot = path.resolve(__dirname, '..');

  return new Promise((c, e) => {
    const testFiles = glob.sync('**/**.test.js', { cwd: testsRoot });

    // Add files to the test suite
    testFiles.forEach((file) => mocha.addFile(path.resolve(testsRoot, file)));

    try {
      // Run the mocha test
      mocha.run((failures: number) => {
        if (failures > 0) {
          e(new Error(`${failures} tests failed.`));
        } else {
          c();
        }
      });
    } catch (err) {
      console.error(err);
      e(err);
    }
  });
}
