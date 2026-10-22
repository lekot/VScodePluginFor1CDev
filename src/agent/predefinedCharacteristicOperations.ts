// src/agent/predefinedCharacteristicOperations.ts
// Business logic for predefined-characteristic API (no vscode dependency).

import * as fs from 'fs';
import * as path from 'path';
import { XMLParser } from 'fast-xml-parser';
import { compareCodeUnits } from '../utils/compareCodeUnits';
import { Logger } from '../utils/logger';
import { parsePredefinedCharacteristics } from '../parsers/predefinedCharacteristicsParser';
import { buildXmlString } from '../utils/xml/xmlFileIo';
import { getConfigurationMutationEngine } from '../services/configurationSession/ConfigurationMutationEngine';
import { unwrapMutationReceipt } from '../services/configurationSession/mutationReceiptError';
import { requireDocumentWriteFormatProfile } from '../utils/format/formatRank';
import type { PredefinedCharacteristicEntry } from '../types/predefinedCharacteristic';
import { AgentPathError } from './agentPathResolver';
import type { ResolvedAgentPath } from './types';
import type { ResolvedSourceAddress } from './agentSourceAddressResolver';
import { MetadataType } from '../models/treeNode';
import {
  assertNoSymlinkSegments,
  assertPathWithinRoot,
  isPathInside,
  isSamePath,
  PathBoundaryError,
} from '../services/configurationSession/pathBoundary';

// Designer folder name for COT
const COT_FOLDER = 'ChartsOfCharacteristicTypes';
// InformationRegisters folder name
const IR_FOLDER = 'InformationRegisters';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
});

// ─── Path helpers ────────────────────────────────────────────────────────────

/**
 * Normalizes a COT address or plain name into a canonical 2-segment metadata address.
 * e.g. "Shared" -> "ChartOfCharacteristicTypes.Shared"
 *      "ext:Shared" -> "ext:ChartOfCharacteristicTypes.Shared"
 *      "ChartOfCharacteristicTypes.Shared" -> "ChartOfCharacteristicTypes.Shared"
 *      "Catalog.Shared" -> "Catalog.Shared" (preserves other metadata types for authoritative validation)
 */
export function normalizeCotAddress(address: string): string {
  if (typeof address !== 'string') {
    return '';
  }
  const trimmed = address.trim();
  if (!trimmed) {
    return '';
  }
  const colonIndex = trimmed.indexOf(':');
  const prefix = colonIndex >= 0 ? trimmed.slice(0, colonIndex + 1) : '';
  const body = colonIndex >= 0 ? trimmed.slice(colonIndex + 1).trim() : trimmed;
  if (!body.includes('.')) {
    return `${prefix}ChartOfCharacteristicTypes.${body}`;
  }
  return trimmed;
}

export interface ResolvedCotTarget {
  readonly configRoot: string;
  readonly cotName: string;
  readonly cotDir: string;
}

export type CotTargetLike =
  | string
  | ResolvedCotTarget
  | ResolvedAgentPath
  | ResolvedSourceAddress;

/**
 * Resolves a COT target (either typed ResolvedAgentPath / ResolvedSourceAddress or string)
 * into a verified ResolvedCotTarget. Rejects mismatched metadata types with AgentPathError.
 */
