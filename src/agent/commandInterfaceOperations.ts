import * as fs from 'fs';
import * as path from 'path';
import { parseCommandInterface, serializeCommandInterface } from '../parsers/commandInterfaceParser';
import type {
  CommandInterfaceModel,
  CommandVisibilityEntry,
  CommandOrderEntry,
  CommandVisibility,
} from '../types/commandInterface';
import type { AgentResult } from './types';

function resolveCommandInterfacePath(subsystemPath: string, configRootPath: string): string {
  // If subsystemPath is already an absolute path pointing to a .xml file,
  // derive Ext/CommandInterface.xml from its directory.
  if (path.isAbsolute(subsystemPath) && subsystemPath.endsWith('.xml')) {
    const dir = path.dirname(subsystemPath);
    return path.join(dir, 'Ext', 'CommandInterface.xml');
  }
  // If subsystemPath is absolute pointing to a directory
  if (path.isAbsolute(subsystemPath) && !subsystemPath.endsWith('.xml')) {
    return path.join(subsystemPath, 'Ext', 'CommandInterface.xml');
  }
  // Relative path like "Subsystems/Администрирование" or "Subsystem.Администрирование"
  const normalized = subsystemPath
    .replace(/^Subsystem\./i, '')
    .replace(/\./g, path.sep)
    .replace(/Subsystem[/\\]/gi, `Subsystems${path.sep}`);

  // Try under Subsystems/ subfolder of configRoot
  const candidate = path.join(configRootPath, 'Subsystems', normalized, 'Ext', 'CommandInterface.xml');
  if (fs.existsSync(candidate)) { return candidate; }

  // Try as-is under configRoot
  return path.join(configRootPath, normalized, 'Ext', 'CommandInterface.xml');
}

function readModel(ciPath: string): CommandInterfaceModel {
  const text = fs.readFileSync(ciPath, 'utf8');
  return parseCommandInterface(text);
}

function writeModel(ciPath: string, model: CommandInterfaceModel): void {
  const xml = serializeCommandInterface(model);
  fs.writeFileSync(ciPath, xml, 'utf8');
}

export class CommandInterfaceOperations {
  constructor(private readonly configRootPath: string) {}

  async getCommandInterface(subsystemPath: string): Promise<AgentResult<CommandInterfaceModel>> {
    try {
      const ciPath = resolveCommandInterfacePath(subsystemPath, this.configRootPath);
      if (!fs.existsSync(ciPath)) {
        return { success: false, error: `Файл не найден: ${ciPath}` };
      }
      const model = readModel(ciPath);
      return { success: true, data: model };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async setCommandVisibility(
    subsystemPath: string,
    commandName: string,
    common: CommandVisibility | null
  ): Promise<AgentResult> {
    try {
      const ciPath = resolveCommandInterfacePath(subsystemPath, this.configRootPath);
      if (!fs.existsSync(ciPath)) {
        return { success: false, error: `Файл не найден: ${ciPath}` };
      }
      const model = readModel(ciPath);
      let updated: readonly CommandVisibilityEntry[];
      if (common === null) {
        updated = model.visibility.filter((e) => e.commandName !== commandName);
      } else {
        const existing = model.visibility.findIndex((e) => e.commandName === commandName);
        if (existing >= 0) {
          updated = model.visibility.map((e) =>
            e.commandName === commandName ? { commandName, common } : e
          );
        } else {
          updated = [...model.visibility, { commandName, common }];
        }
      }
      writeModel(ciPath, { ...model, visibility: updated });
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async setCommandOrder(
    subsystemPath: string,
    entries: CommandOrderEntry[]
  ): Promise<AgentResult> {
    try {
      const ciPath = resolveCommandInterfacePath(subsystemPath, this.configRootPath);
      if (!fs.existsSync(ciPath)) {
        return { success: false, error: `Файл не найден: ${ciPath}` };
      }
      const model = readModel(ciPath);
      writeModel(ciPath, { ...model, commandsOrder: entries });
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async setSubsystemsOrder(
    subsystemPath: string,
    order: string[]
  ): Promise<AgentResult> {
    try {
      const ciPath = resolveCommandInterfacePath(subsystemPath, this.configRootPath);
      if (!fs.existsSync(ciPath)) {
        return { success: false, error: `Файл не найден: ${ciPath}` };
      }
      const model = readModel(ciPath);
      writeModel(ciPath, { ...model, subsystemsOrder: order });
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
