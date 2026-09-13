import { extractV8String } from '../../utils/xmlPropertyUtils';
import { MetadataType, TreeNode } from '../../models/treeNode';
import { MetadataTreeDataProvider } from '../../providers/treeDataProvider';
import {
  QueryMetadataNode,
  TempTableDefinition,
} from './queryMetadataTypes';
import { getStandardAttributes } from './standardAttributesCatalog';
import { getVirtualTables } from './virtualTablesCatalog';

interface CategoryConfig {
  id: string;
  name: string;
  fullName: string;
  label: string;
  metadataType: MetadataType;
  singularRussian: string;
}

const CATEGORY_CONFIGS: readonly CategoryConfig[] = [
  {
    id: 'Catalogs',
    name: 'Catalogs',
    fullName: 'Справочники',
    label: 'Справочники',
    metadataType: MetadataType.Catalog,
    singularRussian: 'Справочник',
  },
  {
    id: 'Documents',
    name: 'Documents',
    fullName: 'Документы',
    label: 'Документы',
    metadataType: MetadataType.Document,
    singularRussian: 'Документ',
  },
  {
    id: 'InformationRegisters',
    name: 'InformationRegisters',
    fullName: 'Регистры сведений',
    label: 'Регистры сведений',
    metadataType: MetadataType.InformationRegister,
    singularRussian: 'РегистрСведений',
  },
  {
    id: 'AccumulationRegisters',
    name: 'AccumulationRegisters',
    fullName: 'Регистры накопления',
    label: 'Регистры накопления',
    metadataType: MetadataType.AccumulationRegister,
    singularRussian: 'РегистрНакопления',
  },
  {
    id: 'AccountingRegisters',
    name: 'AccountingRegisters',
    fullName: 'Регистры бухгалтерии',
    label: 'Регистры бухгалтерии',
    metadataType: MetadataType.AccountingRegister,
    singularRussian: 'РегистрБухгалтерии',
  },
  {
    id: 'ChartsOfCharacteristicTypes',
    name: 'ChartsOfCharacteristicTypes',
    fullName: 'Планы видов характеристик',
    label: 'Планы видов характеристик',
    metadataType: MetadataType.ChartOfCharacteristicTypes,
    singularRussian: 'ПланВидовХарактеристик',
  },
  {
    id: 'ChartsOfAccounts',
    name: 'ChartsOfAccounts',
    fullName: 'Планы счетов',
    label: 'Планы счетов',
    metadataType: MetadataType.ChartOfAccounts,
    singularRussian: 'ПланСчетов',
  },
  {
    id: 'Enums',
    name: 'Enums',
    fullName: 'Перечисления',
    label: 'Перечисления',
    metadataType: MetadataType.Enum,
    singularRussian: 'Перечисление',
  },
];

const CONFIG_BY_TYPE = new Map<MetadataType, CategoryConfig>(
  CATEGORY_CONFIGS.map((c) => [c.metadataType, c])
);

const CONFIG_BY_ID = new Map<string, CategoryConfig>(
  CATEGORY_CONFIGS.map((c) => [c.id.toLowerCase(), c])
);

function isAttributesContainer(node: TreeNode): boolean {
  const name = node.name?.toLowerCase();
  const id = node.id?.toLowerCase();
  const type = String(node.type).toLowerCase();
  return (
    name === 'attributes' ||
    name === 'реквизиты' ||
    type === 'attributesfolder' ||
    id === 'attributes' ||
    id.endsWith('.attributes')
  );
}

function isDimensionsContainer(node: TreeNode): boolean {
  const name = node.name?.toLowerCase();
  const id = node.id?.toLowerCase();
  const type = String(node.type).toLowerCase();
  return (
    name === 'dimensions' ||
    name === 'измерения' ||
    type === 'dimensionsfolder' ||
    id === 'dimensions' ||
    id.endsWith('.dimensions')
  );
}

