import {
  type CfeFormXmlElement,
  directChildren,
  findElementsByLocalName,
  textContent,
} from './formXml';

export type CfeFormDependencyKind =
  | 'CommonPicture'
  | 'StyleItem'
  | 'EnumValue'
  | 'Catalog'
  | 'Document'
  | 'Enum';

export interface CfeFormDependency {
  readonly kind: CfeFormDependencyKind;
  readonly name: string;
  readonly valueName?: string;
}

/** A metadata reference whose ownership closure is not part of the supported matrix. */
export interface CfeUnsupportedFormDependency {
  readonly value: string;
}

/**
 * Extracts only dependency kinds whose CFE closure has an explicit rule. Unknown
 * cfg/xr references are deliberately not guessed: the service fails closed when
 * it cannot prove a referenced source object is already represented in the CFE.
 */
export function collectCfeFormDependencies(root: CfeFormXmlElement): readonly CfeFormDependency[] {
  const dependencies = new Map<string, CfeFormDependency>();
  const record = (dependency: CfeFormDependency): void => {
    const key = `${dependency.kind}:${dependency.name}:${dependency.valueName ?? ''}`;
    dependencies.set(key, dependency);
  };

  for (const reference of findElementsByLocalName(root, 'Ref')) {
    const match = /^CommonPicture\.([^\s.]+)$/u.exec(textContent(reference));
    if (match) {
      record({ kind: 'CommonPicture', name: match[1]! });
    }
  }
  visit(root, (element) => {
    const styleRef = element.attributes.ref;
    if (element.attributes.kind === 'StyleItem' && styleRef) {
      const match = /^style:([^\s.]+)$/u.exec(styleRef);
      if (match) {
        record({ kind: 'StyleItem', name: match[1]! });
      }
    }
    const scalar = textContent(element);
    const styleText = /^style:([^\s.]+)$/u.exec(scalar);
    if (styleText && /(?:Font|BackColor)$/u.test(localName(element.name))) {
      record({ kind: 'StyleItem', name: styleText[1]! });
    }
    const enumValue = /^Enum\.([^\s.]+)\.EnumValue\.([^\s.]+)$/u.exec(scalar);
    if (enumValue) {
      record({ kind: 'EnumValue', name: enumValue[1]!, valueName: enumValue[2]! });
    }
    for (const typeReference of scalar.matchAll(/cfg:(Catalog|Document|Enum)Ref\.([\p{L}_][\p{L}\p{N}_]*)/gu)) {
      record({ kind: typeReference[1]! as 'Catalog' | 'Document' | 'Enum', name: typeReference[2]! });
    }
  });
  return [...dependencies.values()];
}

/**
 * Detects metadata references that cannot be proved safe by the current CFE
 * dependency matrix. Callers must reject these before any extension mutation.
 */
export function collectUnsupportedCfeFormDependencies(root: CfeFormXmlElement): readonly CfeUnsupportedFormDependency[] {
  const unsupported = new Map<string, CfeUnsupportedFormDependency>();
  const record = (value: string): void => { unsupported.set(value, { value }); };
  visit(root, (element) => {
    const values = [textContent(element), element.attributes.ref, element.attributes.type]
      .filter((value): value is string => typeof value === 'string');
    for (const value of values) {
      for (const match of value.matchAll(/cfg:([\p{L}_][\p{L}\p{N}_]*)Ref\.([\p{L}_][\p{L}\p{N}_]*)/gu)) {
        const kind = match[1]!;
        if (kind !== 'Catalog' && kind !== 'Document' && kind !== 'Enum') {
          record(match[0]!);
        }
      }
      if (localName(element.name) === 'MDObjectRef') {
        const rootType = /^([\p{L}_][\p{L}\p{N}_]*)\.[\p{L}_][\p{L}\p{N}_]*$/u.exec(value)?.[1];
        if (rootType && !['Catalog', 'Document', 'Enum', 'CommonPicture', 'StyleItem'].includes(rootType)) {
          record(value);
        }
      }
    }
  });
  return [...unsupported.values()];
}

export function collectSourceFormCommandNames(root: CfeFormXmlElement): ReadonlySet<string> {
  const commands = new Set<string>();
  for (const section of directChildren(root, 'Commands')) {
    for (const command of directChildren(section, 'Command')) {
      const name = command.attributes.name;
      if (name) {
        commands.add(name);
      }
    }
  }
  return commands;
}

export function collectSourceFormElementNames(root: CfeFormXmlElement): ReadonlySet<string> {
  const names = new Set<string>();
  for (const element of findElementsByLocalName(root, 'ChildItems')) {
    for (const child of directChildren(element)) {
      collectNames(child, names);
    }
  }
  return names;
}

function collectNames(element: CfeFormXmlElement, names: Set<string>): void {
  if (element.attributes.name) {
    names.add(element.attributes.name);
  }
  for (const child of directChildren(element)) {
    collectNames(child, names);
  }
}

function visit(element: CfeFormXmlElement, callback: (candidate: CfeFormXmlElement) => void): void {
  callback(element);
  for (const child of directChildren(element)) {
    visit(child, callback);
  }
}

function localName(name: string): string {
  const separator = name.lastIndexOf(':');
  return separator === -1 ? name : name.slice(separator + 1);
}
