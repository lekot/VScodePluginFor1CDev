import * as fs from 'fs';
import * as path from 'path';
import { parseXmlDocument } from '../../compareMerge/xml/xmlDom';
import {
  InfobaseConfigurationQueueQuarantinedError,
  sharedInfobaseConfigurationOperationQueue,
} from '../../infobases/infobaseConfigurationOperationQueue';
import {
  resolveInfobaseCanonicalIdentity,
  type InfobaseCanonicalIdentity,
} from '../../infobases/infobaseCanonicalIdentity';
import type { InfobaseEntry } from '../../infobases/models/infobaseEntry';
import {
  buildConfiguratorDumpExternalArgs,
  buildConfiguratorLoadExternalArgs,
  type ConfiguratorBatchArguments,
} from '../configurator/configuratorBatchArgs';
import {
  resolveConfiguratorExecutable,
  type ConfiguratorExecutableResolution,
} from '../configurator/configuratorExecutableResolver';
import {
  runConfiguratorProcess,
  type ConfiguratorProcessOutcome,
  type ConfiguratorProcessRunnerOptions,
} from '../configurator/configuratorProcessRunner';
import type { StreamCancellation } from '../process/streamingProcessRunner';
import { resolveExternalProcessorResourceIdentity } from './externalProcessorResourceIdentity';
import type {
  BuildExternalProcessorOptions,
  DumpExternalProcessorOptions,
  ExternalProcessorExecutionContext,
  ExternalProcessorFailedErrorCode,
  ExternalProcessorOperationResult,
  ExternalProcessorRootInspection,
} from './externalProcessorTypes';

const DEFAULT_TIMEOUT_MS = 120_000;
const NO_CANCELLATION: StreamCancellation = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};

interface ExternalProcessorFileSystem {
  stat(filePath: string): Promise<fs.Stats>;
  readFile(filePath: string, encoding: BufferEncoding): Promise<string>;
  readdir(directoryPath: string, options: { withFileTypes: true }): Promise<fs.Dirent[]>;
  mkdir(directoryPath: string): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  rename(sourcePath: string, destinationPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  writeFile(filePath: string, data: string, encoding: BufferEncoding): Promise<void>;
  rm(targetPath: string, options: { recursive: true; force: true }): Promise<void>;
}

interface ExternalProcessorQueue {
  runComposite<T>(
    identities: readonly (InfobaseCanonicalIdentity | string)[],
    operation: () => Promise<T>
  ): Promise<T>;
  quarantine?(
    identities: readonly (InfobaseCanonicalIdentity | string)[],
    reason: string
  ): unknown;
}

export interface ExternalProcessorServiceDependencies {
  readonly fileSystem?: ExternalProcessorFileSystem;
  readonly queue?: ExternalProcessorQueue;
  readonly resolveInfobaseIdentity?: typeof resolveInfobaseCanonicalIdentity;
  readonly resolveExecutable?: (
    entry: InfobaseEntry
  ) => ConfiguratorExecutableResolution;
  readonly runProcess?: (
    options: ConfiguratorProcessRunnerOptions
  ) => Promise<ConfiguratorProcessOutcome>;
  readonly resolveResourceIdentity?: typeof resolveExternalProcessorResourceIdentity;
  readonly createStagingName?: (destinationPath: string) => string;
  readonly platform?: NodeJS.Platform;
}

interface PreparedOperation {
  readonly inputPath: string;
  readonly destinationPath: string;
  readonly context: ExternalProcessorExecutionContext;
  readonly timeoutMs: number;
  readonly cancellation: StreamCancellation;
  readonly infobaseEntry?: InfobaseEntry;
  readonly infobaseIdentity?: InfobaseCanonicalIdentity;
}

interface OperationDescription {
  readonly mode: 'dump' | 'build';
  readonly prepared: PreparedOperation;
  readonly format?: 'Plain' | 'Hierarchical';
  readonly rootInspection?: ExternalProcessorRootInspection;
}

export async function inspectExternalProcessorRoot(
  rootXmlPath: string
): Promise<ExternalProcessorRootInspection> {
  return inspectExternalProcessorRootWithFs(rootXmlPath, defaultFileSystem());
}

export async function dumpExternalProcessor(
  options: DumpExternalProcessorOptions,
  dependencies: ExternalProcessorServiceDependencies = {}
): Promise<ExternalProcessorOperationResult> {
  const service = new ExternalProcessorService(dependencies);
  return service.dump(options);
}

export async function buildExternalProcessor(
  options: BuildExternalProcessorOptions,
  dependencies: ExternalProcessorServiceDependencies = {}
): Promise<ExternalProcessorOperationResult> {
  const service = new ExternalProcessorService(dependencies);
  return service.build(options);
}

export class ExternalProcessorService {
  private readonly fileSystem: ExternalProcessorFileSystem;
  private readonly queue: ExternalProcessorQueue;
  private readonly resolveInfobaseIdentity: typeof resolveInfobaseCanonicalIdentity;
  private readonly resolveExecutable: (
    entry: InfobaseEntry
  ) => ConfiguratorExecutableResolution;
  private readonly runProcess: (
    options: ConfiguratorProcessRunnerOptions
  ) => Promise<ConfiguratorProcessOutcome>;
  private readonly resolveResourceIdentity: typeof resolveExternalProcessorResourceIdentity;
  private readonly createStagingName: (destinationPath: string) => string;
  private readonly platform: NodeJS.Platform;

