import { TreeNode, MetadataType } from '../../src/models/treeNode';
import { isRootObjectCreateInTypeFolder, TOP_LEVEL_TYPES } from '../../src/services/elementOperations';

/** Конкретная форма (лист под «Forms»), не папка-контейнер `id === 'Forms'`. */
function isFormInstanceNode(node: TreeNode): boolean {
  return node.type === MetadataType.Form && node.id !== 'Forms';
}

function isFormsFolderTarget(node: TreeNode): boolean {
  return node.id === 'Forms';
}

function isAttributeOrTabularContainerUnderObject(node: TreeNode): boolean {
  const p = node.parent;
  if (!p || !TOP_LEVEL_TYPES.has(p.type)) {
    return false;
  }
  // Подсистемы в 1С не имеют реквизитов и табличных частей — только состав и порядок.
  if (p.type === MetadataType.Subsystem) {
    return false;
  }
  if (node.id === 'Attributes' && node.type === MetadataType.Attribute) {
    return true;
  }
  if (node.id === 'TabularSections' && node.type === MetadataType.TabularSection) {
    return true;
  }
  return false;
}

function isTopLevelObjectCreateTarget(node: TreeNode): boolean {
  if (!TOP_LEVEL_TYPES.has(node.type)) {
    return false;
  }
  const p = node.parent;
  if (!p) {
    return false;
  }
  return isRootObjectCreateInTypeFolder(p);
}

/**
 * Узел-контейнер для сценария матрицы create×2 → delete×1 (см. docs/plans/e2e-container-matrix-ibcmd.md §3.2).
 */
export function isMatrixTarget(node: TreeNode): boolean {
  if (node.type === MetadataType.Configuration) {
    return false;
  }
  if (isFormInstanceNode(node)) {
    return false;
  }
  if (isFormsFolderTarget(node)) {
    return true;
  }
  if (isRootObjectCreateInTypeFolder(node)) {
    return true;
  }
  if (isTopLevelObjectCreateTarget(node)) {
    return true;
  }
  if (isAttributeOrTabularContainerUnderObject(node)) {
    return true;
  }
  return false;
}
