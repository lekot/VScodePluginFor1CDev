import * as fs from 'fs';
import * as path from 'path';
import type { ConfigurationBinding } from './models/configurationBinding';
import type { InfobaseEntry } from '../infobases/models/infobaseEntry';
import type { DeployItemResult } from './deployContracts';
import { assertExistingPathWithinRootSync, PathBoundaryError, validateWorkspaceRelativePath } from '../services/configurationSession/pathBoundary';

/**
 * Резолв каталога выгрузки: родительский каталог Configuration.xml (как в интерактивном import).
 */
export function resolveConfigurationXmlDirectory(
  workspaceFolderRoot: string,
  configRelativePath: string,
): { ok: true; sourceDir: string; configXml: string } | { ok: false; message: string } {
  if (!configRelativePath.trim()) {
    return { ok: false, message: 'Не задан относительный путь к Configuration.xml.' };
  }
  let rel: string;
  try {
    rel = validateWorkspaceRelativePath(configRelativePath);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const configXml = path.resolve(workspaceFolderRoot, rel);
  const base = path.basename(configXml);
  if (base.toLowerCase() !== 'configuration.xml') {
    return {
      ok: false,
      message: 'Ожидался путь к файлу Configuration.xml в привязке.',
    };
  }
  try {
    if (!fs.existsSync(configXml)) {
      return {
        ok: false,
        message: `Файл конфигурации не найден: ${configXml}`,
      };
    }
    const contained = assertExistingPathWithinRootSync(workspaceFolderRoot, configXml);
    return {
      ok: true,
      sourceDir: path.dirname(contained.canonicalTarget),
      configXml: contained.canonicalTarget,
    };
  } catch (error) {
    const detail = error instanceof PathBoundaryError ? error.message : `Не удалось проверить путь: ${configXml}`;
    return { ok: false, message: detail };
  }
}

/** Подписи целей для диалога подтверждения (порядок = порядок раскатки). */
export function listDeployTargetLabels(binding: ConfigurationBinding, catalog: readonly InfobaseEntry[]): string[] {
  const catalogById = new Map(catalog.map((e) => [e.id, e] as const));
  const orderedIds = binding.infobaseIds;
  const activeIds =
    binding.massDeployment === true ? orderedIds : orderedIds.length > 0 ? [orderedIds[0]!] : [];
  const lines: string[] = [];
  for (const id of activeIds) {
    const entry = catalogById.get(id);
    if (!entry) {
      lines.push(`• (${id}) — не найдена в каталоге`);
    } else if (entry.type === 'web') {
      lines.push(`• ${entry.name} — веб-база, будет пропущена`);
    } else {
      lines.push(`• ${entry.name}`);
    }
  }
  return lines;
}

/** Список ИБ для ibcmd import с учётом massDeployment и фильтра веб-баз (для UI и DeployService). */
export function resolveDeployTargetsForBinding(
  binding: ConfigurationBinding,
  catalogById: ReadonlyMap<string, InfobaseEntry>,
): { entries: InfobaseEntry[]; skipped: DeployItemResult[] } {
  const skipped: DeployItemResult[] = [];
  const orderedIds = binding.infobaseIds;
  const activeIds =
    binding.massDeployment === true ? orderedIds : orderedIds.length > 0 ? [orderedIds[0]!] : [];

  const entries: InfobaseEntry[] = [];
  for (const id of activeIds) {
    const entry = catalogById.get(id);
    if (!entry) {
      skipped.push({
        infobaseId: id,
        name: id,
        status: 'skipped',
        message: 'База не найдена в каталоге Infobase Manager.',
      });
      continue;
    }
    if (entry.type === 'web') {
      skipped.push({
        infobaseId: id,
        name: entry.name,
        status: 'skipped',
        message: 'Веб-база: загрузка конфигурации через ibcmd не поддерживается.',
      });
      continue;
    }
    entries.push(entry);
  }
  return { entries, skipped };
}
