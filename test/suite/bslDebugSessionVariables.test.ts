/**
 * Unit tests for Phase 4 — Variables / Locals drilldown.
 *
 * Tests buildDapVariables (pure function) and ReferencesTable clear-on-continue
 * behaviour, without instantiating the full BslDebugSession (which depends on VS Code API).
 */
import * as assert from 'assert';
import { buildDapVariables, VariableRef } from '../../src/debug/bslDebugSession';
import { ReferencesTable } from '../../src/debug/referencesTable';
import { RdbgVariableNode } from '../../src/debug/rdbg/rdbgTypes';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<RdbgVariableNode> = {}): RdbgVariableNode {
    return {
        name: 'Переменная',
        typeName: 'Строка',
        value: 'значение',
        isExpandable: false,
        isIndexedCollection: false,
        ...overrides,
    };
}

function makeParent(overrides: Partial<VariableRef> = {}): VariableRef {
    return {
        threadId: 1,
        frameLevel: 0,
        path: [],
        view: 'context',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// buildDapVariables tests
// ---------------------------------------------------------------------------

suite('buildDapVariables — Phase 4', () => {

    test('empty children → empty array', () => {
        const table = new ReferencesTable<VariableRef>();
        const result = buildDapVariables(makeParent(), [], table);
        assert.deepStrictEqual(result, []);
        assert.strictEqual(table.size, 0);
    });

    test('non-expandable scalar → variablesReference=0', () => {
        const table = new ReferencesTable<VariableRef>();
        const node = makeNode({ name: 'Число', typeName: 'Число', value: '42', isExpandable: false, isIndexedCollection: false });
        const result = buildDapVariables(makeParent(), [node], table);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].variablesReference, 0);
        assert.ok(result[0].name.includes('Число'), 'name contains variable name');
        assert.strictEqual(result[0].value, '42');
    });

    test('expandable struct (context, non-indexed) → variablesReference > 0, path extended with property', () => {
        const table = new ReferencesTable<VariableRef>();
        const node = makeNode({ name: 'МояСтруктура', typeName: 'Структура', isExpandable: true, isIndexedCollection: false });
        const parent = makeParent({ path: [], view: 'context' });
        const result = buildDapVariables(parent, [node], table);
        assert.strictEqual(result.length, 1);
        assert.ok(result[0].variablesReference > 0, 'ref must be > 0 for expandable struct');

        const stored = table.get(result[0].variablesReference);
        assert.ok(stored !== undefined);
        assert.strictEqual(stored!.view, 'context');
        assert.strictEqual(stored!.path.length, 1);
        const step = stored!.path[0];
        assert.strictEqual(step.type, 'property');
        if (step.type === 'property') {
            assert.strictEqual(step.property, 'МояСтруктура');
        }
    });

    test('indexed collection node within context view → ref switches to view=collection', () => {
        const table = new ReferencesTable<VariableRef>();
        const node = makeNode({ name: 'МойМассив', typeName: 'Массив', isExpandable: true, isIndexedCollection: true });
        const parent = makeParent({ path: [], view: 'context' });
        const result = buildDapVariables(parent, [node], table);
        assert.ok(result[0].variablesReference > 0);
        const stored = table.get(result[0].variablesReference)!;
        assert.strictEqual(stored.view, 'collection', 'indexed collection switches to view=collection');
    });

    test('collection items in parent view=collection → each gets path with type=index', () => {
        const table = new ReferencesTable<VariableRef>();
        // parent is already in collection view (parent.view='collection')
        const parent = makeParent({ path: [{ type: 'expression', expression: 'x' }], view: 'collection' });
        // Each item is also an indexed collection (nested)
        const nodes = [
            makeNode({ name: '0', typeName: 'Массив', isExpandable: true, isIndexedCollection: true }),
            makeNode({ name: '1', typeName: 'Массив', isExpandable: true, isIndexedCollection: true }),
        ];
        const result = buildDapVariables(parent, nodes, table);
        assert.strictEqual(result.length, 2);
        assert.ok(result[0].variablesReference > 0);
        assert.ok(result[1].variablesReference > 0);

        const stored0 = table.get(result[0].variablesReference)!;
        assert.strictEqual(stored0.path[stored0.path.length - 1].type, 'index');
        const stored1 = table.get(result[1].variablesReference)!;
        assert.strictEqual(stored1.path[stored1.path.length - 1].type, 'index');
    });

    test('multiple nodes: references grow monotonically, non-expandables get 0', () => {
        const table = new ReferencesTable<VariableRef>();
        const parent = makeParent();
        const nodes = [
            makeNode({ name: 'Скаляр', isExpandable: false }),
            makeNode({ name: 'Структура', typeName: 'Структура', isExpandable: true, isIndexedCollection: false }),
            makeNode({ name: 'Скаляр2', isExpandable: false }),
            makeNode({ name: 'Массив', typeName: 'Массив', isExpandable: true, isIndexedCollection: true }),
        ];
        const result = buildDapVariables(parent, nodes, table);
        assert.strictEqual(result[0].variablesReference, 0);
        assert.ok(result[1].variablesReference > 0, 'Структура is expandable');
        assert.strictEqual(result[2].variablesReference, 0);
        assert.ok(result[3].variablesReference > 0, 'Массив is expandable');
        assert.ok(result[1].variablesReference < result[3].variablesReference, 'refs grow monotonically');
    });

    test('variable name format: "name (typeName)"', () => {
        const table = new ReferencesTable<VariableRef>();
        const node = makeNode({ name: 'МоёПоле', typeName: 'Дата' });
        const result = buildDapVariables(makeParent(), [node], table);
        assert.strictEqual(result[0].name, 'МоёПоле (Дата)');
    });

});

// ---------------------------------------------------------------------------
// ReferencesTable clear-on-continue behaviour (clear-by-predicate)
// ---------------------------------------------------------------------------

suite('ReferencesTable — clear by threadId (continued event simulation)', () => {

    test('_frameRefs: clear for thread 1 does not remove thread 2 entries', () => {
        const frameRefs = new ReferencesTable<{ threadId: number; frameLevel: number }>();
        frameRefs.add({ threadId: 1, frameLevel: 0 });
        frameRefs.add({ threadId: 1, frameLevel: 1 });
        const ref3 = frameRefs.add({ threadId: 2, frameLevel: 0 });
        assert.strictEqual(frameRefs.size, 3);

        // Simulate "continued" for thread 1
        frameRefs.clear(f => f.threadId === 1);
        assert.strictEqual(frameRefs.size, 1);
        // Thread 2 entry survives
        assert.ok(frameRefs.get(ref3) !== undefined);
    });

    test('_variableRefs: clear for thread 1 does not remove thread 2 entries', () => {
        const varRefs = new ReferencesTable<VariableRef>();
        varRefs.add(makeParent({ threadId: 1 }));
        varRefs.add(makeParent({ threadId: 1 }));
        const refT2 = varRefs.add(makeParent({ threadId: 2 }));
        assert.strictEqual(varRefs.size, 3);

        varRefs.clear(v => v.threadId === 1);
        assert.strictEqual(varRefs.size, 1);
        assert.ok(varRefs.get(refT2) !== undefined);
    });

    test('after clear, new ids do not collide with old ones', () => {
        const refs = new ReferencesTable<VariableRef>();
        refs.add(makeParent({ threadId: 1 }));
        const lastBefore = refs.add(makeParent({ threadId: 1 }));
        refs.clear(v => v.threadId === 1);
        const newRef = refs.add(makeParent({ threadId: 1 }));
        assert.ok(newRef > lastBefore, 'new ref after clear must exceed all previous refs');
    });

});