  constructor(dependencies: ExternalProcessorServiceDependencies = {}) {
    this.fileSystem = dependencies.fileSystem ?? defaultFileSystem();
    this.queue = dependencies.queue ?? sharedInfobaseConfigurationOperationQueue;
    this.resolveInfobaseIdentity =
      dependencies.resolveInfobaseIdentity ?? resolveInfobaseCanonicalIdentity;
    this.resolveExecutable = dependencies.resolveExecutable ?? resolveConfiguratorExecutable;
    this.runProcess = dependencies.runProcess ?? runConfiguratorProcess;
    this.resolveResourceIdentity =
      dependencies.resolveResourceIdentity ?? resolveExternalProcessorResourceIdentity;
    this.createStagingName = dependencies.createStagingName ?? defaultStagingName;
    this.platform = dependencies.platform ?? process.platform;
  }

  async dump(options: DumpExternalProcessorOptions): Promise<ExternalProcessorOperationResult> {
    try {
      return await this.dumpInternal(options);
    } catch (error) {
      return dependencyFailure('dump', error);
    }
  }

  private async dumpInternal(
    options: DumpExternalProcessorOptions
  ): Promise<ExternalProcessorOperationResult> {
    const inputPath = path.resolve(options.externalFilePath);
    const extension = path.extname(inputPath).toLocaleLowerCase();
    if (extension !== '.epf' && extension !== '.erf') {
      return failed(
        'EXTERNAL_EXTENSION_UNSUPPORTED',
        'External processor input must have an .epf or .erf extension.'
      );
    }
    const inputValidation = await this.validateInputFile(inputPath);
    if (inputValidation) {
      return inputValidation;
    }
    if (options.format !== 'Plain' && options.format !== 'Hierarchical') {
      return failed('EXTERNAL_CONTEXT_INVALID', 'Dump format must be Plain or Hierarchical.');
    }
    const prepared = await this.prepareCommon(
      inputPath,
      path.resolve(options.outputDirectory),
      options.context,
      options.timeoutMs,
      options.cancellation
    );
    if ('state' in prepared) {
      return prepared;
    }
    return this.run({
      mode: 'dump',
      prepared,
      format: options.format,
    });
  }

  async build(options: BuildExternalProcessorOptions): Promise<ExternalProcessorOperationResult> {
    try {
      return await this.buildInternal(options);
    } catch (error) {
      return dependencyFailure('build', error);
    }
  }

  private async buildInternal(
    options: BuildExternalProcessorOptions
  ): Promise<ExternalProcessorOperationResult> {
    const inputPath = path.resolve(options.rootXmlPath);
    const inputValidation = await this.validateInputFile(inputPath);
    if (inputValidation) {
      return inputValidation;
    }
    if (path.extname(inputPath).toLocaleLowerCase() !== '.xml') {
      return failed(
        'EXTERNAL_EXTENSION_UNSUPPORTED',
        'External processor source root must have an .xml extension.'
      );
    }

    let rootInspection: ExternalProcessorRootInspection;
    try {
      rootInspection = await inspectExternalProcessorRootWithFs(inputPath, this.fileSystem);
    } catch (error) {
      return failed('EXTERNAL_ROOT_UNSUPPORTED', errorMessage(error));
    }
    const destinationPath = path.resolve(
      options.destinationPath ?? rootInspection.defaultDestinationPath
    );
    if (path.extname(destinationPath).toLocaleLowerCase() !== rootInspection.extension) {
      return failed(
        'EXTERNAL_EXTENSION_UNSUPPORTED',
        `Destination extension must be ${rootInspection.extension}.`
      );
    }
    const prepared = await this.prepareCommon(
      inputPath,
      destinationPath,
      options.context,
      options.timeoutMs,
      options.cancellation
    );
    if ('state' in prepared) {
      return prepared;
    }
    return this.run({
      mode: 'build',
      prepared,
      rootInspection,
    });
  }

