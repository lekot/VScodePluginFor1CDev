import * as assert from 'assert';
import {
  QueryMetadataNode,
  TempTableDefinition,
  VirtualTableParamDefinition,
} from '../../../src/queryBuilder/metadata/queryMetadataTypes';
import { getStandardAttributes } from '../../../src/queryBuilder/metadata/standardAttributesCatalog';
import { getVirtualTables } from '../../../src/queryBuilder/metadata/virtualTablesCatalog';
import { QueryMetadataProvider } from '../../../src/queryBuilder/metadata/queryMetadataProvider';
import { MetadataType, TreeNode } from '../../../src/models/treeNode';

suite('Query Metadata Provider (Synthetic Metadata Layer)', () => {
  suite('1. Standard Attributes Catalog (getStandardAttributes)', () => {
    test('Catalog: returns default standard attributes', () => {
      const attrs = getStandardAttributes('Catalog');
      const names = attrs.map((a: QueryMetadataNode) => a.name);
      assert.deepStrictEqual(names, [
        'Ссылка',
        'ПометкаУдаления',
        'Предопределенный',
        'Код',
        'Наименование',
        'Родитель',
        'Владелец',
        'ЭтоГруппа',
      ]);

      for (const attr of attrs) {
        assert.strictEqual(attr.nodeType, 'field');
        assert.strictEqual(attr.label, attr.name);
        assert.ok(attr.id.includes(attr.name));
      }
    });

    test('Catalog: respects isHierarchical = false by excluding Родитель and ЭтоГруппа', () => {
      const attrs = getStandardAttributes('Catalog', { isHierarchical: false });
      const names = attrs.map((a: QueryMetadataNode) => a.name);
      assert.deepStrictEqual(names, [
        'Ссылка',
        'ПометкаУдаления',
        'Предопределенный',
        'Код',
        'Наименование',
        'Владелец',
      ]);
    });

    test('Document: returns standard attributes', () => {
      const attrs = getStandardAttributes('Document');
      const names = attrs.map((a: QueryMetadataNode) => a.name);
      assert.deepStrictEqual(names, [
        'Ссылка',
        'ПометкаУдаления',
        'Дата',
        'Номер',
        'Проведен',
      ]);
    });

    test('ChartOfCharacteristicTypes: returns standard attributes', () => {
      const attrs = getStandardAttributes('ChartOfCharacteristicTypes');
      const names = attrs.map((a: QueryMetadataNode) => a.name);
      assert.deepStrictEqual(names, [
        'Ссылка',
        'ПометкаУдаления',
        'Предопределенный',
        'Код',
        'Наименование',
        'Родитель',
        'ЭтоГруппа',
      ]);
    });

    test('ChartOfAccounts: returns standard attributes', () => {
      const attrs = getStandardAttributes('ChartOfAccounts');
      const names = attrs.map((a: QueryMetadataNode) => a.name);
      assert.deepStrictEqual(names, [
        'Ссылка',
        'ПометкаУдаления',
        'Код',
        'Наименование',
        'Родитель',
        'Вид',
      ]);
    });

    test('InformationRegister: returns standard attributes for periodic register', () => {
      const attrs = getStandardAttributes('InformationRegister');
      const names = attrs.map((a: QueryMetadataNode) => a.name);
      assert.deepStrictEqual(names, [
        'Период',
        'Регистратор',
        'НомерСтроки',
        'Активность',
      ]);
    });

    test('InformationRegister: returns empty standard attributes when isPeriodic = false', () => {
      const attrs = getStandardAttributes('InformationRegister', { isPeriodic: false });
      const names = attrs.map((a: QueryMetadataNode) => a.name);
      assert.deepStrictEqual(names, []);
    });

    test('AccumulationRegister: returns standard attributes', () => {
      const attrs = getStandardAttributes('AccumulationRegister');
      const names = attrs.map((a: QueryMetadataNode) => a.name);
      assert.deepStrictEqual(names, [
        'Период',
        'Регистратор',
        'НомерСтроки',
        'Активность',
        'ВидДвижения',
      ]);
    });

    test('AccountingRegister: returns standard attributes', () => {
      const attrs = getStandardAttributes('AccountingRegister');
      const names = attrs.map((a: QueryMetadataNode) => a.name);
      assert.deepStrictEqual(names, [
        'Период',
        'Регистратор',
        'НомерСтроки',
        'Активность',
        'СчетДт',
        'СчетКт',
      ]);
    });

    test('TabularSection: returns standard attributes', () => {
      const attrs = getStandardAttributes('TabularSection');
      const names = attrs.map((a: QueryMetadataNode) => a.name);
      assert.deepStrictEqual(names, ['НомерСтроки', 'Ссылка']);
    });

    test('supports Russian names for metadata types (Справочник, Документ, etc.)', () => {
      const catAttrs = getStandardAttributes('Справочник');
      assert.strictEqual(catAttrs.length, 8);
      const docAttrs = getStandardAttributes('Документ');
      assert.strictEqual(docAttrs.length, 5);
      const regAttrs = getStandardAttributes('РегистрНакопления');
      assert.strictEqual(regAttrs.length, 5);
    });

    test('supports custom parentId and parentFullName', () => {
      const attrs = getStandardAttributes('Catalog', {
        parentId: 'Catalog.Товары',
        parentFullName: 'Справочник.Товары',
      });
      const refAttr = attrs.find((a: QueryMetadataNode) => a.name === 'Ссылка');
      assert.ok(refAttr);
      assert.strictEqual(refAttr.id, 'Catalog.Товары.Ссылка');
      assert.strictEqual(refAttr.fullName, 'Справочник.Товары.Ссылка');
    });
  });

  suite('2. Virtual Tables Catalog (getVirtualTables)', () => {
    const dummyDims: QueryMetadataNode[] = [
      {
        id: 'Dim.Номенклатура',
        name: 'Номенклатура',
        fullName: 'Номенклатура',
        label: 'Номенклатура',
        nodeType: 'field',
        dataType: 'Ref',
      },
      {
        id: 'Dim.Склад',
        name: 'Склад',
        fullName: 'Склад',
        label: 'Склад',
        nodeType: 'field',
        dataType: 'Ref',
      },
    ];

    const dummyResources: QueryMetadataNode[] = [
      {
        id: 'Res.Количество',
        name: 'Количество',
        fullName: 'Количество',
        label: 'Количество',
        nodeType: 'field',
        dataType: 'Number',
      },
      {
        id: 'Res.Сумма',
        name: 'Сумма',
        fullName: 'Сумма',
        label: 'Сумма',
        nodeType: 'field',
        dataType: 'Number',
      },
    ];

    const dummyAttrs: QueryMetadataNode[] = [
      {
        id: 'Attr.Комментарий',
        name: 'Комментарий',
        fullName: 'Комментарий',
        label: 'Комментарий',
        nodeType: 'field',
        dataType: 'String',
      },
    ];

    test('InformationRegister: generates СрезПервых and СрезПоследних with correct params and fields', () => {
      const vts = getVirtualTables(
        'InformationRegister',
        'КурсыВалют',
        dummyDims,
        dummyResources,
        dummyAttrs
      );
      assert.strictEqual(vts.length, 2);

      const first = vts.find((v: QueryMetadataNode) => v.name === 'КурсыВалют.СрезПервых');
      const last = vts.find((v: QueryMetadataNode) => v.name === 'КурсыВалют.СрезПоследних');
      assert.ok(first);
      assert.ok(last);

      assert.strictEqual(first.nodeType, 'virtualTable');
      assert.strictEqual(first.isVirtual, true);
      assert.strictEqual(first.fullName, 'РегистрСведений.КурсыВалют.СрезПервых');

      // Check parameters
      assert.ok(first.params);
      const paramNames = first.params.map((p: VirtualTableParamDefinition) => p.name);
      assert.deepStrictEqual(paramNames, ['Период', 'Условие']);

      // Check fields: dimensions + resources + attributes + Период
      const fieldNames = (first.children ?? []).map((f: QueryMetadataNode) => f.name);
      assert.ok(fieldNames.includes('Номенклатура'));
      assert.ok(fieldNames.includes('Склад'));
      assert.ok(fieldNames.includes('Количество'));
      assert.ok(fieldNames.includes('Сумма'));
      assert.ok(fieldNames.includes('Комментарий'));
      assert.ok(fieldNames.includes('Период'));
    });

    test('AccumulationRegister: generates Остатки with params and Остаток resource suffix', () => {
      const vts = getVirtualTables(
        'AccumulationRegister',
        'ОстаткиТоваров',
        dummyDims,
        dummyResources,
        dummyAttrs
      );
      assert.strictEqual(vts.length, 3);

      const balances = vts.find((v: QueryMetadataNode) => v.name === 'ОстаткиТоваров.Остатки');
      assert.ok(balances);
      assert.strictEqual(balances.fullName, 'РегистрНакопления.ОстаткиТоваров.Остатки');

      // Params
      const paramNames = (balances.params ?? []).map((p: VirtualTableParamDefinition) => p.name);
      assert.deepStrictEqual(paramNames, ['Период', 'Условие']);

      // Fields: dimensions + resources with Остаток suffix
      const fieldNames = (balances.children ?? []).map((f: QueryMetadataNode) => f.name);
      assert.ok(fieldNames.includes('Номенклатура'));
      assert.ok(fieldNames.includes('Склад'));
      assert.ok(fieldNames.includes('КоличествоОстаток'));
      assert.ok(fieldNames.includes('СуммаОстаток'));
      assert.ok(!fieldNames.includes('Регистратор'));
    });

    test('AccumulationRegister: generates Обороты with params and Оборот resource suffix', () => {
      const vts = getVirtualTables(
        'AccumulationRegister',
        'ОстаткиТоваров',
        dummyDims,
        dummyResources,
        dummyAttrs
      );
      const turn = vts.find((v: QueryMetadataNode) => v.name === 'ОстаткиТоваров.Обороты');
      assert.ok(turn);

      // Params
      const paramNames = (turn.params ?? []).map((p: VirtualTableParamDefinition) => p.name);
      assert.deepStrictEqual(paramNames, ['НачалоПериода', 'КонецПериода', 'Периодичность', 'Условие']);

      // Fields
      const fieldNames = (turn.children ?? []).map((f: QueryMetadataNode) => f.name);
      assert.ok(fieldNames.includes('Номенклатура'));
      assert.ok(fieldNames.includes('Склад'));
      assert.ok(fieldNames.includes('КоличествоОборот'));
      assert.ok(fieldNames.includes('СуммаОборот'));
      assert.ok(fieldNames.includes('Период'));
      assert.ok(fieldNames.includes('Регистратор'));
      assert.ok(fieldNames.includes('НомерСтроки'));
    });

    test('AccumulationRegister: generates ОстаткиИОбороты with full resource breakdown', () => {
      const vts = getVirtualTables(
        'AccumulationRegister',
        'ОстаткиТоваров',
        dummyDims,
        dummyResources,
        dummyAttrs
      );
      const bo = vts.find((v: QueryMetadataNode) => v.name === 'ОстаткиТоваров.ОстаткиИОбороты');
      assert.ok(bo);

      // Params
      const paramNames = (bo.params ?? []).map((p: VirtualTableParamDefinition) => p.name);
      assert.deepStrictEqual(paramNames, [
        'НачалоПериода',
        'КонецПериода',
        'Периодичность',
        'МетодДополнения',
        'Условие',
      ]);

      // Fields: dimensions + for each resource (НачальныйОстаток, КонечныйОстаток, Приход, Расход, Оборот) + period fields
      const fieldNames = (bo.children ?? []).map((f: QueryMetadataNode) => f.name);
      assert.ok(fieldNames.includes('Номенклатура'));
      assert.ok(fieldNames.includes('КоличествоНачальныйОстаток'));
      assert.ok(fieldNames.includes('КоличествоКонечныйОстаток'));
      assert.ok(fieldNames.includes('КоличествоПриход'));
      assert.ok(fieldNames.includes('КоличествоРасход'));
      assert.ok(fieldNames.includes('КоличествоОборот'));
      assert.ok(fieldNames.includes('СуммаНачальныйОстаток'));
      assert.ok(fieldNames.includes('СуммаКонечныйОстаток'));
      assert.ok(fieldNames.includes('СуммаПриход'));
      assert.ok(fieldNames.includes('СуммаРасход'));
      assert.ok(fieldNames.includes('СуммаОборот'));
      assert.ok(fieldNames.includes('Период'));
      assert.ok(fieldNames.includes('Регистратор'));
      assert.ok(fieldNames.includes('НомерСтроки'));
    });

    test('AccountingRegister: generates all 5 virtual tables with parameters and fields', () => {
      const vts = getVirtualTables(
        'AccountingRegister',
        'Хозрасчетный',
        dummyDims,
        dummyResources,
        dummyAttrs
      );
      assert.strictEqual(vts.length, 5);

      const names = vts.map((v: QueryMetadataNode) => v.name);
      assert.deepStrictEqual(names, [
        'Хозрасчетный.Остатки',
        'Хозрасчетный.Обороты',
        'Хозрасчетный.ОстаткиИОбороты',
        'Хозрасчетный.ДвиженияССубконто',
        'Хозрасчетный.ОборотыДтКт',
      ]);

      for (const vt of vts) {
        assert.strictEqual(vt.nodeType, 'virtualTable');
        assert.strictEqual(vt.isVirtual, true);
        assert.ok(vt.fullName.startsWith('РегистрБухгалтерии.Хозрасчетный.'));
        assert.ok(vt.params && vt.params.length > 0);
        assert.ok(vt.children && vt.children.length > 0);
      }

      // Check specific fields in ДвиженияССубконто
      const subconto = vts.find((v: QueryMetadataNode) => v.name === 'Хозрасчетный.ДвиженияССубконто');
      assert.ok(subconto);
      const subcontoFields = (subconto.children ?? []).map((f: QueryMetadataNode) => f.name);
      assert.ok(subcontoFields.includes('Счет'));
      assert.ok(subcontoFields.includes('КорСчет'));
      assert.ok(subcontoFields.includes('Активность'));
      assert.ok(subcontoFields.includes('ВидДвижения'));

      // Check specific fields in ОборотыДтКт
      const dtKt = vts.find((v: QueryMetadataNode) => v.name === 'Хозрасчетный.ОборотыДтКт');
      assert.ok(dtKt);
      const dtKtFields = (dtKt.children ?? []).map((f: QueryMetadataNode) => f.name);
      assert.ok(dtKtFields.includes('СчетДт'));
      assert.ok(dtKtFields.includes('СчетКт'));
    });

    test('returns empty array for non-register types (Catalog, Document, etc.)', () => {
      const vts = getVirtualTables('Catalog', 'Номенклатура', [], [], []);
      assert.deepStrictEqual(vts, []);
    });
  });

  suite('3. Temp Tables Support', () => {
    test('builds temp table nodes with fields and aliases', () => {
      const provider = new QueryMetadataProvider();
      const tempTables: TempTableDefinition[] = [
        {
          name: 'ВТ_Остатки',
          fields: [
            { name: 'Номенклатура', dataType: 'Ref' },
            { name: 'Количество', alias: 'ОстатокКол', dataType: 'Number' },
          ],
        },
      ];

      const categories = provider.getMetadataCategories(tempTables);
      const ttCategory = categories.find((c: QueryMetadataNode) => c.id === 'TempTables');
      assert.ok(ttCategory);
      assert.strictEqual(ttCategory.nodeType, 'category');
      assert.strictEqual(ttCategory.fullName, 'Временные таблицы');

      assert.ok(ttCategory.children);
      assert.strictEqual(ttCategory.children.length, 1);

      const tt = ttCategory.children[0];
      assert.strictEqual(tt.name, 'ВТ_Остатки');
      assert.strictEqual(tt.nodeType, 'tempTable');
      assert.strictEqual(tt.children?.length, 2);

      const f1 = tt.children?.[0];
      assert.strictEqual(f1?.name, 'Номенклатура');
      assert.strictEqual(f1?.nodeType, 'field');

      const f2 = tt.children?.[1];
      assert.strictEqual(f2?.name, 'Количество');
      assert.strictEqual(f2?.label, 'ОстатокКол');
      assert.strictEqual(f2?.dataType, 'Number');
    });
  });

  suite('4. QueryMetadataProvider', () => {
    let provider: QueryMetadataProvider;

    setup(() => {
      provider = new QueryMetadataProvider();
    });

    test('getMetadataCategories: returns 8 standard 1C categories when no tempTables', () => {
      const categories = provider.getMetadataCategories();
      assert.strictEqual(categories.length, 8);
      const ids = categories.map((c: QueryMetadataNode) => c.id);
      assert.deepStrictEqual(ids, [
        'Catalogs',
        'Documents',
        'InformationRegisters',
        'AccumulationRegisters',
        'AccountingRegisters',
        'ChartsOfCharacteristicTypes',
        'ChartsOfAccounts',
        'Enums',
      ]);
      for (const cat of categories) {
        assert.strictEqual(cat.nodeType, 'category');
        assert.strictEqual(cat.hasChildren, true);
      }
    });

    test('getMetadataCategories: includes TempTables category when tempTables provided', () => {
      const categories = provider.getMetadataCategories([
        { name: 'втДанные', fields: [{ name: 'Поле1' }] },
      ]);
      assert.strictEqual(categories.length, 9);
      const lastCat = categories[categories.length - 1];
      assert.strictEqual(lastCat.id, 'TempTables');
      assert.strictEqual(lastCat.label, 'Временные таблицы');
    });

    test('buildTreeFromProvider: standalone mode returns base categories without crash', async () => {
      const nodesNull = await provider.buildTreeFromProvider(null);
      assert.strictEqual(nodesNull.length, 8);

      const nodesEmpty = await provider.buildTreeFromProvider({
        getRootNodes: () => [],
        getChildren: () => Promise.resolve([]),
      } as any);
      assert.strictEqual(nodesEmpty.length, 8);
    });

    test('buildTreeFromProvider: standalone mode with tempTables includes temp tables', async () => {
      const nodes = await provider.buildTreeFromProvider(null, [
        { name: 'втТовары', fields: [{ name: 'Товар' }] },
      ]);
      assert.strictEqual(nodes.length, 9);
      const ttCat = nodes.find((n: QueryMetadataNode) => n.id === 'TempTables');
      assert.ok(ttCat);
      assert.strictEqual(ttCat.children?.length, 1);
    });

    test('buildTreeFromProvider: enriches tree with standard attributes, tabular sections, and virtual tables', async () => {
      // Create mock tree structure:
      // Root (Configuration)
      //   -> Catalogs Folder (MetadataType.Catalog)
      //        -> Номенклатура (MetadataType.Catalog)
      //             -> Артикул (MetadataType.Attribute)
      //             -> Состав (MetadataType.TabularSection)
      //                  -> Компонент (MetadataType.Attribute)
      //   -> AccumulationRegisters Folder (MetadataType.AccumulationRegister)
      //        -> ОстаткиНоменклатуры (MetadataType.AccumulationRegister)
      //             -> Номенклатура (MetadataType.Dimension)
      //             -> Количество (MetadataType.Resource)

      const catalogNode: TreeNode = {
        id: 'Catalogs.Номенклатура',
        name: 'Номенклатура',
        type: MetadataType.Catalog,
        properties: { synonym: 'Товары и услуги' },
      };

      const customAttr: TreeNode = {
        id: 'Catalogs.Номенклатура.Attributes.Артикул',
        name: 'Артикул',
        type: MetadataType.Attribute,
        properties: { Type: 'String' },
      };

      const tsAttr: TreeNode = {
        id: 'Catalogs.Номенклатура.TabularSections.Состав.Attributes.Компонент',
        name: 'Компонент',
        type: MetadataType.Attribute,
        properties: { Type: 'CatalogRef.Номенклатура' },
      };

      const tabularSectionNode: TreeNode = {
        id: 'Catalogs.Номенклатура.TabularSections.Состав',
        name: 'Состав',
        type: MetadataType.TabularSection,
        properties: {},
      };

      const regNode: TreeNode = {
        id: 'AccumulationRegisters.ОстаткиНоменклатуры',
        name: 'ОстаткиНоменклатуры',
        type: MetadataType.AccumulationRegister,
        properties: { synonym: 'Остатки номенклатуры' },
      };

      const dimNode: TreeNode = {
        id: 'AccumulationRegisters.ОстаткиНоменклатуры.Dimensions.Номенклатура',
        name: 'Номенклатура',
        type: MetadataType.Dimension,
        properties: { Type: 'CatalogRef.Номенклатура' },
      };

      const resNode: TreeNode = {
        id: 'AccumulationRegisters.ОстаткиНоменклатуры.Resources.Количество',
        name: 'Количество',
        type: MetadataType.Resource,
        properties: { Type: 'Number' },
      };

      const catalogsFolder: TreeNode = {
        id: 'Catalogs',
        name: 'Catalogs',
        type: MetadataType.Catalog,
        properties: {},
      };

      const regFolder: TreeNode = {
        id: 'AccumulationRegisters',
        name: 'AccumulationRegisters',
        type: MetadataType.AccumulationRegister,
        properties: {},
      };

      const configRoot: TreeNode = {
        id: 'Configuration.TestConfig',
        name: 'TestConfig',
        type: MetadataType.Configuration,
        properties: {},
      };

      const mockProvider: any = {
        getRootNodes: () => [configRoot],
        getChildren: (node?: TreeNode) => {
          if (!node || node === configRoot) {
            return Promise.resolve([catalogsFolder, regFolder]);
          }
          if (node === catalogsFolder) {
            return Promise.resolve([catalogNode]);
          }
          if (node === catalogNode) {
            return Promise.resolve([customAttr, tabularSectionNode]);
          }
          if (node === tabularSectionNode) {
            return Promise.resolve([tsAttr]);
          }
          if (node === regFolder) {
            return Promise.resolve([regNode]);
          }
          if (node === regNode) {
            return Promise.resolve([dimNode, resNode]);
          }
          return Promise.resolve([]);
        },
      };

      const tree = await provider.buildTreeFromProvider(mockProvider);

      // Verify Catalogs category
      const catCategory = tree.find((c: QueryMetadataNode) => c.id === 'Catalogs');
      assert.ok(catCategory);
      const nomTable = catCategory.children?.find(
        (t: QueryMetadataNode) => t.name === 'Номенклатура'
      );
      assert.ok(nomTable);
      assert.strictEqual(nomTable.fullName, 'Справочник.Номенклатура');
      assert.strictEqual(nomTable.synonym, 'Товары и услуги');

      // Check standard attributes enriched
      const nomFields = nomTable.children ?? [];
      const refField = nomFields.find((f: QueryMetadataNode) => f.name === 'Ссылка');
      const codeField = nomFields.find((f: QueryMetadataNode) => f.name === 'Код');
      const customField = nomFields.find((f: QueryMetadataNode) => f.name === 'Артикул');
      assert.ok(refField, 'Ссылка should be present');
      assert.ok(codeField, 'Код should be present');
      assert.ok(customField, 'Артикул should be present');

      // Check TabularSection and its standard attributes
      const tsNode = nomFields.find(
        (f: QueryMetadataNode) => f.name === 'Состав' && f.nodeType === 'tabularSection'
      );
      assert.ok(tsNode, 'TabularSection Состав should be present');
      const tsFields = tsNode.children ?? [];
      assert.ok(tsFields.find((f: QueryMetadataNode) => f.name === 'НомерСтроки'));
      assert.ok(tsFields.find((f: QueryMetadataNode) => f.name === 'Ссылка'));
      assert.ok(tsFields.find((f: QueryMetadataNode) => f.name === 'Компонент'));

      // Verify AccumulationRegisters category
      const regCategory = tree.find(
        (c: QueryMetadataNode) => c.id === 'AccumulationRegisters'
      );
      assert.ok(regCategory);

      // Main register table exists
      const regTable = regCategory.children?.find(
        (t: QueryMetadataNode) => t.name === 'ОстаткиНоменклатуры'
      );
      assert.ok(regTable);
      assert.strictEqual(regTable.fullName, 'РегистрНакопления.ОстаткиНоменклатуры');

      // Virtual tables should be generated
      const vts = regCategory.children?.filter(
        (t: QueryMetadataNode) => t.nodeType === 'virtualTable'
      ) ?? [];
      assert.strictEqual(vts.length, 3);
      const vtNames = vts.map((v: QueryMetadataNode) => v.name);
      assert.ok(vtNames.includes('ОстаткиНоменклатуры.Остатки'));
      assert.ok(vtNames.includes('ОстаткиНоменклатуры.Обороты'));
      assert.ok(vtNames.includes('ОстаткиНоменклатуры.ОстаткиИОбороты'));
    });
  });
});

