import * as assert from 'assert';
import {
    stringConverter,
    numberConverter,
    booleanConverter,
} from '../../../src/rules/converters/primitiveConverters';
import { i8nTextConverter } from '../../../src/rules/converters/i8nTextConverter';
import { PropertyConverterRegistry } from '../../../src/rules/converters/PropertyConverterRegistry';
import { ConversionContext, MetadataPropertyRule } from '../../../src/rules/types';

const rule: MetadataPropertyRule = { type: 'string' };
const ctx: ConversionContext = { objectName: 'Test', objectType: 'Catalog', defaultLanguage: 'ru' };

suite('primitiveConverters', () => {
    suite('stringConverter', () => {
        test('toXml converts to string', () => {
            assert.strictEqual(stringConverter.toXml('hello', rule, ctx), 'hello');
            assert.strictEqual(stringConverter.toXml(42, rule, ctx), '42');
        });

        test('fromXml converts to string', () => {
            assert.strictEqual(stringConverter.fromXml('hello', rule, ctx), 'hello');
            assert.strictEqual(stringConverter.fromXml(undefined, rule, ctx), '');
            assert.strictEqual(stringConverter.fromXml(null, rule, ctx), '');
        });

        test('round-trip string value', () => {
            const original = 'SomeValue';
            const xmlVal = stringConverter.toXml(original, rule, ctx);
            const back = stringConverter.fromXml(xmlVal, rule, ctx);
            assert.strictEqual(back, original);
        });
    });

    suite('numberConverter', () => {
        test('toXml converts to number', () => {
            assert.strictEqual(numberConverter.toXml(42, rule, ctx), 42);
            assert.strictEqual(numberConverter.toXml('10', rule, ctx), 10);
        });

        test('fromXml converts to number', () => {
            assert.strictEqual(numberConverter.fromXml('42', rule, ctx), 42);
            assert.strictEqual(numberConverter.fromXml('abc', rule, ctx), 0);
            assert.strictEqual(numberConverter.fromXml(undefined, rule, ctx), 0);
        });

        test('round-trip number value', () => {
            const original = 7;
            const xmlVal = numberConverter.toXml(original, rule, ctx);
            const back = numberConverter.fromXml(xmlVal, rule, ctx);
            assert.strictEqual(back, original);
        });
    });

    suite('booleanConverter', () => {
        test('toXml converts boolean to string', () => {
            assert.strictEqual(booleanConverter.toXml(true, rule, ctx), 'true');
            assert.strictEqual(booleanConverter.toXml(false, rule, ctx), 'false');
        });

        test('fromXml parses string boolean', () => {
            assert.strictEqual(booleanConverter.fromXml('true', rule, ctx), true);
            assert.strictEqual(booleanConverter.fromXml('false', rule, ctx), false);
            assert.strictEqual(booleanConverter.fromXml(true, rule, ctx), true);
            assert.strictEqual(booleanConverter.fromXml(false, rule, ctx), false);
            assert.strictEqual(booleanConverter.fromXml('yes', rule, ctx), false);
        });

        test('round-trip boolean true', () => {
            const xmlVal = booleanConverter.toXml(true, rule, ctx);
            const back = booleanConverter.fromXml(xmlVal, rule, ctx);
            assert.strictEqual(back, true);
        });

        test('round-trip boolean false', () => {
            const xmlVal = booleanConverter.toXml(false, rule, ctx);
            const back = booleanConverter.fromXml(xmlVal, rule, ctx);
            assert.strictEqual(back, false);
        });
    });
});

suite('i8nTextConverter', () => {
    const i8nRule: MetadataPropertyRule = { type: 'I8nText' };

    test('fromXml with single ru item returns string', () => {
        const xmlValue = { 'v8:item': { 'v8:lang': 'ru', 'v8:content': 'Справочник товаров' } };
        const result = i8nTextConverter.fromXml(xmlValue, i8nRule, ctx);
        assert.strictEqual(result, 'Справочник товаров');
    });

    test('fromXml with multiple items returns record', () => {
        const xmlValue = {
            'v8:item': [
                { 'v8:lang': 'ru', 'v8:content': 'Справочник' },
                { 'v8:lang': 'en', 'v8:content': 'Catalog' },
            ],
        };
        const result = i8nTextConverter.fromXml(xmlValue, i8nRule, ctx);
        assert.deepStrictEqual(result, { ru: 'Справочник', en: 'Catalog' });
    });

    test('fromXml with null returns empty string', () => {
        const result = i8nTextConverter.fromXml(null, i8nRule, ctx);
        assert.strictEqual(result, '');
    });

    test('fromXml with undefined returns empty string', () => {
        const result = i8nTextConverter.fromXml(undefined, i8nRule, ctx);
        assert.strictEqual(result, '');
    });

    test('toXml with string returns v8:item object', () => {
        const result = i8nTextConverter.toXml('Товары', i8nRule, ctx) as Record<string, unknown>;
        assert.deepStrictEqual(result, {
            'v8:item': { 'v8:lang': 'ru', 'v8:content': 'Товары' },
        });
    });

    test('toXml with empty string returns empty object', () => {
        const result = i8nTextConverter.toXml('', i8nRule, ctx);
        assert.deepStrictEqual(result, {});
    });

    test('toXml with record returns array of v8:item', () => {
        const ir = { ru: 'Справочник', en: 'Catalog' };
        const result = i8nTextConverter.toXml(ir, i8nRule, ctx) as Record<string, unknown>;
        const items = result['v8:item'] as Array<Record<string, string>>;
        assert.ok(Array.isArray(items));
        assert.strictEqual(items.length, 2);
        const langs = items.map(i => i['v8:lang']).sort();
        assert.deepStrictEqual(langs, ['en', 'ru']);
    });

    test('toXml with empty object returns empty object', () => {
        const result = i8nTextConverter.toXml({}, i8nRule, ctx);
        assert.deepStrictEqual(result, {});
    });
});

suite('PropertyConverterRegistry', () => {
    test('get returns registered converter', () => {
        const registry = new PropertyConverterRegistry();
        registry.register('string', stringConverter);
        const got = registry.get('string');
        assert.strictEqual(got, stringConverter);
    });

    test('get throws for unknown type', () => {
        const registry = new PropertyConverterRegistry();
        assert.throws(
            () => registry.get('number'),
            (err: Error) => err.message === 'Unknown converter type: number',
        );
    });
});