  private async prepareCommon(
    inputPath: string,
    destinationPath: string,
    context: ExternalProcessorExecutionContext,
    timeoutMs: number | undefined,
    cancellation: StreamCancellation | undefined
  ): Promise<PreparedOperation | ExternalProcessorOperationResult> {
    const contextValidation = validateContext(context);
    if (contextValidation) {
      return contextValidation;
    }
    const outputExists = await this.pathExists(destinationPath);
    if (outputExists === 'unknown') {
      return failed('EXTERNAL_IO_FAILED', `Cannot inspect output path: ${destinationPath}`);
    }
    if (outputExists) {
      return failed('EXTERNAL_OUTPUT_EXISTS', `Output already exists: ${destinationPath}`);
    }

    let infobaseEntry: InfobaseEntry | undefined;
    let infobaseIdentity: InfobaseCanonicalIdentity | undefined;
    if (context.kind === 'infobase') {
      infobaseEntry = createInfobaseEntry(path.resolve(context.infobasePath));
      try {
        infobaseIdentity = await this.resolveInfobaseIdentity(infobaseEntry);
      } catch (error) {
        return failed('EXTERNAL_CONTEXT_INVALID', errorMessage(error));
      }
      if (
        infobaseIdentity.kind !== 'file'
        || !infobaseIdentity.exists
        || !infobaseIdentity.databaseFilePath
      ) {
        return failed(
          'EXTERNAL_CONTEXT_INVALID',
          'Infobase context must point to an existing file infobase containing 1Cv8.1CD.'
        );
      }
      infobaseEntry = createInfobaseEntry(infobaseIdentity.resolvedPath);
    }
    return {
      inputPath,
      destinationPath,
      context,
      timeoutMs: validTimeout(timeoutMs),
      cancellation: cancellation ?? NO_CANCELLATION,
      ...(infobaseEntry ? { infobaseEntry } : {}),
      ...(infobaseIdentity ? { infobaseIdentity } : {}),
    };
  }

  private async run(description: OperationDescription): Promise<ExternalProcessorOperationResult> {
    const { prepared } = description;
    let identities: string[];
    try {
      identities = [
        await this.resolveResourceIdentity(prepared.inputPath, true),
        await this.resolveResourceIdentity(prepared.destinationPath, false),
      ];
    } catch (error) {
      return failed('EXTERNAL_IO_FAILED', errorMessage(error));
    }
    if (prepared.infobaseIdentity) {
      identities.push(prepared.infobaseIdentity.canonicalTargetId);
    }

    try {
      return await this.queue.runComposite(identities, async () =>
        this.runWithinLease(description, identities)
      );
    } catch (error) {
      if (error instanceof InfobaseConfigurationQueueQuarantinedError) {
        return failed(
          'EXTERNAL_RECOVERY_REQUIRED',
          error.message,
          false,
          false
        );
      }
      return failed(
        'EXTERNAL_IO_FAILED',
        `Configuration operation queue failed: ${safeErrorMessage(error, prepared.context)}`
      );
    }
  }

