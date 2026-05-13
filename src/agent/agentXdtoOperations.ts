import * as fs from 'fs';
import * as path from 'path';
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
import { addRootObjectToConfiguration } from '../services/configurationXmlUpdater';
import type { XdtoPackageModel } from '../types/xdtoPackage';
import { XMLWriter } from '../utils/XMLWriter';
import { normalizeMetaDataObjectRoot } from '../utils/xml/metaDataObjectRootNormalizer';
import { metadataConverter, rulesRegistry } from '../rules';
import { resolveXdtoPackageSchemaPath } from '../xdtoPackageEditor/xdtoPackagePaths';
import { convert1cPackageToXsd, convertXsdTo1cPackage } from '../xdtoPackageEditor/xdtoXsdConverter';
import { serializeAndValidateXdtoModelForSave } from '../xdtoPackageEditor/xdtoPackageEditorProvider';
import {
  applyXdtoPackageMerge,
  buildXdtoPackageCompareTree,
  parseXdtoComparableSource,
} from '../xdtoPackageCompare/xdtoPackageCompareModel';

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
      const source = fs.existsSync(resolved.schemaPath)
        ? fs.readFileSync(resolved.schemaPath, 'utf8')
        : '';
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
      const resolved = this.resolvePackage(params);
      const source = fs.readFileSync(resolved.schemaPath, 'utf8');
      const xsd = convert1cPackageToXsd(source);
      if (params.outputPath) {
        fs.mkdirSync(path.dirname(params.outputPath), { recursive: true });
        fs.writeFileSync(params.outputPath, xsd, 'utf8');
      }
      return {
        success: true,
        data: {
          schemaPath: resolved.schemaPath,
          ...(params.outputPath ? { outputPath: params.outputPath } : {}),
          ...(params.includeSource || !params.outputPath ? { xsd } : {}),
        },
      };
    } catch (err) {
      return failure(err);
    }
  }

  async importXsd(params: XdtoImportXsdParams): Promise<AgentResult<XdtoImportXsdResult>> {
    try {
      const resolved = this.resolvePackage(params);
      const { source } = this.readExclusiveExternalSource(params);
      const fallbackNamespace = parseXdtoPackage(source).targetNamespace ?? '';
      const packageSource = convertXsdTo1cPackage(source, fallbackNamespace);
      const model = this.parseValidPackageSource(packageSource);
      fs.mkdirSync(path.dirname(resolved.schemaPath), { recursive: true });
      fs.writeFileSync(resolved.schemaPath, packageSource, 'utf8');
      return { success: true, data: { schemaPath: resolved.schemaPath, model } };
    } catch (err) {
      return failure(err);
    }
  }

  async createFromXsd(params: XdtoCreateFromXsdParams): Promise<AgentResult<XdtoCreateFromXsdResult>> {
    try {
      const packageName = sanitizePackageName(params.packageName);
      if (!packageName) {
        throw new Error('packageName is required');
      }

      const { source } = this.readExclusiveExternalSource(params);
      const namespace = parseXdtoPackage(source).targetNamespace ?? '';
      const metadataPath = path.join(this.packagesDir(), `${packageName}.xml`);
      const schemaPath = resolveXdtoPackageSchemaPath(metadataPath, packageName);
      if (fs.existsSync(metadataPath) || fs.existsSync(schemaPath)) {
        throw new Error(`XDTO package already exists: ${packageName}`);
      }

      const packageSource = convertXsdTo1cPackage(source, namespace);
      const model = this.parseValidPackageSource(packageSource);
      fs.mkdirSync(this.packagesDir(), { recursive: true });
      fs.writeFileSync(metadataPath, buildXdtoPackageMetadataXml(packageName, namespace), 'utf8');
      fs.mkdirSync(path.dirname(schemaPath), { recursive: true });
      fs.writeFileSync(schemaPath, packageSource, 'utf8');
      await addRootObjectToConfiguration(this.configRoot, 'XDTOPackage', packageName);

      return {
        success: true,
        data: { name: packageName, metadataPath, schemaPath, targetNamespace: model.targetNamespace, model },
      };
    } catch (err) {
      return failure(err);
    }
  }

  async compare(params: XdtoCompareParams): Promise<AgentResult<XdtoCompareResult>> {
    try {
      const resolved = this.resolvePackage(params);
      const left = this.readPackageModel(resolved.schemaPath);
      const rightSource = this.readOptionalExternalSource(params);
      const right = parseXdtoComparableSource(
        rightSource.fileName,
        rightSource.source,
        left.targetNamespace ?? '',
      );
      const tree = buildXdtoPackageCompareTree(left, right);
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
      if (!Array.isArray(params.selectedIds)) {
        throw new Error('selectedIds is required');
      }

      const resolved = this.resolvePackage(params);
      const left = this.readPackageModel(resolved.schemaPath);
      const rightSource = this.readOptionalExternalSource(params);
      const right = parseXdtoComparableSource(
        rightSource.fileName,
        rightSource.source,
        left.targetNamespace ?? '',
      );
      const beforeTree = buildXdtoPackageCompareTree(left, right);
      const model = applyXdtoPackageMerge(left, right, params.selectedIds);
      const validation = serializeAndValidateXdtoModelForSave(model);
      if (!validation.ok) {
        throw new Error(validation.message);
      }
      fs.writeFileSync(resolved.schemaPath, validation.source, 'utf8');
      return { success: true, data: { stats: beforeTree.stats, schemaPath: resolved.schemaPath, model: validation.model } };
    } catch (err) {
      return failure(err);
    }
  }

  private packagesDir(): string {
    return path.join(this.configRoot, 'XDTOPackages');
  }

  private resolvePackage(selector: XdtoPackageSelector): XdtoPackageInfo {
    if (!selector.packageName && !selector.metadataPath) {
      throw new Error('packageName or metadataPath is required');
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
    return { name, metadataPath, schemaPath, targetNamespace: model?.targetNamespace };
  }

  private readPackageModel(schemaPath: string): XdtoPackageModel {
    return this.parseValidPackageSource(fs.readFileSync(schemaPath, 'utf8'));
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
}

function buildXdtoPackageMetadataXml(packageName: string, namespace: string): string {
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
  return normalizeMetaDataObjectRoot(content);
}

function sanitizePackageName(raw: string): string {
  return raw.trim().replace(/[\\/:*?"<>|]/g, '_');
}

function failure<T>(err: unknown): AgentResult<T> {
  return { success: false, error: err instanceof Error ? err.message : String(err) };
}
