import type { CompareTreeNode, CompareTreeStats } from '../compareMerge/compareTreeTypes';
import type { XdtoCompareJoinStrategy } from '../xdtoPackageCompare/xdtoPackageCompareModel';
import type { XdtoPackageModel } from '../types/xdtoPackage';

export interface XdtoPackageSelector {
  packageName?: string;
  metadataPath?: string;
}

export interface XdtoPackageInfo {
  name: string;
  metadataPath: string;
  schemaPath: string;
  targetNamespace?: string;
}

export interface XdtoListPackagesResult {
  packages: XdtoPackageInfo[];
}

export interface XdtoGetPackageParams extends XdtoPackageSelector {
  includeSource?: boolean;
}

export interface XdtoGetPackageResult extends XdtoPackageInfo {
  model: XdtoPackageModel;
  source?: string;
}

export interface XdtoExportXsdParams extends XdtoPackageSelector {
  outputPath?: string;
  includeSource?: boolean;
}

export interface XdtoExportXsdResult {
  xsd?: string;
  outputPath?: string;
  schemaPath: string;
}

export interface XdtoImportXsdParams extends XdtoPackageSelector {
  inputPath?: string;
  source?: string;
}

export interface XdtoImportXsdResult {
  schemaPath: string;
  model: XdtoPackageModel;
}

export interface XdtoCreateFromXsdParams {
  packageName: string;
  inputPath?: string;
  source?: string;
}

export interface XdtoCreateFromXsdResult extends XdtoPackageInfo {
  model: XdtoPackageModel;
}

export interface XdtoCompareParams extends XdtoPackageSelector {
  inputPath?: string;
  source?: string;
  includeTree?: boolean;
  joinStrategy?: XdtoCompareJoinStrategy;
}

export interface XdtoCompareResult {
  stats: CompareTreeStats;
  schemaPath: string;
  sourcePath?: string;
  tree?: CompareTreeNode;
}

export interface XdtoMergeParams extends XdtoPackageSelector {
  inputPath?: string;
  source?: string;
  selectedIds: string[];
  joinStrategy?: XdtoCompareJoinStrategy;
}

export interface XdtoMergeResult {
  stats: CompareTreeStats;
  schemaPath: string;
  model: XdtoPackageModel;
}
