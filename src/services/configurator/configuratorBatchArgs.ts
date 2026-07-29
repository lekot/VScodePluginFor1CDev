import * as path from 'path';

export interface ConfiguratorFileTarget {
  type: 'file';
  filePath: string;
}

export interface ConfiguratorCredentials {
  user?: string;
  password?: string;
}

export interface ConfiguratorBatchArguments {
  operation: 'partialApply' | 'minimalDump' | 'dumpExternal' | 'loadExternal';
  executionArgs: readonly string[];
  /** Safe for logs and journals: the password value is replaced, not merely quoted. */
  diagnosticArgs: readonly string[];
  outputFilePath: string;
}

interface ConfiguratorBatchBaseOptions {
  target: ConfiguratorFileTarget;
  outputFilePath: string;
  credentials?: ConfiguratorCredentials;
  platform?: NodeJS.Platform;
}

export interface ConfiguratorPartialApplyArgsOptions extends ConfiguratorBatchBaseOptions {
  stagingDirectory: string;
  listFilePath: string;
}

export interface ConfiguratorMinimalDumpArgsOptions extends ConfiguratorBatchBaseOptions {
  dumpDirectory: string;
  listFilePath: string;
}

export interface ConfiguratorDumpExternalArgsOptions extends ConfiguratorBatchBaseOptions {
  dumpDirectory: string;
  externalFilePath: string;
  format?: 'Hierarchical' | 'Plain';
}

export interface ConfiguratorLoadExternalArgsOptions extends ConfiguratorBatchBaseOptions {
  externalFilePath: string;
  sourceDirectory: string;
  format?: 'Hierarchical' | 'Plain';
}

export function buildConfiguratorPartialApplyArgs(
  options: ConfiguratorPartialApplyArgsOptions
): ConfiguratorBatchArguments {
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
  ];
  if (format === 'Hierarchical') {
    extraArgs.push('-Format', 'Hierarchical');
  }

  const executionArgs = [...common.executionArgs, ...extraArgs];
  const diagnosticArgs = [...common.diagnosticArgs, ...extraArgs];
  assertSafeBatchArguments(executionArgs);
  return freezeBatchArguments('dumpExternal', executionArgs, diagnosticArgs, common.outputFilePath);
}

export function buildConfiguratorLoadExternalArgs(
  options: ConfiguratorLoadExternalArgsOptions
): ConfiguratorBatchArguments {
  const common = buildCommonArgs(options);
  const format = options.format ?? 'Hierarchical';
  const externalFile = requireValue(options.externalFilePath, 'externalFilePath');
  const sourceDir = requireValue(options.sourceDirectory, 'sourceDirectory');

  const extraArgs = [
    '/LoadExternalDataProcessorOrReportFromFiles',
    externalFile,
    sourceDir,
  ];
  if (format === 'Hierarchical') {
    extraArgs.push('-Format', 'Hierarchical');
  }

  const executionArgs = [...common.executionArgs, ...extraArgs];
  const diagnosticArgs = [...common.diagnosticArgs, ...extraArgs];
  assertSafeBatchArguments(executionArgs);
  return freezeBatchArguments('loadExternal', executionArgs, diagnosticArgs, common.outputFilePath);
}

/** Formats only the already-redacted diagnostic argv. */
export function formatConfiguratorDiagnosticCommand(
  executablePath: string,
  args: ConfiguratorBatchArguments
): string {
  return [executablePath, ...args.diagnosticArgs].map((token) => JSON.stringify(token)).join(' ');
}

function buildCommonArgs(options: ConfiguratorBatchBaseOptions): {
  executionArgs: string[];
  diagnosticArgs: string[];
  outputFilePath: string;
} {
  if (options.target.type !== 'file') {
    throw new Error('Configurator batch operations support file infobases only.');
  }
  const platform = options.platform ?? process.platform;
  const filePath = resolveForPlatform(
    requireValue(options.target.filePath, 'target.filePath'),
    platform
  );
  const outputFilePath = requireValue(options.outputFilePath, 'outputFilePath');
  const executionArgs = [
    'DESIGNER',
    '/F',
    filePath,
    '/DisableStartupDialogs',
    '/DisableStartupMessages',
    '/Out',
    outputFilePath,
  ];
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

function resolveForPlatform(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? path.win32.resolve(value).replace(/\//g, '\\')
    : path.posix.resolve(value);
}