function isResourcesContainer(node: TreeNode): boolean {
  const name = node.name?.toLowerCase();
  const id = node.id?.toLowerCase();
  const type = String(node.type).toLowerCase();
  return (
    name === 'resources' ||
    name === 'ресурсы' ||
    type === 'resourcesfolder' ||
    id === 'resources' ||
    id.endsWith('.resources')
  );
}

function isTabularSectionsContainer(node: TreeNode): boolean {
  const name = node.name?.toLowerCase();
  const id = node.id?.toLowerCase();
  const type = String(node.type).toLowerCase();
  return (
    name === 'tabularsections' ||
    name === 'tabular sections' ||
    name === 'табличные части' ||
    name === 'табличныечасти' ||
    type === 'tabularsectionsfolder' ||
    id === 'tabularsections' ||
    id.endsWith('.tabularsections')
  );
}

function extractSynonym(node: TreeNode): string | undefined {
  const props = node.properties as Record<string, unknown> | undefined;
  const innerProps = (props?.Properties ?? props) as Record<string, unknown> | undefined;
  const raw =
    innerProps?.Synonym ??
    innerProps?.synonym ??
    props?.Synonym ??
    props?.synonym ??
    (node as unknown as { synonym?: unknown }).synonym;

  return extractV8String(raw);
}

function normalizeSingleTypeString(str: string): string {
  const trimmed = str.trim();

  switch (trimmed) {
    case 'xs:string':
      return 'Строка';
    case 'xs:decimal':
    case 'xs:int':
    case 'xs:integer':
      return 'Число';
    case 'xs:boolean':
      return 'Булево';
    case 'xs:dateTime':
    case 'xs:date':
    case 'xs:time':
      return 'Дата';
  }

  const refMatch = trimmed.match(/^(?:cfg:)?([A-Za-z]+Ref)\.(.+)$/);
  if (refMatch) {
    const [, kind, name] = refMatch;
    const prefixMap: Record<string, string> = {
      CatalogRef: 'СправочникСсылка',
      DocumentRef: 'ДокументСсылка',
      EnumRef: 'ПеречислениеСсылка',
      ChartOfCharacteristicTypesRef: 'ПланВидовХарактеристикСсылка',
      ChartOfAccountsRef: 'ПланСчетовСсылка',
      ChartOfCalculationTypesRef: 'ПланВидовРасчетаСсылка',
      BusinessProcessRef: 'БизнесПроцессСсылка',
      TaskRef: 'ЗадачаСсылка',
      ExchangePlanRef: 'ПланОбменаСсылка',
    };
    if (prefixMap[kind]) {
      return `${prefixMap[kind]}.${name}`;
    }
  }

  return trimmed;
}

function normalizeDataType(raw: unknown): string {
  if (raw === null || raw === undefined) {
    return 'String';
  }

  if (typeof raw === 'string') {
    return normalizeSingleTypeString(raw) || 'String';
  }

  if (Array.isArray(raw)) {
    const items = raw.map((item) => normalizeDataType(item)).filter(Boolean);
    return items.join(', ') || 'String';
  }

  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const inner =
      obj['v8:Type'] ??
      obj['#text'] ??
      obj.content ??
      obj.Type ??
      obj.type ??
      obj.name;

    if (inner !== undefined && inner !== raw) {
      return normalizeDataType(inner);
    }

    for (const val of Object.values(obj)) {
      if (typeof val === 'string' && val.trim()) {
        return normalizeSingleTypeString(val);
      }
    }
  }

  return 'String';
}

export class QueryMetadataProvider {
  private static cachedTrees: Map<string, QueryMetadataNode[]> = new Map();

  public static clearCache(): void {
    QueryMetadataProvider.cachedTrees.clear();
  }

  public getCachedTree(configPath: string = ''): QueryMetadataNode[] | undefined {
    return QueryMetadataProvider.cachedTrees.get(configPath);
  }

  public setCachedTree(configPath: string = '', tree: QueryMetadataNode[]): void {
    QueryMetadataProvider.cachedTrees.set(configPath, tree);
  }

