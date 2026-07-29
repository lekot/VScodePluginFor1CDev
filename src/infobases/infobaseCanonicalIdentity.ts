import * as fs from 'fs';
import * as path from 'path';
import type { InfobaseEntry } from './models/infobaseEntry';
import {
  resolvePathForIbcmdYamlFileField,
  tryParseInfobaseFileScalarFromYaml,
} from './ibcmdConfigPathResolver';

interface CanonicalIdentityBase {
  /** Stable queue/cache key for one physical connection target. */
  readonly canonicalTargetId: string;
  readonly key: string;
}

export interface FileInfobaseCanonicalIdentity extends CanonicalIdentityBase {
  readonly kind: 'file';
  /** Opaque YAML cannot be certified as a v1 file-database support target. */
  readonly connectionKind: 'databasePath' | 'opaqueYaml';
  readonly resolvedPath: string;
  /** Physical 1Cv8.1CD when it can be proven; canonical identity is based on this file. */
  readonly databaseFilePath?: string;
  readonly exists: boolean;
}

export interface ServerInfobaseCanonicalIdentity extends CanonicalIdentityBase {
  readonly kind: 'server';
  readonly server: string;
  readonly database: string;
}

export interface WebInfobaseCanonicalIdentity extends CanonicalIdentityBase {
  readonly kind: 'web';
  readonly url: string;
}

export type InfobaseCanonicalIdentity =
  | FileInfobaseCanonicalIdentity
  | ServerInfobaseCanonicalIdentity
  | WebInfobaseCanonicalIdentity;

function normalizeResolvedPath(value: string): string {
  const normalized = path.normalize(value).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function realpathOrLogical(value: string): Promise<{ resolvedPath: string; exists: boolean }> {
  const logical = resolvePathForIbcmdYamlFileField(value);
  try {
    return { resolvedPath: await fs.promises.realpath(logical), exists: true };
  } catch {
    return { resolvedPath: logical, exists: false };
  }
}

async function fileIdentity(
  connectionKind: FileInfobaseCanonicalIdentity['connectionKind'],
  sourcePath: string,
): Promise<FileInfobaseCanonicalIdentity> {
  const resolved = await realpathOrLogical(sourcePath);
  if (connectionKind === 'opaqueYaml') {
    return {
      kind: 'file',
      connectionKind,
      canonicalTargetId: 'file:opaque-or-unresolved',
      key: 'file:opaque-or-unresolved',
      resolvedPath: resolved.resolvedPath,
      exists: resolved.exists,
    };
  }

  let resolvedPath = resolved.resolvedPath;
  let databaseFilePath: string | undefined;
  if (resolved.exists) {
    try {
      const stat = await fs.promises.stat(resolved.resolvedPath);
      if (stat.isFile()) {
        databaseFilePath = await fs.promises.realpath(resolved.resolvedPath);
        resolvedPath = path.dirname(databaseFilePath);
      } else if (stat.isDirectory()) {
        const names = await fs.promises.readdir(resolved.resolvedPath);
        const databaseFileName = names.find((name) => /^1cv8\.1cd$/i.test(name));
        if (databaseFileName) {
          const candidate = path.join(resolved.resolvedPath, databaseFileName);
          if ((await fs.promises.stat(candidate)).isFile()) {
            databaseFilePath = await fs.promises.realpath(candidate);
          }
        }
      }
    } catch {
      // Keep the already resolved catalog path; normal connection validation reports details.
    }
  }
  const physicalIdentityPath = databaseFilePath ?? resolvedPath;
  const canonicalTargetId = `file:databasePath:${normalizeResolvedPath(physicalIdentityPath)}`;
  return {
    kind: 'file',
    connectionKind,
    canonicalTargetId,
    key: canonicalTargetId,
    resolvedPath,
    databaseFilePath,
    exists: resolved.exists,
  };
}

async function resolveExplicitYamlIdentity(
  entry: InfobaseEntry,
): Promise<FileInfobaseCanonicalIdentity | undefined> {
  const yamlPath = entry.ibcmdConfigYamlPath?.trim();
  if (!yamlPath) {
    return undefined;
  }
  const yaml = await realpathOrLogical(yamlPath);
  if (yaml.exists) {
    try {
      const body = await fs.promises.readFile(yaml.resolvedPath, 'utf8');
      const fileScalar = tryParseInfobaseFileScalarFromYaml(body);
      if (fileScalar !== undefined) {
        return fileIdentity('databasePath', fileScalar);
      }
    } catch {
      // An unreadable explicit YAML is still an opaque connection target.
    }
  }
  return fileIdentity('opaqueYaml', yaml.resolvedPath);
}

async function resolveFileIdentity(entry: InfobaseEntry): Promise<FileInfobaseCanonicalIdentity> {
  const filePath = entry.filePath?.trim();
  if (filePath) {
    return fileIdentity('databasePath', filePath);
  }
  // Invalid catalog entries still receive a deterministic per-entry key so legacy callers fail
  // at their existing connection validation point instead of being globally serialized.
  return fileIdentity('opaqueYaml', `unresolved-${entry.id}`);
}

function resolveServerIdentity(entry: InfobaseEntry): ServerInfobaseCanonicalIdentity {
  const server = entry.server?.trim().toLowerCase() ?? '';
  const database = entry.database?.trim().toLowerCase() ?? '';
  const canonicalTargetId = `server:${server}|${database}`;
  return { kind: 'server', canonicalTargetId, key: canonicalTargetId, server, database };
}

function resolveWebIdentity(entry: InfobaseEntry): WebInfobaseCanonicalIdentity {
  const raw = entry.webUrl?.trim() ?? '';
  let url = raw.toLowerCase();
  try {
    const parsed = new URL(raw);
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    url = `${parsed.protocol}//${parsed.host.toLowerCase()}${pathname}${parsed.search}`;
  } catch {
    // Keep a deterministic raw identity; validation remains the caller's responsibility.
  }
  const canonicalTargetId = `web:${url}`;
  return { kind: 'web', canonicalTargetId, key: canonicalTargetId, url };
}

/** Resolves aliases (including junctions/symlinks) to one canonical connection identity. */
export async function resolveInfobaseCanonicalIdentity(
  entry: InfobaseEntry,
): Promise<InfobaseCanonicalIdentity> {
  if (entry.type === 'web') {
    return resolveWebIdentity(entry);
  }
  const explicitYamlIdentity = await resolveExplicitYamlIdentity(entry);
  if (explicitYamlIdentity) {
    return explicitYamlIdentity;
  }
  if (entry.type === 'server') {
    return resolveServerIdentity(entry);
  }
  return resolveFileIdentity(entry);
}
