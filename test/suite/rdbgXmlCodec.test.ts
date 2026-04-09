/**
 * Unit tests for rdbgXmlCodec — encoders and decoders.
 *
 * Encode tests: snapshot comparison against fixtures in test/fixtures/rdbg/.
 * Fixtures are "baseline snapshots" of current encoder output, NOT platform references.
 * They lock the current output so future edits don't silently change the wire format.
 *
 * Decode tests: assert on parsed field values from realistic XML fixtures.
 *
 * UUID strategy:
 *   - All encode tests use fixed UUID constants so snapshots are deterministic.
 *   - encodeEvaluate and encodeEvalLocalVariables generate UUIDs internally via crypto.randomUUID().
 *     sinon is not available. These tests use contains/regex assertions (approach b).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import {
  encodeAttachDebugUI,
  encodeDetachDebugUI,
  encodePing,
  encodeInitSettings,
  encodeGetTargets,
  encodeSetBreakpoints,
  encodeStep,
  encodeContinue,
  encodeGetCallStack,
  encodeEvalLocalVariables,
  encodeEvaluate,
  encodeAttachTargets,
  decodeTargets,
  decodeBreakpoints,
  decodeCallStack,
  decodeVariables,
  decodeEvalResult,
  decodePingEvents,
} from '../../src/debug/rdbg/rdbgXmlCodec';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collapse all whitespace runs to a single space and trim. Used for snapshot comparison. */
function normalizeXml(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Read a fixture file from test/fixtures/rdbg/ */
function readFixture(name: string): string {
  const fixturePath = path.resolve(__dirname, '../../..', 'test/fixtures/rdbg', name);
  return fs.readFileSync(fixturePath, 'utf8');
}

// ---------------------------------------------------------------------------
// Fixed constants for deterministic encode tests
// ---------------------------------------------------------------------------

const DBG_UI_ID  = 'aaaaaaaa-0000-0000-0000-000000000001';
const TARGET_ID  = 'bbbbbbbb-0000-0000-0000-000000000001';
const SEANCE_ID  = 'cccccccc-0000-0000-0000-000000000001';

const MOD1 = {
  objectId:   '11111111-0000-0000-0000-000000000001',
  propertyId: '22222222-0000-0000-0000-000000000001',
};
const MOD2 = {
  objectId:   '33333333-0000-0000-0000-000000000001',
  propertyId: '44444444-0000-0000-0000-000000000001',
};
const MOD_EXT = {
  objectId:      '55555555-0000-0000-0000-000000000001',
  propertyId:    '66666666-0000-0000-0000-000000000001',
  extensionName: 'MyExtension',
};

// ---------------------------------------------------------------------------
// ENCODERS
// ---------------------------------------------------------------------------

suite('rdbgXmlCodec — encoders', () => {

  suite('encodeSetBreakpoints', () => {
    test('single bp single module — snapshot', () => {
      const actual = encodeSetBreakpoints(DBG_UI_ID, [{ moduleId: MOD1, lineNo: 10 }]);
      const expected = readFixture('setBreakpoints-single.xml');
      assert.strictEqual(normalizeXml(actual), normalizeXml(expected));
    });

    test('multi-module (two modules + two lines in first) — snapshot', () => {
      const bps = [
        { moduleId: MOD1, lineNo: 10 },
        { moduleId: MOD1, lineNo: 20 },
        { moduleId: MOD2, lineNo: 5 },
      ];
      const actual = encodeSetBreakpoints(DBG_UI_ID, bps);
      const expected = readFixture('setBreakpoints-multi-module.xml');
      assert.strictEqual(normalizeXml(actual), normalizeXml(expected));
    });

    test('with extensionName — extensionName element present in XML', () => {
      const actual = encodeSetBreakpoints(DBG_UI_ID, [{ moduleId: MOD_EXT, lineNo: 15 }]);
      const expected = readFixture('setBreakpoints-with-extension.xml');
      assert.strictEqual(normalizeXml(actual), normalizeXml(expected));
    });

    test('empty breakpoints array — no bpWorkspace element', () => {
      const xml = encodeSetBreakpoints(DBG_UI_ID, []);
      assert.ok(!xml.includes('bpWorkspace'), 'bpWorkspace should be absent for empty BP list');
    });
  });

  suite('encodeStep', () => {
    // OQ-2: snapshot baseline; field set may need extension if stricter platform versions reject
    // this minimal request (no simple/triggeredTargetID fields). Escalation to P1C3 follow-up
    // NOT required — these fields will be added at the first real breakage.

    test('step-over — snapshot (OQ-2 baseline)', () => {
      const actual = encodeStep(DBG_UI_ID, TARGET_ID, SEANCE_ID, 'over');
      const expected = readFixture('step-over.xml');
      assert.strictEqual(normalizeXml(actual), normalizeXml(expected));
    });

    test('step-into — snapshot', () => {
      const actual = encodeStep(DBG_UI_ID, TARGET_ID, SEANCE_ID, 'into');
      const expected = readFixture('step-into.xml');
      assert.strictEqual(normalizeXml(actual), normalizeXml(expected));
    });

    test('step-out — snapshot', () => {
      const actual = encodeStep(DBG_UI_ID, TARGET_ID, SEANCE_ID, 'out');
      const expected = readFixture('step-out.xml');
      assert.strictEqual(normalizeXml(actual), normalizeXml(expected));
    });

    test('step action values: over→Step, into→StepIn, out→StepOut', () => {
      assert.ok(encodeStep(DBG_UI_ID, TARGET_ID, SEANCE_ID, 'over').includes('>Step<'),   'over → Step');
      assert.ok(encodeStep(DBG_UI_ID, TARGET_ID, SEANCE_ID, 'into').includes('>StepIn<'), 'into → StepIn');
      assert.ok(encodeStep(DBG_UI_ID, TARGET_ID, SEANCE_ID, 'out').includes('>StepOut<'), 'out → StepOut');
    });
  });

  suite('encodeContinue', () => {
    test('continue — snapshot', () => {
      const actual = encodeContinue(DBG_UI_ID, TARGET_ID, SEANCE_ID);
      const expected = readFixture('step-continue.xml');
      assert.strictEqual(normalizeXml(actual), normalizeXml(expected));
    });

    test('uses RDBGStepRequest with action Continue', () => {
      const xml = encodeContinue(DBG_UI_ID, TARGET_ID, SEANCE_ID);
      assert.ok(xml.includes('RDBGStepRequest'), 'uses RDBGStepRequest element');
      assert.ok(xml.includes('>Continue<'),      'action is Continue');
    });
  });

  suite('encodeGetCallStack', () => {
    test('getCallStack — snapshot', () => {
      const actual = encodeGetCallStack(DBG_UI_ID, TARGET_ID, SEANCE_ID);
      const expected = readFixture('getCallStack.xml');
      assert.strictEqual(normalizeXml(actual), normalizeXml(expected));
    });

    test('uses RDBGGetCallStackRequest', () => {
      assert.ok(encodeGetCallStack(DBG_UI_ID, TARGET_ID, SEANCE_ID).includes('RDBGGetCallStackRequest'));
    });
  });

  suite('encodeAttachDebugUI', () => {
    test('attach — snapshot', () => {
      const actual = encodeAttachDebugUI(DBG_UI_ID);
      const expected = readFixture('attach.xml');
      assert.strictEqual(normalizeXml(actual), normalizeXml(expected));
    });

    test('uses RDBGAttachDebugUIRequest', () => {
      assert.ok(encodeAttachDebugUI(DBG_UI_ID).includes('RDBGAttachDebugUIRequest'));
    });
  });

  suite('encodeDetachDebugUI', () => {
    test('detach — snapshot', () => {
      const actual = encodeDetachDebugUI(DBG_UI_ID);
      const expected = readFixture('detach.xml');
      assert.strictEqual(normalizeXml(actual), normalizeXml(expected));
    });
  });

  suite('encodeGetTargets', () => {
    test('getTargets — snapshot', () => {
      const actual = encodeGetTargets(DBG_UI_ID);
      const expected = readFixture('getTargets.xml');
      assert.strictEqual(normalizeXml(actual), normalizeXml(expected));
    });

    test('uses RDBGGetDbgTargetsRequest', () => {
      assert.ok(encodeGetTargets(DBG_UI_ID).includes('RDBGGetDbgTargetsRequest'));
    });
  });

  suite('encodeAttachTargets', () => {
    test('attachTargets — snapshot', () => {
      const actual = encodeAttachTargets(DBG_UI_ID, [{ id: TARGET_ID, seanceId: SEANCE_ID }], true);
      const expected = readFixture('attachTargets.xml');
      assert.strictEqual(normalizeXml(actual), normalizeXml(expected));
    });

    test('detachTargets — snapshot', () => {
      const actual = encodeAttachTargets(DBG_UI_ID, [{ id: TARGET_ID, seanceId: SEANCE_ID }], false);
      const expected = readFixture('detachTargets.xml');
      assert.strictEqual(normalizeXml(actual), normalizeXml(expected));
    });

    test('attach flag true → <attach>true</attach>', () => {
      const xml = encodeAttachTargets(DBG_UI_ID, [{ id: TARGET_ID, seanceId: SEANCE_ID }], true);
      assert.ok(xml.includes('>true<'), 'attach=true present');
    });

    test('attach flag false → <attach>false</attach>', () => {
      const xml = encodeAttachTargets(DBG_UI_ID, [{ id: TARGET_ID, seanceId: SEANCE_ID }], false);
      assert.ok(xml.includes('>false<'), 'attach=false present');
    });

    test('uses RDBGAttachDetachDebugTargetsRequest', () => {
      const xml = encodeAttachTargets(DBG_UI_ID, [], true);
      assert.ok(xml.includes('RDBGAttachDetachDebugTargetsRequest'));
    });
  });

  suite('encodePing', () => {
    test('ping — snapshot', () => {
      const actual = encodePing(DBG_UI_ID);
      const expected = readFixture('ping.xml');
      assert.strictEqual(normalizeXml(actual), normalizeXml(expected));
    });

    test('uses RDBGPingDebugUIRequest', () => {
      assert.ok(encodePing(DBG_UI_ID).includes('RDBGPingDebugUIRequest'));
    });
  });

  suite('encodeInitSettings', () => {
    // OQ-3: snapshot baseline — encodeInitSettings emits only infoBaseAlias + idOfDebuggerUI.
    // akpaevj reference may expect additional fields (autoAttachSettings etc).
    // This test locks the current minimal output. Will be extended if platform rejects it.

    test('initSettings — snapshot (OQ-3 baseline)', () => {
      const actual = encodeInitSettings(DBG_UI_ID);
      const expected = readFixture('initSettings.xml');
      assert.strictEqual(normalizeXml(actual), normalizeXml(expected));
    });

    test('uses RDBGSetInitialDebugSettingsRequest', () => {
      assert.ok(encodeInitSettings(DBG_UI_ID).includes('RDBGSetInitialDebugSettingsRequest'));
    });
  });

  suite('encodeEvalLocalVariables (approach b — contains assertions, UUIDs internal)', () => {
    test('snapshot — snapshot', () => {
      const actual = encodeEvalLocalVariables(DBG_UI_ID, TARGET_ID, SEANCE_ID, 0);
      const expected = readFixture('evalLocalVariables.xml');
      // UUIDs are deterministic because encodeEvalLocalVariables does NOT generate UUIDs internally
      assert.strictEqual(normalizeXml(actual), normalizeXml(expected));
    });

    test('contains calcWaitingTime 100', () => {
      const xml = encodeEvalLocalVariables(DBG_UI_ID, TARGET_ID, SEANCE_ID, 0);
      assert.ok(xml.includes('>100<'), 'calcWaitingTime=100 present');
    });

    test('contains stackLevel 0', () => {
      const xml = encodeEvalLocalVariables(DBG_UI_ID, TARGET_ID, SEANCE_ID, 0);
      assert.ok(xml.includes(':stackLevel>0<'), 'stackLevel=0 present with namespace prefix');
    });
  });

  suite('encodeEvaluate (approach b — contains assertions, UUIDs generated internally)', () => {
    test('contains expression in XML', () => {
      const xml = encodeEvaluate(DBG_UI_ID, TARGET_ID, SEANCE_ID, 'СтрокаКоличества', 0);
      assert.ok(xml.includes('СтрокаКоличества'), 'expression text present');
    });

    test('contains expressionID and expressionResultID elements', () => {
      const xml = encodeEvaluate(DBG_UI_ID, TARGET_ID, SEANCE_ID, 'x', 0);
      assert.ok(xml.includes('expressionID'),       'expressionID present');
      assert.ok(xml.includes('expressionResultID'), 'expressionResultID present');
    });

    test('contains srcCalcInfo with context interfaces', () => {
      const xml = encodeEvaluate(DBG_UI_ID, TARGET_ID, SEANCE_ID, 'x', 0);
      assert.ok(xml.includes('srcCalcInfo'), 'srcCalcInfo present');
      assert.ok(xml.includes('>context<'),   'interfaces=context present');
    });

    test('contains itemType=expression', () => {
      const xml = encodeEvaluate(DBG_UI_ID, TARGET_ID, SEANCE_ID, 'x', 0);
      assert.ok(xml.includes('>expression<'), 'itemType=expression present');
    });

    test('escapes XML special chars in expression', () => {
      const xml = encodeEvaluate(DBG_UI_ID, TARGET_ID, SEANCE_ID, 'a<b&c', 0);
      assert.ok(xml.includes('a&lt;b&amp;c'), 'special chars escaped');
    });
  });

});

// ---------------------------------------------------------------------------
// DECODERS
// ---------------------------------------------------------------------------

suite('rdbgXmlCodec — decoders', () => {

  suite('decodeTargets', () => {
    test('parses two targets from getTargets-response.xml', () => {
      const xml = readFixture('getTargets-response.xml');
      const targets = decodeTargets(xml);
      assert.strictEqual(targets.length, 2);

      const t1 = targets[0];
      assert.strictEqual(t1.id,       '13df3ee2-367c-4c50-9392-5be102ebd1e2');
      assert.strictEqual(t1.seanceId, '828dde1f-247a-4ead-9284-a3fdb21e6750');
      assert.ok(t1.userName.includes('Администратор'));
      assert.strictEqual(t1.infobaseAlias, 'DefAlias');

      const t2 = targets[1];
      assert.strictEqual(t2.id, '22222222-367c-4c50-9392-5be102ebd1e2');
    });

    test('returns empty array for empty XML', () => {
      const targets = decodeTargets('<response xmlns="http://v8.1c.ru/8.3/debugger/debugBaseData"></response>');
      assert.deepStrictEqual(targets, []);
    });
  });

  suite('decodeCallStack', () => {
    test('parses two frames from getCallStack-response.xml', () => {
      const xml = readFixture('getCallStack-response.xml');
      const frames = decodeCallStack(xml);
      assert.strictEqual(frames.length, 2);

      const f1 = frames[0];
      assert.strictEqual(f1.moduleId.objectId,   '498ce97d-6689-44e1-a350-7d98de25218c');
      assert.strictEqual(f1.moduleId.propertyId, 'd22e852a-cf8a-4f77-8ccb-3548e7792bea');
      assert.strictEqual(f1.lineNo, 42);
      assert.strictEqual(f1.presentation, 'Привет мир'); // NDI= decodes to "42", 0J/... decodes to "Привет мир"

      const f2 = frames[1];
      assert.strictEqual(f2.lineNo, 10);
    });

    test('returns empty array for empty body', () => {
      assert.deepStrictEqual(decodeCallStack(''), []);
    });
  });

  suite('decodeEvalResult', () => {
    test('decodes successful result with pres base64 — value is "42", typeName is "Число"', () => {
      const xml = readFixture('evalExpr-response-simple.xml');
      const result = decodeEvalResult(xml);
      assert.strictEqual(result.value,      '42');
      assert.strictEqual(result.typeName,   'Число');
      assert.strictEqual(result.isExpandable, false);
      assert.strictEqual(result.error, undefined);
    });

    test('decodes error result — errorOccurred=true, error field is decoded text', () => {
      const xml = readFixture('evalExpr-response-error.xml');
      const result = decodeEvalResult(xml);
      assert.strictEqual(result.error, 'Ошибка выражения');
      assert.strictEqual(result.value, '');
    });
  });

  suite('decodeVariables', () => {
    test('parses two local variables from evalLocalVariables-response.xml', () => {
      const xml = readFixture('evalLocalVariables-response.xml');
      const vars = decodeVariables(xml);
      assert.strictEqual(vars.length, 2);

      const v1 = vars[0];
      assert.strictEqual(v1.name,     'СтрокаКоличества');
      assert.strictEqual(v1.typeName, 'Число');
      assert.strictEqual(v1.value,    '42'); // NDI= decoded

      const v2 = vars[1];
      assert.strictEqual(v2.name,     'ТекстПеременной');
      assert.strictEqual(v2.typeName, 'Строка');
      assert.strictEqual(v2.value,    'Привет мир'); // 0J/... decoded
    });

    test('returns empty array for empty XML', () => {
      assert.deepStrictEqual(decodeVariables(''), []);
    });
  });

  suite('parseModuleId (via decodeCallStack)', () => {
    test('parses objectId and propertyId', () => {
      const xml = readFixture('getCallStack-response.xml');
      const frames = decodeCallStack(xml);
      assert.ok(frames.length > 0);
      assert.strictEqual(frames[0].moduleId.objectId,   '498ce97d-6689-44e1-a350-7d98de25218c');
      assert.strictEqual(frames[0].moduleId.propertyId, 'd22e852a-cf8a-4f77-8ccb-3548e7792bea');
    });

    test('extensionName is undefined when absent', () => {
      const xml = readFixture('getCallStack-response.xml');
      const frames = decodeCallStack(xml);
      assert.strictEqual(frames[0].moduleId.extensionName, undefined);
    });

    test('extensionName is present when set — via ping target-started BP fixture', () => {
      // Build a minimal getCallStack response with extensionName in moduleID
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<response xmlns="http://v8.1c.ru/8.3/debugger/debugBaseData"
          xmlns:debugRDBGRequestResponse="http://v8.1c.ru/8.3/debugger/debugRDBGRequestResponse">
  <debugRDBGRequestResponse:callStack>
    <moduleID>
      <objectID>11111111-0000-0000-0000-000000000001</objectID>
      <propertyID>22222222-0000-0000-0000-000000000001</propertyID>
      <extensionName>MyExtension</extensionName>
    </moduleID>
    <lineNo>7</lineNo>
    <presentation>NDI=</presentation>
  </debugRDBGRequestResponse:callStack>
</response>`;
      const frames = decodeCallStack(xml);
      assert.strictEqual(frames.length, 1);
      assert.strictEqual(frames[0].moduleId.extensionName, 'MyExtension');
    });
  });

  suite('decodePingEvents', () => {
    test('empty body → empty array', () => {
      assert.deepStrictEqual(decodePingEvents(''), []);
      assert.deepStrictEqual(decodePingEvents('   '), []);
    });

    test('CallStackFormed with stopByBP=true → stopped breakpoint event', () => {
      const xml = readFixture('ping-response-callStack-formed.xml');
      const events = decodePingEvents(xml);
      assert.strictEqual(events.length, 1);
      const ev = events[0];
      assert.strictEqual(ev.type, 'stopped');
      if (ev.type === 'stopped') {
        assert.strictEqual(ev.reason, 'breakpoint');
        assert.strictEqual(ev.targetId, '13df3ee2-367c-4c50-9392-5be102ebd1e2');
        assert.ok(ev.callStack && ev.callStack.length > 0, 'callStack present');
        assert.strictEqual(ev.callStack![0].lineNo, 42);
      }
    });

    test('CallStackFormed with stopByBP=false → stopped step event', () => {
      // Build inline fixture with stopByBP=false
      const xml = readFixture('ping-response-callStack-formed.xml')
        .replace('>true<', '>false<');
      const events = decodePingEvents(xml);
      assert.strictEqual(events.length, 1);
      const ev = events[0];
      assert.strictEqual(ev.type, 'stopped');
      if (ev.type === 'stopped') {
        assert.strictEqual(ev.reason, 'step');
      }
    });

    test('Rte → runtimeError with plain-text descr "Деление на ноль"', () => {
      const xml = readFixture('ping-response-rte.xml');
      const events = decodePingEvents(xml);
      assert.strictEqual(events.length, 1);
      const ev = events[0];
      assert.strictEqual(ev.type, 'runtimeError');
      if (ev.type === 'runtimeError') {
        assert.strictEqual(ev.error.description, 'Деление на ноль');
        assert.strictEqual(ev.error.lineNo, 55);
        assert.strictEqual(ev.error.moduleId.objectId, '498ce97d-6689-44e1-a350-7d98de25218c');
      }
    });

    test('TargetStarted → targetStarted event with target.id', () => {
      const xml = readFixture('ping-response-target-started.xml');
      const events = decodePingEvents(xml);
      assert.strictEqual(events.length, 1);
      const ev = events[0];
      assert.strictEqual(ev.type, 'targetStarted');
      if (ev.type === 'targetStarted') {
        assert.strictEqual(ev.target.id, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      }
    });

    test('TargetQuit → targetQuit event with targetId', () => {
      const xml = readFixture('ping-response-target-quit.xml');
      const events = decodePingEvents(xml);
      assert.strictEqual(events.length, 1);
      const ev = events[0];
      assert.strictEqual(ev.type, 'targetQuit');
      if (ev.type === 'targetQuit') {
        assert.strictEqual(ev.targetId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      }
    });

    test('ExprEvaluated → expressionEvaluated with decoded value "42"', () => {
      const xml = readFixture('ping-response-expr-evaluated.xml');
      const events = decodePingEvents(xml);
      assert.strictEqual(events.length, 1);
      const ev = events[0];
      assert.strictEqual(ev.type, 'expressionEvaluated');
      if (ev.type === 'expressionEvaluated') {
        assert.strictEqual(ev.result.value,    '42');
        assert.strictEqual(ev.result.typeName, 'Число');
        assert.strictEqual(ev.result.error,    undefined);
      }
    });

    test('multiple events in one payload — two events returned', () => {
      const xml = readFixture('ping-response-multi-events.xml');
      const events = decodePingEvents(xml);
      assert.strictEqual(events.length, 2, 'two events expected');
      assert.strictEqual(events[0].type, 'targetStarted');
      assert.strictEqual(events[1].type, 'stopped');
    });
  });

  suite('decodeBreakpoints', () => {
    test('returns empty for response without bpWorkspace', () => {
      const xml = '<response xmlns="http://v8.1c.ru/8.3/debugger/debugBaseData"></response>';
      const bps = decodeBreakpoints(xml);
      assert.deepStrictEqual(bps, []);
    });

    test('parses moduleBPInfo with bpInfo line and isActive', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<response xmlns="http://v8.1c.ru/8.3/debugger/debugBaseData"
          xmlns:debugRDBGRequestResponse="http://v8.1c.ru/8.3/debugger/debugRDBGRequestResponse">
  <debugRDBGRequestResponse:bpWorkspace>
    <moduleBPInfo>
      <id>
        <objectID>11111111-0000-0000-0000-000000000001</objectID>
        <propertyID>22222222-0000-0000-0000-000000000001</propertyID>
      </id>
      <bpInfo>
        <line>42</line>
        <isActive>true</isActive>
      </bpInfo>
    </moduleBPInfo>
  </debugRDBGRequestResponse:bpWorkspace>
</response>`;
      const bps = decodeBreakpoints(xml);
      assert.strictEqual(bps.length, 1);
      assert.strictEqual(bps[0].lineNo, 42);
      assert.strictEqual(bps[0].enabled, true);
      assert.strictEqual(bps[0].moduleId.objectId, '11111111-0000-0000-0000-000000000001');
    });
  });

});