  buildShallowTree(
    treeProvider?: MetadataTreeDataProvider | null,
    targetRootOrTempTables?: TreeNode | TempTableDefinition[] | null,
    tempTables?: TempTableDefinition[]
  ): QueryMetadataNode[] {
    let targetRoot: TreeNode | null = null;
    let actualTempTables = tempTables;
    if (Array.isArray(targetRootOrTempTables)) {
      actualTempTables = targetRootOrTempTables;
    } else if (targetRootOrTempTables) {
      targetRoot = targetRootOrTempTables;
    }

    if (!treeProvider || typeof treeProvider.getRootNodes !== 'function') {
      return this.getMetadataCategories(actualTempTables);
    }

    const categories = this.getMetadataCategories(actualTempTables);
    const categoryMap = new Map<string, QueryMetadataNode>();
    for (const cat of categories) {
      categoryMap.set(cat.id, cat);
    }

    const rootNodes = treeProvider.getRootNodes();
    if (!rootNodes || rootNodes.length === 0) {
      return categories;
    }

    const rootToTraverse =
      targetRoot ??
      rootNodes.find((r) => r.type === MetadataType.Configuration) ??
      rootNodes[0];

    if (rootToTraverse) {
      this.traverseNodeForShallowCategories(rootToTraverse, categoryMap);
    }

    return categories;
  }

  private traverseNodeForShallowCategories(
    node: TreeNode,
    categoryMap: Map<string, QueryMetadataNode>
  ): void {
    if (
      node.type === MetadataType.Configuration ||
      node.type === MetadataType.ConfigurationPackage
    ) {
      const children = node.children || [];
      for (const child of children) {
        this.traverseNodeForShallowCategories(child, categoryMap);
      }
      return;
    }

    const catConfig =
      (node.id ? CONFIG_BY_ID.get(node.id.toLowerCase()) : undefined) ||
      (node.name ? CONFIG_BY_ID.get(node.name.toLowerCase()) : undefined) ||
      CONFIG_BY_TYPE.get(node.type);

    if (catConfig) {
      const targetCategory = categoryMap.get(catConfig.id);
      if (!targetCategory) {
        return;
      }

      const children = node.children || [];
      for (const child of children) {
        if (child.type === catConfig.metadataType) {
          const tableNode = this.buildShallowTableNode(child, catConfig);
          targetCategory.children = targetCategory.children || [];
          targetCategory.children.push(tableNode);

          if (
            catConfig.metadataType === MetadataType.InformationRegister ||
            catConfig.metadataType === MetadataType.AccumulationRegister ||
            catConfig.metadataType === MetadataType.AccountingRegister
          ) {
            const vts = (tableNode.children || []).filter(
              (c) => c.nodeType === 'virtualTable'
            );
            targetCategory.children.push(...vts);
          }
        }
      }
    }
  }

  private buildShallowTableNode(
    node: TreeNode,
    catConfig: CategoryConfig
  ): QueryMetadataNode {
    const tableId = `${catConfig.metadataType}.${node.name}`;
    const tableFullName = `${catConfig.singularRussian}.${node.name}`;
    const synonym = extractSynonym(node);

    const stdAttrs = getStandardAttributes(catConfig.metadataType, {
      parentId: tableId,
      parentFullName: tableFullName,
      parentTableName: node.name,
      parentTableFullName: tableFullName,
    });

    const isRegister =
      catConfig.metadataType === MetadataType.InformationRegister ||
      catConfig.metadataType === MetadataType.AccumulationRegister ||
      catConfig.metadataType === MetadataType.AccountingRegister;

    let vts: QueryMetadataNode[] = [];
    if (isRegister) {
      vts = getVirtualTables(
        catConfig.metadataType,
        node.name,
        [],
        [],
        []
      );
    }

    return {
      id: tableId,
      name: node.name,
      fullName: tableFullName,
      label: synonym ? `${node.name} (${synonym})` : node.name,
      synonym,
      nodeType: 'table',
      hasChildren: true,
      children: [...stdAttrs, ...vts],
    };
  }

