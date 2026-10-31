import type { CompareTreeNode } from '../compareTreeTypes';
import type { ExecutableCandidateFactory } from '../adapters/mergeAdapter';
import type { MergeFileWitness } from '../merge/mergePreview';
import { parseXmlAddressPointer } from '../xml/xmlAddress';
import type { AdoptedDesignerProjectionIssue } from './adoptedDesignerProjection';

export type ExtensionAdoptedProjectionIssue = AdoptedDesignerProjectionIssue & {
  readonly structuralPath?: readonly string[];
};

export interface AdoptedIssueNodeMap {
  readonly byNodeId: ReadonlyMap<string, readonly ExtensionAdoptedProjectionIssue[]>;
  readonly unmatched: readonly ExtensionAdoptedProjectionIssue[];
}

export function mapAdoptedIssuesToNodes(
  nodes: readonly CompareTreeNode[],
  factories: ReadonlyMap<string, ExecutableCandidateFactory>,
  issues: readonly ExtensionAdoptedProjectionIssue[],
): AdoptedIssueNodeMap {
  const byNodeId = new Map<string, ExtensionAdoptedProjectionIssue[]>();
  const unmatched: ExtensionAdoptedProjectionIssue[] = [];
  const candidateNodes = collectCandidateNodes(nodes, factories);
  for (const issue of issues) {
    const affected = candidateNodes.filter((node) => adoptedIssueAffectsNode(issue, node));
    if (affected.length === 0) { unmatched.push(issue); continue; }
    for (const node of affected) {
      const previous = byNodeId.get(node.id) ?? [];
      byNodeId.set(node.id, [...previous, issue]);
    }
  }
  return { byNodeId, unmatched };
}

export function adoptedCandidateUuid(node: CompareTreeNode): string | undefined {
  if (node.kind !== 'xmlElement' || node.status !== 'rightOnly' || !node.payloadRef?.startsWith('xmlPatch:')) { return undefined; }
  try {
    const parsed = parseXmlAddressPointer(node.payloadRef.slice('xmlPatch:'.length));
    const uuidSelector = [...parsed].reverse().find((segment) => segment.selector.toLocaleLowerCase('en-US').startsWith('uuid='));
    const uuid = uuidSelector?.selector.slice('uuid='.length).toLowerCase();
    return uuid && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(uuid) ? uuid : undefined;
  } catch {
    return undefined;
  }
}

export function withRegistryCandidateWitnesses(
  factory: ExecutableCandidateFactory,
  registryWitnesses: readonly MergeFileWitness[],
): ExecutableCandidateFactory {
  if (registryWitnesses.length === 0) { return factory; }
  return async () => {
    const result = await factory();
    if (!result.ok || !result.candidate.xmlPatch) { return result; }
    const witnesses = new Map<string, MergeFileWitness>();
    for (const witness of [...(result.candidate.xmlPatch.sourceWitnesses ?? []), ...registryWitnesses]) {
      const key = `${witness.sourceId}\0${normalizeRelativePath(witness.relativePath)}\0${witness.kind ?? 'file'}`;
      const previous = witnesses.get(key);
      if (previous && normalizeHash(previous.expectedHash) !== normalizeHash(witness.expectedHash)) {
        return {
          ok: false,
          diagnostics: [{
            severity: 'error', code: 'EXTENSION_ADOPTED_UUID_WITNESS_CONFLICT', phase: 'preview',
            sourceId: witness.sourceId, path: witness.relativePath, blocking: true,
            suggestedAction: 'Captured UUID registry witness конфликтует с XML candidate; повторно сравните конфигурации.',
          }],
        };
      }
      witnesses.set(key, { ...witness, expectedHash: normalizeHash(witness.expectedHash) });
    }
    return {
      ok: true,
      candidate: {
        ...result.candidate,
        xmlPatch: { ...result.candidate.xmlPatch, sourceWitnesses: [...witnesses.values()] },
      },
    };
  };
}

function adoptedIssueAffectsNode(issue: ExtensionAdoptedProjectionIssue, node: CompareTreeNode): boolean {
  const payload = node.payloadRef;
  if (!payload?.startsWith('xmlPatch:')) { return false; }
  if (issue.orderOnly) { return adoptedOrderIssueAffectsNode(issue, node, payload); }
  let parsedSegments: ReturnType<typeof parseXmlAddressPointer>;
  try { parsedSegments = parseXmlAddressPointer(payload.slice('xmlPatch:'.length)); } catch { return false; }
  const segments = parsedSegments.map((segment) => `${segment.localName}[${segment.selector}]`);
  const key = issue.identityKey.toLocaleLowerCase('en-US');
  if (key.startsWith('uuid=')) {
    const exact = parsedSegments.some((segment) => segment.selector.toLocaleLowerCase('en-US') === key);
    if (exact) { return true; }
    const issuePath = issue.structuralPath?.map((selector) => selector.toLocaleLowerCase('en-US'));
    if (issuePath && node.status === 'rightOnly' && node.kind === 'xmlElement') {
      const candidatePath = parsedSegments
        .map((segment) => segment.selector.toLocaleLowerCase('en-US'))
        .filter((selector) => selector.startsWith('metadata-root=') || selector.startsWith('uuid='));
      if (candidatePath.length > 0 && candidatePath.length < issuePath.length
        && candidatePath.every((selector, index) => selector === issuePath[index])) {
        return true;
      }
    }
    return false;
  }
  const identityMatches = key.startsWith('root=')
    ? segments.some((segment) => segment.toLocaleLowerCase('en-US').startsWith(`${key.slice('root='.length).split('.')[0]}[`))
    : segments.some((segment) => segment.toLocaleLowerCase('en-US').includes(key));
  if (!identityMatches) { return false; }
  if (!issue.propertyName) { return true; }
  const property = issue.propertyName.toLocaleLowerCase('en-US');
  return segments.some((segment) => {
    const normalized = segment.toLocaleLowerCase('en-US');
    return normalized.startsWith(`${property}[`) || normalized === `@${property}`;
  });
}

function adoptedOrderIssueAffectsNode(
  issue: ExtensionAdoptedProjectionIssue,
  node: CompareTreeNode,
  payload: string,
): boolean {
  if (node.kind !== 'metadataOrderMove' || !issue.orderScopePointer || !issue.orderElementKind) { return false; }
  const pointer = payload.slice('xmlPatch:'.length);
  const separator = pointer.lastIndexOf('/');
  if (separator < 0 || pointer.slice(0, separator) !== issue.orderScopePointer) { return false; }
  try {
    const segments = parseXmlAddressPointer(pointer);
    return segments[segments.length - 1]?.localName === issue.orderElementKind;
  } catch {
    return false;
  }
}

function collectCandidateNodes(
  nodes: readonly CompareTreeNode[],
  factories: ReadonlyMap<string, ExecutableCandidateFactory>,
): CompareTreeNode[] {
  const result: CompareTreeNode[] = [];
  for (const node of nodes) {
    if (factories.has(node.id)) { result.push(node); }
    result.push(...collectCandidateNodes(node.children, factories));
  }
  return result;
}

function normalizeRelativePath(value: string): string { return value.replace(/\\/gu, '/').replace(/^\.\//u, ''); }
function normalizeHash(value: string): string { return value.replace(/^sha256:/iu, '').toLowerCase(); }
