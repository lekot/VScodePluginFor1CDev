import { MetadataTypeMapper } from '../utils/metadataTypeMapper';
import type { LockedObjectRef } from '../services/ibcmd/ibcmdLockedObjectsParser';

export interface LockedObjectsFilterResult {
  readonly kept: string[];
  readonly filtered: string[];
}

/**
 * Derives the Designer folder prefix for a locked object (e.g. "CommonModules/Foo").
 * Uses MetadataTypeMapper for the kind→folder mapping; falls back to `${kind}s` heuristic
 * when the kind is not a recognised MetadataType.
 */
function folderPrefixForLocked(locked: LockedObjectRef): string | null {
  if (!locked.kind) {
    return null;
  }

  const metaType = MetadataTypeMapper.map(locked.kind);
  const folder = MetadataTypeMapper.getDesignerFolderIdForMetadataType(metaType) ?? `${locked.kind}s`;

  return `${folder}/${locked.name}`;
}

export function filterOutLockedObjectFiles(
  relativeFiles: readonly string[],
  locked: readonly LockedObjectRef[],
): LockedObjectsFilterResult {
  if (locked.length === 0) {
    return { kept: [...relativeFiles], filtered: [] };
  }

  const prefixes: string[] = [];
  for (const obj of locked) {
    const prefix = folderPrefixForLocked(obj);
    if (prefix !== null) {
      prefixes.push(prefix.toLowerCase());
    }
  }

  const kept: string[] = [];
  const filtered: string[] = [];

  for (const file of relativeFiles) {
    const lower = file.toLowerCase();
    let isLocked = false;
    for (const prefix of prefixes) {
      // Matches descriptor XML: e.g. "commonmodules/foo.xml"
      // Matches anything inside object dir: e.g. "commonmodules/foo/ext/module.bsl"
      if (lower === `${prefix}.xml` || lower.startsWith(`${prefix}/`)) {
        isLocked = true;
        break;
      }
    }
    if (isLocked) {
      filtered.push(file);
    } else {
      kept.push(file);
    }
  }

  return { kept, filtered };
}