  private async runWithinLease(
    description: OperationDescription,
    identities: readonly string[]
  ): Promise<ExternalProcessorOperationResult> {
    const { prepared } = description;
    const inputValidation = await this.validateInputFile(prepared.inputPath);
    if (inputValidation) {
      return inputValidation;
    }
    const outputExists = await this.pathExists(prepared.destinationPath);
    if (outputExists === 'unknown') {
      return failed(
        'EXTERNAL_IO_FAILED',
        `Cannot inspect output path: ${prepared.destinationPath}`
      );
    }
    if (outputExists) {
      return failed(
        'EXTERNAL_OUTPUT_EXISTS',
        `Output already exists: ${prepared.destinationPath}`
      );
    }

    const resolverEntry =
      prepared.infobaseEntry
      ?? createInfobaseEntry(path.dirname(prepared.inputPath));
    let executable: ConfiguratorExecutableResolution;
    try {
      executable = this.resolveExecutable(resolverEntry);
    } catch (error) {
      return failed(
        'CONFIGURATOR_UNAVAILABLE',
        `Configurator resolver failed: ${safeErrorMessage(error, prepared.context)}`,
        true
      );
    }
    if (executable.status !== 'resolved') {
      return failed('CONFIGURATOR_UNAVAILABLE', executable.message, true);
    }

    const stagingRoot = path.join(
      path.dirname(prepared.destinationPath),
      this.createStagingName(prepared.destinationPath)
    );
    try {
      await this.fileSystem.mkdir(stagingRoot);
    } catch (error) {
      return failed(
        'EXTERNAL_IO_FAILED',
        `Cannot create sibling staging directory: ${safeErrorMessage(error, prepared.context)}`
      );
    }
    // Configurator treats the dump argument as a file-name prefix, not as a
    // directory.  It writes <prefix>.xml alongside auxiliary files (Plain),
    // or <prefix>.xml plus <prefix>/ (Hierarchical).  The staging root is
    // therefore the single publishable artifact for a dump.
    const stagingArtifact =
      description.mode === 'dump'
        ? stagingRoot
        : path.join(stagingRoot, `artifact${description.rootInspection?.extension ?? ''}`);
    const configuratorArtifact =
      description.mode === 'dump'
        ? path.join(
            stagingRoot,
            path.basename(prepared.inputPath, path.extname(prepared.inputPath))
          )
        : stagingArtifact;
    const logPath = path.join(stagingRoot, 'configurator.log');
    let batchArguments: ConfiguratorBatchArguments;
    try {
      batchArguments = this.buildArguments(description, configuratorArtifact, logPath);
    } catch (error) {
      const cleanupError = await this.cleanup(stagingRoot);
      return failed(
        'EXTERNAL_IO_FAILED',
        `Configurator arguments could not be built: ${safeErrorMessage(error, prepared.context)}${
          cleanupError ? `; staging cleanup failed: ${cleanupError}` : ''
        }`
      );
    }

    let outcome: ConfiguratorProcessOutcome;
    try {
      outcome = await this.runProcess({
        executablePath: executable.path,
        batchArguments,
        timeoutMs: prepared.timeoutMs,
        cancellation: prepared.cancellation,
      });
    } catch (error) {
      this.quarantine(identities, 'Configurator runner outcome was lost.');
      const scrubError = await this.scrubLog(logPath);
      return {
        state: 'inDoubt',
        code: 'CONFIGURATOR_IN_DOUBT',
        message: `Configurator runner outcome was lost: ${safeErrorMessage(
          error,
          prepared.context
        )}${scrubError ? `; log scrub failed: ${scrubError}` : ''}`,
        retryable: false,
        effectPossible: true,
        stagingPath: stagingRoot,
        combinedLog: '',
      };
    }

    if (hasUnsafeTermination(outcome)) {
      this.quarantine(
        identities,
        `Configurator process tree survived termination: ${
          outcome.termination?.survivingPids.join(', ') || 'unknown PID'
        }.`
      );
    }
    const scrubError = await this.scrubLog(logPath);
    if (scrubError) {
      return {
        state: 'inDoubt',
        code: 'EXTERNAL_POSTCONDITION_IN_DOUBT',
        message: `Configurator log could not be removed or scrubbed: ${scrubError}`,
        retryable: false,
        effectPossible: true,
        stagingPath: stagingRoot,
        combinedLog: outcome.combinedLog,
        ...(outcome.status === 'inDoubt'
          ? { processErrorCode: outcome.errorCode }
          : {}),
      };
    }

    if (outcome.status === 'inDoubt') {
      return {
        state: 'inDoubt',
        code: 'CONFIGURATOR_IN_DOUBT',
        message: 'Configurator started, but its outcome cannot be confirmed.',
        retryable: false,
        effectPossible: true,
        stagingPath: stagingRoot,
        combinedLog: outcome.combinedLog,
        processErrorCode: outcome.errorCode,
      };
    }
    if (outcome.status === 'failed') {
      const cleanupError = await this.cleanup(stagingRoot);
      return failed(
        cleanupError ? 'EXTERNAL_IO_FAILED' : 'CONFIGURATOR_FAILED',
        cleanupError
          ? `Configurator failed and staging cleanup failed: ${cleanupError}`
          : outcome.errorMessage
            ?? `Configurator failed before acknowledgement (${outcome.errorCode}).`,
        cleanupError ? false : outcome.retryable,
        outcome.effectPossible,
        outcome.combinedLog
      );
    }

    const postcondition = await this.verifyStaging(description, stagingArtifact);
    if (postcondition.state !== 'completed') {
      if (postcondition.state === 'inDoubt') {
        return inDoubtAtStaging(postcondition.message, stagingRoot, outcome.combinedLog);
      }
      const cleanupError = await this.cleanup(stagingRoot);
      return cleanupError
        ? inDoubtAtStaging(
            `${postcondition.message}; staging cleanup failed: ${cleanupError}`,
            stagingRoot,
            outcome.combinedLog
          )
        : failed(
            'EXTERNAL_POSTCONDITION_FAILED',
            postcondition.message,
            false,
            true,
            outcome.combinedLog
          );
    }

    const publication = await this.publishNoReplace(
      description,
      stagingRoot,
      stagingArtifact,
      prepared.destinationPath
    );
    if (publication.state === 'conflict') {
      const cleanupError = await this.cleanup(stagingRoot);
      return cleanupError
        ? inDoubtAtStaging(
            `${publication.message}; staging cleanup failed: ${cleanupError}`,
            stagingRoot,
            outcome.combinedLog
          )
        : failed(
            'EXTERNAL_PUBLISH_CONFLICT',
            publication.message,
            false,
            true,
            outcome.combinedLog
          );
    }
    if (publication.state === 'failed') {
      const cleanupError = await this.cleanup(stagingRoot);
      return cleanupError
        ? inDoubtAtStaging(
            `${publication.message}; staging cleanup failed: ${cleanupError}`,
            stagingRoot,
            outcome.combinedLog
          )
        : failed(
            'EXTERNAL_PUBLISH_UNAVAILABLE',
            publication.message,
            false,
            true,
            outcome.combinedLog
          );
    }
    if (publication.state === 'inDoubt') {
      return inDoubtAtPublished(
        publication.message,
        stagingRoot,
        prepared.destinationPath,
        outcome.combinedLog
      );
    }

    const published = await this.verifyPublished(description, prepared.destinationPath);
    if (!published.ok) {
      return inDoubtAtPublished(
        published.message,
        stagingRoot,
        prepared.destinationPath,
        outcome.combinedLog
      );
    }
    const cleanupError = await this.cleanup(stagingRoot);
    if (cleanupError) {
      return inDoubtAtPublished(
        `Artifact was published, but staging cleanup failed: ${cleanupError}`,
        stagingRoot,
        prepared.destinationPath,
        outcome.combinedLog
      );
    }
    return {
      state: 'completed',
      artifactPath: prepared.destinationPath,
      ...(description.mode === 'dump' && postcondition.rootXmlRelativePath
        ? {
            rootXmlPath: path.join(
              prepared.destinationPath,
              postcondition.rootXmlRelativePath
            ),
          }
        : {}),
      ...(prepared.context.kind === 'standalone'
        ? {
            warning:
              'Standalone mode may replace configuration reference types with primitive types.',
          }
        : {}),
      combinedLog: outcome.combinedLog,
    };
  }

