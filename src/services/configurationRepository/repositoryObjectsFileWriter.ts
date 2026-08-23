import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { RepositoryObjectReference, RepositoryTarget } from './types';

const OBJECTS_NAMESPACE = 'http://v8.1c.ru/8.3/config/objects';

export interface RepositoryObjectsFile {
  readonly filePath: string;
  readonly fullNames: readonly string[];
  readonly dispose: () => Promise<void>;
}

/** Writes the official Designer Objects.xml file in a one-operation temp directory. */
export async function writeRepositoryObjectsFile(
  _target: RepositoryTarget,
  references: readonly RepositoryObjectReference[],
  recursive: boolean,
): Promise<RepositoryObjectsFile> {
  const fullNames = [...new Set(references.map((reference) => reference.repositoryFullName))];
  if (fullNames.length === 0) {
    throw new Error('Для операции Хранилища не выбран объект метаданных.');
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-'));
  const filePath = path.join(directory, 'Objects.xml');
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<Objects xmlns="${OBJECTS_NAMESPACE}" version="1.0">`,
    ...fullNames.map((fullName) =>
      `  <Object fullName="${escapeXml(fullName)}" includeChildObjects="${recursive ? 'true' : 'false'}"/>`),
    '</Objects>',
    '',
  ].join('\n');
  await fs.writeFile(filePath, body, 'utf8');
  return Object.freeze({
    filePath,
    fullNames: Object.freeze(fullNames),
    dispose: async () => {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    },
  });
}

/** Writes a root configuration list when a future operation needs one. */
export async function writeRepositoryConfigurationObjectsFile(
  _target: RepositoryTarget,
  recursive: boolean,
): Promise<RepositoryObjectsFile> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-'));
  const filePath = path.join(directory, 'Objects.xml');
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<Objects xmlns="${OBJECTS_NAMESPACE}" version="1.0">`,
    `  <Configuration includeChildObjects="${recursive ? 'true' : 'false'}"/>`,
    '</Objects>',
    '',
  ].join('\n');
  await fs.writeFile(filePath, body, 'utf8');
  return Object.freeze({
    filePath,
    fullNames: Object.freeze(['Configuration']),
    dispose: async () => {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    },
  });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/"/gu, '&quot;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/'/gu, '&apos;');
}
