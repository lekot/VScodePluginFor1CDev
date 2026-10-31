import type { CompareMessage } from '../domain/compareContracts';
import type { CompareTreeNode } from '../compareTreeTypes';
import { throwIfCompareCancelled, type CompareCancellationToken } from '../compareCancellation';
import type { ExtensionFormEventProjection, ExtensionLinkedRoutineSelection } from './extensionLinkedDesignerBsl';
import { collectExtensionEventDependencies, projectExtensionFormEventHandlers } from './extensionLinkedDesignerBsl';
import type { ExtensionMetadataIndex } from './extensionMetadataIndex';
import type { ExtensionTransferRow } from './extensionTransfer';
import type { LinkedEventDependency, LinkedFormModuleSnapshot } from '../linkedDesignerTypes';

export interface ExtensionFormProjectionCapture<T> {
  readonly payload: T;
  readonly targetRelativePath: string;
  readonly sourceRelativePath: string;
  readonly targetHash: string;
  readonly sourceHash: string;
  readonly targetXml: Buffer;
  readonly sourceXml: Buffer;
}

/** Projects captured Form bodies with their event/module checks and shared node bookkeeping. */
export async function appendExtensionFormProjectionNodes<T>(input: {
  readonly row: ExtensionTransferRow;
  readonly targetRoot: ExtensionMetadataIndex;
  readonly incomingRoot: ExtensionMetadataIndex;
  readonly rightSnapshotId: string;
  readonly cancellation?: CompareCancellationToken;
  readonly forms: readonly ExtensionFormProjectionCapture<T>[];
  readonly compare: (form: ExtensionFormProjectionCapture<T>, events: ExtensionFormEventProjection) => Promise<CompareTreeNode | undefined>;
  readonly childNodes: CompareTreeNode[];
  readonly diagnostics: CompareMessage[];
  readonly linkedRoutineSelections: Map<string, ExtensionLinkedRoutineSelection>;
  readonly linkedFormModules: LinkedFormModuleSnapshot[];
  readonly linkedEventDependencies: Map<string, LinkedEventDependency>;
}): Promise<void> {
  for (const form of input.forms) {
    throwIfCompareCancelled(input.cancellation);
    const events = await projectExtensionFormEventHandlers({
      row: input.row,
      targetRoot: input.targetRoot,
      incomingRoot: input.incomingRoot,
      targetOwner: input.row.target!,
      incomingOwner: input.row.incoming!,
      targetFormPath: form.targetRelativePath,
      sourceFormPath: form.sourceRelativePath,
      targetFormXml: form.targetXml,
      sourceFormXml: form.sourceXml,
      rightSnapshotId: input.rightSnapshotId,
    });
    input.diagnostics.push(...events.diagnostics);
    events.routineSelections.forEach((selection, id) => input.linkedRoutineSelections.set(id, selection));
    if (events.module) {input.linkedFormModules.push(events.module);}
    const node = await input.compare(form, events);
    throwIfCompareCancelled(input.cancellation);
    if (node) {
      input.childNodes.push(node);
      if (events.module) {
        collectExtensionEventDependencies({
          nodes: node.children,
          capabilities: events.context,
          module: events.module,
          output: input.linkedEventDependencies,
        });
      }
    }
    input.childNodes.push(...events.routineNodes);
  }
}
