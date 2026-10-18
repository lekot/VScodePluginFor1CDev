import * as fs from 'fs';
import * as path from 'path';
import {
  assertPathWithinRoot,
  canonicalizePathWithMissingSuffix,
  isSamePath,
  PathBoundaryError,
} from '../services/configurationSession/pathBoundary';

export class SkdPathResolutionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SkdPathResolutionError';
  }
}

type BoundaryValidator = typeof assertPathWithinRoot;

export async function resolveSkdTemplatePath(
  configRoot: string,
  suppliedPath: string,
  allowObjectDiscovery: boolean,
  validate: BoundaryValidator = assertPathWithinRoot,
  allowLegacyExtFallback = false,
): Promise<string> {
  configRoot = await realConfigurationRoot(configRoot);
  let input: string;
  try {
    input = await resolveInputPath(configRoot, suppliedPath, validate);
  } catch (error) {
    if (!allowLegacyExtFallback) { throw error; }
    const absolute = absoluteFromRoot(configRoot, suppliedPath);
    const legacyTargets = path.basename(absolute).toLocaleLowerCase() === 'template.xml'
      ? [path.join(path.dirname(absolute), 'Ext', 'Template.xml')]
      : path.extname(absolute).toLocaleLowerCase() === '.xml'
        ? [path.join(path.dirname(absolute), path.basename(absolute, path.extname(absolute)), 'Ext', 'Template.xml')]
        : [];
    for (const legacyTarget of legacyTargets) {
      if (await isFile(legacyTarget)) { return canonicalInput(configRoot, legacyTarget, validate); }
    }
    throw error;
  }
  const stat = await fs.promises.stat(input);
  if (stat.isDirectory()) {
    const direct = path.join(input, 'Ext', 'Template.xml');
    if (await isFile(direct)) {
      return canonicalInput(configRoot, direct, validate);
    }
    if (allowObjectDiscovery) {
      return discoverObjectTemplate(configRoot, input, validate);
    }
    throw new SkdPathResolutionError('SKD_TEMPLATE_NOT_FOUND', `В каталоге не найден Ext/Template.xml: ${suppliedPath}`);
  }
  if (!stat.isFile() || path.extname(input).toLocaleLowerCase() !== '.xml') {
    throw new SkdPathResolutionError('SKD_PATH_UNSUPPORTED', `Ожидался XML-файл или каталог СКД: ${suppliedPath}`);
  }

  const descriptorType = await readTemplateType(input);
  if (descriptorType === 'DataCompositionSchema') {
    const companion = path.join(path.dirname(input), path.basename(input, path.extname(input)), 'Ext', 'Template.xml');
    if (!await isFile(companion)) {
      throw new SkdPathResolutionError('SKD_TEMPLATE_NOT_FOUND', `Для дескриптора СКД не найден Template.xml: ${suppliedPath}`);
    }
    return canonicalInput(configRoot, companion, validate);
  }
  if (descriptorType) {
    throw new SkdPathResolutionError('SKD_PATH_UNSUPPORTED', `Дескриптор описывает шаблон неподдерживаемого типа: ${descriptorType}`);
  }
  return canonicalInput(configRoot, input, validate);
}

export async function resolveSkdExistingFile(
  configRoot: string,
  suppliedPath: string,
  validate: BoundaryValidator = assertPathWithinRoot,
): Promise<string> {
  configRoot = await realConfigurationRoot(configRoot);
  const target = await resolveInputPath(configRoot, suppliedPath, validate);
  const stat = await fs.promises.stat(target);
  if (!stat.isFile()) {
    throw new SkdPathResolutionError('SKD_PATH_UNSUPPORTED', `Ожидался файл: ${suppliedPath}`);
  }
  return canonicalInput(configRoot, target, validate);
}

export async function resolveSkdOutputPath(
  configRoot: string,
  suppliedPath: string,
  validate: BoundaryValidator = assertPathWithinRoot,
): Promise<string> {
  configRoot = await realConfigurationRoot(configRoot);
  const target = await resolveOutput(configRoot, suppliedPath, validate);
  const existing = await fs.promises.lstat(path.resolve(configRoot, suppliedPath)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') { return undefined; }
    throw error;
  });
  if (existing?.isDirectory() || existing?.isSymbolicLink()) {
    throw new SkdPathResolutionError('SKD_OUTPUT_TARGET_INVALID', 'Выходной путь не может быть каталогом или символической ссылкой.');
  }
  return target;
}

export async function resolveSkdReportPath(
  configRoot: string,
  suppliedPath: string,
  effectiveInput: string,
  validate: BoundaryValidator = assertPathWithinRoot,
): Promise<string> {
  const target = await resolveSkdOutputPath(configRoot, suppliedPath, validate);
  const extension = path.extname(target).toLocaleLowerCase();
  if (extension !== '.txt' && extension !== '.log') {
    throw new SkdPathResolutionError('SKD_REPORT_TARGET_INVALID', 'Файл отчёта должен иметь расширение .txt или .log.');
  }
  if (isSamePath(target, effectiveInput)) {
    throw new SkdPathResolutionError('SKD_REPORT_TARGET_INVALID', 'Файл отчёта не может совпадать с входным шаблоном.');
  }
  const [targetStat, inputStat] = await Promise.all([
    fs.promises.stat(target).catch(() => undefined),
    fs.promises.stat(effectiveInput).catch(() => undefined),
  ]);
  if (targetStat && inputStat && targetStat.dev === inputStat.dev && targetStat.ino === inputStat.ino) {
    throw new SkdPathResolutionError('SKD_REPORT_TARGET_INVALID', 'Файл отчёта не может быть жёсткой ссылкой на входной шаблон.');
  }
  return target;
}

