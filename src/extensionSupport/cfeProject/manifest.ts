import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { assertNoSymlinkSegments, assertPathWithinRoot, validateWorkspaceRelativePath } from '../../services/configurationSession/pathBoundary';
import { validateElementName } from '../../utils/elementNameValidator';
import { CFE_PROJECT_MANIFEST_VERSION, type CfeProjectManifestRecord, type CfeProjectManifestV1 } from './types';

const MANIFEST_FILE = 'cfe-projects.json';

/** Versioned, atomic storage for CFE-to-base project relations. */
export class CfeProjectManifestStorage {
  private static readonly upsertQueues = new Map<string, Promise<void>>();
  readonly path: string;

  constructor(readonly workspaceRoot: string) {
    this.path = path.join(workspaceRoot, '.vscode', MANIFEST_FILE);
  }

  async read(): Promise<CfeProjectManifestV1> {
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.promises.readFile(this.path, 'utf8'));
    } catch (error) {
      if (isMissing(error)) {
        return { version: CFE_PROJECT_MANIFEST_VERSION, projects: [] };
      }
      throw new CfeProjectManifestError('Manifest CFE-проектов повреждён.');
    }
    return await validateManifest(raw, this.workspaceRoot);
  }

  async upsert(record: CfeProjectManifestRecord): Promise<CfeProjectManifestV1> {
    return this.runUpsertExclusive(async () => {
      const normalized = await normalizeRecord(record, this.workspaceRoot);
      const manifest = await this.read();
      const samePair = (candidate: CfeProjectManifestRecord): boolean =>
        candidate.baseConfiguration === normalized.baseConfiguration
        && candidate.extensionConfiguration === normalized.extensionConfiguration;
      const projects = [...manifest.projects.filter((candidate) => !samePair(candidate)), normalized];
      const next: CfeProjectManifestV1 = { version: CFE_PROJECT_MANIFEST_VERSION, projects };
      await this.writeAtomic(next);
      return next;
    });
  }

  /** Serializes the whole read-modify-write cycle for every storage instance of one workspace. */
  private async runUpsertExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const key = await fs.promises.realpath(this.workspaceRoot);
    const previous = CfeProjectManifestStorage.upsertQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const completion = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.catch(() => undefined).then(() => completion);
    CfeProjectManifestStorage.upsertQueues.set(key, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (CfeProjectManifestStorage.upsertQueues.get(key) === queued) {
        CfeProjectManifestStorage.upsertQueues.delete(key);
      }
    }
  }

  async writeAtomic(manifest: CfeProjectManifestV1): Promise<void> {
    const validated = await validateManifest(manifest, this.workspaceRoot);
    const root = await fs.promises.realpath(this.workspaceRoot);
    const target = await assertPathWithinRoot(root, path.join(root, '.vscode', MANIFEST_FILE));
    const directory = path.dirname(target.canonicalTarget);
    await assertNoSymlinkSegments(target.canonicalRoot, target.canonicalTarget);
    await fs.promises.mkdir(directory, { recursive: true });
    await assertNoSymlinkSegments(target.canonicalRoot, target.canonicalTarget);
    const temporary = path.join(directory, `.${MANIFEST_FILE}.${randomUUID()}.tmp`);
    try {
      await fs.promises.writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await fs.promises.rename(temporary, target.canonicalTarget);
    } finally {
      await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

export class CfeProjectManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CfeProjectManifestError';
  }
}

export async function validateManifest(value: unknown, workspaceRoot: string): Promise<CfeProjectManifestV1> {
  if (!value || typeof value !== 'object') {
    throw new CfeProjectManifestError('Manifest CFE-проектов должен быть объектом.');
  }
  const candidate = value as Partial<CfeProjectManifestV1>;
  if (candidate.version !== CFE_PROJECT_MANIFEST_VERSION || !Array.isArray(candidate.projects)) {
    throw new CfeProjectManifestError('Поддерживается только manifest CFE-проектов версии 1.');
  }
  const projects = await Promise.all(candidate.projects.map((record) => normalizeRecord(record, workspaceRoot)));
  const pairs = new Set<string>();
  const extensions = new Set<string>();
  for (const project of projects) {
    const pair = `${project.baseConfiguration}\0${project.extensionConfiguration}`;
    if (pairs.has(pair) || extensions.has(project.extensionConfiguration)) {
      throw new CfeProjectManifestError('Пары CFE-проектов и пути расширений должны быть уникальны.');
    }
    pairs.add(pair);
    extensions.add(project.extensionConfiguration);
  }
  return { version: CFE_PROJECT_MANIFEST_VERSION, projects };
}

export async function normalizeRecord(value: unknown, workspaceRoot: string): Promise<CfeProjectManifestRecord> {
  if (!value || typeof value !== 'object') {
    throw new CfeProjectManifestError('Запись CFE-проекта должна быть объектом.');
  }
  const candidate = value as Partial<CfeProjectManifestRecord>;
  if (typeof candidate.baseConfiguration !== 'string' || typeof candidate.extensionConfiguration !== 'string'
    || typeof candidate.extensionName !== 'string' || validateElementName(candidate.extensionName.trim(), []) !== null) {
    throw new CfeProjectManifestError('Запись CFE-проекта содержит некорректные поля.');
  }
  const baseConfiguration = normalizeProjectPath(candidate.baseConfiguration);
  const extensionConfiguration = normalizeProjectPath(candidate.extensionConfiguration);
  const root = await fs.promises.realpath(workspaceRoot);
  for (const relativePath of [baseConfiguration, extensionConfiguration]) {
    const target = await assertPathWithinRoot(root, path.join(root, relativePath));
    await assertNoSymlinkSegments(target.canonicalRoot, target.canonicalTarget);
  }
  return { baseConfiguration, extensionConfiguration, extensionName: candidate.extensionName.trim() };
}

/** `.` is the only valid spelling for a configuration rooted at the workspace itself. */
function normalizeProjectPath(value: string): string {
  return value.trim() === '.' ? '.' : validateWorkspaceRelativePath(value);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
