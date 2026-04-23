import * as assert from 'assert';
import * as path from 'path';
import { isChromiumInstalled } from '../../src/services/forms/chromiumInstaller';

suite('chromiumInstaller', () => {
    test('isChromiumInstalled returns boolean without throwing', async () => {
        const extensionPath = path.join(__dirname, '../../');
        const result = await isChromiumInstalled(extensionPath);
        assert.strictEqual(typeof result, 'boolean');
    });
});
