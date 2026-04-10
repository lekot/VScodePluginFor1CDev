/**
 * Unit tests for BslDebugSession pure helper functions.
 * Tests run without VS Code runtime (core suite / mocha TDD).
 */

import * as assert from 'assert';
import {
    makeExtKey,
    buildWorkspaceSnapshot,
    dapToRdbgBreakpoints,
} from '../../src/debug/bslDebugSession';
import { RdbgModuleId } from '../../src/debug/rdbg/rdbgTypes';
import { DebugProtocol } from '@vscode/debugprotocol';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeModuleId(objectId: string, propertyId: string, extensionName?: string): RdbgModuleId {
    return { objectId, propertyId, extensionName };
}

function makeDapBp(overrides: Partial<DebugProtocol.SourceBreakpoint>): DebugProtocol.SourceBreakpoint {
    return { line: 1, ...overrides };
}

// ---------------------------------------------------------------------------
// makeExtKey
// ---------------------------------------------------------------------------

suite('BslDebugSession — makeExtKey', () => {
    test('base configuration module gets empty extensionName prefix', () => {
        const mid = makeModuleId('obj-uuid-1', 'prop-uuid-A');
        assert.strictEqual(makeExtKey(mid), '|obj-uuid-1|prop-uuid-A');
    });

    test('extension module gets extensionName prefix', () => {
        const mid = makeModuleId('obj-uuid-1', 'prop-uuid-A', 'MyExt');
        assert.strictEqual(makeExtKey(mid), 'MyExt|obj-uuid-1|prop-uuid-A');
    });

    test('different extensionName → different keys for same obj/prop', () => {
        const base = makeModuleId('obj-1', 'prop-1');
        const ext = makeModuleId('obj-1', 'prop-1', 'ExtA');
        assert.notStrictEqual(makeExtKey(base), makeExtKey(ext));
    });

    test('same extensionName different objectId → different keys', () => {
        const a = makeModuleId('obj-1', 'prop-1', 'ExtA');
        const b = makeModuleId('obj-2', 'prop-1', 'ExtA');
        assert.notStrictEqual(makeExtKey(a), makeExtKey(b));
    });
});

// ---------------------------------------------------------------------------
// buildWorkspaceSnapshot
// ---------------------------------------------------------------------------

suite('BslDebugSession — buildWorkspaceSnapshot', () => {
    function makeEntry(objectId: string, lines: number[], extensionName?: string) {
        const moduleId = makeModuleId(objectId, 'prop-1', extensionName);
        return {
            source: `/path/to/${objectId}.bsl`,
            moduleId,
            bps: lines.map(lineNo => ({ moduleId, lineNo })),
        };
    }

    test('adding first entry returns its BPs in snapshot', () => {
        const state = new Map();
        const entry = makeEntry('obj-A', [10, 20]);
        const snapshot = buildWorkspaceSnapshot(state, '|obj-A|prop-1', entry);
        assert.strictEqual(snapshot.length, 2);
        assert.strictEqual(snapshot[0].lineNo, 10);
        assert.strictEqual(snapshot[1].lineNo, 20);
    });

    test('adding second entry in different extKey → snapshot contains both', () => {
        const state = new Map();
        const entryA = makeEntry('obj-A', [10]);
        const entryB = makeEntry('obj-B', [30, 40]);
        buildWorkspaceSnapshot(state, '|obj-A|prop-1', entryA);
        const snapshot = buildWorkspaceSnapshot(state, '|obj-B|prop-1', entryB);
        assert.strictEqual(snapshot.length, 3);
    });

    test('removing one entry → snapshot contains only the remaining', () => {
        const state = new Map();
        const entryA = makeEntry('obj-A', [10]);
        const entryB = makeEntry('obj-B', [30]);
        buildWorkspaceSnapshot(state, '|obj-A|prop-1', entryA);
        buildWorkspaceSnapshot(state, '|obj-B|prop-1', entryB);
        const snapshot = buildWorkspaceSnapshot(state, '|obj-A|prop-1', undefined);
        assert.strictEqual(snapshot.length, 1);
        assert.strictEqual(snapshot[0].lineNo, 30);
    });

    test('removing nonexistent key → snapshot unchanged', () => {
        const state = new Map();
        const entryA = makeEntry('obj-A', [10]);
        buildWorkspaceSnapshot(state, '|obj-A|prop-1', entryA);
        const snapshot = buildWorkspaceSnapshot(state, '|obj-GHOST|prop-1', undefined);
        assert.strictEqual(snapshot.length, 1);
    });

    test('re-adding same extKey replaces old BPs, no duplication', () => {
        const state = new Map();
        const entryA1 = makeEntry('obj-A', [10, 20]);
        const entryA2 = makeEntry('obj-A', [99]);
        buildWorkspaceSnapshot(state, '|obj-A|prop-1', entryA1);
        const snapshot = buildWorkspaceSnapshot(state, '|obj-A|prop-1', entryA2);
        assert.strictEqual(snapshot.length, 1);
        assert.strictEqual(snapshot[0].lineNo, 99);
    });

    test('empty state + remove = empty snapshot', () => {
        const state = new Map();
        const snapshot = buildWorkspaceSnapshot(state, '|obj-X|prop-1', undefined);
        assert.strictEqual(snapshot.length, 0);
    });
});

