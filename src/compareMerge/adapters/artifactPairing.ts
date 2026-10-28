import * as path from 'path';

import { compareCodeUnits } from '../../utils/compareCodeUnits';
import type { AdapterCompareResult, ArtifactKind, ArtifactUnit, ConfigurationInventory, MetadataObjectMatch, MetadataObjectUnit } from './mergeAdapter';

export function ambiguousArtifactPairResult(sourceId: string): AdapterCompareResult {
  return {
    nodes: [],
    candidateFactories: new Map(),
    diagnostics: [{
      severity: 'error',
      code: 'CONFIG_COMPARE_AMBIGUOUS_XML_ARTIFACT_PAIR',
      phase: 'compare',
      sourceId,
      blocking: true,
      suggestedAction: 'Для одного объекта найдены XML-файлы с одинаковым относительным путём без учёта регистра. Устраните неоднозначность и обновите сравнение.',
    }],
  };
}

export function findArtifactPairs(
  leftInventory: ConfigurationInventory,
  rightInventory: ConfigurationInventory,
  match: MetadataObjectMatch,
  kind: ArtifactKind,
): { pairs: { left: ArtifactUnit; right: ArtifactUnit }[]; ambiguousRelativePaths: string[] } {
  const left = match.left ? findArtifacts(leftInventory, match.left, kind) : [];
  const right = match.right ? findArtifacts(rightInventory, match.right, kind) : [];
  const leftPath = match.left ? groupArtifactsByOwnerRelativePath(match.left, kind, left) : new Map<string, ArtifactUnit[]>();
  const rightPath = match.right ? groupArtifactsByOwnerRelativePath(match.right, kind, right) : new Map<string, ArtifactUnit[]>();
  const ambiguousRelativePaths = [...leftPath.entries(), ...rightPath.entries()]
    .filter(([, artifacts]) => artifacts.length > 1)
    .map(([relativePath]) => relativePath);
  const pairs: { left: ArtifactUnit; right: ArtifactUnit }[] = [];
  for (const [relativePath, leftArtifacts] of leftPath) {
    const rightArtifacts = rightPath.get(relativePath);
    if (leftArtifacts.length === 1 && rightArtifacts?.length === 1) {
      pairs.push({ left: leftArtifacts[0]!, right: rightArtifacts[0]! });
    }
  }
  return { pairs, ambiguousRelativePaths: [...new Set(ambiguousRelativePaths)].sort(compareCodeUnits) };
}

function findArtifacts(
  inventory: ConfigurationInventory,
  object: MetadataObjectUnit,
  kind: ArtifactKind,
): ArtifactUnit[] {
  return inventory.artifactsByObjectId.get(object.objectId)?.filter((artifact) => artifact.kind === kind) ?? [];
}

function ownerRelativeArtifactPath(
  kind: ArtifactKind,
  object: MetadataObjectUnit,
  artifact: ArtifactUnit,
): string {
  if (kind === 'metadataXml') {return 'metadataXml';}
  const normalized = path.normalize(path.relative(object.containerPath, artifact.filePath)).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function groupArtifactsByOwnerRelativePath(
  object: MetadataObjectUnit,
  kind: ArtifactKind,
  artifacts: readonly ArtifactUnit[],
): Map<string, ArtifactUnit[]> {
  const result = new Map<string, ArtifactUnit[]>();
  for (const artifact of artifacts) {
    const key = ownerRelativeArtifactPath(kind, object, artifact);
    result.set(key, [...(result.get(key) ?? []), artifact]);
  }
  return result;
}
