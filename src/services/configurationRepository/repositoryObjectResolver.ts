import * as fs from 'fs';
import * as path from 'path';
import { MetadataType, type TreeNode } from '../../models/treeNode';
import { collectObjectFiles } from '../ibcmd/objectFileCollector';
import { XmlParser } from '../../parsers/xmlParser';
import type {
  RepositoryConfigurationKind,
  RepositoryObjectReference,
  RepositoryTarget,
} from './types';
import { repositoryTargetKey } from './repositoryStores';

/** Technical type names used by the Designer configuration repository. */
const REPOSITORY_TYPE_NAMES: Partial<Record<MetadataType, string>> = {
  [MetadataType.Subsystem]: 'Подсистема',
  [MetadataType.CommonModule]: 'ОбщийМодуль',
  [MetadataType.SessionParameter]: 'ПараметрСеанса',
  [MetadataType.CommonAttribute]: 'ОбщийРеквизит',
  [MetadataType.Role]: 'Роль',
  [MetadataType.CommonForm]: 'ОбщаяФорма',
  [MetadataType.CommonCommand]: 'ОбщаяКоманда',
  [MetadataType.CommandGroup]: 'ГруппаКоманд',
  [MetadataType.CommonPicture]: 'ОбщаяКартинка',
  [MetadataType.CommonTemplate]: 'ОбщийМакет',
  [MetadataType.XDTOPackage]: 'XDTOPackage',
  [MetadataType.StyleItem]: 'ЭлементСтиля',
  [MetadataType.DefinedType]: 'ОпределяемыйТип',
  [MetadataType.FunctionalOption]: 'ФункциональнаяОпция',
  [MetadataType.FunctionalOptionsParameter]: 'ПараметрФункциональнойОпции',
  [MetadataType.SettingsStorage]: 'ХранилищеНастроек',
  [MetadataType.Style]: 'Стиль',
  [MetadataType.WSReference]: 'WSСсылка',
  [MetadataType.Interface]: 'Интерфейс',
  [MetadataType.HTTPService]: 'HTTPСервис',
  [MetadataType.WebService]: 'WebСервис',
  [MetadataType.IntegrationService]: 'СервисИнтеграции',
  [MetadataType.Constant]: 'Константа',
  [MetadataType.Catalog]: 'Справочник',
  [MetadataType.Document]: 'Документ',
  [MetadataType.Enum]: 'Перечисление',
  [MetadataType.InformationRegister]: 'РегистрСведений',
  [MetadataType.AccumulationRegister]: 'РегистрНакопления',
  [MetadataType.AccountingRegister]: 'РегистрБухгалтерии',
  [MetadataType.CalculationRegister]: 'РегистрРасчета',
  [MetadataType.Report]: 'Отчет',
  [MetadataType.DataProcessor]: 'Обработка',
  [MetadataType.BusinessProcess]: 'БизнесПроцесс',
  [MetadataType.Task]: 'Задача',
  [MetadataType.ExchangePlan]: 'ПланОбмена',
  [MetadataType.ChartOfCharacteristicTypes]: 'ПланВидовХарактеристик',
  [MetadataType.ChartOfAccounts]: 'ПланСчетов',
  [MetadataType.ChartOfCalculationTypes]: 'ПланВидовРасчета',
  [MetadataType.DocumentJournal]: 'ЖурналДокументов',
  [MetadataType.DocumentNumerator]: 'НумераторДокументов',
  [MetadataType.ScheduledJob]: 'РегламентноеЗадание',
  [MetadataType.EventSubscription]: 'ПодпискаНаСобытие',
  [MetadataType.FilterCriterion]: 'КритерийОтбора',
  [MetadataType.Sequence]: 'Последовательность',
  [MetadataType.ExternalDataSource]: 'ВнешнийИсточникДанных',
  [MetadataType.Language]: 'Язык',
};

const EXTENSION_CONTAINER_NAMES = new Set(['configurationextensions', 'extensions']);

