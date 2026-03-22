import { TreeNode, MetadataType } from '../../src/models/treeNode';
import { isRootObjectCreateInTypeFolder, TOP_LEVEL_TYPES } from '../../src/services/elementOperations';
import { ROOT_TAGS_WITHOUT_CHILDOBJECTS } from '../../src/utils/XMLWriter';

/** Конкретная форма (лист под «Forms»), не папка-контейнер `id === 'Forms'`. */
function isFormInstanceNode(node: TreeNode): boolean {
  return node.type === MetadataType.Form && node.id !== 'Forms';
}

function isFormsFolderTarget(node: TreeNode): boolean {
  return node.id === 'Forms';
}

/**
 * Папки типов, для которых корректный XML нельзя собрать из шаблона без привязки к конфигурации
 * (Type/Content/таблицы), ibcmd падает на импорте.
 */
const IBMATRIX_SKIP_TYPE_FOLDER_IDS = new Set(['FilterCriteria', 'ExternalDataSources']);

function isIbcmdFragileTypeFolder(node: TreeNode): boolean {
  return IBMATRIX_SKIP_TYPE_FOLDER_IDS.has(node.id);
}

function isAttributeOrTabularContainerUnderObject(node: TreeNode): boolean {
  const p = node.parent;
  if (!p || !TOP_LEVEL_TYPES.has(p.type)) {
    return false;
  }
  // Синхронно с ROOT_TAGS_WITHOUT_CHILDOBJECTS и docs/1c-config-objects-spec.md §6: у этих типов
  // в выгрузке Designer нет ChildObjects — не гоняем матрицу на вложенные Attribute/TabularSection
  // (иначе createElement пишет ChildObjects и ломает ibcmd, см. историю с ролью).
  if (ROOT_TAGS_WITHOUT_CHILDOBJECTS.has(String(p.type))) {
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
  // Экземпляр роли (не папка «Роли» id=Roles): в XML только Properties, без ChildObjects (ibcmd).
  if (node.type === MetadataType.Role && node.id !== 'Roles') {
    return false;
  }
  if (isFormInstanceNode(node)) {
    return false;
  }
  if (isFormsFolderTarget(node)) {
    return true;
  }
  if (isRootObjectCreateInTypeFolder(node)) {
    if (isIbcmdFragileTypeFolder(node)) {
      return false;
    }
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