  private buildArguments(
    description: OperationDescription,
    stagingArtifact: string,
    logPath: string
  ): ConfiguratorBatchArguments {
    const target =
      description.prepared.infobaseEntry?.filePath
        ? { type: 'file' as const, filePath: description.prepared.infobaseEntry.filePath }
        : undefined;
    const credentials =
      description.prepared.context.kind === 'infobase'
        ? description.prepared.context.credentials
        : undefined;
    if (description.mode === 'dump') {
      return buildConfiguratorDumpExternalArgs({
        ...(target ? { target } : {}),
        ...(credentials ? { credentials } : {}),
        outputFilePath: logPath,
        dumpDirectory: stagingArtifact,
        externalFilePath: description.prepared.inputPath,
        format: description.format,
      });
    }
    return buildConfiguratorLoadExternalArgs({
      ...(target ? { target } : {}),
      ...(credentials ? { credentials } : {}),
      outputFilePath: logPath,
      rootXmlPath: description.prepared.inputPath,
      destinationPath: stagingArtifact,
    });
  }

  private async publishNoReplace(
    description: OperationDescription,
    stagingRoot: string,
    stagingArtifact: string,
    destinationPath: string
  ): Promise<
    | { state: 'completed' }
    | { state: 'conflict'; message: string }
    | { state: 'failed'; message: string }
    | { state: 'inDoubt'; message: string }
  > {
    if (description.mode === 'build') {
      try {
        await this.fileSystem.link(stagingArtifact, destinationPath);
      } catch (error) {
        return isAlreadyExistsError(error)
          ? {
              state: 'conflict',
              message: `Destination appeared during no-replace publish: ${destinationPath}`,
            }
          : {
              state: 'failed',
              message: `Atomic no-replace file publication is unavailable: ${errorMessage(error)}`,
            };
      }
      try {
        await this.fileSystem.unlink(stagingArtifact);
      } catch (error) {
        return {
          state: 'inDoubt',
          message: `File was published, but its staging link could not be removed: ${errorMessage(error)}`,
        };
      }
      return { state: 'completed' };
    }

    if (this.platform === 'win32') {
      try {
        await this.fileSystem.rename(stagingArtifact, destinationPath);
        return { state: 'completed' };
      } catch (error) {
        const destinationExists = await this.pathExists(destinationPath);
        if (destinationExists === true) {
          return {
            state: 'conflict',
            message: `Destination appeared during no-replace publish: ${destinationPath}`,
          };
        }
        return {
          state: destinationExists === 'unknown' ? 'inDoubt' : 'failed',
          message: `Windows no-replace directory publication failed: ${errorMessage(error)}`,
        };
      }
    }

    const probe = await this.probeHardLink(stagingArtifact, stagingRoot);
    if (!probe.ok) {
      return {
        state: 'failed',
        message: `No safe no-replace publication primitive is available: ${probe.message}`,
      };
    }
    try {
      await this.fileSystem.mkdir(destinationPath);
    } catch (error) {
      return isAlreadyExistsError(error)
        ? {
            state: 'conflict',
            message: `Destination appeared during no-replace publish: ${destinationPath}`,
          }
        : {
            state: 'failed',
            message: `Cannot claim destination directory without replacement: ${errorMessage(error)}`,
          };
    }
    try {
      await this.copyDirectoryNoReplace(stagingArtifact, destinationPath);
      return { state: 'completed' };
    } catch (error) {
      return {
        state: 'inDoubt',
        message: `Destination directory may be partially published: ${errorMessage(error)}`,
      };
    }
  }

