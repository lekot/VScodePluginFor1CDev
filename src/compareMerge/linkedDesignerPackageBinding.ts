import { parseXmlDocument, textContent } from './xml/xmlDom';
import type { AdapterCompareResult } from './adapters/mergeAdapter';
import type { CompareTreeNode } from './compareTreeTypes';
import type { LinkedDesignerKind, LinkedDesignerPackageRecipe } from './linkedDesignerTypes';
import { finalName, normalizePath } from './linkedDesignerUtils';

type Registration = { readonly kind: LinkedDesignerKind; readonly name: string };

interface RegistrationPathIndex {
  first?: CompareTreeNode;
  readonly children: Map<string, RegistrationPathIndex>;
}

interface RootEvidence {
  readonly resultIndex: number;
  hasNode: boolean;
}

const REGISTRATION_KINDS: readonly LinkedDesignerKind[] = ['Form', 'Template', 'Command'];

/** Associates enabled registration or object-presence nodes with their host-owned package recipes. */
export function bindLinkedDesignerPackageNodes(input: {
  readonly results: readonly AdapterCompareResult[];
  readonly packages: readonly LinkedDesignerPackageRecipe[];
  readonly blockedPresenceNodeIds?: ReadonlyMap<string, string>;
}): { packagesByNodeId: ReadonlyMap<string, LinkedDesignerPackageRecipe>; results: readonly AdapterCompareResult[] } {
  const packagesByNodeId = new Map<string, LinkedDesignerPackageRecipe>();
  const duplicateRecipes = new Map<string, number>();
  const packageKeys = new Map<LinkedDesignerPackageRecipe, string>();
  const rootNodeIds = new Set<string>();
  const presenceNodeIds = new Set<string>();

  for (const recipe of input.packages) {
    if (recipe.rootRegistration) {
      rootNodeIds.add(fileObjectNodeId(recipe));
      continue;
    }
    const key = ownerRegistrationKey(recipe);
    packageKeys.set(recipe, key);
    duplicateRecipes.set(key, (duplicateRecipes.get(key) ?? 0) + 1);
    presenceNodeIds.add(fileObjectNodeId(recipe));
  }

  const registrationIndexes = new Map<string, RegistrationPathIndex>();
  const rootEvidence = new Map<string, RootEvidence>();
  const nextResults = input.results.map((result, resultIndex) => {
    const nextResult = {
      ...result,
      nodes: [...result.nodes],
      candidateFactories: new Map(result.candidateFactories),
    };

    for (const nodeId of nextResult.candidateFactories.keys()) {
      if (!rootNodeIds.has(nodeId)) {continue;}
      const existing = rootEvidence.get(nodeId);
      if (!existing) {rootEvidence.set(nodeId, { resultIndex, hasNode: false });}
    }
    const visit = (nodes: readonly CompareTreeNode[]): void => {
      for (const node of nodes) {
        const nodeId = node.id;
        if (rootNodeIds.has(nodeId)) {
          const evidence = rootEvidence.get(nodeId);
          if (!evidence) {rootEvidence.set(nodeId, { resultIndex, hasNode: true });}
          else if (evidence.resultIndex === resultIndex) {evidence.hasNode = true;}
        }

        const nodeKind = node.kind;
        const status = node.status;
        const mergeable = node.mergeable;
        const label = node.label;
        const rightValue = node.rightValue;
        const leftValue = node.leftValue;
        const targetPath = node.mergeState?.targetFilePath;
        if (mergeable && nodeKind === 'xmlElement' && targetPath && (status === 'rightOnly' || status === 'leftOnly')) {
          const xml = status === 'rightOnly' ? rightValue : leftValue;
          const registrations = readRegistrations(xml, label);
          if (registrations.length > 0) {
            const normalizedTargetPath = normalizePath(targetPath);
            for (const registration of registrations) {
              const name = normalizedRegistrationName(registration.name);
              const key = registrationKey(status, registration.kind, name);
              let root = registrationIndexes.get(key);
              if (!root) {
                root = { children: new Map() };
                registrationIndexes.set(key, root);
              }
              insertCandidate(root, normalizedTargetPath, node);
            }
          }
        }

        visit(node.children);
      }
    };
    visit(nextResult.nodes);
    return nextResult;
  });

  for (const recipe of input.packages) {
    if (recipe.rootRegistration) {
      const nodeId = fileObjectNodeId(recipe);
      const evidence = rootEvidence.get(nodeId);
      if (evidence?.hasNode) {
        packagesByNodeId.set(nodeId, recipe);
        recipe.registrationNodeId = nodeId;
      }
      continue;
    }

    const packageKey = packageKeys.get(recipe)!;
    if (duplicateRecipes.get(packageKey) !== 1) {continue;}
    const status = recipe.action === 'copy' ? 'rightOnly' : 'leftOnly';
    const normalizedName = normalizedRegistrationName(finalName(recipe.qualifiedName));
    const registrationIndex = registrationIndexes.get(registrationKey(status, recipe.kind, normalizedName));
    if (!registrationIndex) {continue;}
    const owner = recipe.ownerTargetRelativePath;
    if (!owner) {continue;}
    const candidate = findSuffixCandidate(registrationIndex, normalizePath(owner));
    if (candidate) {
      packagesByNodeId.set(candidate.id, recipe);
      recipe.registrationNodeId = candidate.id;
    }
  }

  for (const result of nextResults) {
    result.nodes = result.nodes.filter((node) => {
      if (!presenceNodeIds.has(node.id)) {return true;}
      result.candidateFactories.delete(node.id);
      return false;
    });
  }

  const blockedEntries = [...(input.blockedPresenceNodeIds ?? [])];
  if (blockedEntries.length > 0) {
    const blockedOrder = new Map(blockedEntries.map(([nodeId], index) => [nodeId, index]));
    const reasonByNodeId = new Map(blockedEntries);
    for (const result of nextResults) {
      let foundBlockedNode = false;
      const inspect = (nodes: readonly CompareTreeNode[], minimumAncestorOrder: number): void => {
        for (const node of nodes) {
          const order = blockedOrder.get(node.id);
          if (order !== undefined) {
            foundBlockedNode = true;
            if (order < minimumAncestorOrder) {result.candidateFactories.delete(node.id);}
          }
          const childAncestorOrder = order === undefined ? minimumAncestorOrder : Math.min(minimumAncestorOrder, order);
          inspect(node.children, childAncestorOrder);
        }
      };
      inspect(result.nodes, Number.POSITIVE_INFINITY);
      if (!foundBlockedNode) {continue;}

      const transform = (node: CompareTreeNode, blockedAncestor: boolean): CompareTreeNode | undefined => {
        const reason = reasonByNodeId.get(node.id);
        const isBlocked = reason !== undefined;
        // Always scan the original descendants: later blocked entries may still delete
        // their factories even when an earlier tree blocker hides them in the output.
        const transformedChildren = node.children.map((child) => transform(child, blockedAncestor || isBlocked));
        if (blockedAncestor) {return undefined;}
        if (isBlocked) {
          return {
            ...node,
            mergeable: false,
            conflict: { kind: 'unsupported', message: reason, blocking: true },
            mergeState: { state: 'blocked', reason },
            children: [],
          };
        }
        return { ...node, children: transformedChildren.filter((child): child is CompareTreeNode => child !== undefined) };
      };
      result.nodes = result.nodes
        .map((node) => transform(node, false))
        .filter((node): node is CompareTreeNode => node !== undefined);
    }
  }

  return { packagesByNodeId, results: nextResults };
}

