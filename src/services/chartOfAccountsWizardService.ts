import * as path from 'path';
import * as fs from 'fs';
import { XMLWriter } from '../utils/XMLWriter';
import { validateElementName } from '../utils/elementNameValidator';
import { hashContent } from './configurationSession/atomicFileStorage';
import type { MutationExpectation, MutationPlan, MutationStep } from './configurationSession/mutationPlan';
import type { AgentResult } from '../agent/types';
import { CONFIGURATION_XML } from '../constants/fileNames';
import { requireProjectWriteFormatProfile } from '../utils/format/formatRank';
import { buildRootObjectConfigurationContent } from './configurationXmlUpdater';
import { normalizeMetaDataObjectRoot } from '../utils/xml/metaDataObjectRootNormalizer';

async function expectationForPath(targetPath: string): Promise<MutationExpectation> {
  try {
    const stat = await fs.promises.lstat(targetPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Symbolic-link metadata path is forbidden: ${targetPath}`);
    }
    if (stat.isDirectory()) {
      return { state: 'directory' };
    }
    if (stat.isFile()) {
      return { state: 'file', hash: hashContent(await fs.promises.readFile(targetPath)) };
    }
    throw new Error(`Unsupported metadata filesystem entry: ${targetPath}`);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: 'missing' };
    }
    throw error;
  }
}

export interface InitialPredefinedAccount {
  name: string;
  code: string;
  description: string;
  accountType?: 'Active' | 'Passive' | 'ActivePassive';
  offBalance?: boolean;
  order?: string;
}

export interface AccountingFlagParam {
  name: string;
  synonym?: string;
  type?: string;
}

export interface ChartOfAccountsWizardParams {
  name: string;
  synonym?: string;
  comment?: string;
  codeMask?: string;
  codeLength?: number;
  descriptionLength?: number;
  orderLength?: number;
  codeSeries?: 'WholeChartOfAccounts' | 'WithinSubordination';
  checkUnique?: boolean;
  useStandardCommands?: boolean;
  extDimensionTypes?: string;
  maxExtDimensionCount?: number;
  accountingFlags?: AccountingFlagParam[];
  extDimensionAccountingFlags?: AccountingFlagParam[];
  predefinedAccounts?: InitialPredefinedAccount[];
}

export interface AvailableSubcontoType {
  ref: string;
  name: string;
  label: string;
}

export interface PlanCreateChartOfAccountsOptions {
  configPath: string;
  params: ChartOfAccountsWizardParams;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Scan configuration directory for available ChartOfCharacteristicTypes (Планы видов характеристик).
 */
export async function collectAvailableSubcontoTypes(configPath: string): Promise<AvailableSubcontoType[]> {
  const cotsDir = path.join(configPath, 'ChartsOfCharacteristicTypes');
  try {
    const entries = await fs.promises.readdir(cotsDir, { withFileTypes: true });
    const result: AvailableSubcontoType[] = [];
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.xml') && !entry.name.endsWith('.form.xml')) {
        const name = entry.name.slice(0, -4);
        result.push({
          ref: `ChartOfCharacteristicTypes.${name}`,
          name,
          label: `План видов характеристик: ${name}`,
        });
      }
    }
    result.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    return result;
  } catch {
    return [];
  }
}

/**
 * Generate platform-compliant 1C Designer XML for ChartOfAccounts.
 */
export function generateChartOfAccountsXml(
  params: ChartOfAccountsWizardParams,
  targetVersion: string = '2.20'
): string {
  const name = escapeXml(params.name.trim());
  const synonym = escapeXml((params.synonym || params.name).trim());
  const comment = params.comment ? escapeXml(params.comment.trim()) : '';
  const uuid = XMLWriter.generateSimpleUuid();

  // All 7 GeneratedTypes required by 1C platform
  const typeIdObject = XMLWriter.generateSimpleUuid();
  const valueIdObject = XMLWriter.generateSimpleUuid();
  const typeIdRef = XMLWriter.generateSimpleUuid();
  const valueIdRef = XMLWriter.generateSimpleUuid();
  const typeIdSelection = XMLWriter.generateSimpleUuid();
  const valueIdSelection = XMLWriter.generateSimpleUuid();
  const typeIdList = XMLWriter.generateSimpleUuid();
  const valueIdList = XMLWriter.generateSimpleUuid();
  const typeIdManager = XMLWriter.generateSimpleUuid();
  const valueIdManager = XMLWriter.generateSimpleUuid();
  const typeIdExtDimensionTypes = XMLWriter.generateSimpleUuid();
  const valueIdExtDimensionTypes = XMLWriter.generateSimpleUuid();
  const typeIdExtDimensionTypesRow = XMLWriter.generateSimpleUuid();
  const valueIdExtDimensionTypesRow = XMLWriter.generateSimpleUuid();

  const codeMask = params.codeMask !== undefined ? escapeXml(params.codeMask) : '@@@.@@.@';
  const codeLength = params.codeLength ?? 8;
  const descriptionLength = params.descriptionLength ?? 120;
  const orderLength = params.orderLength ?? 5;
  const codeSeries = params.codeSeries ?? 'WholeChartOfAccounts';
  const checkUnique = params.checkUnique !== false ? 'true' : 'false';
  const useStandardCommands = params.useStandardCommands !== false ? 'true' : 'false';

  const hasSubconto = Boolean(params.extDimensionTypes && params.extDimensionTypes.trim());
  const extDimensionTypesTag = hasSubconto
    ? `<ExtDimensionTypes>${escapeXml(params.extDimensionTypes!.trim())}</ExtDimensionTypes>`
    : '<ExtDimensionTypes/>';
  const maxExtDimensionCount = hasSubconto
    ? (params.maxExtDimensionCount !== undefined ? params.maxExtDimensionCount : 3)
    : 0;

  const commentTag = comment ? `<Comment>${comment}</Comment>` : '<Comment/>';

  let childObjectsXml = '';
  if (params.accountingFlags && params.accountingFlags.length > 0) {
    for (const flag of params.accountingFlags) {
      const fUuid = XMLWriter.generateSimpleUuid();
      const fName = escapeXml(flag.name.trim());
      const fSynonym = escapeXml((flag.synonym || flag.name).trim());
      const fType = flag.type ? escapeXml(flag.type.trim()) : 'xs:boolean';
      childObjectsXml += `\t\t\t<AccountingFlag uuid="${fUuid}">
\t\t\t\t<Properties>
\t\t\t\t\t<Name>${fName}</Name>
\t\t\t\t\t<Synonym>
\t\t\t\t\t\t<v8:item>
\t\t\t\t\t\t\t<v8:lang>ru</v8:lang>
\t\t\t\t\t\t\t<v8:content>${fSynonym}</v8:content>
\t\t\t\t\t\t</v8:item>
\t\t\t\t\t</Synonym>
\t\t\t\t\t<Comment/>
\t\t\t\t\t<Type>
\t\t\t\t\t\t<v8:Type>${fType}</v8:Type>
\t\t\t\t\t</Type>
\t\t\t\t\t<PasswordMode>false</PasswordMode>
\t\t\t\t\t<Format/>
\t\t\t\t\t<EditFormat/>
\t\t\t\t\t<ToolTip/>
\t\t\t\t\t<MarkNegatives>false</MarkNegatives>
\t\t\t\t\t<Mask/>
\t\t\t\t\t<MultiLine>false</MultiLine>
\t\t\t\t\t<ExtendedEdit>false</ExtendedEdit>
\t\t\t\t\t<MinValue xsi:nil="true"/>
\t\t\t\t\t<MaxValue xsi:nil="true"/>
\t\t\t\t\t<FillFromFillingValue>false</FillFromFillingValue>
\t\t\t\t\t<FillValue xsi:nil="true"/>
\t\t\t\t\t<FillChecking>DontCheck</FillChecking>
\t\t\t\t\t<ChoiceFoldersAndItems>Items</ChoiceFoldersAndItems>
\t\t\t\t\t<ChoiceParameterLinks/>
\t\t\t\t\t<ChoiceParameters/>
\t\t\t\t\t<QuickChoice>Auto</QuickChoice>
\t\t\t\t\t<CreateOnInput>Auto</CreateOnInput>
\t\t\t\t\t<ChoiceForm/>
\t\t\t\t\t<LinkByType/>
\t\t\t\t\t<ChoiceHistoryOnInput>Auto</ChoiceHistoryOnInput>
\t\t\t\t\t<DataHistory>Use</DataHistory>
\t\t\t\t</Properties>
\t\t\t</AccountingFlag>\n`;
    }
  }

  if (params.extDimensionAccountingFlags && params.extDimensionAccountingFlags.length > 0) {
    for (const flag of params.extDimensionAccountingFlags) {
      const fUuid = XMLWriter.generateSimpleUuid();
      const fName = escapeXml(flag.name.trim());
      const fSynonym = escapeXml((flag.synonym || flag.name).trim());
      const fType = flag.type ? escapeXml(flag.type.trim()) : 'xs:boolean';
      childObjectsXml += `\t\t\t<ExtDimensionAccountingFlag uuid="${fUuid}">
\t\t\t\t<Properties>
\t\t\t\t\t<Name>${fName}</Name>
\t\t\t\t\t<Synonym>
\t\t\t\t\t\t<v8:item>
\t\t\t\t\t\t\t<v8:lang>ru</v8:lang>
\t\t\t\t\t\t\t<v8:content>${fSynonym}</v8:content>
\t\t\t\t\t\t</v8:item>
\t\t\t\t\t</Synonym>
\t\t\t\t\t<Comment/>
\t\t\t\t\t<Type>
\t\t\t\t\t\t<v8:Type>${fType}</v8:Type>
\t\t\t\t\t</Type>
\t\t\t\t\t<PasswordMode>false</PasswordMode>
\t\t\t\t\t<Format/>
\t\t\t\t\t<EditFormat/>
\t\t\t\t\t<ToolTip/>
\t\t\t\t\t<MarkNegatives>false</MarkNegatives>
\t\t\t\t\t<Mask/>
\t\t\t\t\t<MultiLine>false</MultiLine>
\t\t\t\t\t<ExtendedEdit>false</ExtendedEdit>
\t\t\t\t\t<MinValue xsi:nil="true"/>
\t\t\t\t\t<MaxValue xsi:nil="true"/>
\t\t\t\t\t<FillFromFillingValue>false</FillFromFillingValue>
\t\t\t\t\t<FillValue xsi:nil="true"/>
\t\t\t\t\t<FillChecking>DontCheck</FillChecking>
\t\t\t\t\t<ChoiceFoldersAndItems>Items</ChoiceFoldersAndItems>
\t\t\t\t\t<ChoiceParameterLinks/>
\t\t\t\t\t<ChoiceParameters/>
\t\t\t\t\t<QuickChoice>Auto</QuickChoice>
\t\t\t\t\t<CreateOnInput>Auto</CreateOnInput>
\t\t\t\t\t<ChoiceForm/>
\t\t\t\t\t<LinkByType/>
\t\t\t\t\t<ChoiceHistoryOnInput>Auto</ChoiceHistoryOnInput>
\t\t\t\t\t<DataHistory>Use</DataHistory>
\t\t\t\t</Properties>
\t\t\t</ExtDimensionAccountingFlag>\n`;
    }
  }

  const childObjectsBlock = childObjectsXml ? `<ChildObjects>\n${childObjectsXml}\t\t</ChildObjects>` : '<ChildObjects/>';

  const rawXml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:cmi="http://v8.1c.ru/8.2/managed-application/cmi" xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform" xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" xmlns:xen="http://v8.1c.ru/8.3/xcf/enums" xmlns:xpr="http://v8.1c.ru/8.3/xcf/predef" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="${targetVersion}">
\t<ChartOfAccounts uuid="${uuid}">
\t\t<InternalInfo>
\t\t\t<xr:GeneratedType name="ChartOfAccountsObject.${name}" category="Object">
\t\t\t\t<xr:TypeId>${typeIdObject}</xr:TypeId>
\t\t\t\t<xr:ValueId>${valueIdObject}</xr:ValueId>
\t\t\t</xr:GeneratedType>
\t\t\t<xr:GeneratedType name="ChartOfAccountsRef.${name}" category="Ref">
\t\t\t\t<xr:TypeId>${typeIdRef}</xr:TypeId>
\t\t\t\t<xr:ValueId>${valueIdRef}</xr:ValueId>
\t\t\t</xr:GeneratedType>
\t\t\t<xr:GeneratedType name="ChartOfAccountsSelection.${name}" category="Selection">
\t\t\t\t<xr:TypeId>${typeIdSelection}</xr:TypeId>
\t\t\t\t<xr:ValueId>${valueIdSelection}</xr:ValueId>
\t\t\t</xr:GeneratedType>
\t\t\t<xr:GeneratedType name="ChartOfAccountsList.${name}" category="List">
\t\t\t\t<xr:TypeId>${typeIdList}</xr:TypeId>
\t\t\t\t<xr:ValueId>${valueIdList}</xr:ValueId>
\t\t\t</xr:GeneratedType>
\t\t\t<xr:GeneratedType name="ChartOfAccountsManager.${name}" category="Manager">
\t\t\t\t<xr:TypeId>${typeIdManager}</xr:TypeId>
\t\t\t\t<xr:ValueId>${valueIdManager}</xr:ValueId>
\t\t\t</xr:GeneratedType>
\t\t\t<xr:GeneratedType name="ChartOfAccountsExtDimensionTypes.${name}" category="ExtDimensionTypes">
\t\t\t\t<xr:TypeId>${typeIdExtDimensionTypes}</xr:TypeId>
\t\t\t\t<xr:ValueId>${valueIdExtDimensionTypes}</xr:ValueId>
\t\t\t</xr:GeneratedType>
\t\t\t<xr:GeneratedType name="ChartOfAccountsExtDimensionTypesRow.${name}" category="ExtDimensionTypesRow">
\t\t\t\t<xr:TypeId>${typeIdExtDimensionTypesRow}</xr:TypeId>
\t\t\t\t<xr:ValueId>${valueIdExtDimensionTypesRow}</xr:ValueId>
\t\t\t</xr:GeneratedType>
\t\t</InternalInfo>
\t\t<Properties>
\t\t\t<Name>${name}</Name>
\t\t\t<Synonym>
\t\t\t\t<v8:item>
\t\t\t\t\t<v8:lang>ru</v8:lang>
\t\t\t\t\t<v8:content>${synonym}</v8:content>
\t\t\t\t</v8:item>
\t\t\t</Synonym>
\t\t\t${commentTag}
\t\t\t<UseStandardCommands>${useStandardCommands}</UseStandardCommands>
\t\t\t<IncludeHelpInContents>false</IncludeHelpInContents>
\t\t\t<BasedOn/>
\t\t\t${extDimensionTypesTag}
\t\t\t<MaxExtDimensionCount>${maxExtDimensionCount}</MaxExtDimensionCount>
\t\t\t<CodeMask>${codeMask}</CodeMask>
\t\t\t<CodeLength>${codeLength}</CodeLength>
\t\t\t<DescriptionLength>${descriptionLength}</DescriptionLength>
\t\t\t<CodeSeries>${codeSeries}</CodeSeries>
\t\t\t<CheckUnique>${checkUnique}</CheckUnique>
\t\t\t<DefaultPresentation>AsDescription</DefaultPresentation>
\t\t\t<Characteristics/>
\t\t\t<PredefinedDataUpdate>Auto</PredefinedDataUpdate>
\t\t\t<EditType>InDialog</EditType>
\t\t\t<QuickChoice>false</QuickChoice>
\t\t\t<ChoiceMode>BothWays</ChoiceMode>
\t\t\t<InputByString>
\t\t\t\t<xr:Field>ChartOfAccounts.${name}.StandardAttribute.Description</xr:Field>
\t\t\t\t<xr:Field>ChartOfAccounts.${name}.StandardAttribute.Code</xr:Field>
\t\t\t</InputByString>
\t\t\t<CreateOnInput>DontUse</CreateOnInput>
\t\t\t<SearchStringModeOnInputByString>Begin</SearchStringModeOnInputByString>
\t\t\t<ChoiceDataGetModeOnInputByString>Directly</ChoiceDataGetModeOnInputByString>
\t\t\t<FullTextSearchOnInputByString>DontUse</FullTextSearchOnInputByString>
\t\t\t<ChoiceHistoryOnInput>Auto</ChoiceHistoryOnInput>
\t\t\t<DefaultObjectForm/>
\t\t\t<DefaultListForm/>
\t\t\t<DefaultChoiceForm/>
\t\t\t<AuxiliaryObjectForm/>
\t\t\t<AuxiliaryListForm/>
\t\t\t<AuxiliaryChoiceForm/>
\t\t\t<AutoOrderByCode>true</AutoOrderByCode>
\t\t\t<OrderLength>${orderLength}</OrderLength>
\t\t\t<DataLockFields/>
\t\t\t<DataLockControlMode>Managed</DataLockControlMode>
\t\t\t<FullTextSearch>Use</FullTextSearch>
\t\t\t<ObjectPresentation/>
\t\t\t<ExtendedObjectPresentation/>
\t\t\t<ListPresentation/>
\t\t\t<ExtendedListPresentation/>
\t\t\t<Explanation/>
\t\t\t<DataHistory>DontUse</DataHistory>
\t\t\t<UpdateDataHistoryImmediatelyAfterWrite>false</UpdateDataHistoryImmediatelyAfterWrite>
\t\t\t<ExecuteAfterWriteDataHistoryVersionProcessing>false</ExecuteAfterWriteDataHistoryVersionProcessing>
\t\t</Properties>
\t\t${childObjectsBlock}
\t</ChartOfAccounts>
</MetaDataObject>
`;

  return normalizeMetaDataObjectRoot(rawXml, targetVersion);
}

/**
 * Generate platform-compliant Ext/Predefined.xml for ChartOfAccounts.
 */
export function generatePredefinedAccountsXml(
  params: ChartOfAccountsWizardParams,
  targetVersion: string = '2.20'
): string {
  const accounts = params.predefinedAccounts || [];
  if (accounts.length === 0) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<PredefinedData xmlns="http://v8.1c.ru/8.3/xcf/predef" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="ChartOfAccountsPredefinedItems" version="${targetVersion}"/>
`;
  }

  let itemsXml = '';
  for (const acc of accounts) {
    const id = XMLWriter.generateSimpleUuid();
    const name = escapeXml(acc.name.trim());
    const code = escapeXml(acc.code.trim());
    const desc = escapeXml((acc.description || acc.name).trim());
    const accountType = acc.accountType || 'ActivePassive';
    const offBalance = acc.offBalance === true ? 'true' : 'false';
    const order = escapeXml((acc.order !== undefined ? acc.order : acc.code).trim());

    itemsXml += `\t<Item id="${id}">
\t\t<Name>${name}</Name>
\t\t<Code>${code}</Code>
\t\t<Description>${desc}</Description>
\t\t<AccountType>${accountType}</AccountType>
\t\t<OffBalance>${offBalance}</OffBalance>
\t\t<Order>${order}</Order>
\t\t<AccountingFlags/>
\t\t<ExtDimensionTypes/>
\t</Item>\n`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<PredefinedData xmlns="http://v8.1c.ru/8.3/xcf/predef" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="ChartOfAccountsPredefinedItems" version="${targetVersion}">
${itemsXml}</PredefinedData>
`;
}

/**
 * Plan creation of ChartOfAccounts as an atomic MutationPlan.
 */
export async function planCreateChartOfAccounts(
  options: PlanCreateChartOfAccountsOptions
): Promise<MutationPlan<AgentResult<{ filePath: string }>>> {
  const { configPath, params } = options;
  const name = params.name.trim();

  const validationError = validateElementName(name, []);
  if (validationError) {
    throw new Error(`Имя плана счетов неверно: ${validationError}`);
  }

  const coasDir = path.join(configPath, 'ChartsOfAccounts');
  const coaXmlPath = path.join(coasDir, `${name}.xml`);
  const coaChildDir = path.join(coasDir, name);
  const extDir = path.join(coaChildDir, 'Ext');
  const predefinedXmlPath = path.join(extDir, 'Predefined.xml');
  const configXmlPath = path.join(configPath, CONFIGURATION_XML);

  const fileExpected = await expectationForPath(coaXmlPath);
  if (fileExpected.state !== 'missing') {
    throw new Error(`План счетов с именем «${name}» уже существует.`);
  }

  const configurationContent = await fs.promises.readFile(configXmlPath, 'utf8');
  const targetVersion = requireProjectWriteFormatProfile(configurationContent).version;

  const nextConfigurationContent = buildRootObjectConfigurationContent(configurationContent, {
    type: 'add',
    rootTag: 'ChartOfAccounts',
    objectName: name,
  });

  const coaXmlContent = generateChartOfAccountsXml(params, targetVersion);
  const predefinedContent = generatePredefinedAccountsXml(params, targetVersion);
  const predefinedExpected = await expectationForPath(predefinedXmlPath);

  const steps: MutationStep[] = [
    { type: 'ensureDirectory', targetPath: coasDir },
    { type: 'writeFile', targetPath: coaXmlPath, content: coaXmlContent, encoding: 'utf8', expected: fileExpected },
    { type: 'ensureDirectory', targetPath: coaChildDir },
    { type: 'ensureDirectory', targetPath: extDir },
    { type: 'writeFile', targetPath: predefinedXmlPath, content: predefinedContent, encoding: 'utf8', expected: predefinedExpected },
    {
      type: 'writeFile',
      targetPath: configXmlPath,
      content: nextConfigurationContent,
      encoding: 'utf8',
      expected: { state: 'file', hash: hashContent(configurationContent) },
    },
  ];

  return {
    kind: 'chartOfAccounts.create',
    steps,
    result: {
      success: true,
      data: {
        filePath: coaXmlPath,
      },
    },
  };
}