async function resolveInputPath(root: string, supplied: string, validate: BoundaryValidator): Promise<string> {
  const absolute = absoluteFromRoot(root, supplied);
  let realTarget: string;
  try {
    realTarget = await fs.promises.realpath(absolute);
  } catch {
    throw new SkdPathResolutionError('SKD_PATH_UNAVAILABLE', `Путь не существует или недоступен: ${supplied}`);
  }
  return (await validate(root, realTarget)).canonicalTarget;
}

async function resolveOutput(root: string, supplied: string, validate: BoundaryValidator): Promise<string> {
  const absolute = absoluteFromRoot(root, supplied);
  const canonicalTarget = await canonicalizePathWithMissingSuffix(absolute);
  return (await validate(root, canonicalTarget)).canonicalTarget;
}

async function canonicalInput(root: string, target: string, validate: BoundaryValidator): Promise<string> {
  const realTarget = await fs.promises.realpath(target);
  const { canonicalTarget } = await validate(root, realTarget);
  try {
    const stat = await fs.promises.stat(canonicalTarget);
    if (!stat.isFile()) {
      throw new SkdPathResolutionError('SKD_PATH_UNSUPPORTED', `Эффективный путь СКД не является файлом: ${target}`);
    }
  } catch (error) {
    if (error instanceof SkdPathResolutionError) { throw error; }
    throw new SkdPathResolutionError('SKD_PATH_UNAVAILABLE', `Эффективный файл СКД недоступен: ${target}`);
  }
  return canonicalTarget;
}

async function discoverObjectTemplate(
  root: string,
  objectRoot: string,
  validate: BoundaryValidator,
): Promise<string> {
  const templatesDir = path.join(objectRoot, 'Templates');
  const { canonicalTarget } = await validate(root, templatesDir);
  let descriptors: string[];
  try {
    descriptors = (await fs.promises.readdir(canonicalTarget, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && path.extname(entry.name).toLocaleLowerCase() === '.xml')
      .map((entry) => path.join(canonicalTarget, entry.name));
  } catch {
    throw new SkdPathResolutionError('SKD_TEMPLATE_NOT_FOUND', `В каталоге не найден шаблон СКД: ${objectRoot}`);
  }

  const candidates: string[] = [];
  for (const descriptor of descriptors) {
    const descriptorPath = await canonicalInput(root, descriptor, validate);
    if (await readTemplateType(descriptorPath) !== 'DataCompositionSchema') { continue; }
    const companion = path.join(canonicalTarget, path.basename(descriptor, path.extname(descriptor)), 'Ext', 'Template.xml');
    if (await isFile(companion)) {
      candidates.push(await canonicalInput(root, companion, validate));
    }
  }
  if (candidates.length === 1) { return candidates[0]!; }
  if (candidates.length > 1) {
    throw new SkdPathResolutionError('SKD_TEMPLATE_AMBIGUOUS', `Найдено несколько шаблонов СКД в каталоге: ${objectRoot}`);
  }
  throw new SkdPathResolutionError('SKD_TEMPLATE_NOT_FOUND', `В каталоге не найден шаблон СКД: ${objectRoot}`);
}

async function readTemplateType(filePath: string): Promise<string | undefined> {
  const source = await fs.promises.readFile(filePath, 'utf8');
  const match = source.match(/<(?:[\w.-]+:)?TemplateType\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?TemplateType\s*>/i);
  return match?.[1]?.replace(/<[^>]+>/g, '').trim() || undefined;
}

async function isFile(filePath: string): Promise<boolean> {
  try { return (await fs.promises.stat(filePath)).isFile(); }
  catch { return false; }
}

function absoluteFromRoot(root: string, supplied: string): string {
  if (!supplied.trim() || supplied.includes('\0')) {
    throw new SkdPathResolutionError('SKD_PATH_REQUIRED', 'Путь СКД не задан или содержит недопустимые символы.');
  }
  return path.isAbsolute(supplied) ? path.resolve(supplied) : path.resolve(root, supplied);
}

async function realConfigurationRoot(root: string): Promise<string> {
  try { return await fs.promises.realpath(root); }
  catch {
    throw new SkdPathResolutionError('CONFIGURATION_PATH_UNAVAILABLE', `Корень конфигурации недоступен: ${root}`);
  }
}

export function mapSkdPathError(error: unknown, suppliedPath: string): { code: string; message: string } {
  if (error instanceof PathBoundaryError) {
    return {
      code: 'TARGET_OUTSIDE_ROOT',
      message: `Путь "${suppliedPath}" выходит за границы конфигурации (${error.code}).`,
    };
  }
  if (error instanceof SkdPathResolutionError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'PATH_VALIDATION_FAILED',
    message: error instanceof Error ? error.message : String(error),
  };
}
