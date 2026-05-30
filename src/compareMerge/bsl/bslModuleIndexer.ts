import * as fs from 'fs/promises';

import { parseBslRoutines } from '../../bsl/routineRangeProvider';
import type { BslRoutineDiagnostic, BslRoutineInfo, BslTextRange } from '../../bsl/bslRoutineTypes';
import type { CompareSide, CompareMessageSeverity } from '../domain/compareContracts';
import {
  locateMetadataFile,
  type MetadataFileSubPath,
  type MetadataLocation,
} from '../../services/metadataFileLocator';
import { MetadataType } from '../../models/treeNode';
import { MetadataTypeMapper } from '../../utils/metadataTypeMapper';

export type SupportedBslModuleKind = 'Object' | 'Manager' | 'CommonModule' | 'Form' | 'Command';

export type BslModuleDiagnosticCode =
  | 'BSL_MODULE_IDENTITY_MISMATCH'
  | 'BSL_MODULE_DUPLICATE_ROUTINE'
  | 'BSL_MODULE_PARSE_ERROR'
  | 'BSL_MODULE_READ_FAILED'
  | 'BSL_MODULE_UNSUPPORTED_KIND'
  | 'BSL_MODULE_UNSUPPORTED_PATH';

export interface BslModuleIdentity {
  sourceId: string;
  side: CompareSide;
  filePath: string;
  configRoot: string;
  metadataType: string;
  objectName: string;
  moduleKind: SupportedBslModuleKind;
  moduleId: string;
  displayName: string;
  formName?: string;
  commandName?: string;
  extensionName?: string;
}

export interface BslModuleDiagnostic {
  severity: CompareMessageSeverity;
  code: BslModuleDiagnosticCode;
  blocking: boolean;
  message: string;
  sourceId: string;
  side: CompareSide;
  filePath: string;
  moduleId?: string;
  routineName?: string;
  range?: BslTextRange;
}

export interface BslModuleIndexEntry {
  identity: BslModuleIdentity;
  routines: BslRoutineInfo[];
  diagnostics: BslModuleDiagnostic[];
}

export interface BslModuleIndexResult {
  modules: BslModuleIndexEntry[];
  diagnostics: BslModuleDiagnostic[];
}

export interface BslModuleFileInput {
  sourceId: string;
  side: CompareSide;
  filePath: string;
  configRoots: readonly string[];
  source?: string;
}

export interface BslModuleSourceInput {
  identity: BslModuleIdentity;
  source: string;
}

export async function buildBslModuleIndex(
  inputs: readonly BslModuleFileInput[]
): Promise<BslModuleIndexResult> {
  const modules: BslModuleIndexEntry[] = [];
  const diagnostics: BslModuleDiagnostic[] = [];

  for (const input of inputs) {
    const result = await indexBslModuleFile(input);
    diagnostics.push(...result.diagnostics);
    modules.push(...result.modules);
  }

  return { modules, diagnostics };
}

export async function indexBslModuleFile(input: BslModuleFileInput): Promise<BslModuleIndexResult> {
  const identityResult = resolveSupportedBslModuleIdentity(input);
  if (!identityResult.identity) {
    return { modules: [], diagnostics: [identityResult.diagnostic] };
  }

  let source = input.source;
  if (source === undefined) {
    try {
      source = await fs.readFile(input.filePath, 'utf-8');
    } catch (error) {
      return {
        modules: [],
        diagnostics: [
          createDiagnostic(input, {
            code: 'BSL_MODULE_READ_FAILED',
            message: `Failed to read BSL module: ${error instanceof Error ? error.message : String(error)}`,
            moduleId: identityResult.identity.moduleId,
          }),
        ],
      };
    }
  }

  const entry = indexBslModuleSource({
    identity: identityResult.identity,
    source,
  });

  return {
    modules: [entry],
    diagnostics: entry.diagnostics,
  };
}

export function indexBslModuleSource(input: BslModuleSourceInput): BslModuleIndexEntry {
  const parsed = parseBslRoutines(input.source);
  const diagnostics = parsed.diagnostics.map((diagnostic) =>
    convertRoutineDiagnostic(input.identity, diagnostic)
  );

  return {
    identity: input.identity,
    routines: parsed.routines,
    diagnostics,
  };
}

export function resolveSupportedBslModuleIdentity(input: BslModuleFileInput): {
  identity?: BslModuleIdentity;
  diagnostic: BslModuleDiagnostic;
} {
  const location = locateMetadataFile(input.filePath, input.configRoots);
  if (!location?.subPath) {
    return {
      diagnostic: createDiagnostic(input, {
        code: 'BSL_MODULE_UNSUPPORTED_PATH',
        message: 'BSL module path is not a supported metadata module path.',
      }),
    };
  }

  const identity = createIdentity(input, location, location.subPath);
  if (!identity) {
    return {
      diagnostic: createDiagnostic(input, {
        code: 'BSL_MODULE_UNSUPPORTED_KIND',
        message: `BSL module kind "${location.subPath.kind}" is not supported by procedural diff.`,
      }),
    };
  }

  return {
    identity,
    diagnostic: createDiagnostic(input, {
      code: 'BSL_MODULE_UNSUPPORTED_PATH',
      message: 'No diagnostic.',
      moduleId: identity.moduleId,
      blocking: false,
      severity: 'info',
    }),
  };
}

