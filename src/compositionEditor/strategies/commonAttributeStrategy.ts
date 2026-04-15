import type { CompositionStrategy, ContentReadResult, ContentUpdateDiff } from '../compositionContracts';
import type { TreeNode } from '../../models/treeNode';
import { MetadataType } from '../../models/treeNode';
import {
  readCommonAttributeContent,
  applyCommonAttributeContentUpdate,
} from '../../services/commonAttributeContentFileUpdater';

const COMMON_ATTRIBUTE_ELIGIBLE_TYPES: ReadonlySet<string> = new Set<string>([
  MetadataType.Catalog,
  MetadataType.Document,
  MetadataType.ChartOfCharacteristicTypes,
  MetadataType.ChartOfAccounts,
  MetadataType.ChartOfCalculationTypes,
  MetadataType.InformationRegister,
  MetadataType.AccumulationRegister,
  MetadataType.AccountingRegister,
  MetadataType.CalculationRegister,
  MetadataType.BusinessProcess,
  MetadataType.Task,
  MetadataType.ExchangePlan,
]);

export const CommonAttributeStrategy: CompositionStrategy = {
  panelTypeId: '1c-common-attribute-content',
  titlePrefix: 'Состав общего реквизита',
  eligibleTypes: COMMON_ATTRIBUTE_ELIGIBLE_TYPES,
  itemSettingsSchema: [
    { key: 'Use', label: 'Использование', options: ['Use', 'DontUse'], defaultValue: 'Use' },
  ],

  getContentFilePath(node: TreeNode): string {
    return node.filePath!;
  },

  async readContent(filePath: string): Promise<ContentReadResult> {
    return readCommonAttributeContent(filePath);
  },

  async applyUpdate(filePath: string, diff: ContentUpdateDiff) {
    return applyCommonAttributeContentUpdate(filePath, diff);
  },
};
