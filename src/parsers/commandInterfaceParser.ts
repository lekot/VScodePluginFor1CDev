import { XMLParser } from 'fast-xml-parser';
import type {
  CommandInterfaceModel,
  CommandVisibilityEntry,
  CommandPlacementEntry,
  CommandOrderEntry,
  CommandVisibility,
} from '../types/commandInterface';

const BOM = '\uFEFF';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (tagName) =>
    tagName === 'Command' || tagName === 'Subsystem' || tagName === 'Group',
});

function toArray<T>(val: T | T[] | undefined): T[] {
  if (val === undefined || val === null) { return []; }
  return Array.isArray(val) ? val : [val];
}

function parseVisibility(raw: unknown): CommandVisibilityEntry[] {
  if (!raw || typeof raw !== 'object') { return []; }
  const section = raw as Record<string, unknown>;
  const commands = toArray(section['Command'] as Record<string, unknown>[] | undefined);
  return commands.map((cmd) => {
    const name = String(cmd['@_name'] ?? '');
    const visibility = cmd['Visibility'] as Record<string, unknown> | undefined;
    const xrCommon = visibility?.['xr:Common'];
    const common: CommandVisibility = xrCommon === 'true' || xrCommon === true ? 'visible' : 'hidden';
    return { commandName: name, common };
  });
}

function parsePlacement(raw: unknown): CommandPlacementEntry[] {
  if (!raw || typeof raw !== 'object') { return []; }
  const section = raw as Record<string, unknown>;
  const commands = toArray(section['Command'] as Record<string, unknown>[] | undefined);
  return commands.map((cmd) => {
    const name = String(cmd['@_name'] ?? '');
    const commandGroup = String(cmd['CommandGroup'] ?? '');
    const placement = String(cmd['Placement'] ?? '');
    return { commandName: name, commandGroup, placement };
  });
}

function parseCommandsOrder(raw: unknown): CommandOrderEntry[] {
  if (!raw || typeof raw !== 'object') { return []; }
  const section = raw as Record<string, unknown>;
  const commands = toArray(section['Command'] as Record<string, unknown>[] | undefined);
  return commands.map((cmd) => {
    const name = String(cmd['@_name'] ?? '');
    const commandGroup = String(cmd['CommandGroup'] ?? '');
    return { commandName: name, commandGroup };
  });
}

function parseSubsystemsOrder(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') { return []; }
  const section = raw as Record<string, unknown>;
  return toArray(section['Subsystem'] as string[] | undefined).map(String);
}

function parseGroupsOrder(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') { return []; }
  const section = raw as Record<string, unknown>;
  return toArray(section['Group'] as string[] | undefined).map(String);
}

export function parseCommandInterface(xmlText: string): CommandInterfaceModel {
  const hasBom = xmlText.startsWith(BOM);
  const text = hasBom ? xmlText.slice(1) : xmlText;

  const parsed = parser.parse(text) as Record<string, unknown>;
  const root = parsed['CommandInterface'] as Record<string, unknown> | undefined;

  const xmlVersion = String(
    (root?.['@_version'] as string | undefined) ?? '2.17'
  );

  return {
    xmlVersion,
    hasBom,
    visibility: root ? parseVisibility(root['CommandsVisibility']) : [],
    placement: root ? parsePlacement(root['CommandsPlacement']) : [],
    commandsOrder: root ? parseCommandsOrder(root['CommandsOrder']) : [],
    subsystemsOrder: root ? parseSubsystemsOrder(root['SubsystemsOrder']) : [],
    groupsOrder: root ? parseGroupsOrder(root['GroupsOrder']) : [],
  };
}

// ── Serializer ────────────────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function visibilityLines(entries: readonly CommandVisibilityEntry[]): string {
  if (entries.length === 0) { return ''; }
  const rows = entries
    .map(
      (e) =>
        `\t\t<Command name="${escapeXml(e.commandName)}">\n` +
        `\t\t\t<Visibility>\n` +
        `\t\t\t\t<xr:Common>${e.common === 'visible' ? 'true' : 'false'}</xr:Common>\n` +
        `\t\t\t</Visibility>\n` +
        `\t\t</Command>`
    )
    .join('\n');
  return `\t<CommandsVisibility>\n${rows}\n\t</CommandsVisibility>\n`;
}

function placementLines(entries: readonly CommandPlacementEntry[]): string {
  if (entries.length === 0) { return ''; }
  const rows = entries
    .map(
      (e) =>
        `\t\t<Command name="${escapeXml(e.commandName)}">\n` +
        `\t\t\t<CommandGroup>${escapeXml(e.commandGroup)}</CommandGroup>\n` +
        `\t\t\t<Placement>${escapeXml(e.placement)}</Placement>\n` +
        `\t\t</Command>`
    )
    .join('\n');
  return `\t<CommandsPlacement>\n${rows}\n\t</CommandsPlacement>\n`;
}

function commandsOrderLines(entries: readonly CommandOrderEntry[]): string {
  if (entries.length === 0) { return ''; }
  const rows = entries
    .map(
      (e) =>
        `\t\t<Command name="${escapeXml(e.commandName)}">\n` +
        `\t\t\t<CommandGroup>${escapeXml(e.commandGroup)}</CommandGroup>\n` +
        `\t\t</Command>`
    )
    .join('\n');
  return `\t<CommandsOrder>\n${rows}\n\t</CommandsOrder>\n`;
}

function subsystemsOrderLines(entries: readonly string[]): string {
  if (entries.length === 0) { return ''; }
  const rows = entries.map((s) => `\t\t<Subsystem>${escapeXml(s)}</Subsystem>`).join('\n');
  return `\t<SubsystemsOrder>\n${rows}\n\t</SubsystemsOrder>\n`;
}

function groupsOrderLines(entries: readonly string[]): string {
  if (entries.length === 0) { return ''; }
  const rows = entries.map((g) => `\t\t<Group>${escapeXml(g)}</Group>`).join('\n');
  return `\t<GroupsOrder>\n${rows}\n\t</GroupsOrder>\n`;
}

export function serializeCommandInterface(model: CommandInterfaceModel): string {
  const sections =
    visibilityLines(model.visibility) +
    placementLines(model.placement) +
    commandsOrderLines(model.commandsOrder) +
    subsystemsOrderLines(model.subsystemsOrder) +
    groupsOrderLines(model.groupsOrder);

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<CommandInterface` +
    ` xmlns="http://v8.1c.ru/8.3/xcf/extrnprops"` +
    ` xmlns:xr="http://v8.1c.ru/8.3/xcf/readable"` +
    ` xmlns:xs="http://www.w3.org/2001/XMLSchema"` +
    ` xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"` +
    ` version="${escapeXml(model.xmlVersion)}">\n` +
    sections +
    `</CommandInterface>`;

  return model.hasBom ? BOM + body : body;
}
