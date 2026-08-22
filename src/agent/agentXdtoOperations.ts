import * as fs from 'fs';
import * as path from 'path';
import { XMLParser } from 'fast-xml-parser';
import type { AgentResult } from './types';
import type {
  XdtoCompareParams,
  XdtoCompareResult,
  XdtoCreateFromXsdParams,
  XdtoCreateFromXsdResult,
  XdtoExportXsdParams,
  XdtoExportXsdResult,
  XdtoGetPackageParams,
  XdtoGetPackageResult,
  XdtoImportXsdParams,
  XdtoImportXsdResult,
  XdtoListPackagesResult,
  XdtoMergeParams,
  XdtoMergeResult,
  XdtoPackageInfo,
  XdtoPackageSelector,
} from './agentXdtoTypes';
import { parseXdtoPackage } from '../parsers/xdtoPackageParser';
import { buildRootObjectConfigurationContent } from '../services/configurationXmlUpdater';
import type { XdtoPackageModel } from '../types/xdtoPackage';
import { XMLWriter } from '../utils/XMLWriter';
import { normalizeMetaDataObjectRoot } from '../utils/xml/metaDataObjectRootNormalizer';
import { detectFormatVersionFromXml } from '../utils/format/formatRank';
import { metadataConverter, rulesRegistry } from '../rules';
import { resolveXdtoPackageSchemaPath } from '../xdtoPackageEditor/xdtoPackagePaths';
import { buildXdtoPackageSkeleton } from '../xdtoPackageEditor/xdtoPackageFiles';
import { convert1cPackageToXsd, convertXsdTo1cPackage } from '../xdtoPackageEditor/xdtoXsdConverter';
import { serializeAndValidateXdtoModelForSave } from '../xdtoPackageEditor/xdtoPackageEditorProvider';
import {
  applyXdtoPackageMerge,
  buildXdtoPackageCompareTree,
  parseXdtoComparableSource,
} from '../xdtoPackageCompare/xdtoPackageCompareModel';
import { validateElementName } from '../utils/elementNameValidator';
import { assertPathWithinRoot } from '../services/configurationSession/pathBoundary';
import { hashContent } from '../services/configurationSession/atomicFileStorage';
import {
  MutationPlanExecutor,
  type MutationExpectation,
  type MutationPlan,
} from '../services/configurationSession/mutationPlan';
import { CONFIGURATION_XML } from '../constants/fileNames';

const METADATA_XML_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
};

const metadataParser = new XMLParser(METADATA_XML_OPTIONS);

export class XdtoAgentOperations {
  constructor(private readonly configRoot: string) {}

