import { DESIGNER_ROOT_OBJECT_TYPES } from '../../constants/metadataTypeDescriptors';
import type { MetadataObjectPathSegment } from '../../types/metadataObjectPath';

/**
 * Structural root set derived from the canonical metadata descriptor registry.
 */
export const TOP_LEVEL_TYPES = DESIGNER_ROOT_OBJECT_TYPES;

/**
 * Root metadata tags that omit ChildObjects in Designer XML (docs/1c-config-objects-spec.md).
 * Не подставлять искусственно ChildObjects при добавлении вложенных элементов — иначе ibcmd / конфигуратор отвергнут файл.
 */
export const ROOT_TAGS_WITHOUT_CHILDOBJECTS = new Set<string>([
  'CommonModule',
  'Role',
  'SessionParameter',
  'FunctionalOption',
  'FunctionalOptionsParameter',
  'CommandGroup',
  'Interface',
  // Стиль оформления: в ibcmd при пустом ChildObjects — «ожидаемое Style»; в выгрузке нет контейнера ChildObjects.
  'Style',
  'EventSubscription',
  'DefinedType',
  'Language',
  'CommonPicture',
  'CommonAttribute',
  'CommonForm',
  /** Встроенная форма объекта: в ibcmd ожидается последовательность без пустого ChildObjects (см. docs/1c-config-objects-spec.md §6.3). */
  'Form',
  'WSReference',
  'StyleItem',
  'XDTOPackage',
  // Только Properties, без ChildObjects (spec; иначе ibcmd config import падает).
  'DocumentNumerator',
  'ScheduledJob',
  'Constant',
  // Подсистема содержит только состав (Content) и вложенные Subsystem — реквизитов нет.
  'Subsystem',
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
