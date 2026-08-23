import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CfeProjectManifestStorage } from './manifest';
import { CfeProjectError, type CfeProjectContext, type CfeProjectManifestRecord, type CfeProjectPurpose } from './types';
import type { WorkspaceRegistry } from '../../services/configurationSession/WorkspaceRegistry';

/** Resolves persisted relations only to currently discovered, exact configuration sessions. */
export class CfeProjectRegistry {
  constructor(
    readonly workspaceRoot: string,
    private readonly workspaceRegistry: WorkspaceRegistry,
    readonly manifest = new CfeProjectManifestStorage(workspaceRoot),
  ) {}

  async list(): Promise<CfeProjectContext[]> {
    const manifest = await this.manifest.read();
    return Promise.all(manifest.projects.map((record) => this.resolveRecord(record)));
  }

  async getByBase(configurationId: string): Promise<CfeProjectContext> {
    const matches = (await this.list()).filter((context) => context.baseSession.identity.configurationId === configurationId);
    if (matches.length === 0) {
      throw new CfeProjectError('CFE_PROJECT_NOT_FOUND', 'Связанный CFE-проект не найден.');
    }
    if (matches.length > 1) {
      throw new CfeProjectError('CFE_RELATION_AMBIGUOUS', 'Для конфигурации найдено несколько CFE-проектов.');
    }
    return matches[0]!;
  }

  /** Resolves a CFE relation from the extension session, which is always unique. */
  async getByExtension(configurationId: string): Promise<CfeProjectContext> {
    const matches = (await this.list()).filter((context) => context.extensionSession.identity.configurationId === configurationId);
    if (matches.length === 0) {
      throw new CfeProjectError('CFE_PROJECT_NOT_FOUND', 'Связанный CFE-проект не найден.');
    }
    if (matches.length > 1) {
      throw new CfeProjectError('CFE_RELATION_AMBIGUOUS', 'Для расширения найдено несколько CFE-связей.');
    }
    return matches[0]!;
  }

  async findByPaths(baseRoot: string, extensionRoot: string): Promise<CfeProjectContext | undefined> {
    const root = await fs.promises.realpath(this.workspaceRoot);
    const baseRelative = toProjectPath(path.relative(root, await fs.promises.realpath(baseRoot)));
    const extensionRelative = toProjectPath(path.relative(root, await fs.promises.realpath(extensionRoot)));
    const manifest = await this.manifest.read();
    const record = manifest.projects.find((item) => item.baseConfiguration === baseRelative && item.extensionConfiguration === extensionRelative);
    return record ? this.resolveRecord(record) : undefined;
  }

  private async resolveRecord(record: CfeProjectManifestRecord): Promise<CfeProjectContext> {
    const workspaceRoot = await fs.promises.realpath(this.workspaceRoot);
    const baseRoot = await fs.promises.realpath(path.join(workspaceRoot, record.baseConfiguration));
    const extensionRoot = await fs.promises.realpath(path.join(workspaceRoot, record.extensionConfiguration));
    const baseSession = this.workspaceRegistry.list().map((item) => this.workspaceRegistry.require(item.configurationId))
      .find((session) => session.identity.rootPath === baseRoot);
    const extensionSession = this.workspaceRegistry.list().map((item) => this.workspaceRegistry.require(item.configurationId))
      .find((session) => session.identity.rootPath === extensionRoot);
    if (!baseSession || !extensionSession) {
      throw new CfeProjectError('CFE_PROJECT_NOT_FOUND', 'Конфигурации CFE-проекта ещё не обнаружены в workspace.');
    }
    const [baseXml, extensionXml] = await Promise.all([
      fs.promises.readFile(path.join(baseRoot, 'Configuration.xml'), 'utf8'),
      fs.promises.readFile(path.join(extensionRoot, 'Configuration.xml'), 'utf8'),
    ]);
    const baseConfigurationUuid = attribute(baseXml, 'Configuration', 'uuid');
    const formatVersion = attribute(extensionXml, 'MetaDataObject', 'version');
    const purpose = element(extensionXml, 'ConfigurationExtensionPurpose') as CfeProjectPurpose | undefined;
    const namePrefix = element(extensionXml, 'NamePrefix') ?? '';
    const compatibilityMode = element(extensionXml, 'ConfigurationExtensionCompatibilityMode') ?? '';
    if (!baseConfigurationUuid || !formatVersion || !purpose || !isPurpose(purpose)) {
      throw new CfeProjectError('CFE_VALIDATION_FAILED', 'CFE-проект содержит неполный Configuration.xml.');
    }
    return {
      baseSession, extensionSession, baseRoot, extensionRoot, extensionName: record.extensionName,
      purpose, namePrefix, formatVersion, compatibilityMode, baseConfigurationUuid,
      baseFingerprint: crypto.createHash('sha256').update(baseXml).digest('hex'),
    };
  }
}

function attribute(xml: string, elementName: string, attributeName: string): string | undefined {
  return new RegExp(`<${elementName}\\b[^>]*\\b${attributeName}\\s*=\\s*["']([^"']+)["']`, 'i').exec(xml)?.[1];
}
function element(xml: string, name: string): string | undefined {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(xml)?.[1]?.trim();
}
function isPurpose(value: string): value is CfeProjectPurpose {
  return value === 'Customization' || value === 'Patch' || value === 'AddOn';
}
function toProjectPath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  return normalized === '' ? '.' : normalized;
}
