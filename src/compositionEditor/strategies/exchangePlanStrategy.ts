import * as path from 'path';
import type { CompositionStrategy, ContentReadResult, ContentUpdateDiff } from '../compositionContracts';
import type { TreeNode } from '../../models/treeNode';
import { MetadataType } from '../../models/treeNode';
import {
  readExchangePlanContent,
  applyExchangePlanContentUpdate,
} from '../../services/exchangePlanContentFileUpdater';

const EXCHANGE_PLAN_ELIGIBLE_TYPES: ReadonlySet<string> = new Set<string>([
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
  MetadataType.Constant,
]);

export const ExchangePlanStrategy: CompositionStrategy = {
  panelTypeId: '1c-exchange-plan-content',
  titlePrefix: 'Состав плана обмена',
  eligibleTypes: EXCHANGE_PLAN_ELIGIBLE_TYPES,
  itemSettingsSchema: [
    { key: 'AutoRecord', label: 'Авторегистрация', options: ['Allow', 'Deny'], defaultValue: 'Allow' },
  ],

  getContentFilePath(node: TreeNode): string {
    // ExchangePlan content is in a separate Ext/Content.xml file
    // node.filePath points to ExchangePlans/Name.xml
    // Content is at ExchangePlans/Name/Ext/Content.xml
    const dir = path.dirname(node.filePath!);
    const name = path.basename(node.filePath!, '.xml');
    return path.join(dir, name, 'Ext', 'Content.xml');
  },

  async readContent(filePath: string): Promise<ContentReadResult> {
    return readExchangePlanContent(filePath);
  },

  async applyUpdate(filePath: string, diff: ContentUpdateDiff) {
    return applyExchangePlanContentUpdate(filePath, diff);
  },
};