  private async probeHardLink(
    stagingArtifact: string,
    stagingRoot: string
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      const sourceFile = await this.findFirstFile(stagingArtifact);
      if (!sourceFile) {
        return { ok: false, message: 'staging directory contains no regular file' };
      }
      const probePath = path.join(
        stagingRoot,
        `.no-replace-probe-${process.pid}-${Date.now()}`
      );
      await this.fileSystem.link(sourceFile, probePath);
      await this.fileSystem.unlink(probePath);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  }

  private async findFirstFile(directoryPath: string): Promise<string | undefined> {
    const entries = await this.fileSystem.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const childPath = path.join(directoryPath, entry.name);
      if (entry.isFile()) {
        return childPath;
      }
      if (entry.isDirectory()) {
        const nested = await this.findFirstFile(childPath);
        if (nested) {
          return nested;
        }
      }
    }
    return undefined;
  }

  private async copyDirectoryNoReplace(
    sourceDirectory: string,
    destinationDirectory: string
  ): Promise<void> {
    const entries = await this.fileSystem.readdir(sourceDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = path.join(sourceDirectory, entry.name);
      const destinationPath = path.join(destinationDirectory, entry.name);
      if (entry.isFile()) {
        await this.fileSystem.link(sourcePath, destinationPath);
        continue;
      }
      if (entry.isDirectory()) {
        await this.fileSystem.mkdir(destinationPath);
        await this.copyDirectoryNoReplace(sourcePath, destinationPath);
        continue;
      }
      throw new Error(`Unsupported staging entry type: ${sourcePath}`);
    }
  }

  private quarantine(identities: readonly string[], reason: string): void {
    try {
      this.queue.quarantine?.(identities, reason);
    } catch {
      // The original operation remains inDoubt even if quarantine reporting itself fails.
    }
  }

  private async scrubLog(logPath: string): Promise<string | undefined> {
    try {
      await this.fileSystem.rm(logPath, { recursive: true, force: true });
      return undefined;
    } catch (removeError) {
      try {
        await this.fileSystem.writeFile(logPath, '', 'utf8');
        return undefined;
      } catch (scrubError) {
        return `${errorMessage(removeError)}; ${errorMessage(scrubError)}`;
      }
    }
  }