  async listPackages(): Promise<AgentResult<XdtoListPackagesResult>> {
    try {
      const packagesDir = this.packagesDir();
      if (!fs.existsSync(packagesDir)) {
        return { success: true, data: { packages: [] } };
      }

      const packages = fs.readdirSync(packagesDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.xml'))
        .map((entry) => this.packageInfoFromMetadataPath(path.join(packagesDir, entry.name)))
        .sort((left, right) => left.name.localeCompare(right.name));

      return { success: true, data: { packages } };
    } catch (err) {
      return failure(err);
    }
  }

  async getPackage(params: XdtoGetPackageParams): Promise<AgentResult<XdtoGetPackageResult>> {
    try {
      const resolved = this.resolvePackage(params);
      await this.assertPackageContained(resolved);
      const source = this.ensurePackageSource(resolved);
      const model = parseXdtoPackage(source);
      return {
        success: true,
        data: {
          ...resolved,
          targetNamespace: model.targetNamespace,
          model,
          ...(params.includeSource ? { source } : {}),
        },
      };
    } catch (err) {
      return failure(err);
    }
  }

  async exportXsd(params: XdtoExportXsdParams): Promise<AgentResult<XdtoExportXsdResult>> {
    try {
      if (params.outputPath !== undefined) {
        return await new MutationPlanExecutor(this.configRoot).execute(await this.planExportXsd(params));
      }
      const resolved = this.resolvePackage(params);
      await this.assertPackageContained(resolved);
      const source = this.ensurePackageSource(resolved);
      const xsd = convert1cPackageToXsd(source);
      return {
        success: true,
        data: {
          schemaPath: resolved.schemaPath,
          xsd,
        },
      };
    } catch (err) {
      return failure(err);
    }
  }

  async planExportXsd(
    params: XdtoExportXsdParams,
  ): Promise<MutationPlan<AgentResult<XdtoExportXsdResult>>> {
    if (params.outputPath === undefined || !params.outputPath.trim()) {
      throw new Error('outputPath is required for an XDTO export mutation');
    }
    const resolved = this.resolvePackage(params);
    await this.assertPackageContained(resolved);
    const outputPath = this.resolveInputPath(params.outputPath.trim());
    if (path.extname(outputPath).toLocaleLowerCase() !== '.xsd') {
      throw new Error('XDTO export outputPath must have the .xsd extension.');
    }
    await assertPathWithinRoot(this.configRoot, outputPath);
    const expected = await expectationForPath(outputPath);
    if (expected.state === 'directory') {
      throw new Error(`XDTO export target is a directory: ${outputPath}`);
    }
    const xsd = convert1cPackageToXsd(this.ensurePackageSource(resolved));
    return {
      kind: 'agent.xdto.exportXsd',
      steps: [
        { type: 'ensureDirectory', targetPath: path.dirname(outputPath) },
        { type: 'writeFile', targetPath: outputPath, content: xsd, encoding: 'utf8', expected },
      ],
      result: {
        success: true,
        data: {
          schemaPath: resolved.schemaPath,
          outputPath,
          ...(params.includeSource ? { xsd } : {}),
        },
      },
    };
  }

  async importXsd(params: XdtoImportXsdParams): Promise<AgentResult<XdtoImportXsdResult>> {
    try {
      const plan = await this.planImportXsd(params);
      return await new MutationPlanExecutor(this.configRoot).execute(plan);
    } catch (err) {
      return failure(err);
    }
  }

  async planImportXsd(
    params: XdtoImportXsdParams,
  ): Promise<MutationPlan<AgentResult<XdtoImportXsdResult>>> {
    const resolved = this.resolvePackage(params);
    await this.assertPackageContained(resolved);
    const { source } = this.readExclusiveExternalSource(params);
    const fallbackNamespace = parseXdtoPackage(source).targetNamespace ?? '';
    const packageSource = convertXsdTo1cPackage(source, fallbackNamespace);
    const model = this.parseValidPackageSource(packageSource);
    const expected = await expectationForPath(resolved.schemaPath);
    return {
      kind: 'agent.xdto.importXsd',
      steps: [
        { type: 'ensureDirectory', targetPath: path.dirname(resolved.schemaPath) },
        {
          type: 'writeFile', targetPath: resolved.schemaPath, content: packageSource,
          encoding: 'utf8', expected,
        },
      ],
      result: { success: true, data: { schemaPath: resolved.schemaPath, model } },
    };
  }

  async createFromXsd(params: XdtoCreateFromXsdParams): Promise<AgentResult<XdtoCreateFromXsdResult>> {
    try {
      const plan = await this.planCreateFromXsd(params);
      return await new MutationPlanExecutor(this.configRoot).execute(plan);
    } catch (err) {
      return failure(err);
    }
  }

  async planCreateFromXsd(
    params: XdtoCreateFromXsdParams,
  ): Promise<MutationPlan<AgentResult<XdtoCreateFromXsdResult>>> {
    const packageName = params.packageName.trim();
    const siblingNames = fs.existsSync(this.packagesDir())
      ? fs.readdirSync(this.packagesDir(), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLocaleLowerCase().endsWith('.xml'))
        .map((entry) => path.basename(entry.name, path.extname(entry.name)))
      : [];
    const validation = validateElementName(packageName, siblingNames);
    if (validation) {
      throw new Error(validation);
    }

    const { source } = this.readExclusiveExternalSource(params);
    const namespace = parseXdtoPackage(source).targetNamespace ?? '';
    const metadataPath = path.join(this.packagesDir(), `${packageName}.xml`);
    const schemaPath = resolveXdtoPackageSchemaPath(metadataPath, packageName);
    await Promise.all([
      assertPathWithinRoot(this.configRoot, metadataPath),
      assertPathWithinRoot(this.configRoot, schemaPath),
    ]);
    const metadataExpected = await expectationForPath(metadataPath);
    const schemaExpected = await expectationForPath(schemaPath);
    if (metadataExpected.state !== 'missing' || schemaExpected.state !== 'missing') {
      throw new Error(`XDTO package already exists: ${packageName}`);
    }

    const packageSource = convertXsdTo1cPackage(source, namespace);
    const model = this.parseValidPackageSource(packageSource);
    const configurationPath = path.join(this.configRoot, CONFIGURATION_XML);
    const configurationContent = await fs.promises.readFile(configurationPath, 'utf8');
    return {
      kind: 'agent.xdto.createFromXsd',
      steps: [
        { type: 'ensureDirectory', targetPath: this.packagesDir() },
        {
          type: 'writeFile', targetPath: metadataPath,
          content: buildXdtoPackageMetadataXml(packageName, namespace, detectFormatVersionFromXml(configurationContent).version),
          encoding: 'utf8', expected: metadataExpected,
        },
        { type: 'ensureDirectory', targetPath: path.dirname(schemaPath) },
        {
          type: 'writeFile', targetPath: schemaPath, content: packageSource,
          encoding: 'utf8', expected: schemaExpected,
        },
        {
          type: 'writeFile', targetPath: configurationPath,
          content: buildRootObjectConfigurationContent(configurationContent, {
            type: 'add', rootTag: 'XDTOPackage', objectName: packageName,
          }),
          encoding: 'utf8', expected: { state: 'file', hash: hashContent(configurationContent) },
        },
      ],
      result: {
        success: true,
        data: { name: packageName, metadataPath, schemaPath, targetNamespace: model.targetNamespace, model },
      },
    };
  }

  async compare(params: XdtoCompareParams): Promise<AgentResult<XdtoCompareResult>> {
    try {
      const resolved = this.resolvePackage(params);
      await this.assertPackageContained(resolved);
      const left = this.readPackageModel(resolved);
      const rightSource = this.readOptionalExternalSource(params);
      const right = parseXdtoComparableSource(
        rightSource.fileName,
        rightSource.source,
        left.targetNamespace ?? '',
      );
      const tree = buildXdtoPackageCompareTree(left, right, params.joinStrategy);
      return {
        success: true,
        data: {
          stats: tree.stats,
          schemaPath: resolved.schemaPath,
          ...(rightSource.sourcePath ? { sourcePath: rightSource.sourcePath } : {}),
          ...(params.includeTree ? { tree: tree.root } : {}),
        },
      };
    } catch (err) {
      return failure(err);
    }
  }

  async merge(params: XdtoMergeParams): Promise<AgentResult<XdtoMergeResult>> {
    try {
      const plan = await this.planMerge(params);
      return await new MutationPlanExecutor(this.configRoot).execute(plan);
    } catch (err) {
      return failure(err);
    }
  }

  async planMerge(params: XdtoMergeParams): Promise<MutationPlan<AgentResult<XdtoMergeResult>>> {
    if (!Array.isArray(params.selectedIds)) {
      throw new Error('selectedIds is required');
    }
    const resolved = this.resolvePackage(params);
    await this.assertPackageContained(resolved);
    const left = this.readPackageModel(resolved);
    const rightSource = this.readOptionalExternalSource(params);
    const right = parseXdtoComparableSource(
      rightSource.fileName,
      rightSource.source,
      left.targetNamespace ?? '',
    );
    const beforeTree = buildXdtoPackageCompareTree(left, right, params.joinStrategy);
    const model = applyXdtoPackageMerge(left, right, params.selectedIds);
    const validation = serializeAndValidateXdtoModelForSave(model);
    if (!validation.ok) {
      throw new Error(validation.message);
    }
    const expected = await expectationForPath(resolved.schemaPath);
    if (expected.state !== 'file') {
      throw new Error(`XDTO schema file not found: ${resolved.schemaPath}`);
    }
    return {
      kind: 'agent.xdto.merge',
      steps: [{
        type: 'writeFile', targetPath: resolved.schemaPath, content: validation.source,
        encoding: 'utf8', expected,
      }],
      result: {
        success: true,
        data: { stats: beforeTree.stats, schemaPath: resolved.schemaPath, model: validation.model },
      },
    };
  }

  private packagesDir(): string {
    return path.join(this.configRoot, 'XDTOPackages');
  }

  private resolvePackage(selector: XdtoPackageSelector): XdtoPackageInfo {
    if (!selector.packageName && !selector.metadataPath) {
      throw new Error('packageName or metadataPath is required');
    }
    if (selector.packageName) {
      const validation = validateElementName(selector.packageName, []);
      if (validation) { throw new Error(validation); }
    }
    const metadataPath = selector.metadataPath
      ? this.resolveInputPath(selector.metadataPath)
      : path.join(this.packagesDir(), `${selector.packageName}.xml`);
    if (!fs.existsSync(metadataPath)) {
      throw new Error(`XDTO metadata file not found: ${metadataPath}`);
    }
    return this.packageInfoFromMetadataPath(metadataPath);
  }

  private packageInfoFromMetadataPath(metadataPath: string): XdtoPackageInfo {
    const name = path.basename(metadataPath, path.extname(metadataPath));
    const schemaPath = resolveXdtoPackageSchemaPath(metadataPath, name);
    const model = fs.existsSync(schemaPath)
      ? parseXdtoPackage(fs.readFileSync(schemaPath, 'utf8'))
      : undefined;
    return { name, metadataPath, schemaPath, targetNamespace: model?.targetNamespace ?? readXdtoMetadataNamespace(metadataPath) };
  }

  private readPackageModel(info: XdtoPackageInfo): XdtoPackageModel {
    return this.parseValidPackageSource(this.ensurePackageSource(info));
  }

  private ensurePackageSource(info: XdtoPackageInfo): string {
    if (fs.existsSync(info.schemaPath)) {
      return fs.readFileSync(info.schemaPath, 'utf8');
    }

    return buildXdtoPackageSkeleton(readXdtoMetadataNamespace(info.metadataPath));
  }

  private parseValidPackageSource(source: string): XdtoPackageModel {
    const model = parseXdtoPackage(source);
    const error = model.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    if (error) {
      throw new Error(error.message);
    }
    return model;
  }

  private readExclusiveExternalSource(params: { inputPath?: string; source?: string }): { source: string; sourcePath?: string; fileName: string } {
    const hasInputPath = Boolean(params.inputPath);
    const hasSource = params.source !== undefined;
    if (hasInputPath === hasSource) {
      throw new Error('Exactly one of inputPath or source is required');
    }
    return this.readOptionalExternalSource(params);
  }

  private readOptionalExternalSource(params: { inputPath?: string; source?: string }): { source: string; sourcePath?: string; fileName: string } {
    if (params.inputPath) {
      const sourcePath = this.resolveInputPath(params.inputPath);
      return { source: fs.readFileSync(sourcePath, 'utf8'), sourcePath, fileName: path.basename(sourcePath) };
    }
    if (params.source !== undefined) {
      return { source: params.source, fileName: 'source.xml' };
    }
    throw new Error('inputPath or source is required');
  }

  private resolveInputPath(inputPath: string): string {
    return path.isAbsolute(inputPath) ? inputPath : path.join(this.configRoot, inputPath);
  }

  private async assertPackageContained(info: XdtoPackageInfo): Promise<void> {
    await Promise.all([
      assertPathWithinRoot(this.configRoot, info.metadataPath),
      assertPathWithinRoot(this.configRoot, info.schemaPath),
    ]);
  }
}

function buildXdtoPackageMetadataXml(packageName: string, namespace: string, targetVersion?: string): string {
  const rules = rulesRegistry.get('XDTOPackage');
  if (!rules) {
    throw new Error('XDTOPackage rules are not registered.');
  }
  const uuid = XMLWriter.generateSimpleUuid();
  const ir = metadataConverter.createDefaultIR(rules, { name: packageName, uuid });
  const content = metadataConverter.irToXml(
    metadataConverter.mergeProperties(ir, { namespace }),
    rules,
  );
  return normalizeMetaDataObjectRoot(content, targetVersion);
}

function readXdtoMetadataNamespace(metadataPath: string): string {
  if (!fs.existsSync(metadataPath)) {
    return '';
  }
  try {
    const parsed = metadataParser.parse(fs.readFileSync(metadataPath, 'utf8')) as unknown;
    return findNamespaceValue(parsed) ?? '';
  } catch {
    return '';
  }
}

function findNamespaceValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNamespaceValue(item);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    if (localXmlName(key) !== 'Namespace') {
      continue;
    }
    if (typeof item === 'string') {
      return item;
    }
    if (Array.isArray(item)) {
      const text = item.map(extractTextNode).find((candidate) => candidate !== undefined);
      if (text !== undefined) {
        return text;
      }
    }
    const text = extractTextNode(item);
    if (text !== undefined) {
      return text;
    }
  }

  for (const item of Object.values(record)) {
    const found = findNamespaceValue(item);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function extractTextNode(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const text = (value as Record<string, unknown>)['#text'];
  return typeof text === 'string' ? text : undefined;
}

function localXmlName(name: string): string {
  const rawName = name.startsWith('@_') ? name.slice(2) : name;
  const separator = rawName.indexOf(':');
  return separator >= 0 ? rawName.slice(separator + 1) : rawName;
}

function failure<T>(err: unknown): AgentResult<T> {
  return { success: false, error: err instanceof Error ? err.message : String(err) };
}

async function expectationForPath(targetPath: string): Promise<MutationExpectation> {
  try {
    const stat = await fs.promises.lstat(targetPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Symbolic-link XDTO target is forbidden: ${targetPath}`);
    }
    if (stat.isDirectory()) {
      return { state: 'directory' };
    }
    if (stat.isFile()) {
      return { state: 'file', hash: hashContent(await fs.promises.readFile(targetPath)) };
    }
    throw new Error(`Unsupported XDTO filesystem target: ${targetPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: 'missing' };
    }
    throw error;
  }
}
