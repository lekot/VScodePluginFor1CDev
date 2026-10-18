import * as fs from 'fs';
import * as path from 'path';
import { METADATA_TYPE_DESCRIPTORS } from '../constants/metadataTypeDescriptors';
import {
  publishConfigurationTreeUnits,
  type ConfigurationTreePublishHooks,
  type ConfigurationTreePublishUnit,
} from './configurationTreePublish';

export type ExportedObjectsPublishHooks = ConfigurationTreePublishHooks;
export type { ConfigurationTreePublishHooks };

const ROOT_METADATA_FILES = new Set(['configuration.xml', 'configdumpinfo.xml']);
const ROOT_CONFIGURATION_MDO = 'configuration.mdo';

/**
 * Publishes only metadata units present in an ibcmd object export. Designer
 * objects use their descriptor and companion directory; EDT objects use one
 * `src/<type>/<object>` directory. Unselected categories and sibling objects
 * are never promoted to publication units.
 */
export async function publishExportedObjects(
  sourceDir: string,
  destinationDir: string,
  hooks: ExportedObjectsPublishHooks = {},
): Promise<number> {
  const source = path.resolve(sourceDir);
  const units = await discoverMetadataUnits(source);
  return publishConfigurationTreeUnits(source, destinationDir, units, 'objects', hooks);
}

async function discoverMetadataUnits(sourceRoot: string): Promise<ConfigurationTreePublishUnit[]> {
  const rootEntries = await readDirectoryEntries(sourceRoot);
  const units: ConfigurationTreePublishUnit[] = [];

  for (const entry of rootEntries) {
    const lowerName = entry.name.toLocaleLowerCase();
    if (entry.isFile() && ROOT_METADATA_FILES.has(lowerName)) {
      units.push({ relativePath: entry.name });
      continue;
    }
    if (!entry.isDirectory()) { continue; }

    if (lowerName === 'src') {
      units.push(...await discoverEdtUnits(sourceRoot, entry.name));
      continue;
    }

    if (findMetadataType(entry.name)) {
      units.push(...await discoverDesignerUnits(sourceRoot, entry.name));
    }
  }

  return units;
}

async function discoverDesignerUnits(
  sourceRoot: string,
  typeFolder: string,
): Promise<ConfigurationTreePublishUnit[]> {
  const typePath = path.join(sourceRoot, typeFolder);
  const entries = await readDirectoryEntries(typePath);
  const objectFolders = new Map(
    entries.filter((entry) => entry.isDirectory()).map((entry) => [entry.name.toLocaleLowerCase(), entry.name]),
  );
  const units: ConfigurationTreePublishUnit[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLocaleLowerCase() !== '.xml') { continue; }
    const objectName = path.basename(entry.name, path.extname(entry.name));
    const companionFolder = objectFolders.get(objectName.toLocaleLowerCase());
    units.push({ relativePath: path.posix.join(typeFolder, entry.name) });
    units.push({
      relativePath: path.posix.join(typeFolder, companionFolder ?? objectName),
      removeWhenMissing: true,
    });
  }

  return units;
}

async function discoverEdtUnits(sourceRoot: string, srcFolder: string): Promise<ConfigurationTreePublishUnit[]> {
  const srcPath = path.join(sourceRoot, srcFolder);
  const typeEntries = await readDirectoryEntries(srcPath);
  const units: ConfigurationTreePublishUnit[] = [];

  for (const typeEntry of typeEntries) {
    if (typeEntry.isFile() && typeEntry.name.toLocaleLowerCase() === ROOT_CONFIGURATION_MDO) {
      units.push({ relativePath: path.posix.join(srcFolder, typeEntry.name) });
      continue;
    }
    if (!typeEntry.isDirectory()) { continue; }

    if (typeEntry.name.toLocaleLowerCase() === 'configuration') {
      const configEntries = await readDirectoryEntries(path.join(srcPath, typeEntry.name));
      if (configEntries.some((entry) => entry.isFile() && entry.name.toLocaleLowerCase() === ROOT_CONFIGURATION_MDO)) {
        units.push({ relativePath: path.posix.join(srcFolder, typeEntry.name) });
      }
      continue;
    }

    const metadataType = findMetadataType(typeEntry.name);
    if (!metadataType) { continue; }
    const objectEntries = await readDirectoryEntries(path.join(srcPath, typeEntry.name));
    for (const objectEntry of objectEntries) {
      if (!objectEntry.isDirectory()) { continue; }
      const objectPath = path.join(srcPath, typeEntry.name, objectEntry.name);
      const objectContents = await readDirectoryEntries(objectPath);
      if (containsObjectDescriptor(objectContents, objectEntry.name, metadataType.edtFileName)) {
        units.push({ relativePath: path.posix.join(srcFolder, typeEntry.name, objectEntry.name) });
      }
    }
  }

  return units;
}

function containsObjectDescriptor(
  entries: readonly fs.Dirent[],
  objectName: string,
  typeDescriptorName: string,
): boolean {
  const acceptedNames = new Set([
    `${objectName}.mdo`.toLocaleLowerCase(),
    typeDescriptorName.toLocaleLowerCase(),
  ]);
  return entries.some((entry) =>
    entry.isFile() && path.extname(entry.name).toLocaleLowerCase() === '.mdo'
    && acceptedNames.has(entry.name.toLocaleLowerCase()),
  );
}

function findMetadataType(folder: string) {
  const lowerFolder = folder.toLocaleLowerCase();
  return METADATA_TYPE_DESCRIPTORS.find((descriptor) =>
    descriptor.designerFolder.toLocaleLowerCase() === lowerFolder
    || descriptor.edtFolder.toLocaleLowerCase() === lowerFolder,
  );
}

async function readDirectoryEntries(directory: string): Promise<fs.Dirent[]> {
  const stat = await fs.promises.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Ожидался обычный каталог экспорта: ${directory}`);
  }
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    const entryStat = await fs.promises.lstat(entryPath);
    if (entryStat.isSymbolicLink()) {
      throw new Error(`Символическая ссылка запрещена в каталоге экспорта: ${entryPath}`);
    }
    if (!entryStat.isFile() && !entryStat.isDirectory()) {
      throw new Error(`Неподдерживаемый тип записи экспорта: ${entryPath}`);
    }
  }
  return entries;
}
