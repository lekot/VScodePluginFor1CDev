import type {
  CompareSide,
  IdentityConflict,
  MatchResult,
  MetadataIdentity,
  MetadataMatchDiagnostic,
} from '../domain/compareContracts';

export interface MetadataMatchInput {
  left: MetadataIdentity[];
  right: MetadataIdentity[];
}

export function matchMetadataIdentities(input: MetadataMatchInput): MatchResult {
  const conflicts: IdentityConflict[] = [];
  const diagnostics: MetadataMatchDiagnostic[] = [];
  const blocked = new Set<MetadataIdentity>();

  collectDuplicateConflicts('left', input.left, conflicts, diagnostics, blocked);
  collectDuplicateConflicts('right', input.right, conflicts, diagnostics, blocked);

  const matchedLeft = new Set<MetadataIdentity>();
  const matchedRight = new Set<MetadataIdentity>();
  const matches: MatchResult['matches'] = [];
  const rightByUuid = uniqueBy(input.right, (identity) => identity.uuid);
  const rightByName = uniqueBy(input.right, (identity) => identity.qualifiedName);

  for (const left of input.left) {
    if (blocked.has(left) || !left.uuid || matchedLeft.has(left)) {
      continue;
    }

    const right = rightByUuid.get(left.uuid);
    if (!right || blocked.has(right) || matchedRight.has(right)) {
      continue;
    }

    matches.push({
      left,
      right,
      matchKind: 'uuid',
      confidence: 'strong',
    });
    matchedLeft.add(left);
    matchedRight.add(right);

    if (left.qualifiedName !== right.qualifiedName) {
      conflicts.push({
        kind: 'sameUuidDifferentName',
        resolution: 'manual',
        blocking: false,
        message: `Metadata uuid ${left.uuid} has different qualified names.`,
        uuid: left.uuid,
        left,
        right,
        identities: [left, right],
      });
    }
  }

  for (const left of input.left) {
    if (blocked.has(left)) {
      continue;
    }

    const right = rightByName.get(left.qualifiedName);
    if (!right || blocked.has(right)) {
      continue;
    }

    if (left.uuid && right.uuid && left.uuid !== right.uuid) {
      conflicts.push({
        kind: 'sameNameDifferentUuid',
        resolution: 'manual',
        blocking: true,
        message: `Metadata ${left.qualifiedName} has different uuids.`,
        qualifiedName: left.qualifiedName,
        left,
        right,
        identities: [left, right],
      });
      if (!matchedLeft.has(left) && !matchedRight.has(right)) {
        matches.push({
          left,
          right,
          matchKind: 'qualifiedName',
          confidence: 'nameOnly',
        });
      }
      matchedLeft.add(left);
      matchedRight.add(right);
      continue;
    }

    if (matchedLeft.has(left) || matchedRight.has(right)) {
      continue;
    }

    matches.push({
      left,
      right,
      matchKind: 'qualifiedName',
      confidence: 'nameOnly',
    });
    matchedLeft.add(left);
    matchedRight.add(right);
  }

  return {
    matches,
    conflicts,
    diagnostics,
    unmatchedLeft: input.left.filter((identity) => !matchedLeft.has(identity)),
    unmatchedRight: input.right.filter((identity) => !matchedRight.has(identity)),
  };
}

function collectDuplicateConflicts(
  side: CompareSide,
  identities: MetadataIdentity[],
  conflicts: IdentityConflict[],
  diagnostics: MetadataMatchDiagnostic[],
  blocked: Set<MetadataIdentity>
): void {
  collectDuplicateGroup(
    side,
    identities,
    (identity) => identity.uuid,
    'duplicateUuid',
    'DUPLICATE_METADATA_UUID',
    conflicts,
    diagnostics,
    blocked
  );
  collectDuplicateGroup(
    side,
    identities,
    (identity) => identity.qualifiedName,
    'duplicateQualifiedName',
    'DUPLICATE_METADATA_QUALIFIED_NAME',
    conflicts,
    diagnostics,
    blocked
  );
}

function collectDuplicateGroup(
  side: CompareSide,
  identities: MetadataIdentity[],
  keySelector: (identity: MetadataIdentity) => string | undefined,
  kind: IdentityConflict['kind'],
  code: string,
  conflicts: IdentityConflict[],
  diagnostics: MetadataMatchDiagnostic[],
  blocked: Set<MetadataIdentity>
): void {
  const groups = groupBy(identities, keySelector);

  for (const [key, group] of groups) {
    if (group.length < 2) {
      continue;
    }

    for (const identity of group) {
      blocked.add(identity);
    }

    const first = group[0];
    const message = `${side} metadata identity ${key} is duplicated.`;
    conflicts.push({
      kind,
      resolution: 'manual',
      blocking: true,
      message,
      side,
      sourceId: first.sourceId,
      metadataType: first.metadataType,
      qualifiedName: kind === 'duplicateQualifiedName' ? key : undefined,
      uuid: kind === 'duplicateUuid' ? key : undefined,
      identities: group,
    });
    diagnostics.push({
      severity: 'error',
      code,
      phase: 'compare',
      blocking: true,
      message,
      side,
      sourceId: first.sourceId,
      path: first.filePath,
      identities: group,
    });
  }
}

function uniqueBy(
  identities: MetadataIdentity[],
  keySelector: (identity: MetadataIdentity) => string | undefined
): Map<string, MetadataIdentity> {
  const groups = groupBy(identities, keySelector);
  const unique = new Map<string, MetadataIdentity>();

  for (const [key, group] of groups) {
    if (group.length === 1) {
      unique.set(key, group[0]);
    }
  }

  return unique;
}

function groupBy(
  identities: MetadataIdentity[],
  keySelector: (identity: MetadataIdentity) => string | undefined
): Map<string, MetadataIdentity[]> {
  const groups = new Map<string, MetadataIdentity[]>();

  for (const identity of identities) {
    const key = keySelector(identity);
    if (!key) {
      continue;
    }

    const group = groups.get(key);
    if (group) {
      group.push(identity);
    } else {
      groups.set(key, [identity]);
    }
  }

  return groups;
}
