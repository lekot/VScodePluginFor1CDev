import * as vscode from 'vscode';
import { MetadataType } from '../models/treeNode';

/**
 * Returns the VS Code ThemeIcon for a given metadata type.
 */
export function getIconForType(type: MetadataType): vscode.ThemeIcon {
  // Map metadata types to VS Code built-in icons
  const iconMap: Record<MetadataType, string> = {
    // Root
    [MetadataType.Configuration]: 'package',

    // Main types
    [MetadataType.Catalog]: 'book',
    [MetadataType.Document]: 'file-text',
    [MetadataType.Enum]: 'symbol-enum',
    [MetadataType.Report]: 'graph',
    [MetadataType.DataProcessor]: 'gear',
    [MetadataType.ChartOfCharacteristicTypes]: 'symbol-class',
    [MetadataType.ChartOfAccounts]: 'symbol-numeric',
    [MetadataType.ChartOfCalculationTypes]: 'calculator',
    [MetadataType.InformationRegister]: 'database',
    [MetadataType.AccumulationRegister]: 'archive',
    [MetadataType.AccountingRegister]: 'symbol-ruler',
    [MetadataType.CalculationRegister]: 'symbol-operator',
    [MetadataType.BusinessProcess]: 'git-branch',
    [MetadataType.Task]: 'checklist',
    [MetadataType.ExternalDataSource]: 'cloud',
    [MetadataType.Constant]: 'symbol-constant',
    [MetadataType.SessionParameter]: 'symbol-parameter',
    [MetadataType.FilterCriterion]: 'filter',
    [MetadataType.ScheduledJob]: 'watch',
    [MetadataType.FunctionalOption]: 'symbol-boolean',
    [MetadataType.FunctionalOptionsParameter]: 'symbol-variable',
    [MetadataType.SettingsStorage]: 'save',
    [MetadataType.EventSubscription]: 'bell',
    [MetadataType.CommonModule]: 'symbol-module',
    [MetadataType.CommandGroup]: 'folder',
    [MetadataType.Command]: 'terminal',
    [MetadataType.Role]: 'shield',
    [MetadataType.Interface]: 'symbol-interface',
    [MetadataType.Style]: 'paintcan',
    [MetadataType.WebService]: 'globe',
    [MetadataType.HTTPService]: 'server',
    [MetadataType.IntegrationService]: 'plug',
    [MetadataType.Subsystem]: 'folder-library',
    [MetadataType.ExchangePlan]: 'repo-sync',
    [MetadataType.DocumentJournal]: 'notebook',
    [MetadataType.DefinedType]: 'symbol-misc',
    [MetadataType.CommonAttribute]: 'symbol-field',
    [MetadataType.CommonCommand]: 'terminal',
    [MetadataType.CommonForm]: 'layout',
    [MetadataType.CommonPicture]: 'file-media',
    [MetadataType.CommonTemplate]: 'file-code',
    [MetadataType.DocumentNumerator]: 'list-ordered',
    [MetadataType.Language]: 'globe',
    [MetadataType.WSReference]: 'link',
    [MetadataType.XDTOPackage]: 'package',
    [MetadataType.StyleItem]: 'symbol-color',

    // Sub-elements
    [MetadataType.Attribute]: 'symbol-field',
    [MetadataType.TabularSection]: 'table',
    [MetadataType.Form]: 'layout',
    [MetadataType.Template]: 'file-code',
    [MetadataType.CommandSubElement]: 'symbol-method',
    [MetadataType.Recurrence]: 'sync',
    [MetadataType.Method]: 'symbol-method',
    [MetadataType.Parameter]: 'symbol-parameter',

    // Extensions
    [MetadataType.Extension]: 'extensions',

    // Unknown
    [MetadataType.Unknown]: 'question',
  };

  const iconName = iconMap[type] || 'file';
  return new vscode.ThemeIcon(iconName);
}