export function resolveRepositoryTarget(node: TreeNode): RepositoryTarget | undefined {
  const root = findConfigurationRoot(node);
  if (!root) {
    return undefined;
  }
  const configRoot = configurationRootPath(root);
  if (!configRoot) {
    return undefined;
  }

  const extensionNameFromPath = extensionNameFromConfigRoot(configRoot);
  const xmlName = readConfigurationName(path.join(configRoot, 'Configuration.xml'));
  const extensionName = extensionNameFromPath ?? (root.properties?.isExtension === true ? xmlName : undefined);
  const configKind: RepositoryConfigurationKind = extensionName ? 'cfe' : 'cf';
  const target: Omit<RepositoryTarget, 'key'> = {
    configRoot,
    configKind,
    ...(extensionName ? { extensionName } : {}),
  };
  return Object.freeze({ ...target, key: repositoryTargetKey(target) });
}

export function resolveRepositoryObject(
  node: TreeNode,
  target: RepositoryTarget,
): RepositoryObjectReference | undefined {
  const owner = resolveOwnerNode(node);
  if (!owner) {
    return undefined;
  }
  const repositoryType = REPOSITORY_TYPE_NAMES[owner.type];
  if (!repositoryType || !owner.name.trim()) {
    return undefined;
  }
  const repositoryFullName = `${repositoryType}.${owner.name.trim()}`;
  const ibcmdFullName = `${owner.type}.${owner.name.trim()}`;
  const relativeFiles = collectObjectFiles(owner, target.configRoot);
  return Object.freeze({
    target,
    ownerNode: owner,
    repositoryFullName,
    ibcmdFullName,
    relativeFiles: Object.freeze([...relativeFiles]),
  });
}

export function resolveRepositoryOwner(node: TreeNode): TreeNode | undefined {
  return resolveOwnerNode(node);
}

export function repositoryTypeName(type: MetadataType): string | undefined {
  return REPOSITORY_TYPE_NAMES[type];
}

export function isRepositoryRootNode(node: TreeNode): boolean {
  return (
    (node.type === MetadataType.Configuration
      || (node.type === MetadataType.Extension && node.properties?.isExtension === true))
    && node.parent === undefined
  );
}

function findConfigurationRoot(node: TreeNode): TreeNode | undefined {
  let current: TreeNode | undefined = node;
  let candidate: TreeNode | undefined;
  while (current) {
    if (
      current.type === MetadataType.Configuration
      || (current.type === MetadataType.Extension && current.properties?.isExtension === true)
    ) {
      candidate = current;
    }
    current = current.parent;
  }
  return candidate;
}

function configurationRootPath(root: TreeNode): string | undefined {
  const filePath = root.filePath?.trim();
  if (!filePath) {
    return undefined;
  }
  const normalized = path.basename(filePath).toLocaleLowerCase() === 'configuration.xml'
    ? path.dirname(filePath)
    : filePath;
  return path.resolve(normalized);
}

function extensionNameFromConfigRoot(configRoot: string): string | undefined {
  const segments = configRoot.replace(/\\/g, '/').split('/').filter(Boolean);
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    if (EXTENSION_CONTAINER_NAMES.has(segments[index]!.toLocaleLowerCase())) {
      const value = segments[index + 1]?.trim();
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function readConfigurationName(xmlPath: string): string | undefined {
  try {
    if (!fs.existsSync(xmlPath)) {
      return undefined;
    }
    const parsed = XmlParser.parseFile(xmlPath);
    return findPropertyString(parsed, 'Name');
  } catch {
    return undefined;
  }
}

function findPropertyString(value: unknown, name: string): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === name && typeof child === 'string' && child.trim()) {
      return child.trim();
    }
    const nested = findPropertyString(child, name);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function resolveOwnerNode(node: TreeNode): TreeNode | undefined {
  let current: TreeNode | undefined = node;
  while (current) {
    if (REPOSITORY_TYPE_NAMES[current.type]) {
      return current;
    }
    if (current.type === MetadataType.Configuration || current.type === MetadataType.Extension) {
      return undefined;
    }
    current = current.parent;
  }
  return undefined;
}
