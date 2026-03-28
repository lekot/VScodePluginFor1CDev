import * as assert from 'assert';
import {
  getIbcmdService,
  resetIbcmdServiceSingletonForTests,
} from '../../src/infobaseManager/ibcmd/ibcmdServiceSingleton';

suite('ibcmdServiceSingleton', () => {
  teardown(() => {
    resetIbcmdServiceSingletonForTests();
  });

  test('getIbcmdService returns the same instance', () => {
    const a = getIbcmdService();
    const b = getIbcmdService();
    assert.strictEqual(a, b);
  });

  test('resetIbcmdServiceSingletonForTests yields a new instance', () => {
    const a = getIbcmdService();
    resetIbcmdServiceSingletonForTests();
    const b = getIbcmdService();
    assert.notStrictEqual(a, b);
  });
});
