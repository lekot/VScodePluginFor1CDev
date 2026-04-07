/**
 * Tests for formEventCatalog — event lists, handler name generation, and BSL directives.
 *
 * Pure unit tests: no vscode dependency, no FS access.
 */

import * as assert from 'assert';
import {
  FORM_LEVEL_EVENTS,
  EVENT_RUSSIAN_SUFFIX,
  FORM_EVENT_CATALOG,
  getEventsForTag,
  generateHandlerName,
  getDirective,
} from '../../src/formEditor/formEventCatalog';

suite('formEventCatalog — getEventsForTag', () => {
  test('InputField returns array containing OnChange and StartChoice with correct length', () => {
    const events = getEventsForTag('InputField');
    assert.ok(Array.isArray(events), 'should be an array');
    assert.ok(events.includes('OnChange'), 'should include OnChange');
    assert.ok(events.includes('StartChoice'), 'should include StartChoice');
    assert.strictEqual(events.length, FORM_EVENT_CATALOG['InputField']!.length);
  });

  test('Button returns [Click]', () => {
    const events = getEventsForTag('Button');
    assert.deepStrictEqual(events, ['Click']);
  });

  test('UnknownTag returns empty array', () => {
    const events = getEventsForTag('UnknownTag');
    assert.deepStrictEqual(events, []);
  });

  test('UsualGroup returns empty array', () => {
    const events = getEventsForTag('UsualGroup');
    assert.deepStrictEqual(events, []);
  });
});

suite('formEventCatalog — generateHandlerName', () => {
  test('element-level OnChange produces ElementName + Russian suffix', () => {
    assert.strictEqual(generateHandlerName('Контрагент', 'OnChange', false), 'КонтрагентПриИзменении');
  });

  test('form-level OnOpen omits element name (suffix only)', () => {
    assert.strictEqual(generateHandlerName('', 'OnOpen', true), 'ПриОткрытии');
  });

  test('element-level Click produces ElementName + Нажатие', () => {
    assert.strictEqual(generateHandlerName('Btn', 'Click', false), 'BtnНажатие');
  });

  test('unknown event falls back to eventName appended to element name', () => {
    assert.strictEqual(generateHandlerName('El', 'UnknownEvent', false), 'ElUnknownEvent');
  });
});

suite('formEventCatalog — getDirective', () => {
  test('OnCreateAtServer returns &НаСервере', () => {
    assert.strictEqual(getDirective('OnCreateAtServer'), '&НаСервере');
  });

  test('OnOpen returns &НаКлиенте', () => {
    assert.strictEqual(getDirective('OnOpen'), '&НаКлиенте');
  });

  test('FillCheckProcessingAtServer returns &НаСервере', () => {
    assert.strictEqual(getDirective('FillCheckProcessingAtServer'), '&НаСервере');
  });

  test('Click returns &НаКлиенте', () => {
    assert.strictEqual(getDirective('Click'), '&НаКлиенте');
  });
});

suite('formEventCatalog — catalog completeness', () => {
  test('every FORM_LEVEL_EVENTS entry has a corresponding EVENT_RUSSIAN_SUFFIX entry', () => {
    const missing: string[] = [];
    for (const event of FORM_LEVEL_EVENTS) {
      if (!(event in EVENT_RUSSIAN_SUFFIX)) {
        missing.push(event);
      }
    }
    assert.deepStrictEqual(missing, [], `missing Russian suffixes: ${missing.join(', ')}`);
  });
});
