import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { pathToFileURL } from 'url';

import type { CompareMessage } from './domain/compareContracts';
import { CompareSession } from './domain/compareSession';
import type { ConfigurationCompareWorkspaceState } from './configurationCompareWorkspace';
import { buildCompareTreeProjection } from './projection/compareTreeProjection';
import { throwIfCompareCancelled, type CompareCancellationToken } from './compareCancellation';

const EDT_MARKERS = [
  path.join('src', 'Configuration', 'Configuration.mdo'),
  path.join('Configuration', 'Configuration.mdo'),
];

export async function tryBuildEdtUnsupportedState(input: {
  leftRootPath: string;
  rightRootPath: string;
  createdAt?: Date;
  cancellation?: CompareCancellationToken;
}): Promise<ConfigurationCompareWorkspaceState | undefined> {
  const leftRoot = path.resolve(input.leftRootPath);
  const rightRoot = path.resolve(input.rightRootPath);
  const createdAt = input.createdAt ?? new Date();
  const [leftMarker, rightMarker] = await Promise.all([
    edtMarkerPath(leftRoot, input.cancellation),
    edtMarkerPath(rightRoot, input.cancellation),
  ]);
  throwIfCompareCancelled(input.cancellation);

  const findings = [
    { side: 'left' as const, sourceId: 'left-source', root: leftRoot, marker: leftMarker },
    { side: 'right' as const, sourceId: 'right-source', root: rightRoot, marker: rightMarker },
  ].filter((item) => item.marker);
  if (findings.length === 0) {
    return undefined;
  }

  const messages: CompareMessage[] = findings.map((item) => ({
    severity: 'error',
    code: 'CONFIG_COMPARE_EDT_UNSUPPORTED',
    phase: 'compare',
    sourceId: item.sourceId,
    path: item.marker,
    blocking: true,
    suggestedAction: `Обнаружен формат EDT (${item.marker}); сравнение и слияние .mdo в этом режиме пока не поддержаны. Используйте выгрузку Designer XML.`,
  }));
  const sessionId = `edt-compare-unsupported-${createdAt.getTime()}-${randomUUID()}`;
  const session = CompareSession.create({
    sessionId,
    createdAt: createdAt.toISOString(),
    sources: [
      {
        sourceId: 'left-source', side: 'left', kind: 'workspace',
        displayName: path.basename(leftRoot) || leftRoot,
        rootUri: pathToFileURL(leftRoot).toString(), targetWorkspaceRoot: leftRoot, writable: true,
      },
      {
        sourceId: 'right-source', side: 'right', kind: 'file',
        displayName: path.basename(rightRoot) || rightRoot,
        rootUri: pathToFileURL(rightRoot).toString(), writable: false,
      },
    ],
  });
  for (const message of messages) {session.addMessage(message);}
  return {
    session,
    projection: buildCompareTreeProjection({ messages }),
    candidateFactories: new Map(),
    mergeableNodeIds: [],
  };
}

async function edtMarkerPath(root: string, cancellation?: CompareCancellationToken): Promise<string | undefined> {
  for (const relativePath of EDT_MARKERS) {
    throwIfCompareCancelled(cancellation);
    try {
      if ((await fs.stat(path.join(root, relativePath))).isFile()) {
        return relativePath.replace(/\\/gu, '/');
      }
    } catch {
      // Keep probing the supported EDT root layouts; missing markers are ordinary.
    }
  }
  return undefined;
}
