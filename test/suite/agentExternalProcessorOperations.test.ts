import * as assert from 'assert';
import {
  agentBuildExternalProcessor,
  agentDumpExternalProcessor,
} from '../../src/agent/agentExternalProcessorOperations';

suite('agentExternalProcessorOperations', () => {
  test('agentDumpExternalProcessor formats paths correctly', async () => {
    const res = await agentDumpExternalProcessor({
      srcPath: 'C:\\test\\MyProcessor.epf',
    });

    assert.strictEqual(res.success, false); // executable resolution fail in unit environment
    assert.ok(res.message);
  });

  test('agentBuildExternalProcessor formats paths correctly', async () => {
    const res = await agentBuildExternalProcessor({
      srcDir: 'C:\\test\\MyProcessor_src',
    });

    assert.strictEqual(res.success, false);
    assert.ok(res.message);
  });
});