// ---------------------------------------------------------------------------
// dapToRdbgBreakpoints
// ---------------------------------------------------------------------------

suite('BslDebugSession — dapToRdbgBreakpoints', () => {
    const moduleId = makeModuleId('obj-uuid', 'prop-uuid');

    test('maps lineNo correctly', () => {
        const result = dapToRdbgBreakpoints(moduleId, [makeDapBp({ line: 42 })]);
        assert.strictEqual(result[0].lineNo, 42);
    });

    test('maps condition when non-empty', () => {
        const result = dapToRdbgBreakpoints(moduleId, [makeDapBp({ condition: 'x > 0' })]);
        assert.strictEqual(result[0].condition, 'x > 0');
    });

    test('does NOT set condition when empty string', () => {
        const result = dapToRdbgBreakpoints(moduleId, [makeDapBp({ condition: '' })]);
        assert.strictEqual(result[0].condition, undefined);
    });

    test('does NOT set condition when whitespace only', () => {
        const result = dapToRdbgBreakpoints(moduleId, [makeDapBp({ condition: '   ' })]);
        assert.strictEqual(result[0].condition, undefined);
    });

    test('maps logMessage when non-empty', () => {
        const result = dapToRdbgBreakpoints(moduleId, [makeDapBp({ logMessage: 'hit!' })]);
        assert.strictEqual(result[0].logMessage, 'hit!');
    });

    test('does NOT set logMessage when empty', () => {
        const result = dapToRdbgBreakpoints(moduleId, [makeDapBp({ logMessage: '' })]);
        assert.strictEqual(result[0].logMessage, undefined);
    });

    test('hitCondition plain integer → hitCount', () => {
        const result = dapToRdbgBreakpoints(moduleId, [makeDapBp({ hitCondition: '5' })]);
        assert.strictEqual(result[0].hitCount, 5);
    });

    test('hitCondition ">= 3" → hitCount 3', () => {
        const result = dapToRdbgBreakpoints(moduleId, [makeDapBp({ hitCondition: '>= 3' })]);
        assert.strictEqual(result[0].hitCount, 3);
    });

    test('hitCondition "> 3" → hitCount 4 (first pause after 3)', () => {
        const result = dapToRdbgBreakpoints(moduleId, [makeDapBp({ hitCondition: '> 3' })]);
        assert.strictEqual(result[0].hitCount, 4);
    });

    test('hitCondition "% 7" (multiple-of) → hitCount 7', () => {
        const result = dapToRdbgBreakpoints(moduleId, [makeDapBp({ hitCondition: '% 7' })]);
        assert.strictEqual(result[0].hitCount, 7);
    });

    test('hitCondition unparseable string → hitCount undefined (ignored)', () => {
        const result = dapToRdbgBreakpoints(moduleId, [makeDapBp({ hitCondition: 'abc' })]);
        assert.strictEqual(result[0].hitCount, undefined);
    });

    test('hitCondition empty string → hitCount undefined', () => {
        const result = dapToRdbgBreakpoints(moduleId, [makeDapBp({ hitCondition: '' })]);
        assert.strictEqual(result[0].hitCount, undefined);
    });

    test('CRITICAL OQ-8: hitCountVariant is NEVER set in any BP', () => {
        // Even when hitCondition is valid, hitCountVariant must not be set
        // (platform XSD would reject the string-union value in a decimal field)
        const result = dapToRdbgBreakpoints(moduleId, [
            makeDapBp({ hitCondition: '5' }),
            makeDapBp({ hitCondition: '>= 3' }),
            makeDapBp({ hitCondition: '> 3' }),
            makeDapBp({ hitCondition: '% 7' }),
        ]);
        for (const bp of result) {
            const bpRec = bp as unknown as Record<string, unknown>;
            assert.strictEqual(
                bpRec['hitCountVariant'],
                undefined,
                `hitCountVariant must be undefined, got: ${bpRec['hitCountVariant']}`
            );
        }
    });

    test('isActive is NEVER set (DAP SourceBreakpoint has no isActive field)', () => {
        const result = dapToRdbgBreakpoints(moduleId, [makeDapBp({ line: 10 })]);
        assert.strictEqual(result[0].isActive, undefined);
    });

    test('multiple breakpoints in one call are all converted', () => {
        const dapBps = [
            makeDapBp({ line: 1, condition: 'a > 0' }),
            makeDapBp({ line: 5, hitCondition: '10' }),
            makeDapBp({ line: 9, logMessage: 'log me' }),
        ];
        const result = dapToRdbgBreakpoints(moduleId, dapBps);
        assert.strictEqual(result.length, 3);
        assert.strictEqual(result[0].condition, 'a > 0');
        assert.strictEqual(result[1].hitCount, 10);
        assert.strictEqual(result[2].logMessage, 'log me');
    });

    test('empty input returns empty array', () => {
        const result = dapToRdbgBreakpoints(moduleId, []);
        assert.deepStrictEqual(result, []);
    });
});
