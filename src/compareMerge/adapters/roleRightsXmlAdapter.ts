import { createHash } from 'crypto';
import * as path from 'path';

import type { AdapterCompareInput, AdapterCompareResult, MergeAdapter, XmlPatchPayload } from './mergeAdapter';
import { buildXmlAdapterResult } from './semanticXml/semanticXmlAdapter';
import { namespaceUriForName } from './semanticXml/semanticXmlIdentity';
import { ROLE_RIGHTS_NAMESPACE } from './semanticXml/semanticXmlRights';
import { localFilePath } from './semanticXml/semanticXmlAdapterUtils';
import { projectRoleRightsPair, type RoleRightsProjectionIssue } from './roleRightsEffectiveProjection';
import { parseXmlAddressPointer } from '../xml/xmlAddress';

const RIGHTS_STRUCTURES = new Set(['Rights', 'object', 'right', 'restrictionByCondition', 'restrictionTemplate']);

export const roleRightsXmlAdapter: MergeAdapter = {
  kind: 'roleRightsXml',
  async compare(input: AdapterCompareInput): Promise<AdapterCompareResult> {
    const container = input.match.left?.containerPath ?? input.match.right?.containerPath ?? '';
    const filePath = path.join(container, 'Ext', 'Rights.xml');
    const targetFilePath = input.artifactPaths?.left ?? filePath;
    const sourceFilePath = input.artifactPaths?.right
      ?? (input.match.right ? path.join(input.match.right.containerPath, 'Ext', 'Rights.xml') : undefined);
    const projection = projectRoleRightsPair({ targetXml: input.snapshots.left, sourceXml: input.snapshots.right });
    const rawSourceWitness = physicalSourceWitness(input, sourceFilePath);
    const compareInput: AdapterCompareInput = {
      ...input,
      semanticContextWitnesses: rawSourceWitness
        ? [...(input.semanticContextWitnesses ?? []), rawSourceWitness]
        : input.semanticContextWitnesses,
      snapshots: { left: input.snapshots.left, right: projection.comparisonSourceXml },
    };
    const result = await buildXmlAdapterResult(compareInput, {
      adapterKind: 'roleRightsXml',
      rootLabel: 'Права роли',
      rootKind: 'roleRightsXml',
      nodeIdPrefix: 'roleRightsXml',
      targetFilePath,
      sourceFilePath,
      semanticKind: 'roleRightsXml',
      elementKind: ({ element }) => {
        const name = localName(element.name);
        return name === 'object' ? 'roleRightsObject' : name === 'right' ? 'roleRight' : name === 'restrictionTemplate' ? 'roleRestrictionTemplate' : 'xmlElement';
      },
      knownComplexElement: ({ element }) => namespaceUriForName(element.dom) === ROLE_RIGHTS_NAMESPACE && RIGHTS_STRUCTURES.has(localName(element.name)),
    });

    const rawWitnessIssue = conflictingSourceWitness(input, rawSourceWitness);
    const issues = rawWitnessIssue
      ? [...projection.issues, { scope: 'file' as const, reason: rawWitnessIssue }]
      : projection.issues;
    return applyRoleRightsProjectionIssues(result, issues, targetFilePath);
  },
};

function physicalSourceWitness(input: AdapterCompareInput, sourcePath?: string): NonNullable<XmlPatchPayload['sourceWitnesses']>[number] | undefined {
  if (!sourcePath) {return undefined;}
  const inventoryRoot = path.resolve(localFilePath(input.rightInventory.rootPath));
  const absolutePath = path.resolve(localFilePath(sourcePath));
  const relativePath = path.relative(inventoryRoot, absolutePath).replace(/\\/gu, '/');
  if (!relativePath || relativePath === '.' || relativePath === '..' || relativePath.startsWith('../') || path.isAbsolute(relativePath)) {
    return undefined;
  }
  const sourceId = input.session.state.sources.find((source) => source.side === 'right')?.sourceId ?? 'right-source';
  return {
    sourceId,
    relativePath,
    expectedHash: createHash('sha256').update(Buffer.from(input.snapshots.right, 'utf8')).digest('hex'),
    kind: 'file',
  };
}

function conflictingSourceWitness(
  input: AdapterCompareInput,
  physical: NonNullable<XmlPatchPayload['sourceWitnesses']>[number] | undefined,
): string | undefined {
  if (!physical) {return 'Не удалось подтвердить физический файл Rights.xml для фиксации исходного SHA-256.';}
  const existing = (input.semanticContextWitnesses ?? []).find((witness) =>
    witness.sourceId === physical.sourceId && normalizePath(witness.relativePath) === normalizePath(physical.relativePath),
  );
  if (!existing || normalizeHash(existing.expectedHash) === physical.expectedHash) {return undefined;}
  return 'Снимок и физический SHA-256 Rights.xml противоречат друг другу; перенос доступен только для чтения.';
}

