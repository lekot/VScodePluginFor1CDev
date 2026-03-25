import * as assert from 'assert';
import { coreSuiteFiles } from './coreSuites';

/**
 * Suites that must stay in coreSuiteFiles so `npm run test:ci` exercises them.
 * Update this list when intentionally adding new always-on core coverage.
 */
const mustRegisterInCoreCi: readonly string[] = [
  'suite/formPaths.test.js',
  'suite/xmlChildObjects.test.js',
  'suite/xmlPropertyUtils.test.js',
  'suite/metadataParser.edge.test.js',
  'suite/errorHandling.test.js',
];

suite('coreSuiteFiles registration guard', () => {
  test('guarded suites remain listed for test:ci', () => {
    const set = new Set(coreSuiteFiles);
    for (const file of mustRegisterInCoreCi) {
      assert.ok(set.has(file), `${file} must be in coreSuiteFiles (merge regression)`);
    }
  });
});