  /**
   * Returns top-level metadata categories (Catalogs, Documents, Registers, etc.)
   * and optionally the TempTables category when tempTables are defined.
   */
  getMetadataCategories(tempTables?: TempTableDefinition[]): QueryMetadataNode[] {
    const categories: QueryMetadataNode[] = CATEGORY_CONFIGS.map((c) => ({
      id: c.id,
      name: c.name,
      fullName: c.fullName,
      label: c.label,
      nodeType: 'category',
      hasChildren: true,
      children: [],
    }));

    if (tempTables && tempTables.length > 0) {
      const tempNodes = this.buildTempTableNodes(tempTables);
      categories.push({
        id: 'TempTables',
        name: 'TempTables',
        fullName: 'Временные таблицы',
        label: 'Временные таблицы',
        nodeType: 'category',
        hasChildren: tempNodes.length > 0,
        children: tempNodes,
      });
    }

    return categories;
  }

  /**
   * Converts temporary table definitions into QueryMetadataNode tree.
   */
  buildTempTableNodes(tempTables: TempTableDefinition[]): QueryMetadataNode[] {
    return tempTables.map((tt) => {
      const ttId = `TempTables.${tt.name}`;
      const ttFullName = tt.name;
      const fields: QueryMetadataNode[] = (tt.fields ?? []).map((f) => ({
        id: `${ttId}.${f.name}`,
        name: f.name,
        fullName: `${ttFullName}.${f.name}`,
        label: f.alias || f.name,
        nodeType: 'field',
        dataType: f.dataType || 'String',
        isVirtual: false,
        parentTableFullName: ttFullName,
        parentTableName: tt.name,
        fieldName: f.name,
      }));

      return {
        id: ttId,
        name: tt.name,
        fullName: ttFullName,
        label: tt.name,
        nodeType: 'tempTable',
        hasChildren: fields.length > 0,
        children: fields,
      };
    });
  }

  /**
   * Builds the query metadata tree by reading nodes from MetadataTreeDataProvider.
   * If the provider is empty or unavailable, falls back to standalone mode (empty categories).
   */
  async buildTreeFromProvider(
    treeProvider?: MetadataTreeDataProvider | null,
    targetRootOrTempTables?: TreeNode | TempTableDefinition[] | null,
    tempTables?: TempTableDefinition[]
  ): Promise<QueryMetadataNode[]> {
    let targetRoot: TreeNode | null = null;
    let actualTempTables = tempTables;
    if (Array.isArray(targetRootOrTempTables)) {
      actualTempTables = targetRootOrTempTables;
    } else if (targetRootOrTempTables) {
      targetRoot = targetRootOrTempTables;
    }

    if (!treeProvider || typeof treeProvider.getRootNodes !== 'function') {
      return this.getMetadataCategories(actualTempTables);
    }

    const categories = this.getMetadataCategories(actualTempTables);
    const categoryMap = new Map<string, QueryMetadataNode>();
    for (const cat of categories) {
      categoryMap.set(cat.id, cat);
    }

    const rootNodes = treeProvider.getRootNodes();
    if (!rootNodes || rootNodes.length === 0) {
      return categories;
    }

    const rootToTraverse =
      targetRoot ??
      rootNodes.find((r) => r.type === MetadataType.Configuration) ??
      rootNodes[0];

    if (rootToTraverse) {
      await this.traverseNodeForCategories(rootToTraverse, treeProvider, categoryMap);
    }

    return categories;
  }