  private async verifyStaging(
    description: OperationDescription,
    stagingArtifact: string
  ): Promise<
    | { state: 'completed'; rootXmlRelativePath?: string }
    | { state: 'failed'; message: string }
    | { state: 'inDoubt'; message: string }
  > {
    try {
      const stat = await this.fileSystem.stat(stagingArtifact);
      if (description.mode === 'build') {
        return stat.isFile() && stat.size > 0
          ? { state: 'completed' }
          : {
              state: 'failed',
              message: 'Configurator did not produce a non-empty EPF/ERF staging file.',
            };
      }
      if (!stat.isDirectory()) {
        return {
          state: 'failed',
          message: 'Configurator did not produce an XML staging directory.',
        };
      }
      const entries = await this.fileSystem.readdir(stagingArtifact, { withFileTypes: true });
      if (entries.length === 0) {
        return {
          state: 'failed',
          message: 'Configurator produced an empty XML staging directory.',
        };
      }
      const candidates: string[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || path.extname(entry.name).toLocaleLowerCase() !== '.xml') {
          continue;
        }
        const candidatePath = path.join(stagingArtifact, entry.name);
        try {
          const inspection = await inspectExternalProcessorRootWithFs(
            candidatePath,
            this.fileSystem
          );
          if (
            inspection.extension
            === path.extname(description.prepared.inputPath).toLocaleLowerCase()
          ) {
            candidates.push(entry.name);
          }
        } catch {
          // Only the metadata root XML matches; auxiliary XML files are ignored.
        }
      }
      return candidates.length === 1
        ? { state: 'completed', rootXmlRelativePath: candidates[0] }
        : {
            state: 'failed',
            message: `Expected exactly one external processor root XML, found ${candidates.length}.`,
          };
    } catch (error) {
      if (isMissingError(error)) {
        return {
          state: 'failed',
          message: 'Configurator acknowledged success but did not create the expected artifact.',
        };
      }
      return {
        state: 'inDoubt',
        message: `Cannot verify Configurator staging output: ${errorMessage(error)}`,
      };
    }
  }

  private async verifyPublished(
    description: OperationDescription,
    destinationPath: string
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      const stat = await this.fileSystem.stat(destinationPath);
      if (description.mode === 'build') {
        return stat.isFile() && stat.size > 0
          ? { ok: true }
          : { ok: false, message: 'Published EPF/ERF is not a non-empty file.' };
      }
      if (!stat.isDirectory()) {
        return { ok: false, message: 'Published XML artifact is not a directory.' };
      }
      const entries = await this.fileSystem.readdir(destinationPath, { withFileTypes: true });
      return entries.length > 0
        ? { ok: true }
        : { ok: false, message: 'Published XML directory is empty.' };
    } catch (error) {
      return {
        ok: false,
        message: `Cannot verify the published artifact: ${errorMessage(error)}`,
      };
    }
  }

  private async validateInputFile(
    inputPath: string
  ): Promise<ExternalProcessorOperationResult | undefined> {
    try {
      const stat = await this.fileSystem.stat(inputPath);
      return stat.isFile()
        ? undefined
        : failed('EXTERNAL_INPUT_NOT_FILE', `Input is not a file: ${inputPath}`);
    } catch (error) {
      return isMissingError(error)
        ? failed('EXTERNAL_INPUT_MISSING', `Input file does not exist: ${inputPath}`)
        : failed('EXTERNAL_IO_FAILED', `Cannot inspect input file: ${errorMessage(error)}`);
    }
  }

  private async pathExists(filePath: string): Promise<boolean | 'unknown'> {
    try {
      await this.fileSystem.stat(filePath);
      return true;
    } catch (error) {
      return isMissingError(error) ? false : 'unknown';
    }
  }

  private async cleanup(stagingRoot: string): Promise<string | undefined> {
    try {
      await this.fileSystem.rm(stagingRoot, { recursive: true, force: true });
      return undefined;
    } catch (error) {
      return errorMessage(error);
    }
  }
}

async function inspectExternalProcessorRootWithFs(
  rootXmlPath: string,
  fileSystem: ExternalProcessorFileSystem
): Promise<ExternalProcessorRootInspection> {
  const stat = await fileSystem.stat(rootXmlPath);
  if (!stat.isFile()) {
    throw new Error(`Root XML is not a file: ${rootXmlPath}`);
  }
  const document = parseXmlDocument(await fileSystem.readFile(rootXmlPath, 'utf8'));
  if (document.root.localName !== 'MetaDataObject') {
    throw new Error('Root XML element must be MetaDataObject.');
  }
  const supportedChildren = document.root.children.filter(
    (child) =>
      child.kind === 'element'
      && (child.localName === 'ExternalDataProcessor' || child.localName === 'ExternalReport')
  );
  if (supportedChildren.length !== 1) {
    throw new Error(
      'MetaDataObject must contain exactly one direct ExternalDataProcessor or ExternalReport child.'
    );
  }
  const kind = (supportedChildren[0] as { localName: string }).localName as
    | 'ExternalDataProcessor'
    | 'ExternalReport';
  const extension = kind === 'ExternalReport' ? '.erf' : '.epf';
  const sourceDirectory = path.dirname(path.resolve(rootXmlPath));
  const sourceName = path.basename(sourceDirectory).replace(/_src$/iu, '');
  return {
    kind,
    extension,
    defaultDestinationPath: path.join(
      path.dirname(sourceDirectory),
      `${sourceName}_built${extension}`
    ),
  };
}

