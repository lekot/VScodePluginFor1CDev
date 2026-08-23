import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type * as vscode from 'vscode';
import type {
  RepositoryBinding,
  RepositoryObservedState,
  RepositoryTarget,
} from './types';

const BINDINGS_SCHEMA_VERSION = 1;
const STATE_SCHEMA_VERSION = 1;
const DEFAULT_STATE: RepositoryObservedState = Object.freeze({
  connection: 'unknown',
  locks: Object.freeze({}),
  source: 'unknown',
});

const mutationTails = new Map<string, Promise<void>>();

async function withMutationLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath).toLocaleLowerCase();
  const previous = mutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  mutationTails.set(key, gate);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (mutationTails.get(key) === gate) {
      mutationTails.delete(key);
    }
  }
}

interface StoredBinding {
  readonly targetKey: string;
  readonly configRoot: string;
  readonly configKind: RepositoryTarget['configKind'];
  readonly extensionName?: string;
  readonly repositoryPath: string;
  readonly repositoryUser: string;
  readonly executionInfobaseId: string;
}

interface BindingsFile {
  readonly schemaVersion: 1;
  readonly bindings: readonly StoredBinding[];
}

interface StateFile {
  readonly schemaVersion: 1;
  readonly states: Readonly<Record<string, RepositoryObservedState>>;
}

function normalizePath(value: string): string {
  const normalized = path.resolve(value).replace(/\\/g, '/').replace(/\/+$/u, '');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}

export function repositoryTargetKey(target: Pick<RepositoryTarget, 'configRoot' | 'configKind' | 'extensionName'>): string {
  return `${target.configKind}:${normalizePath(target.configRoot)}:${(target.extensionName ?? '').trim().toLocaleLowerCase()}`;
}

export class RepositoryBindingStore {
  constructor(private readonly filePath: string) {}

  async get(target: RepositoryTarget): Promise<RepositoryBinding | undefined> {
    const file = await this.readFile();
    const key = repositoryTargetKey(target);
    const binding = file.bindings.find((candidate) => candidate.targetKey === key);
    return binding
      ? Object.freeze({
          repositoryPath: binding.repositoryPath,
          repositoryUser: binding.repositoryUser,
          executionInfobaseId: binding.executionInfobaseId,
        })
      : undefined;
  }

  async list(): Promise<readonly StoredBinding[]> {
    return Object.freeze([...(await this.readFile()).bindings]);
  }

  async set(target: RepositoryTarget, binding: RepositoryBinding): Promise<void> {
    const repositoryPath = binding.repositoryPath.trim();
    const repositoryUser = binding.repositoryUser.trim();
    const executionInfobaseId = binding.executionInfobaseId.trim();
    if (!repositoryPath || !repositoryUser || !executionInfobaseId) {
      throw new Error('Путь, пользователь Хранилища и исполняющая файловая ИБ обязательны.');
    }
    await withMutationLock(this.filePath, async () => {
      const file = await this.readFile();
      const targetKey = repositoryTargetKey(target);
      const next: StoredBinding = {
        targetKey,
        configRoot: normalizePath(target.configRoot),
        configKind: target.configKind,
        ...(target.extensionName?.trim() ? { extensionName: target.extensionName.trim() } : {}),
        repositoryPath,
        repositoryUser,
        executionInfobaseId,
      };
      const bindings = file.bindings.filter((candidate) => candidate.targetKey !== targetKey);
      bindings.push(next);
      await this.writeFile({ schemaVersion: BINDINGS_SCHEMA_VERSION, bindings });
    });
  }

  async delete(target: RepositoryTarget): Promise<boolean> {
    return withMutationLock(this.filePath, async () => {
      const file = await this.readFile();
      const targetKey = repositoryTargetKey(target);
      const bindings = file.bindings.filter((candidate) => candidate.targetKey !== targetKey);
      if (bindings.length === file.bindings.length) {
        return false;
      }
      await this.writeFile({ schemaVersion: BINDINGS_SCHEMA_VERSION, bindings });
      return true;
    });
  }

