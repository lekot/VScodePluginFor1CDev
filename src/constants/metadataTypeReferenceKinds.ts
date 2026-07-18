import { MetadataType } from '../models/treeNode';
import { METADATA_TYPE_DESCRIPTORS } from './metadataTypeDescriptors';

/**
 * Mapping of MetadataType to reference kind strings used in XML.
 * Examples: CatalogRef, DocumentRef, EnumRef, etc.
 */
const referenceKinds = Object.fromEntries(
  Object.values(MetadataType).map((type) => [type, undefined])
) as Record<MetadataType, string | undefined>;

for (const descriptor of METADATA_TYPE_DESCRIPTORS) {
  referenceKinds[descriptor.type] = descriptor.referenceKind;
}

export const METADATA_TYPE_TO_REFERENCE_KIND: Readonly<Record<MetadataType, string | undefined>> =
  Object.freeze(referenceKinds);