function validateContext(
  context: ExternalProcessorExecutionContext
): ExternalProcessorOperationResult | undefined {
  if (!context || typeof context !== 'object') {
    return failed('EXTERNAL_CONTEXT_INVALID', 'Execution context is required.');
  }
  if (context.kind === 'standalone') {
    const candidate = context as ExternalProcessorExecutionContext & {
      credentials?: unknown;
      infobasePath?: unknown;
    };
    return context.acknowledgeTypeLoss === true
      && candidate.credentials === undefined
      && candidate.infobasePath === undefined
      ? undefined
      : failed(
          'EXTERNAL_CONTEXT_INVALID',
          'Standalone context requires acknowledgeTypeLoss=true and cannot contain infobase credentials.'
        );
  }
  if (context.kind === 'infobase') {
    if (
      typeof context.infobasePath !== 'string'
      || context.infobasePath.trim().length === 0
    ) {
      return failed('EXTERNAL_CONTEXT_INVALID', 'Infobase path is required.');
    }
    if (
      context.credentials?.password
      && !context.credentials.user?.trim()
    ) {
      return failed(
        'EXTERNAL_CONTEXT_INVALID',
        'An infobase password requires a user name.'
      );
    }
    return undefined;
  }
  return failed(
    'EXTERNAL_CONTEXT_INVALID',
    'Execution context kind must be infobase or standalone.'
  );
}

function createInfobaseEntry(filePath: string): InfobaseEntry {
  return {
    id: 'external-processor-operation',
    name: 'External processor operation',
    type: 'file',
    filePath,
    hasStoredPassword: false,
    createdAt: new Date(0).toISOString(),
  };
}

function failed(
  code: ExternalProcessorFailedErrorCode,
  message: string,
  retryable = false,
  effectPossible = false,
  combinedLog = ''
): ExternalProcessorOperationResult {
  return {
    state: 'failed',
    code,
    message,
    retryable,
    effectPossible,
    combinedLog,
  };
}

function inDoubtAtStaging(
  message: string,
  stagingPath: string,
  combinedLog: string
): Extract<ExternalProcessorOperationResult, { state: 'inDoubt' }> {
  return {
    state: 'inDoubt',
    code: 'EXTERNAL_POSTCONDITION_IN_DOUBT',
    message,
    retryable: false,
    effectPossible: true,
    stagingPath,
    combinedLog,
  };
}

function inDoubtAtPublished(
  message: string,
  stagingPath: string,
  publishedArtifactPath: string,
  combinedLog: string
): ExternalProcessorOperationResult {
  return {
    ...inDoubtAtStaging(message, stagingPath, combinedLog),
    publishedArtifactPath,
  };
}

function hasUnsafeTermination(outcome: ConfiguratorProcessOutcome): boolean {
  return outcome.termination !== undefined
    && (
      !outcome.termination.terminated
      || outcome.termination.survivingPids.length > 0
    );
}

function dependencyFailure(
  operation: 'dump' | 'build',
  _error: unknown
): ExternalProcessorOperationResult {
  return failed(
    'EXTERNAL_IO_FAILED',
    `External processor ${operation} dependency failed.`
  );
}

function safeErrorMessage(
  error: unknown,
  context: ExternalProcessorExecutionContext
): string {
  const message = errorMessage(error);
  if (context.kind !== 'infobase' || !context.credentials?.password) {
    return message;
  }
  return message.split(context.credentials.password).join('<redacted>');
}

function validTimeout(timeoutMs: number | undefined): number {
  return Number.isFinite(timeoutMs) && (timeoutMs ?? 0) > 0
    ? Math.floor(timeoutMs as number)
    : DEFAULT_TIMEOUT_MS;
}

function defaultStagingName(destinationPath: string): string {
  const baseName = path.basename(destinationPath);
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `.${baseName}.cdt-staging-${nonce}`;
}

function defaultFileSystem(): ExternalProcessorFileSystem {
  return {
    stat: (filePath) => fs.promises.stat(filePath),
    readFile: (filePath, encoding) => fs.promises.readFile(filePath, encoding),
    readdir: (directoryPath, options) => fs.promises.readdir(directoryPath, options),
    mkdir: async (directoryPath) => {
      await fs.promises.mkdir(directoryPath);
    },
    link: (existingPath, newPath) => fs.promises.link(existingPath, newPath),
    rename: (sourcePath, destinationPath) =>
      fs.promises.rename(sourcePath, destinationPath),
    unlink: (filePath) => fs.promises.unlink(filePath),
    writeFile: (filePath, data, encoding) =>
      fs.promises.writeFile(filePath, data, encoding),
    rm: (targetPath, options) => fs.promises.rm(targetPath, options),
  };
}

function isMissingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isAlreadyExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'EEXIST';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
