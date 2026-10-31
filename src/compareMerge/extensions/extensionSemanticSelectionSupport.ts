import type { AdapterCompareInput, ExecutableCandidateFactory } from '../adapters/mergeAdapter';
import type { CompareTreeNode } from '../compareTreeTypes';
import type { MergeFileWitness } from '../merge/mergePreview';
import { LINKED_FORM_REFERENCE_PROPERTIES } from '../linkedDesignerUtils';
import { parseXmlDocument, textContent } from '../xml/xmlDom';
import type { ExtensionMetadataIndex } from './extensionMetadataIndex';
import { normalizeArtifactPath } from './extensionSemanticSidecars';

export function selectionDependency(
  node: CompareTreeNode,
  context: AdapterCompareInput['linkedDesignerContext'],
): { requiredPackageId?: string; targetFormComplete?: boolean; witnesses: MergeFileWitness[] } {
  const payload = node.payloadRef ?? '';
  const decoded = payload.split('/').map((segment) => {
    try {return decodeURIComponent(segment);} catch {return segment;}
  });
  const propertyName = LINKED_FORM_REFERENCE_PROPERTIES.find((name) => decoded.some((part) => part === name || part.startsWith(`${name}[`)));
  if (propertyName) {
    const value = node.rightValue?.trim() ?? '';
    const capability = context?.defaultObjectForms.find((item) => item.propertyName === propertyName && item.value.trim() === value);
    if (!capability || !value) {return { witnesses: [] };}
    return {
      ...(capability.packageId && !capability.targetFormComplete ? { requiredPackageId: capability.packageId } : {}),
      targetFormComplete: capability.targetFormComplete,
      witnesses: [...(capability.targetWitnesses ?? [])],
    };
  }
  if (/(?:^|%2F|\/)Event(?:%5B|\[)/iu.test(payload)) {
    const handler = eventHandlerName(node.rightValue?.trim() ?? '');
    const capability = handler ? context?.formEventHandlers.find((item) => item.name.trim() === handler) : undefined;
    return { witnesses: [...(capability?.targetWitnesses ?? [])] };
  }
  return { witnesses: [] };
}

export function withRootConfigurationWitnesses(
  factory: ExecutableCandidateFactory,
  target: ExtensionMetadataIndex,
  incoming: ExtensionMetadataIndex,
): ExecutableCandidateFactory {
  return async () => {
    const result = await factory();
    if (!result.ok || !result.candidate.xmlPatch) {return result;}
    const witnesses = (result.candidate.xmlPatch.sourceWitnesses ?? []).filter((witness) =>
      !((witness.sourceId === target.sourceId || witness.sourceId === incoming.sourceId)
        && witness.relativePath.replace(/\\/gu, '/') === 'Configuration.xml'));
    if (target.configurationHash) {
      witnesses.push({ sourceId: target.sourceId, relativePath: 'Configuration.xml', expectedHash: target.configurationHash, kind: 'file' });
    }
    if (incoming.configurationHash) {
      witnesses.push({ sourceId: incoming.sourceId, relativePath: 'Configuration.xml', expectedHash: incoming.configurationHash, kind: 'file' });
    }
    return {
      ok: true,
      candidate: {
        ...result.candidate,
        xmlPatch: { ...result.candidate.xmlPatch, sourceWitnesses: witnesses },
      },
    };
  };
}

export function dedupeSemanticWitnesses(witnesses: readonly MergeFileWitness[]): MergeFileWitness[] {
  const byKey = new Map<string, MergeFileWitness>();
  for (const witness of witnesses) {
    byKey.set(`${witness.sourceId}\0${normalizeArtifactPath(witness.relativePath)}\0${witness.kind ?? 'file'}`, witness);
  }
  return [...byKey.values()];
}

function eventHandlerName(value: string): string | undefined {
  if (!value) {return undefined;}
  try {
    const root = parseXmlDocument(value).root;
    return root.localName === 'Event' ? textContent(root).trim() || undefined : undefined;
  } catch {
    return value.startsWith('<') ? undefined : value;
  }
}