export function resolveCotTarget(
  configRoot: string,
  target: CotTargetLike,
): ResolvedCotTarget {
  if (typeof target === 'object' && target !== null) {
    if ('cotDir' in target && typeof target.cotDir === 'string') {
      if (
        !('configRoot' in target)
        || typeof target.configRoot !== 'string'
        || !isSamePath(target.configRoot, configRoot)
        || !isValidCotName(target.cotName)
      ) {
        throw invalidCotTarget('COT target does not belong to the selected configuration.');
      }
      const expectedCotDir = path.resolve(configRoot, COT_FOLDER, target.cotName);
      if (!isPathInside(configRoot, expectedCotDir) || !isSamePath(target.cotDir, expectedCotDir)) {
        throw invalidCotTarget('COT directory is outside the selected configuration.');
      }
      return { configRoot, cotName: target.cotName, cotDir: expectedCotDir };
    }
    if (
      'configRoot' in target
      && (typeof target.configRoot !== 'string' || !isSamePath(target.configRoot, configRoot))
    ) {
      throw invalidCotTarget('COT target does not belong to the selected configuration.');
    }
    const resolvedPath = 'resolvedPath' in target ? target.resolvedPath : (target as ResolvedAgentPath);
    if (
      resolvedPath.rootTag !== 'ChartOfCharacteristicTypes' &&
      resolvedPath.rootTag !== MetadataType.ChartOfCharacteristicTypes
    ) {
      throw new AgentPathError(
        'INVALID_AGENT_PATH',
        `Expected ChartOfCharacteristicTypes path, got ${resolvedPath.rootTag}.${resolvedPath.objectName}`,
      );
    }
    const cotName = resolvedPath.objectName;
    if (!isValidCotName(cotName)) {
      throw invalidCotTarget('Invalid ChartOfCharacteristicTypes object name.');
    }
    const cotDir = path.resolve(configRoot, COT_FOLDER, cotName);
    if (!isPathInside(configRoot, cotDir)) {
      throw invalidCotTarget('COT directory is outside the selected configuration.');
    }
    return { configRoot, cotName, cotDir };
  }

  if (typeof target !== 'string' || !target.trim()) {
    throw new AgentPathError('INVALID_AGENT_PATH', 'Invalid ChartOfCharacteristicTypes path.');
  }

  const normalized = normalizeCotAddress(target);
  const colonIndex = normalized.indexOf(':');
  const dotPath = colonIndex >= 0 ? normalized.slice(colonIndex + 1).trim() : normalized.trim();
  const segments = dotPath.split('.');
  if (segments.length === 2) {
    const [rootTag, cotName] = segments;
    if (
      rootTag !== 'ChartOfCharacteristicTypes' &&
      rootTag !== MetadataType.ChartOfCharacteristicTypes
    ) {
      throw new AgentPathError(
        'INVALID_AGENT_PATH',
        `Expected ChartOfCharacteristicTypes path, got ${rootTag}.${cotName}`,
      );
    }
    if (!isValidCotName(cotName)) {
      throw invalidCotTarget('Invalid ChartOfCharacteristicTypes object name.');
    }
    const cotDir = path.resolve(configRoot, COT_FOLDER, cotName);
    if (!isPathInside(configRoot, cotDir)) {
      throw invalidCotTarget('COT directory is outside the selected configuration.');
    }
    return { configRoot, cotName, cotDir };
  }

  throw new AgentPathError(
    'INVALID_AGENT_PATH',
    `Invalid ChartOfCharacteristicTypes target: "${target}"`,
  );
}

function isValidCotName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.trim() === value
    && value !== '.'
    && value !== '..'
    && !value.includes('\0')
    && !value.includes('/')
    && !value.includes('\\');
}

function invalidCotTarget(message: string): AgentPathError {
  return new AgentPathError('INVALID_AGENT_PATH', message);
}


function predefinedXmlPath(cotDir: string): string {
  return path.join(cotDir, 'Ext', 'Predefined.xml');
}

