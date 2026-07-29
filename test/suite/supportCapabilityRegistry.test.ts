import * as assert from 'assert';
import {
  SupportCapabilityRegistry,
  type SupportCapabilityQuery,
} from '../../src/support/supportCapabilityRegistry';

suite('SupportCapabilityRegistry', () => {
  const certifiedQuery: SupportCapabilityQuery = {
    targetKind: 'file',
    platformVersion: '8.3.27.1859',
    formatRevision: '6',
    configurationStrategy: 'main',
  };

  test('accepts only the certified file/main/platform/revision tuple', () => {
    const registry = new SupportCapabilityRegistry();

    const resolution = registry.resolve(certifiedQuery);

    assert.deepStrictEqual(resolution, {
      supported: true,
      strategy: {
        id: 'file-main-8.3.27.1859-revision6',
        targetKind: 'file',
        platformVersion: '8.3.27.1859',
        formatRevision: '6',
        configurationStrategy: 'main',
        includeConfigDumpInfo: false,
      },
    });
    assert.strictEqual(resolution.supported, true);
    if (resolution.supported) {
      assert.strictEqual(Object.isFrozen(resolution.strategy), true);
    }
  });

  test('rejects every unsupported dimension with stable typed reason', () => {
    const registry = new SupportCapabilityRegistry();
    const cases: ReadonlyArray<{
      readonly query: SupportCapabilityQuery;
      readonly reason: 'targetType' | 'platformVersion' | 'formatRevision' | 'configurationStrategy';
    }> = [
      {
        query: { ...certifiedQuery, targetKind: 'server' },
        reason: 'targetType',
      },
      {
        query: { ...certifiedQuery, targetKind: 'web' },
        reason: 'targetType',
      },
      {
        query: { ...certifiedQuery, platformVersion: '8.3.27.1860' },
        reason: 'platformVersion',
      },
      {
        query: { ...certifiedQuery, formatRevision: '7' },
        reason: 'formatRevision',
      },
      {
        query: { ...certifiedQuery, configurationStrategy: 'extension' },
        reason: 'configurationStrategy',
      },
    ];

    for (const { query, reason } of cases) {
      assert.deepStrictEqual(registry.resolve(query), {
        supported: false,
        errorCode: 'SUPPORT_TARGET_UNSUPPORTED',
        reason,
      });
    }
  });

  test('uses deterministic fail-closed precedence when several dimensions are unknown', () => {
    const registry = new SupportCapabilityRegistry();

    assert.deepStrictEqual(registry.resolve({
      targetKind: 'server',
      platformVersion: 'unknown',
      formatRevision: 'unknown',
      configurationStrategy: 'extension',
    }), {
      supported: false,
      errorCode: 'SUPPORT_TARGET_UNSUPPORTED',
      reason: 'targetType',
    });
    assert.deepStrictEqual(registry.resolve({
      ...certifiedQuery,
      platformVersion: 'unknown',
      formatRevision: 'unknown',
      configurationStrategy: 'extension',
    }), {
      supported: false,
      errorCode: 'SUPPORT_TARGET_UNSUPPORTED',
      reason: 'platformVersion',
    });
  });
});
