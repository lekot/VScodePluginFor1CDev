import type { FormModel } from './formModel';
import {
  applyAddElement,
  applyDeleteElements,
  applyMoveElementSibling,
  applyPropertyChange,
  type CommandResult,
} from './formModelCommands';

export type PropertyChangeCommand = {
  type: 'propertyChange';
  payload: { elementId?: string; section?: string; key: string; value: unknown };
};

export type AddElementCommand = {
  type: 'addElement';
  payload: { parentId?: string; tag?: string; name?: string; index?: number };
};

export type DeleteElementCommand = {
  type: 'deleteElement';
  payload: { elementIds: string[] };
};

export type MoveElementSiblingCommand = {
  type: 'moveElementSibling';
  payload: { elementId: string; direction: 'up' | 'down' };
};

export type FormEditorCommand =
  | PropertyChangeCommand
  | AddElementCommand
  | DeleteElementCommand
  | MoveElementSiblingCommand;

type HistoryEntry = {
  commandType: FormEditorCommand['type'];
  before: FormModel;
  after: FormModel;
};

export type FormCommandEngineSnapshot = {
  canUndo: boolean;
  canRedo: boolean;
  undoDepth: number;
  redoDepth: number;
  dirty: boolean;
  lastCommandType?: FormEditorCommand['type'];
};

export class FormCommandEngine {
  private readonly model: FormModel;
  private baseline: FormModel;
  private readonly undoStack: HistoryEntry[] = [];
  private readonly redoStack: HistoryEntry[] = [];

  public constructor(model: FormModel) {
    this.model = model;
    this.baseline = cloneModel(model);
  }

  public execute(command: FormEditorCommand): CommandResult {
    const before = cloneModel(this.model);
    const result = executeFormEditorCommand(this.model, command);
    if (!result.ok) {
      return result;
    }

    this.undoStack.push({
      commandType: command.type,
      before,
      after: cloneModel(this.model),
    });
    this.redoStack.length = 0;
    return { ok: true };
  }

  public undo(): CommandResult {
    const entry = this.undoStack.pop();
    if (!entry) {
      return { ok: false, error: 'Нет команд для undo.' };
    }
    restoreModel(this.model, entry.before);
    this.redoStack.push(entry);
    return { ok: true };
  }

  public redo(): CommandResult {
    const entry = this.redoStack.pop();
    if (!entry) {
      return { ok: false, error: 'Нет команд для redo.' };
    }
    restoreModel(this.model, entry.after);
    this.undoStack.push(entry);
    return { ok: true };
  }

  public getSnapshot(): FormCommandEngineSnapshot {
    return {
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      undoDepth: this.undoStack.length,
      redoDepth: this.redoStack.length,
      dirty: this.isDirty(),
      lastCommandType: this.undoStack[this.undoStack.length - 1]?.commandType,
    };
  }

  public isDirty(): boolean {
    return JSON.stringify(this.model) !== JSON.stringify(this.baseline);
  }

  public markSaved(): void {
    this.baseline = cloneModel(this.model);
  }
}

function executeFormEditorCommand(model: FormModel, command: FormEditorCommand): CommandResult {
  switch (command.type) {
    case 'propertyChange':
      applyPropertyChange(model, command.payload);
      return { ok: true };
    case 'addElement':
      return applyAddElement(
        model,
        command.payload.parentId,
        command.payload.tag || 'InputField',
        command.payload.name || 'NewItem',
        command.payload.index
      );
    case 'deleteElement':
      return applyDeleteElements(model, command.payload.elementIds);
    case 'moveElementSibling':
      return applyMoveElementSibling(model, command.payload.elementId, command.payload.direction);
  }
}

function cloneModel(model: FormModel): FormModel {
  return JSON.parse(JSON.stringify(model)) as FormModel;
}

function restoreModel(target: FormModel, snapshot: FormModel): void {
  const next = cloneModel(snapshot) as unknown as Record<string, unknown>;
  for (const key of Object.keys(target as unknown as Record<string, unknown>)) {
    delete (target as unknown as Record<string, unknown>)[key];
  }
  Object.assign(target as unknown as Record<string, unknown>, next);
}
