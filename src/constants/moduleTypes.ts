import { MetadataType } from '../models/treeNode';
import { getStandardModules } from './metadataModuleDescriptors';

/** Tree projection for one standard BSL module. */
export interface StandardModule {
  /** Filename, e.g. "ObjectModule.bsl" */
  fileName: string;
  /** Human-readable label shown in the tree */
  label: string;
}

/**
 * Tree/parser projection of the canonical standard module registry.
 * Only types that have at least one standard module are listed.
 */
/* eslint-disable @typescript-eslint/naming-convention */
export const STANDARD_MODULES: Partial<Record<MetadataType, StandardModule[]>> = Object.values(
  MetadataType
).reduce((projection, metadataType) => {
  const modules = getStandardModules(metadataType);
  if (modules.length > 0) {
    projection[metadataType] = modules.map(({ fileName, label }) => ({ fileName, label }));
  }
  return projection;
}, {} as Partial<Record<MetadataType, StandardModule[]>>);
/* eslint-enable @typescript-eslint/naming-convention */
