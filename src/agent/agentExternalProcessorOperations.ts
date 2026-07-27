import * as path from 'path';
import {
  buildExternalProcessor,
  dumpExternalProcessor,
} from '../services/externalProcessor/externalProcessorService';

export interface AgentDumpExternalProcessorInput {
  /** Path to .epf or .erf file */
  srcPath: string;
  /** Output directory for XML source files. If omitted, defaults to <srcPath_without_ext>_src */
  outDir?: string;
  format?: 'Hierarchical' | 'Plain';
}

export interface AgentBuildExternalProcessorInput {
  /** Path to directory with XML source files */
  srcDir: string;
  /** Destination .epf or .erf file path. If omitted, defaults to <srcDir>_built.epf */
  dstPath?: string;
  format?: 'Hierarchical' | 'Plain';
}

export interface AgentExternalProcessorOutcome {
  success: boolean;
  message?: string;
  outputPath?: string;
}

export async function agentDumpExternalProcessor(
  input: AgentDumpExternalProcessorInput
): Promise<AgentExternalProcessorOutcome> {
  const srcPath = path.resolve(input.srcPath);
  const outDir = input.outDir
    ? path.resolve(input.outDir)
    : path.join(path.dirname(srcPath), `${path.basename(srcPath, path.extname(srcPath))}_src`);

  const res = await dumpExternalProcessor({
    externalFilePath: srcPath,
    directoryPath: outDir,
    format: input.format,
  });

  return {
    success: res.success,
    message: res.message,
    outputPath: res.success ? outDir : undefined,
  };
}

export async function agentBuildExternalProcessor(
  input: AgentBuildExternalProcessorInput
): Promise<AgentExternalProcessorOutcome> {
  const srcDir = path.resolve(input.srcDir);
  const dstPath = input.dstPath
    ? path.resolve(input.dstPath)
    : path.join(path.dirname(srcDir), `${path.basename(srcDir).replace(/_src$/, '')}_built.epf`);

  const res = await buildExternalProcessor({
    externalFilePath: dstPath,
    directoryPath: srcDir,
    format: input.format,
  });

  return {
    success: res.success,
    message: res.message,
    outputPath: res.success ? dstPath : undefined,
  };
}