  /**
   * Loads detailed attributes (custom attributes, tabular sections) for a single table on-demand.
   */
  async loadTableAttributes(
    treeProvider: MetadataTreeDataProvider,
    targetRoot: TreeNode | null,
    tableId: string
  ): Promise<QueryMetadataNode[]> {
    const parts = tableId.split('.');
    if (parts.length < 2) {
      return [];
    }
    const metaTypeStr = parts[0];
    const tableName = parts.slice(1).join('.');
    const catConfig = CONFIG_BY_TYPE.get(metaTypeStr as MetadataType);
    if (!catConfig) {
      return [];
    }

    const allRoots = treeProvider.getRootNodes() || [];
    const root =
      targetRoot ??
      allRoots.find((r) => r.type === MetadataType.Configuration) ??
      allRoots[0];
    if (!root) {
      return [];
    }

    let objectNode: TreeNode | undefined;
    const findInNode = async (n: TreeNode): Promise<void> => {
      if (objectNode) {
        return;
      }
      if (n.name === tableName && (n.type === catConfig.metadataType || !catConfig.metadataType)) {
        objectNode = n;
        return;
      }
      const children = await this.safeGetChildren(treeProvider, n);
      for (const child of children) {
        if (objectNode) {
          return;
        }
        if (child.name === tableName && child.type === catConfig.metadataType) {
          objectNode = child;
          return;
        }
        if (child.children && child.children.length > 0) {
          await findInNode(child);
        }
      }
    };

    await findInNode(root);
    if (!objectNode) {
      return [];
    }

    const built = await this.buildTableNode(objectNode, catConfig, treeProvider);
    return built.children || [];
  }

  private async safeGetChildren(
    provider: MetadataTreeDataProvider,
    element: TreeNode
  ): Promise<TreeNode[]> {
    try {
      const res = await provider.getChildren(element);
      return res || element.children || [];
    } catch {
      return element.children || [];
    }
  }

