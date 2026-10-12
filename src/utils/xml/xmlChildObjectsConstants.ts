import { DESIGNER_ROOT_OBJECT_TYPES, METADATA_TYPE_DESCRIPTORS } from '../../constants/metadataTypeDescriptors';
import type { MetadataObjectPathSegment } from '../../types/metadataObjectPath';

/**
 * Structural root set derived from the canonical metadata descriptor registry.
 */
export const TOP_LEVEL_TYPES = DESIGNER_ROOT_OBJECT_TYPES;

/**
 * Root tags that omit ChildObjects, projected from the canonical metadata registry.
 * Form is a nested metadata object and is therefore the one explicit non-root exception.
 */
export const ROOT_TAGS_WITHOUT_CHILDOBJECTS: ReadonlySet<string> = new Set([
  ...METADATA_TYPE_DESCRIPTORS
    .filter((descriptor) => !descriptor.structure.hasChildObjects)
    .map((descriptor) => descriptor.designerRootTag),
  /** Embedded object form: ibcmd expects no empty ChildObjects section (docs/1c-config-objects-spec.md §6.3). */
  'Form',
]);

/**
 * Options for {@link writeNestedElementProperties} (XMLWriter facade).
 * When `scopedTabularSectionName` is set with `elementType === 'Attribute'`, name-based updates apply only
 * to columns under that tabular section (not top-level attributes or other sections).
 */
export type WriteNestedElementOptions = {
  scopedTabularSectionName?: string;
  /** Exact root-to-leaf selector used for collision-safe nested property access. */
  nestedPath?: readonly MetadataObjectPathSegment[];
};

/** Internal: Attribute nested write scoped to one tabular section by `<Name>`. */
export type NestedAttributeScopeState = {
  scopedTabularSectionName: string;
  insideMatchingTabularSection: boolean;
};
