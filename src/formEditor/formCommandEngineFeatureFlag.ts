const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function isFormCommandEngineEnabled(): boolean {
  const raw = process.env.FORM_COMMAND_ENGINE_ENABLED;
  if (!raw) {
    return false;
  }
  return TRUE_VALUES.has(raw.trim().toLowerCase());
}

export function isFormCommandEngineExplicitSaveEnabled(): boolean {
  const raw = process.env.FORM_COMMAND_ENGINE_EXPLICIT_SAVE_ENABLED;
  return !!raw && TRUE_VALUES.has(raw.trim().toLowerCase());
}
