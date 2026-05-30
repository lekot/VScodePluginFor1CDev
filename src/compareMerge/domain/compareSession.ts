import type {
  CompareMessage,
  ComparePreview,
  ComparePreviewInput,
  CompareSessionCreateInput,
  CompareSessionState,
  CompareSide,
  CompareSnapshot,
  CompareSource,
  PreviewGuard,
} from './compareContracts';
import { cloneComparePreview, PreviewStore } from './previewStore';

export class CompareSession {
  readonly #previewStore = new PreviewStore();

  private readonly sessionState: CompareSessionState;

  private constructor(input: CompareSessionCreateInput) {
    this.sessionState = {
      sessionId: input.sessionId,
      createdAt: input.createdAt,
      sources: input.sources.map((source) => ({ ...source })),
      snapshots: [],
      messages: [],
      previews: [],
    };
  }

  static create(input: CompareSessionCreateInput): CompareSession {
    return new CompareSession(input);
  }

  get state(): CompareSessionState {
    this.sessionState.previews = this.#previewStore.listPreviews(this.sessionState.sessionId);
    return cloneSessionState(this.sessionState);
  }

  registerSnapshot(snapshot: CompareSnapshot): CompareSnapshot {
    const source = this.requireSource(snapshot.sourceId);
    const storedSnapshot = { ...snapshot };
    const existingIndex = this.sessionState.snapshots.findIndex(
      (item) => item.snapshotId === storedSnapshot.snapshotId
    );

    if (existingIndex >= 0) {
      this.sessionState.snapshots[existingIndex] = storedSnapshot;
    } else {
      this.sessionState.snapshots.push(storedSnapshot);
    }

    source.snapshotId = storedSnapshot.snapshotId;
    return cloneSnapshot(storedSnapshot);
  }

  addMessage(message: CompareMessage): CompareMessage {
    this.requireSource(message.sourceId);

    const storedMessage = {
      ...message,
      range: message.range ? { ...message.range } : undefined,
    };
    this.sessionState.messages.push(storedMessage);

    return cloneMessage(storedMessage);
  }

  hasBlockingMessages(): boolean {
    return this.sessionState.messages.some((message) => message.blocking);
  }

  createPreview(input: ComparePreviewInput): ComparePreview {
    this.requireSource(input.targetSourceId);
    if (!hasSnapshotIds(input.snapshotIds)) {
      throw new Error('Preview must include at least one snapshot id.');
    }

    return this.#previewStore.createPreview({
      ...input,
      snapshotIds: { ...input.snapshotIds },
      sessionId: this.sessionState.sessionId,
    });
  }

  approvePreview(previewId: string): ComparePreview {
    return this.#previewStore.approvePreview(previewId, this.createPreviewGuard());
  }

  canExecutePreview(previewId: string): boolean {
    return this.#previewStore.canExecutePreview(previewId, this.createPreviewGuard());
  }

  requireExecutablePreview(previewId: string): ComparePreview {
    return this.#previewStore.requireExecutablePreview(previewId, this.createPreviewGuard());
  }

  markPreviewExecuted(previewId: string): ComparePreview {
    return this.#previewStore.markExecuted(previewId, this.createPreviewGuard());
  }

  private requireSource(sourceId: string): CompareSource {
    const source = this.sessionState.sources.find((item) => item.sourceId === sourceId);
    if (!source) {
      throw new Error(`Compare source not found: ${sourceId}`);
    }

    return source;
  }

  private createPreviewGuard(): PreviewGuard {
    const snapshotIds: Partial<Record<CompareSide, string>> = {};

    for (const source of this.sessionState.sources) {
      if (source.snapshotId) {
        snapshotIds[source.side] = source.snapshotId;
      }
    }

    return {
      sessionId: this.sessionState.sessionId,
      snapshotIds,
    };
  }
}

function cloneSessionState(state: CompareSessionState): CompareSessionState {
  return {
    sessionId: state.sessionId,
    createdAt: state.createdAt,
    sources: state.sources.map(cloneSource),
    snapshots: state.snapshots.map(cloneSnapshot),
    messages: state.messages.map(cloneMessage),
    previews: state.previews.map(clonePreview),
  };
}

function cloneSource(source: CompareSource): CompareSource {
  return { ...source };
}

function cloneSnapshot(snapshot: CompareSnapshot): CompareSnapshot {
  return { ...snapshot };
}

function cloneMessage(message: CompareMessage): CompareMessage {
  return {
    ...message,
    range: message.range ? { ...message.range } : undefined,
  };
}

function clonePreview(preview: ComparePreview): ComparePreview {
  return cloneComparePreview(preview);
}

function hasSnapshotIds(snapshotIds: PreviewGuard['snapshotIds']): boolean {
  return Object.values(snapshotIds).some((snapshotId) => Boolean(snapshotId));
}
