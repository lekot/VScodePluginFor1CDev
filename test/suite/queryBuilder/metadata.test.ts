import * as assert from 'assert';
import * as path from 'path';
import {
  QueryMetadataNode,
  TempTableDefinition,
  VirtualTableParamDefinition,
} from '../../../src/queryBuilder/metadata/queryMetadataTypes';
import { getStandardAttributes } from '../../../src/queryBuilder/metadata/standardAttributesCatalog';
import { getVirtualTables } from '../../../src/queryBuilder/metadata/virtualTablesCatalog';
import { QueryMetadataProvider } from '../../../src/queryBuilder/metadata/queryMetadataProvider';
import { MetadataType, TreeNode, TreeNodeProperties } from '../../../src/models/treeNode';
import { DesignerParser } from '../../../src/parsers/designerParser';

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

    test('Catalog: respects hasOwner = false by excluding Владелец', () => {
      const attrs = getStandardAttributes('Catalog', { hasOwner: false });
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

    test('Catalog: respects isHierarchical = false and hasOwner = false', () => {
      const attrs = getStandardAttributes('Catalog', { isHierarchical: false, hasOwner: false });
      const names = attrs.map((a: QueryMetadataNode) => a.name);
      assert.deepStrictEqual(names, [
        'Ссылка',
        'ПометкаУдаления',
        'Предопределенный',
        'Код',
        'Наименование',
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

    test('Enum: returns standard attributes Ссылка and Порядок', () => {
      const attrs = getStandardAttributes('Enum');
      const names = attrs.map((a: QueryMetadataNode) => a.name);
      assert.deepStrictEqual(names, ['Ссылка', 'Порядок']);
      const refField = attrs.find((a: QueryMetadataNode) => a.name === 'Ссылка');
      const orderField = attrs.find((a: QueryMetadataNode) => a.name === 'Порядок');
      assert.strictEqual(refField?.dataType, 'Ref');
      assert.strictEqual(orderField?.dataType, 'Number');
    });

    test('Enum: supports Russian name Перечисление', () => {
      const attrs = getStandardAttributes('Перечисление');
      const names = attrs.map((a: QueryMetadataNode) => a.name);
      assert.deepStrictEqual(names, ['Ссылка', 'Порядок']);
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

    test('AccumulationRegister: turnovers only generates solely Обороты virtual table', () => {
      const vts = getVirtualTables(
        'AccumulationRegister',
        'Продажи',
        dummyDims,
        dummyResources,
        dummyAttrs,
        { registerTypeKind: 'Turnovers' }
      );
      assert.strictEqual(vts.length, 1);
      assert.strictEqual(vts[0].name, 'Продажи.Обороты');
    });

    test('InformationRegister: non-periodic generates no virtual tables', () => {
      const vts = getVirtualTables(
        'InformationRegister',
        'КурсыВалют',
        dummyDims,
        dummyResources,
        dummyAttrs,
        { isPeriodic: false }
      );
      assert.strictEqual(vts.length, 0);
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

  suite('5. Group 3 Improvements (P1.6, P2.18, P2.19)', () => {
    let provider: QueryMetadataProvider;

    setup(() => {
      provider = new QueryMetadataProvider();
    });

    test('P1.6: unpacks container folders (Attributes, Dimensions, Resources, TabularSections) and does not treat them as fields', async () => {
      // Mock realistic CDT tree with folder containers
      const configRoot: TreeNode = {
        id: 'Configuration.App',
        name: 'App',
        type: MetadataType.Configuration,
        properties: {},
      };

      const catalogsFolder: TreeNode = {
        id: 'Catalogs',
        name: 'Catalogs',
        type: MetadataType.Catalog,
        properties: {},
      };

      const nomCatalog: TreeNode = {
        id: 'Catalogs.Товары',
        name: 'Товары',
        type: MetadataType.Catalog,
        properties: { synonym: 'Справочник товаров' },
      };

      const attrsContainer: TreeNode = {
        id: 'Attributes',
        name: 'Attributes',
        type: MetadataType.Attribute,
        properties: {},
      };

      const attrArtikul: TreeNode = {
        id: 'Attributes.Артикул',
        name: 'Артикул',
        type: MetadataType.Attribute,
        properties: { Type: { 'v8:Type': 'xs:string' } },
      };

      const attrBarcode: TreeNode = {
        id: 'Attributes.Штрихкод',
        name: 'Штрихкод',
        type: MetadataType.Attribute,
        properties: { Type: 'xs:string' },
      };

      const tsContainer: TreeNode = {
        id: 'TabularSections',
        name: 'Tabular Sections',
        type: MetadataType.TabularSection,
        properties: {},
      };

      const tsSklad: TreeNode = {
        id: 'TabularSections.Состав',
        name: 'Состав',
        type: MetadataType.TabularSection,
        properties: { synonym: 'Состав комплекта' },
      };

      const tsAttrsContainer: TreeNode = {
        id: 'TabularSections.Состав.Attributes',
        name: 'Attributes',
        type: MetadataType.Attribute,
        properties: {},
      };

      const tsAttrMaterial: TreeNode = {
        id: 'TabularSections.Состав.Attributes.Материал',
        name: 'Материал',
        type: MetadataType.Attribute,
        properties: { Type: { 'v8:Type': 'cfg:CatalogRef.Номенклатура' } },
      };

      const tsAttrQuantity: TreeNode = {
        id: 'TabularSections.Состав.Attributes.Количество',
        name: 'Количество',
        type: MetadataType.Attribute,
        properties: { Type: { 'v8:Type': 'xs:decimal' } },
      };

      // Accumulation register with Dimensions and Resources containers
      const accFolder: TreeNode = {
        id: 'AccumulationRegisters',
        name: 'AccumulationRegisters',
        type: MetadataType.AccumulationRegister,
        properties: {},
      };

      const accReg: TreeNode = {
        id: 'AccumulationRegisters.Остатки',
        name: 'Остатки',
        type: MetadataType.AccumulationRegister,
        properties: {},
      };

      const dimsContainer: TreeNode = {
        id: 'Dimensions',
        name: 'Dimensions',
        type: MetadataType.Dimension,
        properties: {},
      };

      const dimSklad: TreeNode = {
        id: 'Dimensions.Склад',
        name: 'Склад',
        type: MetadataType.Dimension,
        properties: { Type: { 'v8:Type': 'cfg:CatalogRef.Склады' } },
      };

      const resContainer: TreeNode = {
        id: 'Resources',
        name: 'Resources',
        type: MetadataType.Resource,
        properties: {},
      };

      const resKol: TreeNode = {
        id: 'Resources.Количество',
        name: 'Количество',
        type: MetadataType.Resource,
        properties: { Type: { 'v8:Type': 'xs:decimal' } },
      };

      const mockProvider: any = {
        getRootNodes: () => [configRoot],
        getChildren: (node?: TreeNode) => {
          if (!node || node === configRoot) {
            return Promise.resolve([catalogsFolder, accFolder]);
          }
          if (node === catalogsFolder) {
            return Promise.resolve([nomCatalog]);
          }
          if (node === nomCatalog) {
            return Promise.resolve([attrsContainer, tsContainer]);
          }
          if (node === attrsContainer) {
            return Promise.resolve([attrArtikul, attrBarcode]);
          }
          if (node === tsContainer) {
            return Promise.resolve([tsSklad]);
          }
          if (node === tsSklad) {
            return Promise.resolve([tsAttrsContainer]);
          }
          if (node === tsAttrsContainer) {
            return Promise.resolve([tsAttrMaterial, tsAttrQuantity]);
          }
          if (node === accFolder) {
            return Promise.resolve([accReg]);
          }
          if (node === accReg) {
            return Promise.resolve([dimsContainer, resContainer]);
          }
          if (node === dimsContainer) {
            return Promise.resolve([dimSklad]);
          }
          if (node === resContainer) {
            return Promise.resolve([resKol]);
          }
          return Promise.resolve([]);
        },
      };

      const tree = await provider.buildTreeFromProvider(mockProvider);

      // Verify Catalog "Товары"
      const catCategory = tree.find((c: QueryMetadataNode) => c.id === 'Catalogs');
      assert.ok(catCategory);
      const tovaryTable = catCategory.children?.find((t: QueryMetadataNode) => t.name === 'Товары');
      assert.ok(tovaryTable);

      const tableFields = tovaryTable.children ?? [];
      const fieldNames = tableFields.map((f: QueryMetadataNode) => f.name);

      // Containers must NOT be present as fields
      assert.strictEqual(fieldNames.includes('Attributes'), false, 'Attributes container must not be a field');
      assert.strictEqual(fieldNames.includes('TabularSections'), false, 'TabularSections container must not be a field');
      assert.strictEqual(fieldNames.includes('Tabular Sections'), false, 'Tabular Sections container must not be a field');

      // Unpacked attributes must be present
      assert.ok(fieldNames.includes('Артикул'), 'Unpacked Артикул must be present');
      assert.ok(fieldNames.includes('Штрихкод'), 'Unpacked Штрихкод must be present');

      // TabularSection "Состав" must be present as a tabularSection node
      const tsNode = tableFields.find((f: QueryMetadataNode) => f.name === 'Состав' && f.nodeType === 'tabularSection');
      assert.ok(tsNode, 'TabularSection Состав must be present');
      assert.strictEqual(tsNode.synonym, 'Состав комплекта');

      const tsFields = tsNode.children ?? [];
      const tsFieldNames = tsFields.map((f: QueryMetadataNode) => f.name);
      assert.strictEqual(tsFieldNames.includes('Attributes'), false, 'Attributes inside TS must not be a field');
      assert.ok(tsFieldNames.includes('НомерСтроки'), 'TS standard attr НомерСтроки must be present');
      assert.ok(tsFieldNames.includes('Ссылка'), 'TS standard attr Ссылка must be present');
      assert.ok(tsFieldNames.includes('Материал'), 'TS unpacked column Материал must be present');
      assert.ok(tsFieldNames.includes('Количество'), 'TS unpacked column Количество must be present');

      // Verify AccumulationRegister
      const regCategory = tree.find((c: QueryMetadataNode) => c.id === 'AccumulationRegisters');
      assert.ok(regCategory);
      const regTable = regCategory.children?.find((t: QueryMetadataNode) => t.name === 'Остатки');
      assert.ok(regTable);

      const regFields = regTable.children ?? [];
      const regFieldNames = regFields.map((f: QueryMetadataNode) => f.name);
      assert.strictEqual(regFieldNames.includes('Dimensions'), false);
      assert.strictEqual(regFieldNames.includes('Resources'), false);
      assert.ok(regFieldNames.includes('Склад'));
      assert.ok(regFieldNames.includes('Количество'));

      // Virtual tables must use the unpacked dimensions and resources
      const balVt = regCategory.children?.find((v: QueryMetadataNode) => v.name === 'Остатки.Остатки');
      assert.ok(balVt);
      const balFieldNames = (balVt.children ?? []).map((f: QueryMetadataNode) => f.name);
      assert.ok(balFieldNames.includes('Склад'));
      assert.ok(balFieldNames.includes('КоличествоОстаток'));
    });

    test('P2.18: reads synonym from object { ru: ... }, { content: ... }, Synonym, and synonym', async () => {
      const configRoot: TreeNode = {
        id: 'Configuration.App',
        name: 'App',
        type: MetadataType.Configuration,
        properties: {},
      };

      const catFolder: TreeNode = {
        id: 'Catalogs',
        name: 'Catalogs',
        type: MetadataType.Catalog,
        properties: {},
      };

      // Synonym as { ru: 'Контрагенты', en: 'Counterparties' }
      const cat1: TreeNode = {
        id: 'Catalogs.Контрагенты',
        name: 'Контрагенты',
        type: MetadataType.Catalog,
        properties: {
          synonym: { ru: 'Контрагенты компании', en: 'Company Counterparties' } as any,
        },
      };

      // Synonym via PascalCase Synonym property with { content: 'Договоры' }
      const cat2: TreeNode = {
        id: 'Catalogs.Договоры',
        name: 'Договоры',
        type: MetadataType.Catalog,
        properties: {
          Synonym: { content: 'Договоры контрагентов' } as any,
        },
      };

      // Synonym directly on node.synonym
      const cat3: TreeNode = {
        id: 'Catalogs.Склады',
        name: 'Склады',
        type: MetadataType.Catalog,
        properties: {},
      };
      (cat3 as any).synonym = 'Места хранения';

      const attrField: TreeNode = {
        id: 'Catalogs.Контрагенты.ИНН',
        name: 'ИНН',
        type: MetadataType.Attribute,
        properties: {
          Synonym: { ru: 'Идентификационный номер' } as any,
          Type: { 'v8:Type': 'xs:string' },
        },
      };

      const mockProvider: any = {
        getRootNodes: () => [configRoot],
        getChildren: (node?: TreeNode) => {
          if (!node || node === configRoot) {
            return Promise.resolve([catFolder]);
          }
          if (node === catFolder) {
            return Promise.resolve([cat1, cat2, cat3]);
          }
          if (node === cat1) {
            return Promise.resolve([attrField]);
          }
          return Promise.resolve([]);
        },
      };

      const tree = await provider.buildTreeFromProvider(mockProvider);
      const catCategory = tree.find((c: QueryMetadataNode) => c.id === 'Catalogs');
      assert.ok(catCategory);

      const t1 = catCategory.children?.find((t: QueryMetadataNode) => t.name === 'Контрагенты');
      assert.strictEqual(t1?.synonym, 'Контрагенты компании');
      assert.strictEqual(t1?.label, 'Контрагенты компании');

      const t2 = catCategory.children?.find((t: QueryMetadataNode) => t.name === 'Договоры');
      assert.strictEqual(t2?.synonym, 'Договоры контрагентов');
      assert.strictEqual(t2?.label, 'Договоры контрагентов');

      const t3 = catCategory.children?.find((t: QueryMetadataNode) => t.name === 'Склады');
      assert.strictEqual(t3?.synonym, 'Места хранения');
      assert.strictEqual(t3?.label, 'Места хранения');

      const inn = t1?.children?.find((f: QueryMetadataNode) => f.name === 'ИНН');
      assert.strictEqual(inn?.synonym, 'Идентификационный номер');
      assert.strictEqual(inn?.label, 'Идентификационный номер');
    });

    test('P2.18: normalizes data types from { v8:Type: ... }, arrays, and raw XML strings', async () => {
      const configRoot: TreeNode = {
        id: 'Configuration.App',
        name: 'App',
        type: MetadataType.Configuration,
        properties: {},
      };

      const docFolder: TreeNode = {
        id: 'Documents',
        name: 'Documents',
        type: MetadataType.Document,
        properties: {},
      };

      const doc: TreeNode = {
        id: 'Documents.Заказ',
        name: 'Заказ',
        type: MetadataType.Document,
        properties: {},
      };

      const fString: TreeNode = {
        id: 'Documents.Заказ.СтроковоеПоле',
        name: 'СтроковоеПоле',
        type: MetadataType.Attribute,
        properties: { Type: { 'v8:Type': 'xs:string' } },
      };

      const fNumber: TreeNode = {
        id: 'Documents.Заказ.ЧисловоеПоле',
        name: 'ЧисловоеПоле',
        type: MetadataType.Attribute,
        properties: { Type: { 'v8:Type': 'xs:decimal' } },
      };

      const fBool: TreeNode = {
        id: 'Documents.Заказ.БулевоПоле',
        name: 'БулевоПоле',
        type: MetadataType.Attribute,
        properties: { Type: { 'v8:Type': 'xs:boolean' } },
      };

      const fDate: TreeNode = {
        id: 'Documents.Заказ.ДатаПоле',
        name: 'ДатаПоле',
        type: MetadataType.Attribute,
        properties: { Type: { 'v8:Type': 'xs:dateTime' } },
      };

      const fCatalogRef: TreeNode = {
        id: 'Documents.Заказ.Клиент',
        name: 'Клиент',
        type: MetadataType.Attribute,
        properties: { Type: { 'v8:Type': 'cfg:CatalogRef.Контрагенты' } },
      };

      const fDocRef: TreeNode = {
        id: 'Documents.Заказ.Основание',
        name: 'Основание',
        type: MetadataType.Attribute,
        properties: { Type: 'cfg:DocumentRef.СчетНаОплату' },
      };

      const fCompound: TreeNode = {
        id: 'Documents.Заказ.Составной',
        name: 'Составной',
        type: MetadataType.Attribute,
        properties: { Type: ['xs:string', 'cfg:CatalogRef.Товары'] },
      };

      const fPlain: TreeNode = {
        id: 'Documents.Заказ.Обычное',
        name: 'Обычное',
        type: MetadataType.Attribute,
        properties: { Type: 'CustomTypeName' },
      };

      const mockProvider: any = {
        getRootNodes: () => [configRoot],
        getChildren: (node?: TreeNode) => {
          if (!node || node === configRoot) {
            return Promise.resolve([docFolder]);
          }
          if (node === docFolder) {
            return Promise.resolve([doc]);
          }
          if (node === doc) {
            return Promise.resolve([fString, fNumber, fBool, fDate, fCatalogRef, fDocRef, fCompound, fPlain]);
          }
          return Promise.resolve([]);
        },
      };

      const tree = await provider.buildTreeFromProvider(mockProvider);
      const docCat = tree.find((c: QueryMetadataNode) => c.id === 'Documents');
      const docTable = docCat?.children?.find((t: QueryMetadataNode) => t.name === 'Заказ');
      const fields = docTable?.children ?? [];

      const getDataType = (name: string) => fields.find((f: QueryMetadataNode) => f.name === name)?.dataType;

      assert.strictEqual(getDataType('СтроковоеПоле'), 'Строка');
      assert.strictEqual(getDataType('ЧисловоеПоле'), 'Число');
      assert.strictEqual(getDataType('БулевоПоле'), 'Булево');
      assert.strictEqual(getDataType('ДатаПоле'), 'Дата');
      assert.strictEqual(getDataType('Клиент'), 'СправочникСсылка.Контрагенты');
      assert.strictEqual(getDataType('Основание'), 'ДокументСсылка.СчетНаОплату');
      assert.strictEqual(getDataType('Составной'), 'Строка, СправочникСсылка.Товары');
      assert.strictEqual(getDataType('Обычное'), 'CustomTypeName');
    });

    test('P2.19: respects object properties (Hierarchical, Owners, Periodicity, RegisterType, Enum)', async () => {
      const configRoot: TreeNode = {
        id: 'Configuration.App',
        name: 'App',
        type: MetadataType.Configuration,
        properties: {},
      };

      const catFolder: TreeNode = {
        id: 'Catalogs',
        name: 'Catalogs',
        type: MetadataType.Catalog,
        properties: {},
      };

      // 1. Non-hierarchical catalog without owners
      const nonHierCat: TreeNode = {
        id: 'Catalogs.Валюты',
        name: 'Валюты',
        type: MetadataType.Catalog,
        properties: {
          Hierarchical: false,
          Owners: [],
        } as unknown as TreeNodeProperties,
      };

      // 2. Hierarchical catalog with owners
      const hierCatWithOwner: TreeNode = {
        id: 'Catalogs.Договоры',
        name: 'Договоры',
        type: MetadataType.Catalog,
        properties: {
          Hierarchical: true,
          Owners: ['Catalog.Контрагенты'],
        } as unknown as TreeNodeProperties,
      };

      // 3. Non-periodic information register
      const irFolder: TreeNode = {
        id: 'InformationRegisters',
        name: 'InformationRegisters',
        type: MetadataType.InformationRegister,
        properties: {},
      };

      const nonPeriodicIr: TreeNode = {
        id: 'InformationRegisters.Штрихкоды',
        name: 'Штрихкоды',
        type: MetadataType.InformationRegister,
        properties: {
          InformationRegisterPeriodicity: 'Nonperiodic',
        } as unknown as TreeNodeProperties,
      };

      // 4. Accumulation register of type Turnovers
      const arFolder: TreeNode = {
        id: 'AccumulationRegisters',
        name: 'AccumulationRegisters',
        type: MetadataType.AccumulationRegister,
        properties: {},
      };

      const turnoversAr: TreeNode = {
        id: 'AccumulationRegisters.Продажи',
        name: 'Продажи',
        type: MetadataType.AccumulationRegister,
        properties: {
          RegisterType: 'Turnovers',
        } as unknown as TreeNodeProperties,
      };

      // 5. Enum
      const enumFolder: TreeNode = {
        id: 'Enums',
        name: 'Enums',
        type: MetadataType.Enum,
        properties: {},
      };

      const testEnum: TreeNode = {
        id: 'Enums.СтатусыЗаказов',
        name: 'СтатусыЗаказов',
        type: MetadataType.Enum,
        properties: { synonym: 'Статусы заказов' },
      };

      const mockProvider: any = {
        getRootNodes: () => [configRoot],
        getChildren: (node?: TreeNode) => {
          if (!node || node === configRoot) {
            return Promise.resolve([catFolder, irFolder, arFolder, enumFolder]);
          }
          if (node === catFolder) {
            return Promise.resolve([nonHierCat, hierCatWithOwner]);
          }
          if (node === irFolder) {
            return Promise.resolve([nonPeriodicIr]);
          }
          if (node === arFolder) {
            return Promise.resolve([turnoversAr]);
          }
          if (node === enumFolder) {
            return Promise.resolve([testEnum]);
          }
          return Promise.resolve([]);
        },
      };

      const tree = await provider.buildTreeFromProvider(mockProvider);

      // Check Non-hierarchical catalog without owners:
      // must NOT have 'Родитель', 'ЭтоГруппа', 'Владелец'
      const catCat = tree.find((c: QueryMetadataNode) => c.id === 'Catalogs');
      const valyuty = catCat?.children?.find((t: QueryMetadataNode) => t.name === 'Валюты');
      const valyutyFieldNames = (valyuty?.children ?? []).map((f: QueryMetadataNode) => f.name);
      assert.ok(valyutyFieldNames.includes('Ссылка'));
      assert.ok(valyutyFieldNames.includes('Код'));
      assert.strictEqual(valyutyFieldNames.includes('Родитель'), false, 'Non-hierarchical must not have Родитель');
      assert.strictEqual(valyutyFieldNames.includes('ЭтоГруппа'), false, 'Non-hierarchical must not have ЭтоГруппа');
      assert.strictEqual(valyutyFieldNames.includes('Владелец'), false, 'Catalog without owners must not have Владелец');

      // Check Hierarchical catalog with owners:
      // must have 'Родитель', 'ЭтоГруппа', 'Владелец'
      const dogovory = catCat?.children?.find((t: QueryMetadataNode) => t.name === 'Договоры');
      const dogovoryFieldNames = (dogovory?.children ?? []).map((f: QueryMetadataNode) => f.name);
      assert.ok(dogovoryFieldNames.includes('Родитель'));
      assert.ok(dogovoryFieldNames.includes('ЭтоГруппа'));
      assert.ok(dogovoryFieldNames.includes('Владелец'));

      // Check Non-periodic information register:
      // must NOT have 'Период', and must NOT generate СрезПервых / СрезПоследних
      const irCat = tree.find((c: QueryMetadataNode) => c.id === 'InformationRegisters');
      const barcodeTable = irCat?.children?.find((t: QueryMetadataNode) => t.name === 'Штрихкоды');
      const barcodeFieldNames = (barcodeTable?.children ?? []).map((f: QueryMetadataNode) => f.name);
      assert.strictEqual(barcodeFieldNames.includes('Период'), false, 'Non-periodic IR must not have Период');
      const irVts = (irCat?.children ?? []).filter((t: QueryMetadataNode) => t.nodeType === 'virtualTable');
      assert.strictEqual(irVts.length, 0, 'Non-periodic IR must not generate virtual tables');

      // Check Accumulation register of type Turnovers:
      // must generate ONLY .Обороты, no .Остатки and no .ОстаткиИОбороты
      const arCat = tree.find((c: QueryMetadataNode) => c.id === 'AccumulationRegisters');
      const arVts = (arCat?.children ?? []).filter((t: QueryMetadataNode) => t.nodeType === 'virtualTable');
      assert.strictEqual(arVts.length, 1);
      assert.strictEqual(arVts[0].name, 'Продажи.Обороты');

      // Check Enum:
      // must have Ссылка (Ref) and Порядок (Number)
      const enumCat = tree.find((c: QueryMetadataNode) => c.id === 'Enums');
      const enumTable = enumCat?.children?.find((t: QueryMetadataNode) => t.name === 'СтатусыЗаказов');
      assert.ok(enumTable);
      assert.strictEqual(enumTable.fullName, 'Перечисление.СтатусыЗаказов');
      assert.strictEqual(enumTable.synonym, 'Статусы заказов');
      const enumFields = enumTable.children ?? [];
      assert.strictEqual(enumFields.length, 2);
      const refF = enumFields.find((f: QueryMetadataNode) => f.name === 'Ссылка');
      const orderF = enumFields.find((f: QueryMetadataNode) => f.name === 'Порядок');
      assert.ok(refF);
      assert.strictEqual(refF.dataType, 'Ref');
      assert.ok(orderF);
      assert.strictEqual(orderF.dataType, 'Number');
    });
  });

  suite('6. Designer XML Fixture Parsing (R9, R10)', () => {
    test('Designer XML: TestCatalog1 omits Родитель and ЭтоГруппа when Hierarchical is false (R9)', async () => {
      const fixtureDir = path.resolve(__dirname, '../../../../test/fixtures/designer-config');
      const rootNode = await DesignerParser.parse(fixtureDir);

      const provider = new QueryMetadataProvider();
      const mockTreeProvider = {
        getRootNodes: () => [rootNode],
        getChildren: async (element?: TreeNode) => {
          if (!element || element === rootNode) {
            return rootNode.children ?? [];
          }
          return element.children ?? [];
        },
      } as any;

      const tree = await provider.buildTreeFromProvider(mockTreeProvider);
      const catCat = tree.find((c: QueryMetadataNode) => c.id === 'Catalogs');
      assert.ok(catCat, 'Catalogs category must exist');

      const testCat1 = catCat.children?.find((t: QueryMetadataNode) => t.name === 'TestCatalog1');
      assert.ok(testCat1, 'TestCatalog1 must exist in tree');

      const fieldNames = (testCat1.children ?? []).map((f: QueryMetadataNode) => f.name);
      assert.ok(fieldNames.includes('Ссылка'), 'Must have Ссылка');
      assert.ok(fieldNames.includes('Код'), 'Must have Код');
      assert.strictEqual(fieldNames.includes('Родитель'), false, 'Non-hierarchical TestCatalog1 must NOT have Родитель');
      assert.strictEqual(fieldNames.includes('ЭтоГруппа'), false, 'Non-hierarchical TestCatalog1 must NOT have ЭтоГруппа');
    });

    test('Designer XML: extracts localized synonyms for catalog and attributes (R10)', async () => {
      const fixtureDir = path.resolve(__dirname, '../../../../test/fixtures/designer-config');
      const rootNode = await DesignerParser.parse(fixtureDir);

      const provider = new QueryMetadataProvider();
      const mockTreeProvider = {
        getRootNodes: () => [rootNode],
        getChildren: async (element?: TreeNode) => {
          if (!element || element === rootNode) {
            return rootNode.children ?? [];
          }
          return element.children ?? [];
        },
      } as any;

      const tree = await provider.buildTreeFromProvider(mockTreeProvider);
      const catCat = tree.find((c: QueryMetadataNode) => c.id === 'Catalogs');

      // TestCatalogWithAttribute has synonym: "Test Catalog With Attribute"
      const catWithAttr = catCat?.children?.find((t: QueryMetadataNode) => t.name === 'TestCatalogWithAttribute');
      assert.ok(catWithAttr, 'TestCatalogWithAttribute must exist');
      assert.strictEqual(catWithAttr.synonym, 'Test Catalog With Attribute');
      assert.strictEqual(catWithAttr.label, 'Test Catalog With Attribute');

      // StringAttribute has synonym: "String Attribute"
      const strAttr = catWithAttr.children?.find((f: QueryMetadataNode) => f.name === 'StringAttribute');
      assert.ok(strAttr, 'StringAttribute must exist');
      assert.strictEqual(strAttr.synonym, 'String Attribute');
      assert.strictEqual(strAttr.label, 'String Attribute');

      // TestCatalog1 has NewAttribute with multi-item Synonym
      const testCat1 = catCat?.children?.find((t: QueryMetadataNode) => t.name === 'TestCatalog1');
      assert.ok(testCat1);
      assert.strictEqual(testCat1.synonym, 'Test Catalog 1');
      const newAttr = testCat1.children?.find((f: QueryMetadataNode) => f.name === 'NewAttribute');
      assert.ok(newAttr, 'NewAttribute must exist');
      assert.strictEqual(newAttr.synonym, 'NewAttribute');
    });

    test('Designer XML: extracts object synonym when properties are lazy-loaded during getChildren (Finding 6)', async () => {
      const rootNode: TreeNode = {
        id: 'Configuration',
        name: 'Configuration',
        type: MetadataType.Configuration,
        properties: {},
        children: [
          {
            id: 'Catalogs',
            name: 'Catalogs',
            type: MetadataType.Catalog,
            properties: {},
            children: [
              {
                id: 'Catalog.LazyCatalog',
                name: 'LazyCatalog',
                type: MetadataType.Catalog,
                // properties are intentionally empty at index-level before getChildren!
                properties: {},
              } as TreeNode,
            ],
          } as TreeNode,
        ],
      } as TreeNode;

      const provider = new QueryMetadataProvider();
      const mockTreeProvider = {
        getRootNodes: () => [rootNode],
        getChildren: async (element?: TreeNode) => {
          if (!element || element === rootNode) {
            return rootNode.children ?? [];
          }
          if (element.name === 'Catalogs') {
            return element.children ?? [];
          }
          if (element.name === 'LazyCatalog') {
            // Simulate lazy loading: properties loaded when children are requested
            element.properties = {
              Synonym: {
                item: {
                  lang: 'ru',
                  content: 'Ленивый Справочник',
                },
              },
            } as any;
            return [];
          }
          return [];
        },
      } as any;

      const tree = await provider.buildTreeFromProvider(mockTreeProvider);
      const catCat = tree.find((c: QueryMetadataNode) => c.id === 'Catalogs');
      const lazyCat = catCat?.children?.find((t: QueryMetadataNode) => t.name === 'LazyCatalog');

      assert.ok(lazyCat, 'LazyCatalog must exist in tree');
      assert.strictEqual(lazyCat.synonym, 'Ленивый Справочник', 'Must extract synonym after lazy properties load');
      assert.strictEqual(lazyCat.label, 'Ленивый Справочник', 'Label must use extracted synonym');
    });
  });
});


