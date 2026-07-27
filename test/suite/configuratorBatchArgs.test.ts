import * as assert from 'assert';
import {
  buildConfiguratorDumpExternalArgs,
  buildConfiguratorLoadExternalArgs,
  buildConfiguratorMinimalDumpArgs,
  buildConfiguratorPartialApplyArgs,
} from '../../src/services/configurator/configuratorBatchArgs';

suite('configuratorBatchArgs', () => {
  test('buildConfiguratorDumpExternalArgs generates correct Designer flags', () => {
    const args = buildConfiguratorDumpExternalArgs({
      target: { type: 'file', filePath: 'C:\\db\\1Cv8.1CD' },
      outputFilePath: 'C:\\logs\\out.log',
      dumpDirectory: 'C:\\src\\epf_src',
      externalFilePath: 'C:\\files\\MyProcessor.epf',
      format: 'Hierarchical',
    });

    assert.strictEqual(args.operation, 'dumpExternal');
    assert.ok(args.executionArgs.includes('/DumpExternalDataProcessorOrReportToFiles'));
    assert.ok(args.executionArgs.includes('C:\\src\\epf_src'));
    assert.ok(args.executionArgs.includes('C:\\files\\MyProcessor.epf'));
    assert.ok(args.executionArgs.includes('-Format'));
    assert.ok(args.executionArgs.includes('Hierarchical'));
  });

  test('buildConfiguratorLoadExternalArgs generates correct Designer flags', () => {
    const args = buildConfiguratorLoadExternalArgs({
      target: { type: 'file', filePath: 'C:\\db\\1Cv8.1CD' },
      outputFilePath: 'C:\\logs\\out.log',
      sourceDirectory: 'C:\\src\\epf_src',
      externalFilePath: 'C:\\files\\MyProcessor.epf',
      format: 'Plain',
    });

    assert.strictEqual(args.operation, 'loadExternal');
    assert.ok(args.executionArgs.includes('/LoadExternalDataProcessorOrReportFromFiles'));
    assert.ok(args.executionArgs.includes('C:\\files\\MyProcessor.epf'));
    assert.ok(args.executionArgs.includes('C:\\src\\epf_src'));
    assert.strictEqual(args.executionArgs.includes('-Format'), false);
  });
});
