import * as path from 'path';

export interface ConfiguratorFileTarget {
  type: 'file';
  filePath: string;
}

export interface ConfiguratorCredentials {
  user?: string;
  password?: string;
}

/** Credentials used by the platform configuration repository. */
export interface ConfigurationRepositoryCredentials {
  user: string;
  password?: string;
}

export type ConfiguratorBatchOperation =
  | 'partialApply'
  | 'minimalDump'
  | 'dumpExternal'
  | 'loadExternal'
  | 'repositoryBind'
  | 'repositoryUnbind'
  | 'repositoryLock'
  | 'repositoryUnlock'
  | 'repositoryCommit'
  | 'repositoryUpdateObject'
  | 'repositoryUpdateConfiguration';

export interface ConfiguratorBatchArguments {
  operation: ConfiguratorBatchOperation;
  executionArgs: readonly string[];
  /** Safe for logs and journals: the password value is replaced, not merely quoted. */
  diagnosticArgs: readonly string[];
  outputFilePath: string;
}

export interface ConfigurationRepositoryBatchOptions {
  operation: Extract<ConfiguratorBatchOperation, `repository${string}`>;
  target: ConfiguratorFileTarget;
  outputFilePath: string;
  repositoryPath: string;
  repositoryCredentials: ConfigurationRepositoryCredentials;
  credentials?: ConfiguratorCredentials;
  extensionName?: string;
  objectListPath?: string;
  comment?: string;
  keepLocked?: boolean;
  force?: boolean;
  platform?: NodeJS.Platform;
}

interface ConfiguratorBatchSharedOptions {
  outputFilePath: string;
  credentials?: ConfiguratorCredentials;
  platform?: NodeJS.Platform;
}

interface ConfiguratorRequiredTargetOptions extends ConfiguratorBatchSharedOptions {
  target: ConfiguratorFileTarget;
}

interface ConfiguratorExternalOptions extends ConfiguratorBatchSharedOptions {
  target?: ConfiguratorFileTarget;
}

export interface ConfiguratorPartialApplyArgsOptions extends ConfiguratorRequiredTargetOptions {
  stagingDirectory: string;
  listFilePath: string;
}

export interface ConfiguratorMinimalDumpArgsOptions extends ConfiguratorRequiredTargetOptions {
  dumpDirectory: string;
  listFilePath: string;
}

export interface ConfiguratorDumpExternalArgsOptions extends ConfiguratorExternalOptions {
  dumpDirectory: string;
  externalFilePath: string;
  format?: 'Hierarchical' | 'Plain';
}

export interface ConfiguratorLoadExternalArgsOptions extends ConfiguratorExternalOptions {
  rootXmlPath: string;
  destinationPath: string;
}

export function buildConfiguratorPartialApplyArgs(
  options: ConfiguratorPartialApplyArgsOptions
): ConfiguratorBatchArguments {
  requireTarget(options.target);
  const common = buildCommonArgs(options);
  const executionArgs = [
    ...common.executionArgs,
    '/LoadConfigFromFiles',
    requireValue(options.stagingDirectory, 'stagingDirectory'),
    '-listFile',
    requireValue(options.listFilePath, 'listFilePath'),
    '-Format',
    'Hierarchical',
    '-partial',
  ];
  const diagnosticArgs = [
    ...common.diagnosticArgs,
    '/LoadConfigFromFiles',
    requireValue(options.stagingDirectory, 'stagingDirectory'),
    '-listFile',
    requireValue(options.listFilePath, 'listFilePath'),
    '-Format',
    'Hierarchical',
    '-partial',
  ];
  assertSafeBatchArguments(executionArgs);
  return freezeBatchArguments('partialApply', executionArgs, diagnosticArgs, common.outputFilePath);
}

export function buildConfiguratorMinimalDumpArgs(
  options: ConfiguratorMinimalDumpArgsOptions
): ConfiguratorBatchArguments {
  requireTarget(options.target);
  const common = buildCommonArgs(options);
  const executionArgs = [
    ...common.executionArgs,
    '/DumpConfigToFiles',
    requireValue(options.dumpDirectory, 'dumpDirectory'),
    '-Format',
    'Hierarchical',
    '-listFile',
    requireValue(options.listFilePath, 'listFilePath'),
  ];
  const diagnosticArgs = [
    ...common.diagnosticArgs,
    '/DumpConfigToFiles',
    requireValue(options.dumpDirectory, 'dumpDirectory'),
    '-Format',
    'Hierarchical',
    '-listFile',
    requireValue(options.listFilePath, 'listFilePath'),
  ];
  assertSafeBatchArguments(executionArgs);
  return freezeBatchArguments('minimalDump', executionArgs, diagnosticArgs, common.outputFilePath);
}

