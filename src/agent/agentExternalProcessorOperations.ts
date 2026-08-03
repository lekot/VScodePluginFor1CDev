import * as path from 'path';
import {
  buildExternalProcessor,
  dumpExternalProcessor,
} from '../services/externalProcessor/externalProcessorService';
import type { ExternalProcessorExecutionContext } from '../services/externalProcessor/externalProcessorTypes';
import type {
  AgentBuildExternalProcessorParams,
  AgentDumpExternalProcessorParams,
  AgentResult,
  ExternalProcessorAgentData,
} from './types';

export function agentDumpExternalProcessor(
  input: AgentDumpExternalProcessorParams
): Promise<AgentResult<ExternalProcessorAgentData>>;
export function agentDumpExternalProcessor(
  input: unknown
): Promise<AgentResult<ExternalProcessorAgentData>>;
export async function agentDumpExternalProcessor(
  input: unknown
): Promise<AgentResult<ExternalProcessorAgentData>> {
  const request = parseDumpRequest(input);
  if ('state' in request) {
    return toAgentResult(request);
  }
  const srcPath = path.resolve(request.srcPath);
  const outDir = request.outDir
    ? path.resolve(request.outDir)
    : path.join(
        path.dirname(srcPath),
        `${path.basename(srcPath, path.extname(srcPath))}_src`
      );
  const result = await dumpExternalProcessor({
    externalFilePath: srcPath,
    outputDirectory: outDir,
    format: request.format,
    context: request.context,
    timeoutMs: request.timeoutMs,
  });
  return toAgentResult(result);
}

export function agentBuildExternalProcessor(
  input: AgentBuildExternalProcessorParams
): Promise<AgentResult<ExternalProcessorAgentData>>;
export function agentBuildExternalProcessor(
  input: unknown
): Promise<AgentResult<ExternalProcessorAgentData>>;
export async function agentBuildExternalProcessor(
  input: unknown
): Promise<AgentResult<ExternalProcessorAgentData>> {
  const request = parseBuildRequest(input);
  if ('state' in request) {
    return toAgentResult(request);
  }
  const result = await buildExternalProcessor({
    rootXmlPath: path.resolve(request.rootXmlPath),
    destinationPath: request.dstPath ? path.resolve(request.dstPath) : undefined,
    context: request.context,
    timeoutMs: request.timeoutMs,
  });
  return toAgentResult(result);
}

function parseDumpRequest(
  input: unknown
): AgentDumpExternalProcessorParams | ExternalProcessorAgentData {
  const record = asRecord(input);
  const context = parseContext(record?.context);
  if (!context) {
    return invalidRequest(
      'EXTERNAL_CONTEXT_INVALID',
      'Execution context must be an explicit infobase or acknowledged standalone context.'
    );
  }
  if (
    !record
    || !hasOnlyKeys(record, ['srcPath', 'outDir', 'format', 'context', 'timeoutMs'])
    || !isNonEmptyString(record.srcPath)
    || (record.outDir !== undefined && !isNonEmptyString(record.outDir))
    || (record.format !== 'Plain' && record.format !== 'Hierarchical')
    || !isOptionalPositiveInteger(record.timeoutMs)
  ) {
    return invalidRequest('EXTERNAL_INPUT_MISSING', 'External processor dump input is invalid.');
  }
  return {
    srcPath: record.srcPath,
    outDir: record.outDir as string | undefined,
    format: record.format,
    context,
    timeoutMs: record.timeoutMs as number | undefined,
  };
}

function parseBuildRequest(
  input: unknown
): AgentBuildExternalProcessorParams | ExternalProcessorAgentData {
  const record = asRecord(input);
  const context = parseContext(record?.context);
  if (!context) {
    return invalidRequest(
      'EXTERNAL_CONTEXT_INVALID',
      'Execution context must be an explicit infobase or acknowledged standalone context.'
    );
  }
  if (
    !record
    || !hasOnlyKeys(record, ['rootXmlPath', 'dstPath', 'context', 'timeoutMs'])
    || !isNonEmptyString(record.rootXmlPath)
    || (record.dstPath !== undefined && !isNonEmptyString(record.dstPath))
    || !isOptionalPositiveInteger(record.timeoutMs)
  ) {
    return invalidRequest('EXTERNAL_INPUT_MISSING', 'External processor build input is invalid.');
  }
  return {
    rootXmlPath: record.rootXmlPath,
    dstPath: record.dstPath as string | undefined,
    context,
    timeoutMs: record.timeoutMs as number | undefined,
  };
}

function parseContext(context: unknown): ExternalProcessorExecutionContext | undefined {
  const record = asRecord(context);
  if (!record) {
    return undefined;
  }
  if (record.kind === 'standalone') {
    return hasOnlyKeys(record, ['kind', 'acknowledgeTypeLoss'])
      && record.acknowledgeTypeLoss === true
      ? { kind: 'standalone', acknowledgeTypeLoss: true }
      : undefined;
  }
  if (
    record.kind !== 'infobase'
    || !hasOnlyKeys(record, ['kind', 'infobasePath', 'credentials'])
    || !isNonEmptyString(record.infobasePath)
  ) {
    return undefined;
  }
  const credentials = parseCredentials(record.credentials);
  if (record.credentials !== undefined && !credentials) {
    return undefined;
  }
  return {
    kind: 'infobase',
    infobasePath: path.resolve(record.infobasePath),
    ...(credentials ? { credentials } : {}),
  };
}

function parseCredentials(
  credentials: unknown
): { user?: string; password?: string } | undefined {
  if (credentials === undefined) {
    return undefined;
  }
  const record = asRecord(credentials);
  if (
    !record
    || !hasOnlyKeys(record, ['user', 'password'])
    || (record.user !== undefined && typeof record.user !== 'string')
    || (record.password !== undefined && typeof record.password !== 'string')
    || (typeof record.password === 'string'
      && record.password.length > 0
      && (typeof record.user !== 'string' || record.user.trim().length === 0))
  ) {
    return undefined;
  }
  return {
    user: record.user as string | undefined,
    password: record.password as string | undefined,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOptionalPositiveInteger(value: unknown): boolean {
  return value === undefined
    || (typeof value === 'number' && Number.isInteger(value) && value > 0);
}

function invalidRequest(
  code: 'EXTERNAL_CONTEXT_INVALID' | 'EXTERNAL_INPUT_MISSING',
  message: string
): ExternalProcessorAgentData {
  return {
    state: 'failed',
    code,
    message,
    retryable: false,
    effectPossible: false,
    combinedLog: '',
  };
}

function toAgentResult(
  result: ExternalProcessorAgentData
): AgentResult<ExternalProcessorAgentData> {
  if (result.state === 'completed') {
    return {
      success: true,
      data: result,
    };
  }
  return {
    success: false,
    code: result.code,
    error: result.message,
    data: result,
  };
}
