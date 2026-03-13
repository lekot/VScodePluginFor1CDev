import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import { MetadataWatcherService } from '../../src/services/metadataWatcherService';

suite('MetadataWatcherService', () => {
  let service: MetadataWatcherService;

  setup(() => {
    service = new MetadataWatcherService();
  });

  teardown(() => {
    service.dispose();
  });

  test('start then stop does not throw', () => {
    const configRoot = path.join(os.tmpdir(), '1cviewer-watcher-test');
    let onTreeReloadCalls = 0;
    service.start(configRoot, {
      onTreeReload: () => {
        onTreeReloadCalls += 1;
      },
    });
    service.stop();
    assert.strictEqual(onTreeReloadCalls, 0);
  });

  test('dispose cleans up', () => {
    const configRoot = path.join(os.tmpdir(), '1cviewer-watcher-test');
    service.start(configRoot, { onTreeReload: () => {} });
    service.dispose();
    // Second dispose is no-op
    service.dispose();
  });
});