  private async traverseNodeForCategories(
    node: TreeNode,
    provider: MetadataTreeDataProvider,
    categoryMap: Map<string, QueryMetadataNode>
  ): Promise<void> {
    if (
      node.type === MetadataType.Configuration ||
      node.type === MetadataType.ConfigurationPackage
    ) {
      const children = await this.safeGetChildren(provider, node);
      for (const child of children) {
        await this.traverseNodeForCategories(child, provider, categoryMap);
      }
      return;
    }

    // Check if node is a category folder (e.g. Catalogs, Documents)
    const catConfig =
      (node.id ? CONFIG_BY_ID.get(node.id.toLowerCase()) : undefined) ||
      (node.name ? CONFIG_BY_ID.get(node.name.toLowerCase()) : undefined) ||
      CONFIG_BY_TYPE.get(node.type);

    if (catConfig) {
      const targetCategory = categoryMap.get(catConfig.id);
      if (!targetCategory) {
        return;
      }

      // If the node itself is a folder container of objects:
      // (either folder id matches, or it has children of that metadata type)
      const children = await this.safeGetChildren(provider, node);
      for (const child of children) {
        if (child.type === catConfig.metadataType) {
          const tableNode = await this.buildTableNode(child, catConfig, provider);
          targetCategory.children = targetCategory.children || [];
          targetCategory.children.push(tableNode);

          // If this is a register with virtual tables, also add them to category children
          if (
            catConfig.metadataType === MetadataType.InformationRegister ||
            catConfig.metadataType === MetadataType.AccumulationRegister ||
            catConfig.metadataType === MetadataType.AccountingRegister
          ) {
            const vts = (tableNode.children || []).filter(
              (c) => c.nodeType === 'virtualTable'
            );
            targetCategory.children.push(...vts);
          }

          // Cooperative yield to keep event loop responsive
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    }
  }

  private async buildTableNode(
    node: TreeNode,
    catConfig: CategoryConfig,
    provider: MetadataTreeDataProvider
  ): Promise<QueryMetadataNode> {
    const tableId = `${catConfig.metadataType}.${node.name}`;
    const tableFullName = `${catConfig.singularRussian}.${node.name}`;

    const rawChildren = await this.safeGetChildren(provider, node);
    // In lazy loading, safeGetChildren triggers loadChildrenForElement which populates node.properties (including Synonym)
    const synonym = extractSynonym(node);

    const dims: QueryMetadataNode[] = [];
    const resources: QueryMetadataNode[] = [];
    const customAttrs: QueryMetadataNode[] = [];
    const tabularSections: QueryMetadataNode[] = [];

    for (const child of rawChildren) {
      if (isAttributesContainer(child)) {
        const subChildren = await this.safeGetChildren(provider, child);
        for (const sub of subChildren) {
          customAttrs.push(this.makeFieldNode(tableId, tableFullName, sub, node.name));
        }
      } else if (isDimensionsContainer(child)) {
        const subChildren = await this.safeGetChildren(provider, child);
        for (const sub of subChildren) {
          dims.push(this.makeFieldNode(tableId, tableFullName, sub, node.name));
        }
      } else if (isResourcesContainer(child)) {
        const subChildren = await this.safeGetChildren(provider, child);
        for (const sub of subChildren) {
          resources.push(this.makeFieldNode(tableId, tableFullName, sub, node.name));
        }
      } else if (isTabularSectionsContainer(child)) {
        const subChildren = await this.safeGetChildren(provider, child);
        for (const sub of subChildren) {
          const tsNode = await this.buildTabularSectionNode(
            sub,
            tableId,
            tableFullName,
            provider
          );
          tabularSections.push(tsNode);
        }
      } else {
        if (child.type === MetadataType.Dimension) {
          dims.push(this.makeFieldNode(tableId, tableFullName, child, node.name));
        } else if (child.type === MetadataType.Resource) {
          resources.push(this.makeFieldNode(tableId, tableFullName, child, node.name));
        } else if (child.type === MetadataType.Attribute) {
          customAttrs.push(this.makeFieldNode(tableId, tableFullName, child, node.name));
        } else if (child.type === MetadataType.TabularSection) {
          const tsNode = await this.buildTabularSectionNode(
            child,
            tableId,
            tableFullName,
            provider
          );
          tabularSections.push(tsNode);
        }
      }
    }

    let isHierarchical: boolean | undefined;
    let hasOwner: boolean | undefined;
    let isPeriodic: boolean | undefined;
    let accumulationRegisterType: string | undefined;
        const props = (node.properties as Record<string, unknown> | undefined) || {};
    const innerProps = ((props.Properties as Record<string, unknown> | undefined) || props);

    if (catConfig.metadataType === MetadataType.Catalog) {
      const rawHierarchical =
        innerProps.Hierarchical ??
        innerProps.isHierarchical ??
        innerProps.hierarchical ??
        props.Hierarchical ??
        props.isHierarchical ??
        props.hierarchical;
      if (rawHierarchical !== undefined) {
        isHierarchical = rawHierarchical !== false && String(rawHierarchical).trim().toLowerCase() !== 'false';
      }

      const rawOwners =
        innerProps.Owners ??
        innerProps.owners ??
        innerProps.hasOwner ??
        props.Owners ??
        props.owners ??
        props.hasOwner;
      if (rawOwners !== undefined) {
        if (typeof rawOwners === 'boolean') {
          hasOwner = rawOwners;
        } else if (typeof rawOwners === 'string') {
          hasOwner = rawOwners.trim().length > 0 && rawOwners.trim().toLowerCase() !== 'false';
        } else if (Array.isArray(rawOwners)) {
          hasOwner = rawOwners.length > 0;
        } else if (typeof rawOwners === 'object' && rawOwners !== null) {
          hasOwner = Object.keys(rawOwners).length > 0;
        } else {
          hasOwner = false;
        }
      } else {
        hasOwner = false;
      }
    } else if (catConfig.metadataType === MetadataType.InformationRegister) {
      const rawPeriodicity =
        props.InformationRegisterPeriodicity ??
        props.Periodicity ??
        props.periodicity ??
        props.isPeriodic;
      if (rawPeriodicity !== undefined) {
        const str = String(rawPeriodicity).trim().toLowerCase();
        if (rawPeriodicity === false || str === 'false' || str === 'nonperiodic' || str === 'непериодический') {
          isPeriodic = false;
        } else {
          isPeriodic = true;
        }
      }
    } else if (catConfig.metadataType === MetadataType.AccumulationRegister) {
      const rawType =
        props.RegisterType ??
        props.registerType;
      if (rawType !== undefined) {
        accumulationRegisterType = String(rawType).trim();
      }
    }

    // Standard attributes
    const stdAttrs = getStandardAttributes(catConfig.metadataType, {
      parentId: tableId,
      parentFullName: tableFullName,
      parentTableName: node.name,
      parentTableFullName: tableFullName,
      isHierarchical,
      hasOwner,
      isPeriodic,
    });

    const fields: QueryMetadataNode[] = [
      ...stdAttrs,
      ...dims,
      ...resources,
      ...customAttrs,
      ...tabularSections,
    ];

    // Virtual tables for registers
    const isRegister =
      catConfig.metadataType === MetadataType.InformationRegister ||
      catConfig.metadataType === MetadataType.AccumulationRegister ||
      catConfig.metadataType === MetadataType.AccountingRegister;

    if (isRegister) {
      const vts = getVirtualTables(
        catConfig.metadataType,
        node.name,
        dims,
        resources,
        customAttrs,
        {
          isPeriodic,
          registerTypeKind: accumulationRegisterType,
        }
      );
      fields.push(...vts);
    }

    return {
      id: tableId,
      name: node.name,
      fullName: tableFullName,
      label: synonym || node.name,
      synonym,
      nodeType: 'table',
      hasChildren: fields.length > 0,
      children: fields,
    };
  }

  private async buildTabularSectionNode(
    node: TreeNode,
    parentTableId: string,
    parentTableFullName: string,
    provider: MetadataTreeDataProvider
  ): Promise<QueryMetadataNode> {
    const tsId = `${parentTableId}.${node.name}`;
    const tsFullName = `${parentTableFullName}.${node.name}`;

    const rawChildren = await this.safeGetChildren(provider, node);
    const synonym = extractSynonym(node);
    const customAttrs: QueryMetadataNode[] = [];

    for (const child of rawChildren) {
      if (isAttributesContainer(child)) {
        const subChildren = await this.safeGetChildren(provider, child);
        for (const sub of subChildren) {
          customAttrs.push(this.makeFieldNode(tsId, tsFullName, sub, node.name));
        }
      } else if (child.type === MetadataType.Attribute) {
        customAttrs.push(this.makeFieldNode(tsId, tsFullName, child, node.name));
      }
    }

    const stdAttrs = getStandardAttributes('TabularSection', {
      parentId: tsId,
      parentFullName: tsFullName,
      parentTableName: node.name,
      parentTableFullName: tsFullName,
    });

    const fields = [...stdAttrs, ...customAttrs];

    return {
      id: tsId,
      name: node.name,
      fullName: tsFullName,
      label: synonym || node.name,
      synonym,
      nodeType: 'tabularSection',
      hasChildren: fields.length > 0,
      children: fields,
    };
  }

  private makeFieldNode(
    parentId: string,
    parentFullName: string,
    node: TreeNode,
    parentTableName?: string
  ): QueryMetadataNode {
    const rawType = node.properties?.Type ?? node.properties?.['v8:Type'];
    const dataType = normalizeDataType(rawType);
    const synonym = extractSynonym(node);

    return {
      id: `${parentId}.${node.name}`,
      name: node.name,
      fullName: `${parentFullName}.${node.name}`,
      label: synonym || node.name,
      synonym,
      nodeType: 'field',
      dataType,
      isVirtual: false,
      parentTableFullName: parentFullName,
      parentTableName:
        parentTableName ??
        (parentFullName ? parentFullName.split('.').pop() : undefined),
      fieldName: node.name,
    };
  }
}
