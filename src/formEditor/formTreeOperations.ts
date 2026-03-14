/**
 * Pure tree-manipulation helpers for FormModel.
 * No vscode dependency — safe to import in console tests.
 */

import type { FormModel, FormChildItem } from './formModel';

/** Tags that can contain ChildItems (valid drop targets). */
export const CONTAINER_TAGS = new Set([
  'UsualGroup',
  'Pages',
  'Page',
  'Table',
  'AutoCommandBar',
  'Form',
  'Group',
  'CollapsibleGroup',
]);

export function isContainer(item: FormChildItem): boolean {
  return CONTAINER_TAGS.has(item.tag);
}

/** Find element by id or name in tree (recursive). */
export function findElementById(root: FormChildItem[], elementId: string): FormChildItem | undefined {
  const id = String(elementId);
  for (const item of root) {
    if ((item.id != null && String(item.id) === id) || (item.name != null && String(item.name) === id)) return item;
    if (item.childItems?.length) {
      const found = findElementById(item.childItems, id);
      if (found) return found;
    }
  }
  return undefined;
}

/** Check if sourceId is the same as targetId or is a descendant of target. */
export function isDescendantOf(model: FormModel, sourceId: string, targetId: string): boolean {
  if (sourceId === targetId) return true;
  const target = findElementById(model.childItemsRoot, targetId);
  if (!target?.childItems?.length) return false;
  const walk = (items: FormChildItem[]): boolean => {
    for (const item of items) {
      const id = item.id != null ? String(item.id) : (item.name != null ? String(item.name) : '');
      if (id && id === sourceId) return true;
      if (item.childItems?.length && walk(item.childItems)) return true;
    }
    return false;
  };
  return walk(target.childItems);
}

/** Find parent array and index of element. */
export function findParentAndIndex(
  root: FormChildItem[],
  elementId: string
): { parent: FormChildItem[]; index: number } | null {
  const id = String(elementId);
  for (let i = 0; i < root.length; i++) {
    if ((root[i].id != null && String(root[i].id) === id) || (root[i].name != null && String(root[i].name) === id)) {
      return { parent: root, index: i };
    }
    if (root[i].childItems?.length) {
      const found = findParentAndIndex(root[i].childItems!, id);
      if (found) return found;
    }
  }
  return null;
}

/** Move node from source to target's childItems at index. Returns true on success. */
export function moveNodeInModel(
  model: FormModel,
  sourceId: string,
  targetId: string,
  index: number
): boolean {
  const sourceLoc = findParentAndIndex(model.childItemsRoot, sourceId);
  const targetEl = findElementById(model.childItemsRoot, targetId);
  if (!sourceLoc || !targetEl || !isContainer(targetEl)) return false;
  // Guard: cannot move element into its own descendant
  if (isDescendantOf(model, targetId, sourceId)) return false;
  const [node] = sourceLoc.parent.splice(sourceLoc.index, 1);
  if (!node) return false;
  // Guard: if the root was emptied by this splice, roll back and reject
  if (model.childItemsRoot.length === 0) {
    sourceLoc.parent.splice(sourceLoc.index, 0, node);
    return false;
  }
  const targetList = targetEl.childItems ?? (targetEl.childItems = []);
  targetList.splice(Math.min(index, targetList.length), 0, node);
  return true;
}

/** Remove node from model by elementId. Root (childItemsRoot) is not removed. */
export function removeNodeInModel(model: FormModel, elementId: string): boolean {
  const loc = findParentAndIndex(model.childItemsRoot, elementId);
  if (!loc) return false;
  loc.parent.splice(loc.index, 1);
  return true;
}

/** Move element among siblings: direction 'up' or 'down'. */
export function moveElementSiblingInModel(
  model: FormModel,
  elementId: string,
  direction: 'up' | 'down'
): boolean {
  const loc = findParentAndIndex(model.childItemsRoot, elementId);
  if (!loc) return false;
  const idx = loc.index;
  if (direction === 'up' && idx <= 0) return false;
  if (direction === 'down' && idx >= loc.parent.length - 1) return false;
  const newIdx = direction === 'up' ? idx - 1 : idx + 1;
  const [node] = loc.parent.splice(idx, 1);
  if (!node) return false;
  loc.parent.splice(newIdx, 0, node);
  return true;
}

/** Count all elements in tree recursively. */
export function countAll(items: FormChildItem[]): number {
  let n = 0;
  for (const item of items) {
    n++;
    if (item.childItems?.length) n += countAll(item.childItems);
  }
  return n;
}
