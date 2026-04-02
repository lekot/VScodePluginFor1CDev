import { TreeNode } from '../models/treeNode';
import { ExtensionState } from '../state/extensionState';

/**
 * Returns all extension root nodes from the tree.
 * Extensions are top-level root nodes that have extensionPurpose in properties.
 */
export function getExtensionRootNodes(state: ExtensionState): TreeNode[] {
  const provider = state.treeDataProvider;
  if (!provider) {
    return [];
  }
  return provider.getRootNodes().filter(
    (root) => typeof root.properties.extensionPurpose === 'string'
  ) as TreeNode[];
}

/** Свойства узла расширения, добавляются в TreeNode.properties */
export interface ExtensionNodeProperties {
  /** Назначение расширения (только на корне расширения) */
  extensionPurpose?: 'Patch' | 'Customization' | 'AddOn';
  /** Префикс имён собственных объектов */
  namePrefix?: string;
  /** 'Adopted' для заимствованных объектов */
  objectBelonging?: 'Adopted';
  /** UUID объекта в основной конфигурации */
  extendedConfigurationObject?: string;
}

/** Запись о перехвате в BSL-модуле расширения */
export interface InterceptEntry {
  decorator: 'Перед' | 'После' | 'Вместо' | 'ИзменениеИКонтроль';
  targetProcedure: string;
  line: number;
}
