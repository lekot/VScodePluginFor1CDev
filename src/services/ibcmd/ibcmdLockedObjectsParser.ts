export interface LockedObjectRef {
  readonly kind: string;
  readonly name: string;
  readonly fullName: string;
}

// Reactive approach: parse stderr after ibcmd failure.
// Pre-flight via XML is not feasible in Designer format (ParentConfigurations.bin is binary).
const RU_PATTERN = /редактирование объекта метаданных (\S+?) запрещено/gi;
const EN_PATTERN = /editing of metadata object (\S+?) is forbidden/gi;

export function parseLockedMetadataObjects(combinedLog: string): LockedObjectRef[] {
  const seen = new Map<string, LockedObjectRef>();

  const addMatch = (fullName: string): void => {
    const key = fullName.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    const dotIdx = fullName.indexOf('.');
    const kind = dotIdx >= 0 ? fullName.slice(0, dotIdx) : '';
    const name = dotIdx >= 0 ? fullName.slice(dotIdx + 1) : fullName;
    seen.set(key, { kind, name, fullName });
  };

  for (const match of combinedLog.matchAll(RU_PATTERN)) {
    addMatch(match[1]!);
  }
  for (const match of combinedLog.matchAll(EN_PATTERN)) {
    addMatch(match[1]!);
  }

  return [...seen.values()];
}
