import * as assert from 'assert';
import * as path from 'path';

import { indexBslModuleSource, type BslModuleIdentity } from '../../../src/compareMerge/bsl/bslModuleIndexer';
import { scanBslRoutineLogicalOutline } from '../../../src/compareMerge/bsl/bslRoutineLogicalScanner';

suite('BslRoutineLogicalScanner', () => {
  test('recognizes supported Russian and English blocks', () => {
    const russian = scanSource([
      'Procedure Run()',
      '  Если Ready Тогда',
      '    Value = 1;',
      '  ИначеЕсли Maybe Тогда',
      '    Value = 2;',
      '  Иначе',
      '    Value = 3;',
      '  КонецЕсли;',
      '  Для каждого Item Из Items Цикл',
      '    Value = Item;',
      '  КонецЦикла;',
      '  Попытка',
      '    Value = 4;',
      '  Исключение',
      '    Value = 5;',
      '  КонецПопытки;',
      'EndProcedure',
    ]);
    const english = scanSource([
      'Procedure Run()',
      '  If Ready Then',
      '    Value = 1;',
      '  ElsIf Maybe Then',
      '    Value = 2;',
      '  Else',
      '    Value = 3;',
      '  EndIf;',
      '  For Each Item In Items Do',
      '    Value = Item;',
      '  EndDo;',
      '  While Ready Do',
      '    Value = 4;',
      '  EndDo;',
      '  Try',
      '    Value = 5;',
      '  Except',
      '    Value = 6;',
      '  EndTry;',
      'EndProcedure',
    ]);

    assert.strictEqual(russian.diagnostics.length, 0);
    assert.strictEqual(english.diagnostics.length, 0);
    assert.deepStrictEqual(
      russian.outline.sections[russian.outline.rootSectionId].nodes.map((node) => node.kind),
      ['if', 'loop', 'try']
    );
    assert.deepStrictEqual(
      english.outline.sections[english.outline.rootSectionId].nodes.map((node) => node.kind),
      ['if', 'loop', 'loop', 'try']
    );
  });

  test('builds nested if loop and try outline', () => {
    const result = scanSource([
      'Procedure Run()',
      '  If Ready Then',
      '    For Each Item In Items Do',
      '      Try',
      '        Value = Item;',
      '      Except',
      '        Value = 0;',
      '      EndTry;',
      '    EndDo;',
      '  EndIf;',
      'EndProcedure',
    ]);

    assert.strictEqual(result.diagnostics.length, 0);
    const rootNodes = result.outline.sections[result.outline.rootSectionId].nodes;
    const ifNode = rootNodes[0];
    const thenSection = result.outline.sections[ifNode.sections[0].id];
    const loopNode = thenSection.nodes[0];
    const loopSection = result.outline.sections[loopNode.sections[0].id];

    assert.strictEqual(ifNode.kind, 'if');
    assert.strictEqual(loopNode.kind, 'loop');
    assert.strictEqual(loopSection.nodes[0].kind, 'try');
  });

  test('marks preprocessor directive inside routine body as manual', () => {
    const result = scanSource([
      'Procedure Run()',
      '  #If Server Then',
      '  Value = 1;',
      '  #EndIf',
      'EndProcedure',
    ]);

    assert.deepStrictEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ['preprocessor-directive', 'preprocessor-directive']
    );
    assert.strictEqual(result.canAutoMerge, false);
  });

  test('marks one-line and compound syntax as manual', () => {
    const oneLine = scanSource([
      'Procedure Run()',
      '  If Ready Then Value = 1; EndIf;',
      'EndProcedure',
    ]);
    const oneLineElsIf = scanSource([
      'Procedure Run()',
      '  If Ready Then',
      '    Value = 1;',
      '  ElsIf Maybe Then Value = 2;',
      '  EndIf;',
      'EndProcedure',
    ]);
    const compound = scanSource(['Procedure Run()', '  A = 1; B = 2;', 'EndProcedure']);
    const elseBoundary = scanSource([
      'Procedure Run()',
      '  If Ready Then',
      '    A = 1;',
      '  Else B = 1;',
      '  EndIf;',
      'EndProcedure',
    ]);
    const exceptBoundary = scanSource([
      'Procedure Run()',
      '  Try',
      '    A = 1;',
      '  Except B = 1;',
      '  EndTry;',
      'EndProcedure',
    ]);
    const endBoundary = scanSource([
      'Procedure Run()',
      '  If Ready Then',
      '    A = 1;',
      '  EndIf; B = 1;',
      'EndProcedure',
    ]);

    assert.strictEqual(oneLine.canAutoMerge, false);
    assert.strictEqual(oneLineElsIf.canAutoMerge, false);
    assert.strictEqual(compound.canAutoMerge, false);
    assert.strictEqual(elseBoundary.canAutoMerge, false);
    assert.strictEqual(exceptBoundary.canAutoMerge, false);
    assert.strictEqual(endBoundary.canAutoMerge, false);
    assert.deepStrictEqual(
      oneLine.diagnostics.map((diagnostic) => diagnostic.code),
      ['one-line-block']
    );
    assert.deepStrictEqual(
      oneLineElsIf.diagnostics.map((diagnostic) => diagnostic.code),
      ['one-line-block']
    );
    assert.deepStrictEqual(
      compound.diagnostics.map((diagnostic) => diagnostic.code),
      ['compound-statement']
    );
    assert.deepStrictEqual(
      elseBoundary.diagnostics.map((diagnostic) => diagnostic.code),
      ['compound-statement']
    );
    assert.deepStrictEqual(
      exceptBoundary.diagnostics.map((diagnostic) => diagnostic.code),
      ['compound-statement']
    );
    assert.deepStrictEqual(
      endBoundary.diagnostics.map((diagnostic) => diagnostic.code),
      ['compound-statement']
    );
  });
});

function scanSource(lines: string[]) {
  const source = lines.join('\n');
  const module = indexBslModuleSource({
    identity: makeIdentity(),
    source,
  });
  const routine = module.routines[0];
  return scanBslRoutineLogicalOutline({ source, routine });
}

function makeIdentity(): BslModuleIdentity {
  return {
    sourceId: 'scanner',
    side: 'left',
    filePath: path.join('root', 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl'),
    configRoot: 'root',
    metadataType: 'Catalog',
    objectName: 'Products',
    moduleKind: 'Object',
    moduleId: 'Catalog.Products.Object',
    displayName: 'Catalog.Products.Object',
  };
}
