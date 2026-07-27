import * as assert from 'assert';
import {
  buildExternalProcessor,
  dumpExternalProcessor,
} from '../../src/services/externalProcessor/externalProcessorService';

suite('externalProcessorService', () => {
  test('dumpExternalProcessor rejects unsupported extensions', async () => {
    const res = await dumpExternalProcessor({
      externalFilePath: 'C:\\test\\file.txt',
      directoryPath: 'C:\\test\\out',
    });

    assert.strictEqual(res.success, false);
    assert.ok(res.message?.includes('Unsupported external processor file extension'));
  });

  test('buildExternalProcessor rejects unsupported extensions', async () => {
    const res = await buildExternalProcessor({
      externalFilePath: 'C:\\test\\file.doc',
      directoryPath: 'C:\\test\\out',
    });

    assert.strictEqual(res.success, false);
    assert.ok(res.message?.includes('Unsupported external processor file extension'));
  });
});
