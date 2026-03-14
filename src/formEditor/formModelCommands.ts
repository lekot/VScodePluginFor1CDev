/**
 * Pure model mutation functions for the form editor.
 * No vscode dependency — safe to import in console tests.
 *
 * Each function accepts a FormModel and typed parameters,
 * mutates the model in place on success, and returns CommandResult.
 */

import type { FormModel, FormChildItem, FormAttribute, FormCommand } from './formModel';
import {
  isContainer,
  isDescendantOf,
  findElementById,
  findParentAndIndex,
  moveNodeInModel,
  removeNodeInModel,
  moveElementSiblingInModel,
  FORM_ROOT_ID,
} from './formTreeOperations';
import {
  generateNextId,
  generateNextAttributeId,
  generateNextCommandId,
  createIdGenerator,
  cloneWithNewIds,
  requisiteTypeToTag,
  orderIdsForDeletion,
} from './formModelUtils';

/** Result type for model mutation commands. */
export type CommandResult = { ok: true } | { ok: false; error: string };

/** Update property on an element (or attribute/command by section). No return value — always succeeds. */
export function applyPropertyChange(
  model: FormModel,
  payload: { elementId?: string; section?: string; key: string; value: unknown }
): void {
  if (payload.section === 'attributes' && payload.elementId) {
    const attr = model.attributes.find(
      (a) => a.name === payload.elementId || a.id === payload.elementId
    );
    if (attr) {
      if (payload.key === 'name') attr.name = String(payload.value ?? '');
      else if (payload.key === 'id') attr.id = String(payload.value ?? '');
      else attr.properties[payload.key] = payload.value;
    }
    return;
  }
  if (payload.section === 'commands' && payload.elementId) {
    const cmd = model.commands.find(
      (c) => c.name === payload.elementId || c.id === payload.elementId
    );
    if (cmd) {
      if (payload.key === 'name') cmd.name = String(payload.value ?? '');
      else if (payload.key === 'id') cmd.id = String(payload.value ?? '');
      else cmd.properties[payload.key] = payload.value;
    }
    return;
  }
  if (payload.section === 'events' && payload.elementId) {
    const el = findElementById(model.childItemsRoot, payload.elementId);
    if (el && payload.key) {
      if (!el.events) el.events = {};
      el.events[payload.key] = String(payload.value ?? '');
    }
    return;
  }
  if (payload.elementId) {
    const el = findElementById(model.childItemsRoot, payload.elementId);
    if (el) {
      if (payload.key === 'name') el.name = String(payload.value ?? '');
      else if (payload.key === 'id') el.id = String(payload.value ?? '');
      else el.properties[payload.key] = payload.value;
    }
  }
}

/** Move element sourceId into targetId's children at index. */
export function applyDragDrop(
  model: FormModel,
  sourceId: string,
  targetId: string,
  index: number
): CommandResult {
  if (!sourceId || !targetId) {
    return { ok: false, error: 'Неверные параметры dragDrop.' };
  }
  if (sourceId === targetId || isDescendantOf(model, sourceId, targetId) || isDescendantOf(model, targetId, sourceId)) {
    return { ok: false, error: 'Нельзя переместить элемент в себя или в своего потомка.' };
  }
  const sourceLoc = findParentAndIndex(model.childItemsRoot, sourceId);
  if (!sourceLoc) {
    return { ok: false, error: 'Элемент-источник не найден.' };
  }
  // Special case: drop onto the synthetic form root
  if (targetId === FORM_ROOT_ID) {
    if (sourceLoc.parent === model.childItemsRoot) {
      return { ok: false, error: 'Элемент уже находится на верхнем уровне формы.' };
    }
    if (!moveNodeInModel(model, sourceId, FORM_ROOT_ID, index)) {
      return { ok: false, error: 'Не удалось переместить элемент в корень формы.' };
    }
    return { ok: true };
  }
  const targetEl = findElementById(model.childItemsRoot, targetId);
  if (!targetEl || !isContainer(targetEl)) {
    return { ok: false, error: 'Цель должна быть контейнером (группа, страница, таблица и т.д.).' };
  }
  if (!moveNodeInModel(model, sourceId, targetId, index)) {
    return { ok: false, error: 'Не удалось переместить элемент.' };
  }
  return { ok: true };
}

/** Add a new element under parentId (or root if parentId is undefined). */
export function applyAddElement(
  model: FormModel,
  parentId: string | undefined,
  tag: string,
  name: string,
  index?: number
): CommandResult {
  const parentList = parentId
    ? (() => {
        const parentEl = findElementById(model.childItemsRoot, parentId);
        if (!parentEl || !isContainer(parentEl)) return null;
        return parentEl.childItems ?? (parentEl.childItems = []);
      })()
    : model.childItemsRoot;
  if (!parentList) {
    return { ok: false, error: 'Родитель не является контейнером.' };
  }
  const newId = generateNextId(model);
  const newItem: FormChildItem = {
    tag: tag || 'InputField',
    id: newId,
    name: name || 'NewItem',
    properties: {},
    childItems: [],
  };
  const insertIndex = typeof index === 'number'
    ? Math.max(0, Math.min(index, parentList.length))
    : parentList.length;
  parentList.splice(insertIndex, 0, newItem);
  return { ok: true };
}

