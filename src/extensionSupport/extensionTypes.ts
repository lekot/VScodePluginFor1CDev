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