function createIdentity(
  input: BslModuleFileInput,
  location: MetadataLocation,
  subPath: MetadataFileSubPath
): BslModuleIdentity | undefined {
  const ownerType = metadataTypeFromFolder(location.objectType);
  const extensionName = location.extensionName;
  const base = {
    sourceId: input.sourceId,
    side: input.side,
    filePath: input.filePath,
    configRoot: location.configRoot,
    metadataType: ownerType,
    objectName: location.objectName,
    ...(extensionName !== undefined ? { extensionName } : {}),
  };

  switch (subPath.kind) {
    case 'objectModule':
      if (!isObjectOrManagerSupported(ownerType)) {
        return undefined;
      }
      return moduleIdentity(base, `${ownerType}.${location.objectName}.Object`, {
        moduleKind: 'Object',
      });
    case 'managerModule':
      if (!isObjectOrManagerSupported(ownerType)) {
        return undefined;
      }
      return moduleIdentity(base, `${ownerType}.${location.objectName}.Manager`, {
        moduleKind: 'Manager',
      });
    case 'commonModule':
      return moduleIdentity(base, `CommonModule.${location.objectName}`, {
        metadataType: 'CommonModule',
        moduleKind: 'CommonModule',
      });
    case 'form':
      if (subPath.subFile !== 'module') {
        return undefined;
      }
      if (ownerType === 'CommonForm') {
        return moduleIdentity(base, `CommonForm.${location.objectName}.FormModule`, {
          moduleKind: 'Form',
          formName: subPath.name,
        });
      }
      return moduleIdentity(
        base,
        `${ownerType}.${location.objectName}.Form.${subPath.name}.FormModule`,
        {
          moduleKind: 'Form',
          formName: subPath.name,
        }
      );
    case 'command':
      if (subPath.subFile !== 'module') {
        return undefined;
      }
      if (ownerType === 'CommonCommand') {
        return moduleIdentity(base, `CommonCommand.${location.objectName}.CommandModule`, {
          moduleKind: 'Command',
          commandName: subPath.name,
        });
      }
      return moduleIdentity(
        base,
        `${ownerType}.${location.objectName}.Command.${subPath.name}.CommandModule`,
        {
          moduleKind: 'Command',
          commandName: subPath.name,
        }
      );
    case 'recordSetModule':
    case 'valueManagerModule':
    case 'template':
    case 'rights':
    case 'predefinedData':
      return undefined;
    default:
      return assertNever(subPath);
  }
}

function moduleIdentity(
  base: Omit<
    BslModuleIdentity,
    'moduleKind' | 'moduleId' | 'displayName' | 'formName' | 'commandName'
  >,
  localModuleId: string,
  details: Pick<BslModuleIdentity, 'moduleKind'> &
    Partial<Pick<BslModuleIdentity, 'metadataType' | 'formName' | 'commandName'>>
): BslModuleIdentity {
  const moduleId = qualifyModuleId(localModuleId, base.extensionName);
  return {
    ...base,
    ...details,
    moduleId,
    displayName: moduleId,
  };
}

function qualifyModuleId(localModuleId: string, extensionName: string | undefined): string {
  return extensionName === undefined
    ? localModuleId
    : `Extension.${extensionName}.${localModuleId}`;
}

function convertRoutineDiagnostic(
  identity: BslModuleIdentity,
  diagnostic: BslRoutineDiagnostic
): BslModuleDiagnostic {
  return {
    severity: diagnostic.severity,
    code:
      diagnostic.code === 'duplicate-routine'
        ? 'BSL_MODULE_DUPLICATE_ROUTINE'
        : 'BSL_MODULE_PARSE_ERROR',
    blocking: diagnostic.severity === 'error',
    message: diagnostic.message,
    sourceId: identity.sourceId,
    side: identity.side,
    filePath: identity.filePath,
    moduleId: identity.moduleId,
    routineName: diagnostic.routineName,
    range: diagnostic.range,
  };
}

function createDiagnostic(
  input: Pick<BslModuleFileInput, 'sourceId' | 'side' | 'filePath'>,
  diagnostic: {
    code: BslModuleDiagnosticCode;
    message: string;
    moduleId?: string;
    blocking?: boolean;
    severity?: CompareMessageSeverity;
  }
): BslModuleDiagnostic {
  return {
    severity: diagnostic.severity ?? 'error',
    code: diagnostic.code,
    blocking: diagnostic.blocking ?? true,
    message: diagnostic.message,
    sourceId: input.sourceId,
    side: input.side,
    filePath: input.filePath,
    moduleId: diagnostic.moduleId,
  };
}

function isObjectOrManagerSupported(metadataType: string): boolean {
  return metadataType === 'Catalog' || metadataType === 'Document';
}

function metadataTypeFromFolder(folderName: string): string {
  const mappedType = MetadataTypeMapper.map(folderName);
  return mappedType === MetadataType.Unknown ? singularizeMetadataFolder(folderName) : mappedType;
}

function singularizeMetadataFolder(folderName: string): string {
  if (folderName.endsWith('ies')) {
    return `${folderName.slice(0, -3)}y`;
  }
  if (folderName.endsWith('s')) {
    return folderName.slice(0, -1);
  }

  return folderName;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported metadata sub path: ${JSON.stringify(value)}`);
}
