import type { ObjectTypeDefinition } from '../types/objectTypeDefinitions';

export class ObjectTypeSerializer {
  /**
   * Serializes ObjectTypeDefinition to an XML <Source> fragment.
   * Round-trip invariant: parse(serialize(x)) produces an equivalent object.
   *
   * Manager-kinds (objectName === '') serialize without a dot: cfg:CatalogManager
   * All other kinds serialize with a dot: cfg:CatalogObject.Name
   */
  static serialize(def: ObjectTypeDefinition): string {
    if (!def.types || def.types.length === 0) {
      return '<Source/>';
    }

    const indent = '  ';
    const lines = def.types.map(({ objectKind, objectName }) => {
      const typeValue =
        objectName === ''
          ? `cfg:${objectKind}`
          : `cfg:${objectKind}.${objectName}`;
      return `${indent}<v8:Type>${typeValue}</v8:Type>`;
    });

    return `<Source>\n${lines.join('\n')}\n</Source>`;
  }
}
