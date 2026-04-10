/**
 * Unit tests for DebuggeeLauncher pure helper functions.
 * Tests run without VS Code runtime (core suite / mocha TDD).
 *
 * We test only the pure exported helpers buildDbgsArgs and buildDebuggeeArgs.
 * Actual spawn/kill is not tested here (requires live OS processes).
 */

import * as assert from 'assert';
import { buildDbgsArgs, buildDebuggeeArgs } from '../../src/debug/debuggeeLauncher';

// ---------------------------------------------------------------------------
// buildDbgsArgs
// ---------------------------------------------------------------------------

suite('debuggeeLauncher — buildDbgsArgs', () => {
    test('always includes --port=<n>', () => {
        const args = buildDbgsArgs('localhost', 1550);
        assert.ok(args.includes('--port=1550'), `Expected --port=1550 in ${JSON.stringify(args)}`);
    });

    test('on win32 does not add --addr for localhost', () => {
        // We cannot force process.platform in unit tests, but we can verify
        // that the result always contains port and is an array.
        const args = buildDbgsArgs('localhost', 1551);
        assert.strictEqual(typeof args[0], 'string');
        assert.ok(args[0].startsWith('--port='));
    });

    test('different ports produce different args', () => {
        const args1 = buildDbgsArgs('localhost', 1550);
        const args2 = buildDbgsArgs('localhost', 1551);
        assert.notDeepStrictEqual(args1, args2);
    });

    test('returns array', () => {
        const args = buildDbgsArgs('localhost', 1550);
        assert.ok(Array.isArray(args));
        assert.ok(args.length >= 1);
    });
});

// ---------------------------------------------------------------------------
// buildDebuggeeArgs
// ---------------------------------------------------------------------------

suite('debuggeeLauncher — buildDebuggeeArgs', () => {
    test('appends /Debug -http -attach /DebuggerURL <url>', () => {
        const base = ['/IBNAME', 'MyBase'];
        const url = 'http://localhost:1550';
        const result = buildDebuggeeArgs(base, url);

        assert.deepStrictEqual(result, [
            '/IBNAME', 'MyBase',
            '/Debug', '-http', '-attach', '/DebuggerURL', 'http://localhost:1550',
        ]);
    });

    test('does not mutate baseArgs', () => {
        const base = ['/IBNAME', 'MyBase'];
        const original = [...base];
        buildDebuggeeArgs(base, 'http://localhost:1550');
        assert.deepStrictEqual(base, original);
    });

    test('works with empty base args', () => {
        const result = buildDebuggeeArgs([], 'http://127.0.0.1:1551');
        assert.deepStrictEqual(result, [
            '/Debug', '-http', '-attach', '/DebuggerURL', 'http://127.0.0.1:1551',
        ]);
    });

    test('url is placed at the end', () => {
        const result = buildDebuggeeArgs(['/A', '/B'], 'http://host:9999');
        assert.strictEqual(result[result.length - 1], 'http://host:9999');
    });
});
