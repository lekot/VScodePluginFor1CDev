import * as fs from 'fs';
import * as path from 'path';
import { parseCommandInterface, serializeCommandInterface } from '../parsers/commandInterfaceParser';
import { assertPathWithinRoot, PathBoundaryError } from '../services/configurationSession/pathBoundary';
import { AtomicFileStorage, hashContent, StorageOutcome } from '../services/configurationSession/atomicFileStorage';
import type {
  CommandInterfaceModel,
  CommandVisibilityEntry,
  CommandOrderEntry,
  CommandVisibility,
} from '../types/commandInterface';
import type { AgentResult } from './types';

async function resolveCommandInterfacePath(subsystemPath: string, configRootPath: string): Promise<string> {
  let candidate: string;
  // If subsystemPath is already an absolute path pointing to a .xml file,
  // derive Ext/CommandInterface.xml from its directory.
  if (path.isAbsolute(subsystemPath) && subsystemPath.endsWith('.xml')) {
    const dir = path.dirname(subsystemPath);
    candidate = path.join(dir, 'Ext', 'CommandInterface.xml');
  } else if (path.isAbsolute(subsystemPath)) {
    // If subsystemPath is absolute pointing to a directory
    candidate = path.join(subsystemPath, 'Ext', 'CommandInterface.xml');
  } else if (subsystemPath.includes('/') || subsystemPath.includes('\\')) {
    // Relative filesystem path (e.g. "Subsystems/Администрирование" or "../../Outside")
    const resolved = path.resolve(configRootPath, subsystemPath);
    if (resolved.endsWith('.xml')) {
      candidate = path.join(path.dirname(resolved), 'Ext', 'CommandInterface.xml');
    } else {
      candidate = path.join(resolved, 'Ext', 'CommandInterface.xml');
    }
  } else {
    // Relative path with 1C metadata notation like "Subsystems/Администрирование" or "Subsystem.Администрирование"
    const normalized = subsystemPath
      .replace(/^Subsystem\./i, '')
      .replace(/\./g, path.sep);

    // Try under Subsystems/ subfolder of configRoot
    const underSubsystems = path.join(configRootPath, 'Subsystems', normalized, 'Ext', 'CommandInterface.xml');
    try {
      await fs.promises.access(underSubsystems);
      candidate = underSubsystems;
    } catch {
      // Try as-is under configRoot
      candidate = path.join(configRootPath, normalized, 'Ext', 'CommandInterface.xml');
    }
  }

  await assertPathWithinRoot(configRootPath, candidate);
  return candidate;
}

async function readModelWithHash(ciPath: string): Promise<{ model: CommandInterfaceModel; hash: string }> {
  const text = await fs.promises.readFile(ciPath, 'utf8');
  return {
    model: parseCommandInterface(text),
    hash: hashContent(text),
  };
}

async function writeModel(
  configRootPath: string,
  ciPath: string,
  model: CommandInterfaceModel,
  expectedHash: string,
): Promise<StorageOutcome> {
  const xml = serializeCommandInterface(model);
  const storage = new AtomicFileStorage(configRootPath);
  return storage.replace(ciPath, xml, expectedHash);
}

export class CommandInterfaceOperations {
  constructor(private readonly configRootPath: string) {}

  async getCommandInterface(subsystemPath: string): Promise<AgentResult<CommandInterfaceModel>> {
    try {
      const ciPath = await resolveCommandInterfacePath(subsystemPath, this.configRootPath);
      try {
        await fs.promises.access(ciPath);
      } catch {
        return { success: false, error: `Файл не найден: ${ciPath}` };
      }
      const { model } = await readModelWithHash(ciPath);
      return { success: true, data: model };
    } catch (err) {
      if (err instanceof PathBoundaryError) {
        return {
          success: false,
          code: err.code === 'PATH_UNAVAILABLE' ? 'PATH_UNAVAILABLE' : 'TARGET_OUTSIDE_ROOT',
          error: err.message,
        };
      }
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async setCommandVisibility(
    subsystemPath: string,
    commandName: string,
    common: CommandVisibility | null,
  ): Promise<AgentResult> {
    try {
      const ciPath = await resolveCommandInterfacePath(subsystemPath, this.configRootPath);
      try {
        await fs.promises.access(ciPath);
      } catch {
        return { success: false, error: `Файл не найден: ${ciPath}` };
      }
      const { model, hash } = await readModelWithHash(ciPath);
      let updated: readonly CommandVisibilityEntry[];
      if (common === null) {
        updated = model.visibility.filter((e) => e.commandName !== commandName);
      } else {
        const existing = model.visibility.findIndex((e) => e.commandName === commandName);
        if (existing >= 0) {
          updated = model.visibility.map((e) =>
            e.commandName === commandName ? { commandName, common } : e,
          );
        } else {
          updated = [...model.visibility, { commandName, common }];
        }
      }
      const outcome = await writeModel(this.configRootPath, ciPath, { ...model, visibility: updated }, hash);
      if (outcome.status === 'conflict') {
        return { success: false, code: outcome.code, error: outcome.message };
      }
      if (outcome.status !== 'committed') {
        return { success: false, error: outcome.message };
      }
      return { success: true };
    } catch (err) {
      if (err instanceof PathBoundaryError) {
        return {
          success: false,
          code: err.code === 'PATH_UNAVAILABLE' ? 'PATH_UNAVAILABLE' : 'TARGET_OUTSIDE_ROOT',
          error: err.message,
        };
      }
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async setCommandOrder(
    subsystemPath: string,
    entries: CommandOrderEntry[],
  ): Promise<AgentResult> {
    try {
      const ciPath = await resolveCommandInterfacePath(subsystemPath, this.configRootPath);
      try {
        await fs.promises.access(ciPath);
      } catch {
        return { success: false, error: `Файл не найден: ${ciPath}` };
      }
      const { model, hash } = await readModelWithHash(ciPath);
      const outcome = await writeModel(this.configRootPath, ciPath, { ...model, commandsOrder: entries }, hash);
      if (outcome.status === 'conflict') {
        return { success: false, code: outcome.code, error: outcome.message };
      }
      if (outcome.status !== 'committed') {
        return { success: false, error: outcome.message };
      }
      return { success: true };
    } catch (err) {
      if (err instanceof PathBoundaryError) {
        return {
          success: false,
          code: err.code === 'PATH_UNAVAILABLE' ? 'PATH_UNAVAILABLE' : 'TARGET_OUTSIDE_ROOT',
          error: err.message,
        };
      }
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async setSubsystemsOrder(
    subsystemPath: string,
    order: string[],
  ): Promise<AgentResult> {
    try {
      const ciPath = await resolveCommandInterfacePath(subsystemPath, this.configRootPath);
      try {
        await fs.promises.access(ciPath);
      } catch {
        return { success: false, error: `Файл не найден: ${ciPath}` };
      }
      const { model, hash } = await readModelWithHash(ciPath);
      const outcome = await writeModel(this.configRootPath, ciPath, { ...model, subsystemsOrder: order }, hash);
      if (outcome.status === 'conflict') {
        return { success: false, code: outcome.code, error: outcome.message };
      }
      if (outcome.status !== 'committed') {
        return { success: false, error: outcome.message };
      }
      return { success: true };
    } catch (err) {
      if (err instanceof PathBoundaryError) {
        return {
          success: false,
          code: err.code === 'PATH_UNAVAILABLE' ? 'PATH_UNAVAILABLE' : 'TARGET_OUTSIDE_ROOT',
          error: err.message,
        };
      }
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