async function assertConfiguredPathHasNoSymlinks(
  configRoot: string,
  targetPath: string,
): Promise<{ canonicalRoot: string; canonicalTarget: string }> {
  try {
    const boundary = await assertPathWithinRoot(configRoot, targetPath);
    const relativeTarget = path.relative(path.resolve(configRoot), path.resolve(targetPath));
    const canonicalLexicalTarget = path.resolve(boundary.canonicalRoot, relativeTarget);
    await assertNoSymlinkSegments(boundary.canonicalRoot, canonicalLexicalTarget);
    try {
      const stat = await fs.promises.lstat(targetPath);
      if (stat.isSymbolicLink()) {
        throw new PathBoundaryError('PATH_OUTSIDE_ROOT', `Target is a symbolic link: ${targetPath}`, targetPath);
      }
    } catch (error) {
      if (error instanceof PathBoundaryError) {
        throw error;
      }
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
    return boundary;
  } catch (error) {
    if (error instanceof PathBoundaryError) {
      throw invalidCotTarget('Predefined.xml path is not a regular path inside the selected configuration.');
    }
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

// ─── Read helpers ────────────────────────────────────────────────────────────

async function readPredefinedXml(xmlPath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(xmlPath, 'utf-8');
  } catch {
    return null;
  }
}

// ─── Type serialization for write ────────────────────────────────────────────

// http://v8.1c.ru/8.1/data/enterprise/current-config namespace used in Predefined.xml
const CURRENT_CONFIG_NS = 'http://v8.1c.ru/8.1/data/enterprise/current-config';

/**
 * Build the <Type> child object from an array of type strings.
 * cfg:CatalogRef.X → xmlns:d4p1 attribute + d4p1:CatalogRef.X text.
 * xs:* primitives stay as-is.
 */
function buildTypeObject(types: readonly string[]): Record<string, unknown> {
  if (types.length === 0) {
    return {};
  }

  const typeEntries: unknown[] = [];
  let needsCfgNs = false;

  for (const t of types) {
    if (t.startsWith('cfg:')) {
      needsCfgNs = true;
      // d4p1:CatalogRef.X
      const local = t.slice('cfg:'.length);
      typeEntries.push({ '@_xmlns:d4p1': CURRENT_CONFIG_NS, '#text': `d4p1:${local}` });
    } else {
      typeEntries.push(t);
    }
  }

  const typeNode: Record<string, unknown> = {};
  if (needsCfgNs && typeEntries.length === 1) {
    typeNode['v8:Type'] = typeEntries[0];
  } else if (typeEntries.length === 1) {
    typeNode['v8:Type'] = typeEntries[0];
  } else {
    typeNode['v8:Type'] = typeEntries;
  }
  return typeNode;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * List all predefined characteristic entries for a COT.
 */
export async function listPredefinedCharacteristics(
  configRoot: string,
  cotTarget: CotTargetLike
): Promise<PredefinedCharacteristicEntry[]> {
  const { cotDir } = resolveCotTarget(configRoot, cotTarget);
  const boundary = await assertConfiguredPathHasNoSymlinks(configRoot, predefinedXmlPath(cotDir));
  const xmlPath = boundary.canonicalTarget;
  const xml = await readPredefinedXml(xmlPath);
  await assertConfiguredPathHasNoSymlinks(configRoot, predefinedXmlPath(cotDir));
  if (!xml) {
    return [];
  }
  return parsePredefinedCharacteristics(xml);
}

/**
 * Get the type strings for a specific predefined characteristic by name.
 */
export async function getPredefinedCharacteristicType(
  configRoot: string,
  cotTarget: CotTargetLike,
  predefinedName: string
): Promise<string[]> {
  const entries = await listPredefinedCharacteristics(configRoot, cotTarget);
  const entry = entries.find((e) => e.name === predefinedName);
  if (!entry) {
    return [];
  }
  return [...entry.type];
}

/**
 * Set the type for a specific predefined characteristic by name.
 * Reads Predefined.xml, finds the Item, replaces its <Type> content, and writes back.
 */
export async function setPredefinedCharacteristicType(
  configRoot: string,
  cotTarget: CotTargetLike,
  predefinedName: string,
  types: readonly string[]
): Promise<void> {
  const { cotDir } = resolveCotTarget(configRoot, cotTarget);
  const initialBoundary = await assertConfiguredPathHasNoSymlinks(configRoot, predefinedXmlPath(cotDir));
  const xmlPath = initialBoundary.canonicalTarget;
  let transformFailureCaptured = false;
  let transformFailure: unknown;
  const receipt = await getConfigurationMutationEngine().transformFile(
    xmlPath,
    { kind: 'agent.cot.setPredefinedCharacteristicType', resourcePath: xmlPath },
    async (state) => {
      try {
        if (!state.exists) {
          throw new Error(`Predefined.xml not found: ${xmlPath}`);
        }
        const currentBoundary = await assertConfiguredPathHasNoSymlinks(
          configRoot,
          predefinedXmlPath(cotDir),
        );
        if (!isSamePath(xmlPath, currentBoundary.canonicalTarget)) {
          throw invalidCotTarget('Predefined.xml target changed while the update was being prepared.');
        }
        requireDocumentWriteFormatProfile(state.content);

        let parsed: unknown;
        try {
          parsed = xmlParser.parse(state.content);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`Failed to parse Predefined.xml: ${msg}`);
        }

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Invalid Predefined.xml structure');
        }

        let root: Record<string, unknown> | null = null;
        for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
          if ((key === 'PredefinedData' || key.endsWith(':PredefinedData')) &&
              val && typeof val === 'object' && !Array.isArray(val)) {
            root = val as Record<string, unknown>;
            break;
          }
        }

        if (!root) {
          throw new Error('PredefinedData root not found in Predefined.xml');
        }

        const rawItems = root['Item'];
        if (!rawItems) {
          throw new Error(`Item "${predefinedName}" not found`);
        }

        const itemArray = Array.isArray(rawItems)
          ? rawItems as Record<string, unknown>[]
          : [rawItems as Record<string, unknown>];
        const targetItem = itemArray.find((item) => item['Name'] === predefinedName);

        if (!targetItem) {
          throw new Error(`Predefined item "${predefinedName}" not found`);
        }

        targetItem['Type'] = buildTypeObject(types);
        return { content: buildXmlString(parsed), result: undefined };
      } catch (error) {
        transformFailureCaptured = true;
        transformFailure = error;
        throw error;
      }
    },
  );
  if (transformFailureCaptured) {
    throw transformFailure;
  }
  unwrapMutationReceipt(receipt, `Unable to update Predefined.xml: ${xmlPath}`);
  Logger.info(`setPredefinedCharacteristicType: updated "${predefinedName}" in ${xmlPath}`);
}