/** Delete elements by ids (descendants first). Refuses to delete sole root element. */
export function applyDeleteElements(
  model: FormModel,
  ids: string[]
): CommandResult {
  if (!ids.length) {
    return { ok: false, error: 'Неверные параметры deleteElement.' };
  }
  const toDelete = ids.length === 1 ? ids : orderIdsForDeletion(model, ids);
  const rootIds = new Set(
    model.childItemsRoot.length === 1
      ? [model.childItemsRoot[0].id || model.childItemsRoot[0].name].filter(Boolean)
      : []
  );
  const toDeleteFiltered = toDelete.filter((id) => !rootIds.has(id));
  let anyRemoved = false;
  for (const id of toDeleteFiltered) {
    if (removeNodeInModel(model, id)) anyRemoved = true;
  }
  if (!anyRemoved) {
    const rootOnly = toDeleteFiltered.length < toDelete.length && ids.some((id) => rootIds.has(id));
    return {
      ok: false,
      error: rootOnly ? 'Корневой элемент удалить нельзя.' : 'Не удалось удалить элементы.',
    };
  }
  return { ok: true };
}

/** Move element among siblings (up or down). */
export function applyMoveElementSibling(
  model: FormModel,
  elementId: string,
  direction: 'up' | 'down'
): CommandResult {
  if (!elementId || (direction !== 'up' && direction !== 'down')) {
    return { ok: false, error: 'Неверные параметры moveElementSibling.' };
  }
  if (!moveElementSiblingInModel(model, elementId, direction)) {
    return { ok: false, error: 'Не удалось переместить элемент.' };
  }
  return { ok: true };
}

/** Paste (clone) clipboard items into targetId's children at index. */
export function applyPasteElements(
  model: FormModel,
  targetId: string,
  clipboards: FormChildItem[],
  index?: number
): CommandResult {
  if (!targetId || !clipboards.length) {
    return { ok: false, error: 'Неверные параметры pasteElement (нужны targetId и clipboard).' };
  }
  const targetEl = findElementById(model.childItemsRoot, targetId);
  if (!targetEl || !isContainer(targetEl)) {
    return { ok: false, error: 'Цель должна быть контейнером.' };
  }
  const nextId = createIdGenerator(model);
  const targetList = targetEl.childItems ?? (targetEl.childItems = []);
  let insertIndex = typeof index === 'number'
    ? Math.max(0, Math.min(index, targetList.length))
    : targetList.length;
  for (const clipboard of clipboards) {
    const cloned = cloneWithNewIds(clipboard, nextId);
    targetList.splice(insertIndex, 0, cloned);
    insertIndex += 1;
  }
  return { ok: true };
}

/** Add a new element from a form requisite (attribute) into targetId's children. */
export function applyAddElementFromRequisite(
  model: FormModel,
  requisiteName: string,
  dataPath: string,
  targetId: string,
  index: number
): CommandResult {
  if (!requisiteName || !targetId) {
    return { ok: false, error: 'Неверные параметры addElementFromRequisite (requisiteName, targetId).' };
  }
  const targetEl = findElementById(model.childItemsRoot, targetId);
  if (!targetEl || !isContainer(targetEl)) {
    return { ok: false, error: 'Цель должна быть контейнером (группа, страница, таблица и т.д.).' };
  }
  const attr = model.attributes?.find((a) => a.name === requisiteName);
  const tag = requisiteTypeToTag(attr);
  const newId = generateNextId(model);
  const targetList = targetEl.childItems ?? (targetEl.childItems = []);
  const insertIndex = typeof index === 'number'
    ? Math.max(0, Math.min(index, targetList.length))
    : targetList.length;
  const newItem: FormChildItem = {
    tag,
    id: newId,
    name: requisiteName,
    properties: { DataPath: dataPath },
    childItems: [],
  };
  targetList.splice(insertIndex, 0, newItem);
  return { ok: true };
}

/** Add a new form attribute with default name and type. */
export function applyAddAttribute(model: FormModel): CommandResult {
  const name = 'NewAttribute';
  const id = generateNextAttributeId(model);
  const newAttr: FormAttribute = {
    name,
    id,
    properties: { Type: 'xs:string' },
  };
  model.attributes = model.attributes || [];
  model.attributes.push(newAttr);
  return { ok: true };
}

/** Delete a form attribute by id or name. */
export function applyDeleteAttribute(model: FormModel, key: string): CommandResult {
  if (key === undefined || key === null) {
    return { ok: false, error: 'Неверные параметры deleteAttribute.' };
  }
  const idx = model.attributes.findIndex(
    (a) => a.id === key || a.name === key
  );
  if (idx < 0) {
    return { ok: false, error: 'Реквизит не найден.' };
  }
  model.attributes.splice(idx, 1);
  return { ok: true };
}

/** Add a new form command with default name. */
export function applyAddCommand(model: FormModel): CommandResult {
  const name = 'NewCommand';
  const id = generateNextCommandId(model);
  const newCmd: FormCommand = {
    name,
    id,
    properties: {},
  };
  model.commands = model.commands || [];
  model.commands.push(newCmd);
  return { ok: true };
}

/** Delete a form command by id or name. */
export function applyDeleteCommand(model: FormModel, key: string): CommandResult {
  if (key === undefined || key === null) {
    return { ok: false, error: 'Неверные параметры deleteCommand.' };
  }
  const idx = model.commands.findIndex(
    (c) => c.id === key || c.name === key
  );
  if (idx < 0) {
    return { ok: false, error: 'Команда не найдена.' };
  }
  model.commands.splice(idx, 1);
  return { ok: true };
}
