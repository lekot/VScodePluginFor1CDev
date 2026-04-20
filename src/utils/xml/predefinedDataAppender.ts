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

const COT_FALLBACK_TYPE: Record<string, unknown> = {
  'v8:Type': 'xs:string',
  'v8:StringQualifiers': {
    'v8:Length': '150',
    'v8:AllowedLength': 'Variable',
  },
};

function findTypeInProperties(obj: Record<string, unknown>): Record<string, unknown> | null {
  const props = obj['Properties'];
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    const t = (props as Record<string, unknown>)['Type'];
    if (t && typeof t === 'object' && !Array.isArray(t)) {
      return t as Record<string, unknown>;
    }
  }
  return null;
}

function extractCotTypeFromParsed(parsed: Record<string, unknown>): Record<string, unknown> | null {
  for (const val of Object.values(parsed)) {
    if (!val || typeof val !== 'object' || Array.isArray(val)) {
      continue;
    }
    const level1 = val as Record<string, unknown>;
    const direct = findTypeInProperties(level1);
    if (direct) {
      return direct;
    }
    for (const inner of Object.values(level1)) {
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        const found = findTypeInProperties(inner as Record<string, unknown>);
        if (found) {
          return found;
        }
      }
    }
  }
  return null;
}

async function readCotOwnerType(ownerFilePath: string | undefined): Promise<Record<string, unknown>> {
  if (!ownerFilePath) {
    return COT_FALLBACK_TYPE;
  }
  try {
    const content = await fs.promises.readFile(ownerFilePath, 'utf-8');
    const parsed = xmlParser.parse(content) as Record<string, unknown>;
    const extracted = extractCotTypeFromParsed(parsed);
    if (!extracted) {
      return COT_FALLBACK_TYPE;
    }
    const firstType = Array.isArray(extracted['v8:Type']) ? extracted['v8:Type'][0] : extracted['v8:Type'];
    if (!firstType || typeof firstType !== 'string') {
      return COT_FALLBACK_TYPE;
    }
    const result: Record<string, unknown> = { 'v8:Type': firstType };
    const qualifierKeys = Object.keys(extracted).filter((k) => k !== 'v8:Type');
    for (const key of qualifierKeys) {
      result[key] = extracted[key];
    }
    return result;
  } catch {
    return COT_FALLBACK_TYPE;
  }
}

function buildCotItemObject(name: string, description: string, ownerType: Record<string, unknown>): Record<string, unknown> {
  return {
    '@_id': generateSimpleUuid(),
    Name: name,
    Code: name.slice(0, 9),
    Description: description || name,
    Type: ownerType,
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

function buildNewPredefinedFileContent(
  ownerType: MetadataType,
  name: string,
  description: string,
  cotResolvedType?: Record<string, unknown>
): string {
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
    const typeXml = buildCotTypeXml(cotResolvedType ?? COT_FALLBACK_TYPE);
    return `<?xml version="1.0" encoding="UTF-8"?>
${open}
	<Item id="${id}">
		<Name>${en}</Name>
		<Code>${code}</Code>
		<Description>${ed}</Description>
		<Type>
${typeXml}
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

function buildItemObjectForMerge(
  ownerType: MetadataType,
  name: string,
  description: string,
  cotResolvedType?: Record<string, unknown>
): Record<string, unknown> {
  switch (ownerType) {
    case MetadataType.Catalog:
      return buildCatalogItemObject(name, description);
    case MetadataType.ChartOfCharacteristicTypes:
      return buildCotItemObject(name, description, cotResolvedType ?? COT_FALLBACK_TYPE);
    case MetadataType.ChartOfAccounts:
      return buildChartOfAccountsItemObject(name, description);
    default:
      throw new Error('Unsupported predefined owner');
  }
}

function buildCotTypeXml(t: Record<string, unknown>): string {
  const typeName = String(t['v8:Type'] ?? 'xs:string');
  const qualifierKey = Object.keys(t).find((k) => k !== 'v8:Type');
  if (!qualifierKey) {
    return `\t\t\t<v8:Type>${escapeXmlText(typeName)}</v8:Type>`;
  }
  const qval = t[qualifierKey] as Record<string, unknown>;
  const inner = Object.entries(qval)
    .map(([k, v]) => `\t\t\t\t<${k}>${escapeXmlText(String(v))}</${k}>`)
    .join('\n');
  return `\t\t\t<v8:Type>${escapeXmlText(typeName)}</v8:Type>\n\t\t\t<${qualifierKey}>\n${inner}\n\t\t\t</${qualifierKey}>`;
}

/**
 * Create `Ext/Predefined.xml` if missing, or append `<Item>` for supported owner types.
 * `ownerFilePath` — path to the owner metadata XML (e.g. COT.xml) used to read its Type.
 */
export async function appendPredefinedDesignerItem(
  filePath: string,
  ownerType: MetadataType,
  name: string,
  description?: string,
  ownerFilePath?: string
): Promise<void> {
  if (!PREDEFINED_ROOT_OPEN[ownerType]) {
    throw new Error('Предопределённые элементы для этого типа объекта создаются только в XML вручную.');
  }
  const desc = description ?? name;

  const cotResolvedType =
    ownerType === MetadataType.ChartOfCharacteristicTypes
      ? await readCotOwnerType(ownerFilePath)
      : undefined;

  let xmlContent: string;
  try {
    xmlContent = await fs.promises.readFile(filePath, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      const body = buildNewPredefinedFileContent(ownerType, name, desc, cotResolvedType);
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
  mergeItemIntoPredefinedRoot(root, buildItemObjectForMerge(ownerType, name, desc, cotResolvedType));
  const updated = buildXmlString(parsed);
  await writeUtf8FileWithBackup(filePath, xmlContent, updated);
}
