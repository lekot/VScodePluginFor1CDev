import type { ObjectTypeDefinition } from '../types/objectTypeDefinitions';

export class ObjectTypeSerializer {
  /**
   * Serializes ObjectTypeDefinition to an XML <Source> fragment.
   * Round-trip invariant: parse(serialize(x)) produces an equivalent object.
   */
  static serialize(def: ObjectTypeDefinition): string {
    if (!def.types || def.types.length === 0) {
      return '<Source/>';
    }

    const indent = '  ';
    const lines = def.types.map(
      ({ objectKind, objectName }) => `${indent}<v8:Type>cfg:${objectKind}.${objectName}</v8:Type>`
    );

    return `<Source>\n${lines.join('\n')}\n</Source>`;
  }
}