export function buildConfiguratorDumpExternalArgs(
  options: ConfiguratorDumpExternalArgsOptions
): ConfiguratorBatchArguments {
  const common = buildCommonArgs(options);
  const format = options.format ?? 'Hierarchical';
  const dumpDir = requireValue(options.dumpDirectory, 'dumpDirectory');
  const externalFile = requireValue(options.externalFilePath, 'externalFilePath');

  const extraArgs = [
    '/DumpExternalDataProcessorOrReportToFiles',
    dumpDir,
    externalFile,
    '-Format',
    format,
  ];

  const executionArgs = [...common.executionArgs, ...extraArgs];
  const diagnosticArgs = [...common.diagnosticArgs, ...extraArgs];
  assertSafeBatchArguments(executionArgs);
  return freezeBatchArguments('dumpExternal', executionArgs, diagnosticArgs, common.outputFilePath);
}

export function buildConfiguratorLoadExternalArgs(
  options: ConfiguratorLoadExternalArgsOptions
): ConfiguratorBatchArguments {
  const common = buildCommonArgs(options);
  const rootXmlPath = requireValue(options.rootXmlPath, 'rootXmlPath');
  const destinationPath = requireValue(options.destinationPath, 'destinationPath');

  const extraArgs = [
    '/LoadExternalDataProcessorOrReportFromFiles',
    rootXmlPath,
    destinationPath,
  ];

  const executionArgs = [...common.executionArgs, ...extraArgs];
  const diagnosticArgs = [...common.diagnosticArgs, ...extraArgs];
  assertSafeBatchArguments(executionArgs);
  return freezeBatchArguments('loadExternal', executionArgs, diagnosticArgs, common.outputFilePath);
}

/**
 * Builds one official Designer configuration-repository operation.
 * Repository credentials are kept separate from infobase credentials because the
 * platform accepts both pairs in the same command line.
 */
export function buildConfigurationRepositoryBatchArgs(
  options: ConfigurationRepositoryBatchOptions,
): ConfiguratorBatchArguments {
  requireTarget(options.target);
  const common = buildCommonArgs(options);
  const repositoryPath = requireValue(options.repositoryPath, 'repositoryPath');
  const repositoryUser = requireValue(options.repositoryCredentials.user, 'repositoryCredentials.user');
  const operation = repositoryOperation(options);

  const repositoryArgs = [
    '/ConfigurationRepositoryF',
    repositoryPath,
    '/ConfigurationRepositoryN',
    repositoryUser,
  ];
  const repositoryDiagnosticArgs = [...repositoryArgs];
  const repositoryPassword = options.repositoryCredentials.password;
  if (repositoryPassword) {
    repositoryArgs.push('/ConfigurationRepositoryP', repositoryPassword);
    repositoryDiagnosticArgs.push('/ConfigurationRepositoryP', '<redacted>');
  }

  const executionArgs = [...common.executionArgs, ...repositoryArgs, ...operation.executionArgs];
  const diagnosticArgs = [...common.diagnosticArgs, ...repositoryDiagnosticArgs, ...operation.diagnosticArgs];
  if (options.extensionName?.trim()) {
    executionArgs.push('-Extension', options.extensionName.trim());
    diagnosticArgs.push('-Extension', options.extensionName.trim());
  }
  assertSafeBatchArguments(executionArgs);
  return freezeBatchArguments(operation.name, executionArgs, diagnosticArgs, common.outputFilePath);
}

