/**
 * Append or create Designer `Ext/Predefined.xml` items (Catalog / COT / ChartOfAccounts).
 */
import * as fs from 'fs';
import * as path from 'path';
import { MetadataType } from '../../models/treeNode';
import { xmlParser } from './xmlCore';
import { buildXmlString, writeUtf8FileWithBackup } from './xmlFileIo';
import { generateSimpleUuid } from './xmlHelpers';

function escapeXmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const PREDEFINED_ROOT_OPEN: Partial<Record<MetadataType, string>> = {
  [MetadataType.Catalog]: `<PredefinedData xmlns="http://v8.1c.ru/8.3/xcf/predef" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CatalogPredefinedItems" version="2.20">`,
  [MetadataType.ChartOfCharacteristicTypes]: `<PredefinedData xmlns="http://v8.1c.ru/8.3/xcf/predef" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="PlanOfCharacteristicKindPredefinedItems" version="2.20">`,
  [MetadataType.ChartOfAccounts]: `<PredefinedData xmlns="http://v8.1c.ru/8.3/xcf/predef" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="ChartOfAccountsPredefinedItems" version="2.20">`,
};

function findPredefinedDataRoot(parsed: Record<string, unknown>): Record<string, unknown> | null {
  for (const [key, val] of Object.entries(parsed)) {
    if (key === 'PredefinedData' || key.endsWith(':PredefinedData')) {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        return val as Record<string, unknown>;
      }
    }
  }
  return null;
}

function mergeItemIntoPredefinedRoot(root: Record<string, unknown>, item: Record<string, unknown>): void {
  const raw = root.Item;
  if (raw === undefined || raw === null) {
    root.Item = item;
    return;
  }
  if (Array.isArray(raw)) {
    raw.push(item);
    return;
  }
  root.Item = [raw, item];
}

function buildCatalogItemObject(name: string, description: string): Record<string, unknown> {
  return {
    '@_id': generateSimpleUuid(),
    Name: name,
    Code: '',
    Description: description || name,
    IsFolder: 'false',
  };
}

function buildCotItemObject(name: string, description: string): Record<string, unknown> {
  return {
    '@_id': generateSimpleUuid(),
    Name: name,
    Code: name.slice(0, 9),
    Description: description || name,
    Type: {
      'v8:Type': 'xs:string',
      'v8:StringQualifiers': {
        'v8:Length': '150',
        'v8:AllowedLength': 'Variable',
      },
    },
    IsFolder: 'false',
  };
}

function buildChartOfAccountsItemObject(name: string, description: string): Record<string, unknown> {
  const code = name.slice(0, 8);
  return {
    '@_id': generateSimpleUuid(),
    Name: name,
    Code: code,
    Description: description || name,
    AccountType: 'ActivePassive',
    OffBalance: 'false',
    Order: code,
    AccountingFlags: '',
    ExtDimensionTypes: '',
  };
}

function buildNewPredefinedFileContent(ownerType: MetadataType, name: string, description: string): string {
  const open = PREDEFINED_ROOT_OPEN[ownerType];
  if (!open) {
    throw new Error('Unsupported predefined root');
  }
  const en = escapeXmlText(name);
  const ed = escapeXmlText(description || name);
  const id = generateSimpleUuid();

  if (ownerType === MetadataType.Catalog) {
    return `<?xml version="1.0" encoding="UTF-8"?>
${open}
	<Item id="${id}">
		<Name>${en}</Name>
		<Code/>
		<Description>${ed}</Description>
		<IsFolder>false</IsFolder>
	</Item>
</PredefinedData>
`;
  }

  if (ownerType === MetadataType.ChartOfCharacteristicTypes) {
    const code = escapeXmlText(name.slice(0, 9));
    return `<?xml version="1.0" encoding="UTF-8"?>
${open}
	<Item id="${id}">
		<Name>${en}</Name>
		<Code>${code}</Code>
		<Description>${ed}</Description>
		<Type>
			<v8:Type>xs:string</v8:Type>
			<v8:StringQualifiers>
				<v8:Length>150</v8:Length>
				<v8:AllowedLength>Variable</v8:AllowedLength>
			</v8:StringQualifiers>
		</Type>
		<IsFolder>false</IsFolder>
	</Item>
</PredefinedData>
`;
  }

  // ChartOfAccounts — minimal valid-looking entry; refine in Конфигуратор if needed.
  const code = escapeXmlText(name.slice(0, 8));
  return `<?xml version="1.0" encoding="UTF-8"?>
${open}
	<Item id="${id}">
		<Name>${en}</Name>
		<Code>${code}</Code>
		<Description>${ed}</Description>
		<AccountType>ActivePassive</AccountType>
		<OffBalance>false</OffBalance>
		<Order>${code}</Order>
		<AccountingFlags/>
		<ExtDimensionTypes/>
	</Item>
</PredefinedData>
`;
}

function buildItemObjectForMerge(ownerType: MetadataType, name: string, description: string): Record<string, unknown> {
  switch (ownerType) {
    case MetadataType.Catalog:
      return buildCatalogItemObject(name, description);
    case MetadataType.ChartOfCharacteristicTypes:
      return buildCotItemObject(name, description);
    case MetadataType.ChartOfAccounts:
      return buildChartOfAccountsItemObject(name, description);
    default:
      throw new Error('Unsupported predefined owner');
  }
}

/**
 * Create `Ext/Predefined.xml` if missing, or append `<Item>` for supported owner types.
 */
export async function appendPredefinedDesignerItem(
  filePath: string,
  ownerType: MetadataType,
  name: string,
  description?: string
): Promise<void> {
  if (!PREDEFINED_ROOT_OPEN[ownerType]) {
    throw new Error('Предопределённые элементы для этого типа объекта создаются только в XML вручную.');
  }
  const desc = description ?? name;

  let xmlContent: string;
  try {
    xmlContent = await fs.promises.readFile(filePath, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      const body = buildNewPredefinedFileContent(ownerType, name, desc);
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, body, 'utf-8');
      return;
    }
    throw e;
  }

  let parsed: unknown;
  try {
    parsed = xmlParser.parse(xmlContent);
  } catch (parseErr) {
    const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    throw new Error(`Не удалось разобрать Predefined.xml: ${msg}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Некорректное содержимое Predefined.xml');
  }
  const root = findPredefinedDataRoot(parsed as Record<string, unknown>);
  if (!root) {
    throw new Error('В Predefined.xml не найден корень PredefinedData');
  }
  mergeItemIntoPredefinedRoot(root, buildItemObjectForMerge(ownerType, name, desc));
  const updated = buildXmlString(parsed);
  await writeUtf8FileWithBackup(filePath, xmlContent, updated);
}
