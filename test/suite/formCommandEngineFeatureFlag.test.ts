import * as assert from 'assert';
import {
  isFormCommandEngineEnabled,
  isFormCommandEngineExplicitSaveEnabled,
} from '../../src/formEditor/formCommandEngineFeatureFlag';

suite('formCommandEngineFeatureFlag', () => {
  const enabledKey = 'FORM_COMMAND_ENGINE_ENABLED';
  const explicitKey = 'FORM_COMMAND_ENGINE_EXPLICIT_SAVE_ENABLED';
  let saved: Record<string, string | undefined>;

  setup(() => {
    saved = {
      [enabledKey]: process.env[enabledKey],
      [explicitKey]: process.env[explicitKey],
    };
    delete process.env[enabledKey];
    delete process.env[explicitKey];
  });

  teardown(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test('engine disabled when env unset', () => {
    assert.strictEqual(isFormCommandEngineEnabled(), false);
  });

  test('engine enabled for accepted truthy string values', () => {
    for (const raw of ['1', 'true', 'YES', ' on ']) {
      process.env[enabledKey] = raw;
      assert.strictEqual(isFormCommandEngineEnabled(), true, raw);
    }
  });

  test('engine disabled for other string values', () => {
    process.env[enabledKey] = '0';
    assert.strictEqual(isFormCommandEngineEnabled(), false);
  });

  test('explicit save disabled when env unset or empty', () => {
    assert.strictEqual(isFormCommandEngineExplicitSaveEnabled(), false);
    process.env[explicitKey] = '';
    assert.strictEqual(isFormCommandEngineExplicitSaveEnabled(), false);
  });

  test('explicit save enabled when env is truthy accepted value', () => {
    process.env[explicitKey] = 'true';
    assert.strictEqual(isFormCommandEngineExplicitSaveEnabled(), true);
  });
});