/**
 * Find InformationRegisters that reference this COT via Resources or Dimensions.
 * Looks for <v8:Type>...ChartOfCharacteristicTypesRef.<cotName>...</v8:Type>.
 * Returns array like ['InformationRegister.A', 'InformationRegister.B'].
 */
export async function getCharacteristicValueRegisters(
  configRoot: string,
  cotTarget: CotTargetLike
): Promise<string[]> {
  const { cotName } = resolveCotTarget(configRoot, cotTarget);
  const irDir = path.join(configRoot, IR_FOLDER);

  let irEntries: string[];
  try {
    irEntries = await fs.promises.readdir(irDir);
  } catch {
    Logger.warn(`getCharacteristicValueRegisters: InformationRegisters dir not found at ${irDir}`);
    return [];
  }

  // Pattern: ChartOfCharacteristicTypesRef.cotName (with any prefix like cfg: or d4p1:)
  const refPattern = `ChartOfCharacteristicTypesRef.${cotName}`;

  const found = new Set<string>();

  for (const entry of irEntries) {
    if (!entry.endsWith('.xml')) {
      continue;
    }
    const xmlPath = path.join(irDir, entry);
    try {
      const content = await fs.promises.readFile(xmlPath, 'utf-8');
      if (content.includes(refPattern)) {
        const regName = entry.slice(0, -4); // strip .xml
        found.add(`InformationRegister.${regName}`);
      }
    } catch (err) {
      Logger.warn(`getCharacteristicValueRegisters: failed to read ${xmlPath}`, err);
    }
  }

  return Array.from(found).sort(compareCodeUnits);
}
