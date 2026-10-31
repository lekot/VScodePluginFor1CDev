import type { CompareTreeNode } from '../compareTreeTypes';
import { parseXmlAddressPointer } from '../xml/xmlAddress';
import type { ExtensionTransferRow } from './extensionTransfer';
import type {
  ExtensionAdoptedPreparedRightsArtifact,
  ExtensionAdoptedRightsPreparation,
} from './extensionAdoptedRightsHost';

export interface AdoptedRightsDeclarationScope {
  readonly references: readonly string[];
  readonly reason?: string;
}

/** Derives CFE declaration dependencies from the selected Rights subtree, never from unselected siblings. */
export function adoptedRightsDeclarationScope(node: CompareTreeNode): AdoptedRightsDeclarationScope {
  const references = new Set<string>();
  const pending = [node];
  while (pending.length > 0) {
    const current = pending.pop()!;
    pending.push(...current.children);
    const requiresObjectIdentity = current.kind === 'roleRightsObject' || current.kind === 'roleRight';
    const isRightsAdapterNode = current.id.startsWith('roleRightsXml:');
    if (!requiresObjectIdentity && !isRightsAdapterNode) {continue;}
    const address = current.payloadRef?.startsWith('xmlPatch:')
      ? current.payloadRef.slice('xmlPatch:'.length)
      : current.id.slice(current.id.lastIndexOf(':') + 1);
    let pointer = address;
    if (!pointer.startsWith('/')) {
      try {pointer = decodeURIComponent(pointer);} catch {pointer = '';}
    }
    if (!pointer.startsWith('/')) {
      if (requiresObjectIdentity) {return { references: [], reason: 'Выбранное изменение Rights не содержит точного XML-адреса объекта.' };}
      continue;
    }
    let segments: ReturnType<typeof parseXmlAddressPointer>;
    try {segments = parseXmlAddressPointer(pointer);} catch {
      if (!requiresObjectIdentity && current.kind !== 'xmlProperty') {continue;}
      return { references: [], reason: 'Выбранное изменение Rights содержит некорректный XML-адрес объекта.' };
    }
    const objectSegments = segments.filter((segment) => segment.localName === 'object'
      && segment.selector.startsWith('rights-object='));
    if (objectSegments.length === 0 && !requiresObjectIdentity) {continue;}
    if (objectSegments.length !== 1) {
      return { references: [], reason: 'Выбранное изменение Rights не идентифицирует единственный metadata object.' };
    }
    const qualifiedName = canonicalMetadataRoot(objectSegments[0]!.selector.slice('rights-object='.length));
    if (!qualifiedName) {return { references: [], reason: 'Rights object не содержит поддерживаемый metadata root qualified name.' };}
    if (!qualifiedName.startsWith('Configuration.')) {references.add(qualifiedName);}
  }
  return { references: [...references].sort((left, right) => left.localeCompare(right)) };
}

export async function appendAdoptedRightsProjectionNodes(input: {
  readonly row: ExtensionTransferRow;
  readonly preparation: ExtensionAdoptedRightsPreparation;
  readonly compareArtifact: (artifact: ExtensionAdoptedPreparedRightsArtifact) => Promise<CompareTreeNode | undefined>;
}): Promise<CompareTreeNode[]> {
  const nodes: CompareTreeNode[] = [];
  if (input.preparation.artifact) {
    const projected = await input.compareArtifact(input.preparation.artifact);
    if (projected) {nodes.push(projected);}
  }
  for (const blocker of input.preparation.blockers) {
    nodes.push({
      id: `extension:adopted-role-rights:${input.row.id}:${encodeURIComponent(blocker.targetRelativePath)}`,
      label: `Права роли: ${blocker.targetRelativePath}`,
      kind: 'roleRightsProjectionBlocker',
      status: 'changed',
      mergeable: false,
      conflict: { kind: 'unsupported', blocking: true, message: blocker.reason },
      mergeState: { state: 'blocked', reason: blocker.reason, targetFilePath: blocker.targetRelativePath },
      children: [],
    });
  }
  return nodes;
}

function canonicalMetadataRoot(value: string): string | undefined {
  const segments = value.trim().split('.');
  if (segments.length < 2 || segments.some((segment) => !/^[\p{L}_][\p{L}\p{N}_]*$/u.test(segment))) {return undefined;}
  if (segments[0]!.toLocaleLowerCase('en-US') === 'configuration') {return `Configuration.${segments[1]}`;}
  return `${segments[0]}.${segments[1]}`;
}
