export type CommandVisibility = 'visible' | 'hidden';

export interface CommandVisibilityEntry {
  readonly commandName: string;
  readonly common: CommandVisibility;
}

export interface CommandPlacementEntry {
  readonly commandName: string;
  readonly commandGroup: string;
  readonly placement: string;
}

export interface CommandOrderEntry {
  readonly commandName: string;
  readonly commandGroup: string;
}

export interface CommandInterfaceModel {
  readonly xmlVersion: string;
  readonly hasBom: boolean;
  readonly visibility: readonly CommandVisibilityEntry[];
  readonly placement: readonly CommandPlacementEntry[];
  readonly commandsOrder: readonly CommandOrderEntry[];
  readonly subsystemsOrder: readonly string[];
  readonly groupsOrder: readonly string[];
}
