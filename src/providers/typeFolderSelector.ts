import { getMetadataTypeDescriptorByFolder } from '../constants/metadataTypeDescriptors';
import { MetadataType, type TreeNode } from '../models/treeNode';

/** Returns true only for a registered type folder directly under Configuration or Common. */
export function isTypeIndexFolder(root: TreeNode, node: TreeNode): boolean {
  const descriptor = getMetadataTypeDescriptorByFolder(node.id);
  if (!descriptor || node.type !== descriptor.type) {
    return false;
  }
  if (node.parent === root) {
    return root.type === MetadataType.Configuration;
  }
  return node.parent?.id === 'Common'
    && node.parent.type === MetadataType.Unknown
    && node.parent.parent === root
    && root.type === MetadataType.Configuration;
}

export function getTypeIndexFolders(root: TreeNode): TreeNode[] {
  if (root.type !== MetadataType.Configuration) {
    return [];
  }
  const folders: TreeNode[] = [];
  for (const child of root.children ?? []) {
    if (isTypeIndexFolder(root, child)) {
      folders.push(child);
    }
    if (child.id === 'Common' && child.type === MetadataType.Unknown && child.parent === root) {
      for (const commonChild of child.children ?? []) {
        if (isTypeIndexFolder(root, commonChild)) {
          folders.push(commonChild);
        }
      }
    }
  }
  return folders;
}

export function isTypeIndexLoaded(node: TreeNode): boolean {
  return (node.properties as Record<string, unknown> | undefined)?._indexLoaded === true
    || (node.children?.length ?? 0) > 0;
}