  private async readFile(): Promise<BindingsFile> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object' || (raw as { schemaVersion?: unknown }).schemaVersion !== BINDINGS_SCHEMA_VERSION) {
        throw new Error('Неподдерживаемая версия файла привязок Хранилища.');
      }
      const items = (raw as { bindings?: unknown }).bindings;
      if (!Array.isArray(items)) {
        throw new Error('Поле bindings в файле Хранилища должно быть массивом.');
      }
      const bindings: StoredBinding[] = [];
      for (const item of items) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        const candidate = item as Partial<StoredBinding>;
        if (
          typeof candidate.targetKey !== 'string'
          || typeof candidate.configRoot !== 'string'
          || (candidate.configKind !== 'cf' && candidate.configKind !== 'cfe')
          || typeof candidate.repositoryPath !== 'string'
          || typeof candidate.repositoryUser !== 'string'
          || typeof candidate.executionInfobaseId !== 'string'
          || !candidate.executionInfobaseId.trim()
        ) {
          continue;
        }
        bindings.push(Object.freeze({
          targetKey: candidate.targetKey,
          configRoot: candidate.configRoot,
          configKind: candidate.configKind,
          ...(typeof candidate.extensionName === 'string' && candidate.extensionName.trim()
            ? { extensionName: candidate.extensionName.trim() }
            : {}),
          repositoryPath: candidate.repositoryPath,
          repositoryUser: candidate.repositoryUser,
          executionInfobaseId: candidate.executionInfobaseId.trim(),
        }));
      }
      return { schemaVersion: BINDINGS_SCHEMA_VERSION, bindings };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { schemaVersion: BINDINGS_SCHEMA_VERSION, bindings: [] };
      }
      if (error instanceof SyntaxError) {
        throw new Error(`Файл привязок Хранилища повреждён: ${error.message}`);
      }
      throw error;
    }
  }

  private async writeFile(file: BindingsFile): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, this.filePath);
  }
}

export class RepositoryStateStore {
  constructor(private readonly filePath: string) {}

  async get(target: RepositoryTarget): Promise<RepositoryObservedState> {
    const file = await this.readFile();
    return file.states[repositoryTargetKey(target)] ?? DEFAULT_STATE;
  }

  async set(target: RepositoryTarget, state: RepositoryObservedState): Promise<void> {
    const normalized = normalizeObservedState(state);
    await withMutationLock(this.filePath, async () => {
      const file = await this.readFile();
      const states = { ...file.states, [repositoryTargetKey(target)]: normalized };
      await this.writeFile({ schemaVersion: STATE_SCHEMA_VERSION, states });
    });
  }

  async clear(target: RepositoryTarget): Promise<void> {
    await withMutationLock(this.filePath, async () => {
      const file = await this.readFile();
      const states = { ...file.states };
      delete states[repositoryTargetKey(target)];
      await this.writeFile({ schemaVersion: STATE_SCHEMA_VERSION, states });
    });
  }

  private async readFile(): Promise<StateFile> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object' || (raw as { schemaVersion?: unknown }).schemaVersion !== STATE_SCHEMA_VERSION) {
        throw new Error('Неподдерживаемая версия файла состояния Хранилища.');
      }
      const states = (raw as { states?: unknown }).states;
      return { schemaVersion: STATE_SCHEMA_VERSION, states: decodeStates(states) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { schemaVersion: STATE_SCHEMA_VERSION, states: {} };
      }
      if (error instanceof SyntaxError) {
        throw new Error(`Файл состояния Хранилища повреждён: ${error.message}`);
      }
      throw error;
    }
  }

  private async writeFile(file: StateFile): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, this.filePath);
  }
}

export class RepositorySecretStore {
  constructor(private readonly secretStorage: vscode.SecretStorage) {}

  async get(target: RepositoryTarget): Promise<string | undefined> {
    return (await this.secretStorage.get(repositorySecretKey(target))) ?? undefined;
  }

  async set(target: RepositoryTarget, password: string): Promise<void> {
    await this.secretStorage.store(repositorySecretKey(target), password);
  }

  async delete(target: RepositoryTarget): Promise<void> {
    await this.secretStorage.delete(repositorySecretKey(target));
  }
}

export function repositorySecretKey(target: RepositoryTarget): string {
  const digest = crypto.createHash('sha256').update(repositoryTargetKey(target), 'utf8').digest('hex');
  return `cdt.configurationRepository.password.${digest}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function decodeStates(value: unknown): Readonly<Record<string, RepositoryObservedState>> {
  if (!isRecord(value)) {
    return {};
  }
  const states: Record<string, RepositoryObservedState> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isRecord(raw)) {
      continue;
    }
    try {
      states[key] = normalizeObservedState(raw);
    } catch {
      // Ignore malformed entries; the next acknowledged operation rewrites only its target.
    }
  }
  return states;
}

function normalizeObservedState(value: RepositoryObservedState | Record<string, unknown>): RepositoryObservedState {
  if (
    !isRecord(value)
    || (value.connection !== 'connected' && value.connection !== 'disconnected' && value.connection !== 'unknown')
    || (value.source !== 'configuratorAcknowledgement' && value.source !== 'unknown')
    || !isRecord(value.locks)
  ) {
    throw new Error('Некорректное состояние Хранилища конфигурации.');
  }
  const locks: Record<string, RepositoryObservedState['locks'][string]> = {};
  for (const [fullName, rawLock] of Object.entries(value.locks)) {
    if (rawLock === 'heldByCurrentCredentials' || rawLock === 'unlocked' || rawLock === 'unknown') {
      locks[fullName] = rawLock;
    }
  }
  return Object.freeze({
    connection: value.connection,
    locks: Object.freeze(locks),
    ...(typeof value.lastConfirmedAt === 'string' && value.lastConfirmedAt.trim()
      ? { lastConfirmedAt: value.lastConfirmedAt }
      : {}),
    source: value.source,
  });
}
