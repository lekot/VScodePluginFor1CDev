import { TreeNode } from '../models/treeNode';

/** Serializable node without circular parent reference */
interface SerializedNode {
  id: string;
  name: string;
  type: string;
  properties: Record<string, unknown>;
  filePath?: string;
  parentFilePath?: string;
  children?: SerializedNode[];
}

function nodeToSerializable(node: TreeNode): SerializedNode {
  const out: SerializedNode = {
    id: node.id,
    name: node.name,
    type: node.type,
    properties: node.properties ? { ...node.properties } : {},
    filePath: node.filePath,
    parentFilePath: node.parentFilePath,
  };
  if (node.children && node.children.length > 0) {
    out.children = node.children.map(nodeToSerializable);
  }
  return out;
}

function serializableToNode(s: SerializedNode): TreeNode {
  const node: TreeNode = {
    id: s.id,
    name: s.name,
    type: s.type as TreeNode['type'],
    properties: s.properties ?? {},
    filePath: s.filePath,
    parentFilePath: s.parentFilePath,
  };
  if (s.children && s.children.length > 0) {
    node.children = s.children.map((c) => {
      const child = serializableToNode(c);
      child.parent = node;
      return child;
    });
  }
  return node;
}

/**
 * Serialize tree to JSON (omits parent references to avoid cycles).
 */
export function serializeTree(root: TreeNode): string {
  return JSON.stringify(nodeToSerializable(root));
}

/**
 * Deserialize tree from JSON and restore parent references on children.
 */
export function deserializeTree(json: string): TreeNode {
  const s = JSON.parse(json) as SerializedNode;
  return serializableToNode(s);
}
