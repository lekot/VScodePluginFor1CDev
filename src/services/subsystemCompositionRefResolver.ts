/**
 * Map subsystem `Content` reference (`Catalog.Items`, …) to Designer tree node id (`Catalogs.Items`).
 */
import { validateSubsystemCompositionRef } from '../parsers/xmlChildObjects';
import { MetadataType } from '../models/treeNode';
import { MetadataTypeMapper } from '../utils/metadataTypeMapper';

/**
 * Returns expected metadata tree node id for a composition ref, or `null` if syntax/type is not supported.
 */
export function expectedTreeNodeIdForCompositionRef(ref: string): string | null {
  if (validateSubsystemCompositionRef(ref) !== null) {
    return null;
  }
  const dot = ref.indexOf('.');
  const typePart = ref.slice(0, dot);
  const namePart = ref.slice(dot + 1);
  const metaType = typePart as MetadataType;
  const folderId = MetadataTypeMapper.getDesignerFolderIdForMetadataType(metaType);
  if (!folderId) {
    return null;
  }
  return `${folderId}.${namePart}`;
}