function ownerRegistrationKey(recipe: LinkedDesignerPackageRecipe): string {
  return `${normalizePath(recipe.ownerTargetRelativePath ?? '')}\0${recipe.kind}\0${normalizedRegistrationName(finalName(recipe.qualifiedName))}`;
}

function registrationKey(status: string, kind: LinkedDesignerKind, name: string): string {
  return `${status}\0${kind}\0${name}`;
}

function normalizedRegistrationName(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

function readRegistrations(xml: string | undefined, label: string): Registration[] {
  if (xml) {
    try {
      const root = parseXmlDocument(xml).root;
      const kind = root.localName;
      if (kind === 'Form' || kind === 'Template' || kind === 'Command') {
        return [{ kind, name: textContent(root).trim() }];
      }
    } catch {
      // Some host projections expose only scalar text instead of the captured subtree.
    }
  }
  const trimmedLabel = label.trim();
  const kindMatch = /^(Form|Template|Command)\s*:\s*(.+)$/u.exec(trimmedLabel);
  if (kindMatch) {return [{ kind: kindMatch[1] as LinkedDesignerKind, name: kindMatch[2]!.trim() }];}
  return trimmedLabel ? REGISTRATION_KINDS.map((kind) => ({ kind, name: trimmedLabel })) : [];
}

function insertCandidate(root: RegistrationPathIndex, path: string, candidate: CompareTreeNode): void {
  let current = root;
  if (!current.first) {current.first = candidate;}
  for (let index = path.length - 1; index >= 0; index--) {
    const character = path.charAt(index);
    let child = current.children.get(character);
    if (!child) {
      child = { children: new Map() };
      current.children.set(character, child);
    }
    current = child;
    if (!current.first) {current.first = candidate;}
  }
}

function findSuffixCandidate(root: RegistrationPathIndex, suffix: string): CompareTreeNode | undefined {
  let current = root;
  for (let index = suffix.length - 1; index >= 0; index--) {
    const child = current.children.get(suffix.charAt(index));
    if (!child) {return undefined;}
    current = child;
  }
  return current.first;
}

function fileObjectNodeId(recipe: LinkedDesignerPackageRecipe): string {
  const status = recipe.action === 'copy' ? 'rightOnly' : 'leftOnly';
  return `fileObject:${status}:${encodeURIComponent(recipe.qualifiedName)}`;
}
