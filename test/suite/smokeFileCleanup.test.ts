import * as assert from 'assert';
import { cleanupSmokeFile } from '../helpers/smokeFileCleanup';

suite('smoke file cleanup', () => {
  test('unlinks the file when closing its tabs fails', async () => {
    const closeError = new Error('tab close failed');
    let fileExists = true;

    await assert.rejects(
      cleanupSmokeFile(
        async () => {
          throw closeError;
        },
        async () => {
          fileExists = false;
        }
      ),
      (error: unknown) => error === closeError
    );

    assert.strictEqual(
      fileExists,
      false,
      'the temporary BSL must be removed even when tab closing fails'
    );
  });

  test('preserves both tab-close and unlink errors', async () => {
    const closeError = new Error('tab close failed');
    const unlinkError = new Error('unlink failed');

    await assert.rejects(
      cleanupSmokeFile(
        async () => {
          throw closeError;
        },
        async () => {
          throw unlinkError;
        }
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.strictEqual(error.name, 'AggregateError');
        assert.deepStrictEqual((error as Error & { errors?: unknown[] }).errors, [
          closeError,
          unlinkError,
        ]);
        return true;
      }
    );
  });
});
