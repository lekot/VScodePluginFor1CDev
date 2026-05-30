import type { ComparePreview, PreviewGuard, PreviewStoreCreateInput } from './compareContracts';

export class PreviewStore {
  private readonly previews = new Map<string, ComparePreview>();

  createPreview(input: PreviewStoreCreateInput): ComparePreview {
    if (this.previews.has(input.previewId)) {
      throw new Error(`Preview already exists: ${input.previewId}`);
    }
    assertHasSnapshotIds(input.snapshotIds, 'Preview');

    const preview: ComparePreview = {
      previewId: input.previewId,
      sessionId: input.sessionId,
      targetSourceId: input.targetSourceId,
      snapshotIds: { ...input.snapshotIds },
      createdAt: input.createdAt,
      summary: input.summary,
      approvalState: 'draft',
      payload: clonePreviewPayload(input.payload),
    };

    this.previews.set(preview.previewId, preview);
    return cloneComparePreview(preview);
  }

  getPreview(previewId: string): ComparePreview | undefined {
    const preview = this.previews.get(previewId);
    return preview ? cloneComparePreview(preview) : undefined;
  }

  listPreviews(sessionId?: string): ComparePreview[] {
    const previews = Array.from(this.previews.values());
    const filteredPreviews = sessionId
      ? previews.filter((preview) => preview.sessionId === sessionId)
      : previews;

    return filteredPreviews.map(cloneComparePreview);
  }

  approvePreview(previewId: string, guard: PreviewGuard): ComparePreview {
    const preview = this.requirePreview(previewId);
    this.assertBelongsToGuard(preview, guard);
    if (preview.approvalState !== 'draft') {
      throw new Error(`Preview is not draft: ${previewId}`);
    }

    preview.approvalState = 'approved';
    return cloneComparePreview(preview);
  }

  canExecutePreview(previewId: string, guard: PreviewGuard): boolean {
    const preview = this.getPreview(previewId);
    if (!preview || preview.approvalState !== 'approved') {
      return false;
    }

    try {
      this.assertBelongsToGuard(preview, guard);
      return true;
    } catch {
      return false;
    }
  }

  requireExecutablePreview(previewId: string, guard: PreviewGuard): ComparePreview {
    if (!this.canExecutePreview(previewId, guard)) {
      throw new Error(`Preview is not executable: ${previewId}`);
    }

    return cloneComparePreview(this.requirePreview(previewId));
  }

  markExecuted(previewId: string, guard: PreviewGuard): ComparePreview {
    if (!this.canExecutePreview(previewId, guard)) {
      throw new Error(`Preview is not executable: ${previewId}`);
    }

    const preview = this.requirePreview(previewId);
    preview.approvalState = 'executed';
    return cloneComparePreview(preview);
  }

  private requirePreview(previewId: string): ComparePreview {
    const preview = this.previews.get(previewId);
    if (!preview) {
      throw new Error(`Preview not found: ${previewId}`);
    }

    return preview;
  }

  private assertBelongsToGuard(preview: ComparePreview, guard: PreviewGuard): void {
    if (preview.sessionId !== guard.sessionId) {
      throw new Error(
        `Preview session mismatch: expected ${guard.sessionId}, got ${preview.sessionId}`
      );
    }

    assertHasSnapshotIds(preview.snapshotIds, 'Preview');
    assertHasSnapshotIds(guard.snapshotIds, 'Preview guard');

    const guardEntries = Object.entries(guard.snapshotIds).filter(([, snapshotId]) => snapshotId);
    const previewEntries = Object.entries(preview.snapshotIds).filter(([, snapshotId]) => snapshotId);

    if (previewEntries.length !== guardEntries.length) {
      throw new Error(
        `Preview snapshot mismatch: expected ${formatSnapshotIds(guard.snapshotIds)}, got ${formatSnapshotIds(preview.snapshotIds)}`
      );
    }

    for (const [side, currentSnapshotId] of guardEntries) {
      const previewSnapshotId = preview.snapshotIds[side as keyof typeof preview.snapshotIds];
      if (previewSnapshotId !== currentSnapshotId) {
        throw new Error(
          `Preview snapshot mismatch for ${side}: expected ${currentSnapshotId}, got ${previewSnapshotId ?? 'none'}`
        );
      }
    }
  }
}

export function cloneComparePreview(preview: ComparePreview): ComparePreview {
  return {
    ...preview,
    snapshotIds: { ...preview.snapshotIds },
    payload: clonePreviewPayload(preview.payload),
  };
}

function clonePreviewPayload(payload: unknown): unknown {
  if (payload === undefined || payload === null || typeof payload !== 'object') {
    return payload;
  }

  if (Array.isArray(payload)) {
    return payload.map(clonePreviewPayload);
  }

  const clonedPayload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    clonedPayload[key] = clonePreviewPayload(value);
  }

  return clonedPayload;
}

function formatSnapshotIds(snapshotIds: PreviewGuard['snapshotIds']): string {
  const entries = Object.entries(snapshotIds)
    .filter(([, snapshotId]) => snapshotId)
    .map(([side, snapshotId]) => `${side}=${snapshotId}`)
    .sort();

  return entries.length > 0 ? entries.join(', ') : 'none';
}

function assertHasSnapshotIds(snapshotIds: PreviewGuard['snapshotIds'], owner: string): void {
  if (!Object.values(snapshotIds).some((snapshotId) => Boolean(snapshotId))) {
    throw new Error(`${owner} must include at least one snapshot id.`);
  }
}