function repositoryOperation(options: ConfigurationRepositoryBatchOptions): {
  name: Extract<ConfiguratorBatchOperation, `repository${string}`>;
  executionArgs: string[];
  diagnosticArgs: string[];
} {
  const list = options.objectListPath?.trim();
  const listArgs = list ? ['-Objects', list] : [];
  const comment = options.comment;
  switch (options.operation) {
    case 'repositoryBind':
      return { name: 'repositoryBind', executionArgs: ['/ConfigurationRepositoryBindCfg'], diagnosticArgs: ['/ConfigurationRepositoryBindCfg'] };
    case 'repositoryUnbind': {
      const args = ['/ConfigurationRepositoryUnbindCfg', ...(options.force ? ['-force'] : [])];
      return { name: 'repositoryUnbind', executionArgs: args, diagnosticArgs: [...args] };
    }
    case 'repositoryLock': {
      if (!list) {
        throw new Error('objectListPath is required for repository lock.');
      }
      const args = ['/ConfigurationRepositoryLock', ...listArgs, ...(options.force ? ['-revised'] : [])];
      return { name: 'repositoryLock', executionArgs: args, diagnosticArgs: [...args] };
    }
    case 'repositoryUnlock': {
      if (!list) {
        throw new Error('objectListPath is required for repository unlock.');
      }
      const args = ['/ConfigurationRepositoryUnLock', ...listArgs, ...(options.force ? ['-force'] : [])];
      return { name: 'repositoryUnlock', executionArgs: args, diagnosticArgs: [...args] };
    }
    case 'repositoryCommit': {
      if (!list) {
        throw new Error('objectListPath is required for repository commit.');
      }
      const args = [
        '/ConfigurationRepositoryCommit',
        ...listArgs,
        ...(comment?.trim() ? ['-comment', comment] : []),
        ...(options.keepLocked ? ['-keepLocked'] : []),
        ...(options.force ? ['-force'] : []),
      ];
      return { name: 'repositoryCommit', executionArgs: args, diagnosticArgs: [...args] };
    }
    case 'repositoryUpdateObject': {
      if (!list) {
        throw new Error('objectListPath is required for repository object update.');
      }
      const args = ['/ConfigurationRepositoryUpdateCfg', ...listArgs, ...(options.force ? ['-force'] : [])];
      return { name: 'repositoryUpdateObject', executionArgs: args, diagnosticArgs: [...args] };
    }
    case 'repositoryUpdateConfiguration': {
      const args = ['/ConfigurationRepositoryUpdateCfg', ...(options.force ? ['-force'] : [])];
      return { name: 'repositoryUpdateConfiguration', executionArgs: args, diagnosticArgs: [...args] };
    }
    default:
      throw new Error(`Unsupported configuration repository operation: ${String(options.operation)}`);
  }
}

/** Formats only the already-redacted diagnostic argv. */
export function formatConfiguratorDiagnosticCommand(
  executablePath: string,
  args: ConfiguratorBatchArguments
): string {
  return [executablePath, ...args.diagnosticArgs].map((token) => JSON.stringify(token)).join(' ');
}

function buildCommonArgs(options: ConfiguratorRequiredTargetOptions | ConfiguratorExternalOptions): {
  executionArgs: string[];
  diagnosticArgs: string[];
  outputFilePath: string;
} {
  const platform = options.platform ?? process.platform;
  const outputFilePath = requireValue(options.outputFilePath, 'outputFilePath');
  const executionArgs = [
    'DESIGNER',
    '/DisableStartupDialogs',
    '/DisableStartupMessages',
    '/Out',
    outputFilePath,
  ];
  if (options.target) {
    if (options.target.type !== 'file') {
      throw new Error('Configurator batch operations support file infobases only.');
    }
    const filePath = resolveForPlatform(
      requireValue(options.target.filePath, 'target.filePath'),
      platform
    );
    executionArgs.splice(1, 0, '/F', filePath);
  } else if (options.credentials !== undefined) {
    throw new Error('Configurator credentials require an infobase execution context.');
  }
  const diagnosticArgs = [...executionArgs];
  const user = options.credentials?.user?.trim();
  if (user) {
    executionArgs.push('/N', user);
    diagnosticArgs.push('/N', user);
    const password = options.credentials?.password;
    if (password) {
      executionArgs.push('/P', password);
      diagnosticArgs.push('/P', '<redacted>');
    }
  }
  return { executionArgs, diagnosticArgs, outputFilePath };
}

function freezeBatchArguments(
  operation: ConfiguratorBatchArguments['operation'],
  executionArgs: string[],
  diagnosticArgs: string[],
  outputFilePath: string
): ConfiguratorBatchArguments {
  return Object.freeze({
    operation,
    executionArgs: Object.freeze([...executionArgs]),
    diagnosticArgs: Object.freeze([...diagnosticArgs]),
    outputFilePath,
  });
}

function assertSafeBatchArguments(args: readonly string[]): void {
  if (args.some((argument) => argument.toLocaleLowerCase() === '-nocheck')) {
    throw new Error('-NoCheck is prohibited for support configuration operations.');
  }
}

function requireValue(value: string, name: string): string {
  const result = value.trim();
  if (!result) {
    throw new Error(`${name} is required.`);
  }
  return result;
}

function requireTarget(target: ConfiguratorFileTarget | undefined): void {
  if (!target) {
    throw new Error('target is required.');
  }
}

function resolveForPlatform(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? path.win32.resolve(value).replace(/\//g, '\\')
    : path.posix.resolve(value);
}