export function applyRoleRightsProjectionIssues(
  result: AdapterCompareResult,
  issues: readonly RoleRightsProjectionIssue[],
  targetFilePath: string,
): AdapterCompareResult {
  if (issues.length === 0) {return result;}
  const candidateFactories = new Map(result.candidateFactories);
  const remaining = new Set(issues);
  const nodes = result.nodes.map((node) => rewriteNode(node, issues, remaining, candidateFactories, targetFilePath));
  const unmatched = [...remaining].map((issue) => issueNode(issue, targetFilePath));
  return { ...result, nodes: [...nodes, ...unmatched], candidateFactories };
}

function rewriteNode(
  node: AdapterCompareResult['nodes'][number],
  issues: readonly RoleRightsProjectionIssue[],
  remaining: Set<RoleRightsProjectionIssue>,
  candidateFactories: Map<string, AdapterCompareResult['candidateFactories'] extends ReadonlyMap<string, infer T> ? T : never>,
  targetFilePath: string,
): AdapterCompareResult['nodes'][number] {
  const affected = issues.filter((issue) => matchesIssue(node, issue));
  for (const issue of affected) {remaining.delete(issue);}
  const children = node.children.map((child) => rewriteNode(child, issues, remaining, candidateFactories, targetFilePath));
  if (affected.length === 0) {return { ...node, children };}
  candidateFactories.delete(node.id);
  const reason = affected.map((issue) => issue.reason).join(' ');
  return {
    ...node,
    mergeable: false,
    conflict: { kind: 'unsupported', blocking: true, message: reason },
    mergeState: { state: 'blocked', reason, targetFilePath },
    children,
  };
}

function matchesIssue(node: AdapterCompareResult['nodes'][number], issue: RoleRightsProjectionIssue): boolean {
  if (issue.scope === 'file') {return true;}
  if (issue.scope === 'policy') {return node.kind === 'xmlProperty' && node.label === issue.policyName;}
  if (!issue.objectQualifiedName || !issue.rightName) {return false;}
  const pointer = node.payloadRef?.startsWith('xmlPatch:') ? node.payloadRef.slice('xmlPatch:'.length) : undefined;
  if (!pointer) {return false;}
  let segments: ReturnType<typeof parseXmlAddressPointer>;
  try {segments = parseXmlAddressPointer(pointer);} catch {return false;}
  const objectSegments = segments.filter((segment) => segment.localName === 'object'
    && segment.selector.startsWith('rights-object='));
  if (objectSegments.length !== 1
    || normalizeName(objectSegments[0]!.selector.slice('rights-object='.length)) !== normalizeName(issue.objectQualifiedName)) {
    return false;
  }
  const rightSegments = segments.filter((segment) => segment.localName === 'right'
    && segment.selector.startsWith('rights-right='));
  if (rightSegments.length > 0) {
    return rightSegments.some((segment) =>
      normalizeName(segment.selector.slice('rights-right='.length)) === normalizeName(issue.rightName!),
    );
  }

  // A selectable object-level patch inserts/deletes the entire subtree, including every right.
  return node.id.length > 0 && node.kind === 'roleRightsObject';
}

function issueNode(issue: RoleRightsProjectionIssue, targetFilePath: string): AdapterCompareResult['nodes'][number] {
  const identity = issue.scope === 'right'
    ? `${issue.objectQualifiedName ?? 'Объект'} / ${issue.rightName ?? 'право'}`
    : issue.policyName ? `Политика ${issue.policyName}` : 'Права роли';
  const reason = issue.reason;
  return {
    id: `roleRightsXml:projection-blocker:${encodeURIComponent(identity)}`,
    label: identity,
    kind: 'roleRightsProjectionBlocker',
    status: 'changed',
    mergeable: false,
    conflict: { kind: 'unsupported', blocking: true, message: reason },
    mergeState: { state: 'blocked', reason, targetFilePath },
    children: [],
  };
}

function normalizeName(value: string): string {
  return value.normalize('NFC').trim().toLocaleLowerCase('en-US');
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/gu, '/');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function normalizeHash(value: string): string {
  return value.startsWith('sha256:') ? value.slice('sha256:'.length).toLowerCase() : value.toLowerCase();
}

function localName(name: string): string {
  return name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
}
