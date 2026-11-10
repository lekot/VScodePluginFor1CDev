import type { BslModuleDiagnostic, BslModuleIdentity } from './bslModuleIndexer';

export interface ResolvedBslInventoryFile {
  readonly filePath: string;
  readonly identity?: BslModuleIdentity;
  readonly diagnostic?: BslModuleDiagnostic;
}

export interface BslSourceRetention {
  readonly leftPaths: ReadonlySet<string>;
  readonly rightPaths: ReadonlySet<string>;
}

/** Selects source text needed by paired module diffs and proven linked form-module operations. */
export function selectBslSourceRetention(input: {
  left: readonly ResolvedBslInventoryFile[];
  right: readonly ResolvedBslInventoryFile[];
  matchedFormModuleIds: ReadonlySet<string>;
}): BslSourceRetention {
  const leftPathsByModuleId = collectPathsByModuleId(input.left);
  const rightPathsByModuleId = collectPathsByModuleId(input.right);
  const leftPaths = new Set<string>();
  const rightPaths = new Set<string>();

  for (const [moduleId, paths] of leftPathsByModuleId) {
    if (!rightPathsByModuleId.has(moduleId)) {
      continue;
    }
    paths.forEach((filePath) => leftPaths.add(filePath));
    rightPathsByModuleId.get(moduleId)?.forEach((filePath) => rightPaths.add(filePath));
  }

  for (const file of input.right) {
    if (file.identity?.moduleKind === 'Form' && input.matchedFormModuleIds.has(file.identity.moduleId)) {
      rightPaths.add(file.filePath);
    }
  }

  return { leftPaths, rightPaths };
}

function collectPathsByModuleId(files: readonly ResolvedBslInventoryFile[]): Map<string, Set<string>> {
  const pathsByModuleId = new Map<string, Set<string>>();
  for (const file of files) {
    if (!file.identity) {
      continue;
    }
    let paths = pathsByModuleId.get(file.identity.moduleId);
    if (!paths) {
      paths = new Set<string>();
      pathsByModuleId.set(file.identity.moduleId, paths);
    }
    paths.add(file.filePath);
  }
  return pathsByModuleId;
}
