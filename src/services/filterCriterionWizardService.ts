import * as path from 'path';
import * as fs from 'fs';
import { XMLWriter } from '../utils/XMLWriter';
import { validateElementName } from '../utils/elementNameValidator';
import { XmlParser } from '../parsers/xmlParser';
import { hashContent } from './configurationSession/atomicFileStorage';
import type { MutationExpectation, MutationPlan } from './configurationSession/mutationPlan';
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

export interface FilterCriterionWizardParams {
  name: string;
  synonym?: string;
  comment?: string;
  types: string[];
  content: string[];
  useStandardCommands?: boolean;
}

export interface AvailableFilterType {
  typeRef: string;
  label: string;
  category: 'catalog' | 'document' | 'enum' | 'primitive' | 'other';
}

export interface AvailableFilterCandidate {
  ref: string;
  label: string;
  detail?: string;
  typeRefs: string[];
  matchesSelectedType: boolean;
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
 * Generate 1C Designer XML for FilterCriterion.
 */
export function generateFilterCriterionXml(
  params: FilterCriterionWizardParams,
  targetVersion: string = '2.20'
): string {
  const name = escapeXml(params.name.trim());
  const synonym = escapeXml((params.synonym || params.name).trim());
  const comment = params.comment ? escapeXml(params.comment.trim()) : '';
  const uuid = XMLWriter.generateSimpleUuid();
  const typeIdManager = XMLWriter.generateSimpleUuid();
  const valueIdManager = XMLWriter.generateSimpleUuid();
  const typeIdList = XMLWriter.generateSimpleUuid();
  const valueIdList = XMLWriter.generateSimpleUuid();

  const typesXml = params.types.length > 0
    ? params.types.map((t) => `\t\t\t\t<v8:Type>${escapeXml(t.trim())}</v8:Type>`).join('\n')
    : '\t\t\t\t<v8:Type>xs:string</v8:Type>';

  const contentRefs = (params.content || []).map((c) => c.trim()).filter((c) => c.length > 0);
  if (contentRefs.length === 0) {
    throw new Error('FilterCriterion content must contain at least one metadata item reference');
  }

  const contentXml = contentRefs
    .map((c) => `\t\t\t\t<xr:Item xsi:type="xr:MDObjectRef">${escapeXml(c)}</xr:Item>`)
    .join('\n');

  const commentXml = comment ? `<Comment>${comment}</Comment>` : '<Comment/>';
  const contentWrapper = `<Content>\n${contentXml}\n\t\t\t</Content>`;
  const useStandardCommands = params.useStandardCommands === true ? 'true' : 'false';

  const rawXml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:cmi="http://v8.1c.ru/8.2/managed-application/cmi" xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform" xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" xmlns:xen="http://v8.1c.ru/8.3/xcf/enums" xmlns:xpr="http://v8.1c.ru/8.3/xcf/predef" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="${targetVersion}">
	<FilterCriterion uuid="${uuid}">
		<InternalInfo>
			<xr:GeneratedType name="FilterCriterionManager.${name}" category="Manager">
				<xr:TypeId>${typeIdManager}</xr:TypeId>
				<xr:ValueId>${valueIdManager}</xr:ValueId>
			</xr:GeneratedType>
			<xr:GeneratedType name="FilterCriterionList.${name}" category="List">
				<xr:TypeId>${typeIdList}</xr:TypeId>
				<xr:ValueId>${valueIdList}</xr:ValueId>
			</xr:GeneratedType>
		</InternalInfo>
		<Properties>
			<Name>${name}</Name>
			<Synonym>
				<v8:item>
					<v8:lang>ru</v8:lang>
					<v8:content>${synonym}</v8:content>
				</v8:item>
			</Synonym>
			${commentXml}
			<Type>
${typesXml}
			</Type>
			<UseStandardCommands>${useStandardCommands}</UseStandardCommands>
			${contentWrapper}
			<DefaultForm/>
			<AuxiliaryForm/>
			<ListPresentation/>
			<ExtendedListPresentation/>
			<Explanation/>
		</Properties>
		<ChildObjects/>
	</FilterCriterion>
</MetaDataObject>`;

  return normalizeMetaDataObjectRoot(rawXml, targetVersion);
}

/**
 * Scan configuration directory for available reference and primitive types.
 */
export async function collectAvailableFilterTypes(configRoot: string): Promise<AvailableFilterType[]> {
  const results: AvailableFilterType[] = [];

  const typeFolderMappings: Array<{ folder: string; category: AvailableFilterType['category']; prefix: string; labelPrefix: string }> = [
    { folder: 'Catalogs', category: 'catalog', prefix: 'cfg:CatalogRef.', labelPrefix: 'Справочник' },
    { folder: 'Documents', category: 'document', prefix: 'cfg:DocumentRef.', labelPrefix: 'Документ' },
    { folder: 'Enums', category: 'enum', prefix: 'cfg:EnumRef.', labelPrefix: 'Перечисление' },
    { folder: 'ExchangePlans', category: 'other', prefix: 'cfg:ExchangePlanRef.', labelPrefix: 'План обмена' },
    { folder: 'ChartsOfAccounts', category: 'other', prefix: 'cfg:ChartOfAccountsRef.', labelPrefix: 'План счетов' },
    { folder: 'ChartsOfCharacteristicTypes', category: 'other', prefix: 'cfg:ChartOfCharacteristicTypesRef.', labelPrefix: 'План видов характеристик' },
  ];

  for (const mapping of typeFolderMappings) {
    const dirPath = path.join(configRoot, mapping.folder);
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.xml')) {
          const objName = entry.name.slice(0, -4);
          results.push({
            typeRef: `${mapping.prefix}${objName}`,
            label: `${mapping.labelPrefix}: ${objName}`,
            category: mapping.category,
          });
        }
      }
    } catch {
      // directory does not exist or inaccessible
    }
  }

  // Primitive types
  results.push(
    { typeRef: 'xs:string', label: 'Строка (xs:string)', category: 'primitive' },
    { typeRef: 'xs:decimal', label: 'Число (xs:decimal)', category: 'primitive' },
    { typeRef: 'xs:boolean', label: 'Булево (xs:boolean)', category: 'primitive' },
    { typeRef: 'xs:dateTime', label: 'Дата (xs:dateTime)', category: 'primitive' }
  );

  return results;
}

function extractTypesFromXmlObject(typeNode: unknown): string[] {
  if (!typeNode || typeof typeNode !== 'object') {
    return [];
  }
  const obj = typeNode as Record<string, unknown>;
  const v8Type = obj['v8:Type'] || obj['Type'];
  if (!v8Type) {
    return [];
  }
  if (Array.isArray(v8Type)) {
    return v8Type
      .map((v) => {
        if (typeof v === 'string') {
          return v.trim();
        }
        if (typeof v === 'object' && v !== null) {
          const rec = v as Record<string, unknown>;
          return typeof rec['#text'] === 'string' ? rec['#text'].trim() : '';
        }
        return '';
      })
      .filter(Boolean);
  }
  if (typeof v8Type === 'string') {
    return [v8Type.trim()];
  }
  if (typeof v8Type === 'object' && v8Type !== null) {
    const rec = v8Type as Record<string, unknown>;
    return typeof rec['#text'] === 'string' ? [rec['#text'].trim()] : [];
  }
  return [];
}

/**
 * Scan configuration objects to collect attributes that can participate in FilterCriterion Content.
 */
export async function collectAvailableFilterCandidates(
  configRoot: string,
  selectedTypes: string[]
): Promise<AvailableFilterCandidate[]> {
  const candidates: AvailableFilterCandidate[] = [];
  const selectedTypesSet = new Set(selectedTypes.map((t) => t.trim()));

  const targetFolders = [
    { folder: 'Catalogs', singular: 'Catalog', label: 'Справочник' },
    { folder: 'Documents', singular: 'Document', label: 'Документ' },
    { folder: 'InformationRegisters', singular: 'InformationRegister', label: 'Регистр сведений' },
    { folder: 'AccumulationRegisters', singular: 'AccumulationRegister', label: 'Регистр накопления' },
  ];

  for (const target of targetFolders) {
    const dirPath = path.join(configRoot, target.folder);
    try {
      const files = await fs.promises.readdir(dirPath);
      for (const file of files) {
        if (!file.endsWith('.xml')) {
          continue;
        }
        const filePath = path.join(dirPath, file);
        try {
          const content = await fs.promises.readFile(filePath, 'utf-8');
          const parsed = XmlParser.parseString(content) as Record<string, unknown>;
          const metaDataObject = (parsed.MetaDataObject || {}) as Record<string, unknown>;
          const rootObj = (metaDataObject[target.singular] || {}) as Record<string, unknown>;
          if (!rootObj || Object.keys(rootObj).length === 0) {
            continue;
          }
          const props = (rootObj.Properties || {}) as Record<string, unknown>;
          const objectName = typeof props.Name === 'string' ? props.Name : file.slice(0, -4);
          const childObjects = (rootObj.ChildObjects || {}) as Record<string, unknown>;

          // Top-level attributes
          const rawAttrs = childObjects.Attribute;
          const attributes: Record<string, unknown>[] = Array.isArray(rawAttrs)
            ? (rawAttrs as Record<string, unknown>[])
            : rawAttrs && typeof rawAttrs === 'object'
              ? [rawAttrs as Record<string, unknown>]
              : [];
          for (const attr of attributes) {
            const attrProps = (attr.Properties || {}) as Record<string, unknown>;
            const attrName = typeof attrProps.Name === 'string' ? attrProps.Name : undefined;
            if (!attrName) {
              continue;
            }
            const types = extractTypesFromXmlObject(attrProps.Type);
            const matches = types.some((t) => selectedTypesSet.has(t) || selectedTypesSet.has(t.replace('cfg:', '')));
            candidates.push({
              ref: `${target.singular}.${objectName}.Attribute.${attrName}`,
              label: `${target.label} ${objectName} → Реквизит: ${attrName}`,
              detail: types.join(', '),
              typeRefs: types,
              matchesSelectedType: matches,
            });
          }

          // Tabular sections attributes
          const rawTS = childObjects.TabularSection;
          const tabularSections: Record<string, unknown>[] = Array.isArray(rawTS)
            ? (rawTS as Record<string, unknown>[])
            : rawTS && typeof rawTS === 'object'
              ? [rawTS as Record<string, unknown>]
              : [];
          for (const ts of tabularSections) {
            const tsProps = (ts.Properties || {}) as Record<string, unknown>;
            const tsName = typeof tsProps.Name === 'string' ? tsProps.Name : undefined;
            if (!tsName) {
              continue;
            }
            const tsChildObjects = (ts.ChildObjects || {}) as Record<string, unknown>;
            const rawTsAttrs = tsChildObjects.Attribute;
            const tsAttrs: Record<string, unknown>[] = Array.isArray(rawTsAttrs)
              ? (rawTsAttrs as Record<string, unknown>[])
              : rawTsAttrs && typeof rawTsAttrs === 'object'
                ? [rawTsAttrs as Record<string, unknown>]
                : [];
            for (const tsAttr of tsAttrs) {
              const tsAttrProps = (tsAttr.Properties || {}) as Record<string, unknown>;
              const tsAttrName = typeof tsAttrProps.Name === 'string' ? tsAttrProps.Name : undefined;
              if (!tsAttrName) {
                continue;
              }
              const types = extractTypesFromXmlObject(tsAttrProps.Type);
              const matches = types.some((t) => selectedTypesSet.has(t) || selectedTypesSet.has(t.replace('cfg:', '')));
              candidates.push({
                ref: `${target.singular}.${objectName}.TabularSection.${tsName}.Attribute.${tsAttrName}`,
                label: `${target.label} ${objectName} → ТЧ ${tsName} → Реквизит: ${tsAttrName}`,
                detail: types.join(', '),
                typeRefs: types,
                matchesSelectedType: matches,
              });
            }
          }

          // Dimensions (for registers)
          const rawDims = childObjects.Dimension;
          const dimensions: Record<string, unknown>[] = Array.isArray(rawDims)
            ? (rawDims as Record<string, unknown>[])
            : rawDims && typeof rawDims === 'object'
              ? [rawDims as Record<string, unknown>]
              : [];
          for (const dim of dimensions) {
            const dimProps = (dim.Properties || {}) as Record<string, unknown>;
            const dimName = typeof dimProps.Name === 'string' ? dimProps.Name : undefined;
            if (!dimName) {
              continue;
            }
            const types = extractTypesFromXmlObject(dimProps.Type);
            const matches = types.some((t) => selectedTypesSet.has(t) || selectedTypesSet.has(t.replace('cfg:', '')));
            candidates.push({
              ref: `${target.singular}.${objectName}.Dimension.${dimName}`,
              label: `${target.label} ${objectName} → Измерение: ${dimName}`,
              detail: types.join(', '),
              typeRefs: types,
              matchesSelectedType: matches,
            });
          }
        } catch {
          // skip invalid or non-parsable xml
        }
      }
    } catch {
      // directory does not exist
    }
  }

  // Sort matching candidates to the top, then alphabetically
  candidates.sort((a, b) => {
    if (a.matchesSelectedType && !b.matchesSelectedType) {
      return -1;
    }
    if (!a.matchesSelectedType && b.matchesSelectedType) {
      return 1;
    }
    return a.ref.localeCompare(b.ref, 'ru');
  });

  return candidates;
}

/**
 * Plan creation of FilterCriterion metadata object with multi-file effects.
 */
export async function planCreateFilterCriterion(
  configRoot: string,
  params: FilterCriterionWizardParams
): Promise<MutationPlan<AgentResult<{ filePath: string }>>> {
  const trimmedName = params.name.trim();
  const contentRefs = (params.content || []).map((c) => c.trim()).filter((c) => c.length > 0);
  if (contentRefs.length === 0) {
    throw new Error('FilterCriterion content must contain at least one metadata item reference');
  }
  const folderPath = path.join(configRoot, 'FilterCriteria');
  const filePath = path.join(folderPath, `${trimmedName}.xml`);
  const elementDir = path.join(folderPath, trimmedName);

  let existingSiblingNames: string[] = [];
  try {
    const files = await fs.promises.readdir(folderPath);
    existingSiblingNames = files.filter((f) => f.endsWith('.xml')).map((f) => f.slice(0, -4));
  } catch {
    // folder might not exist yet
  }

  const validation = validateElementName(trimmedName, existingSiblingNames);
  if (validation) {
    throw new Error(validation);
  }

  const fileExpected = await expectationForPath(filePath);
  if (fileExpected.state !== 'missing') {
    throw new Error(`Object already exists: ${filePath}`);
  }

  const configurationPath = path.join(configRoot, CONFIGURATION_XML);
  const configurationContent = await fs.promises.readFile(configurationPath, 'utf8');
  const targetVersion = requireProjectWriteFormatProfile(configurationContent).version;

  const content = generateFilterCriterionXml(params, targetVersion);
  const nextConfigurationContent = buildRootObjectConfigurationContent(configurationContent, {
    type: 'add',
    rootTag: 'FilterCriterion',
    objectName: trimmedName,
  });

  return {
    kind: 'filterCriterion.create',
    steps: [
      { type: 'ensureDirectory', targetPath: folderPath },
      { type: 'writeFile', targetPath: filePath, content, encoding: 'utf8', expected: fileExpected },
      { type: 'ensureDirectory', targetPath: elementDir },
      {
        type: 'writeFile',
        targetPath: configurationPath,
        content: nextConfigurationContent,
        encoding: 'utf8',
        expected: { state: 'file', hash: hashContent(configurationContent) },
      },
    ],
    result: { success: true, data: { filePath } },
  };
}
