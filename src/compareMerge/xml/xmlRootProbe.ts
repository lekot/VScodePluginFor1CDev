/** Reads an XML root expanded name from a bounded prefix without building a DOM. */
export function probeXmlRootExpandedName(source: string): string | undefined {
  let cursor = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (cursor < source.length) {
    while (/\s/u.test(source[cursor] ?? '')) {cursor += 1;}
    if (source.startsWith('<!--', cursor)) {
      const end = source.indexOf('-->', cursor + 4);
      if (end < 0) {return undefined;}
      cursor = end + 3;
      continue;
    }
    if (source.startsWith('<?', cursor)) {
      const end = source.indexOf('?>', cursor + 2);
      if (end < 0) {return undefined;}
      cursor = end + 2;
      continue;
    }
    if (/^<!DOCTYPE\b/iu.test(source.slice(cursor))) {
      const end = findDoctypeEnd(source, cursor + 9);
      if (end < 0) {return undefined;}
      cursor = end + 1;
      continue;
    }
    break;
  }

  if (source[cursor] !== '<' || source[cursor + 1] === '/' || source[cursor + 1] === '!' || source[cursor + 1] === '?') {
    return undefined;
  }
  const end = findStartTagEnd(source, cursor + 1);
  if (end < 0) {return undefined;}
  const startTag = source.slice(cursor + 1, end);
  const nameMatch = /^([^\s/>]+)/u.exec(startTag);
  if (!nameMatch) {return undefined;}
  const qualifiedName = nameMatch[1]!;
  const nameParts = qualifiedName.split(':');
  if (nameParts.length > 2 || nameParts.some((part) => !/^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(part))) {return undefined;}
  const attributes = parseStartTagAttributes(startTag.slice(nameMatch[0].length));
  if (!attributes) {return undefined;}
  const [prefix, localName] = nameParts.length === 2 ? nameParts : ['', nameParts[0]!];
  const namespace = prefix ? attributes.get(`xmlns:${prefix}`) : attributes.get('xmlns');
  if (prefix && namespace === undefined) {return undefined;}
  return `{${namespace ?? ''}}${localName}`;
}

function findStartTagEnd(source: string, start: number): number {
  let quote = '';
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (character === quote) {quote = '';}
      continue;
    }
    if (character === '"' || character === "'") {quote = character; continue;}
    if (character === '>') {return index;}
  }
  return -1;
}

function findDoctypeEnd(source: string, start: number): number {
  let quote = '';
  let subsetDepth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (character === quote) {quote = '';}
      continue;
    }
    if (character === '"' || character === "'") {quote = character; continue;}
    if (character === '[') {subsetDepth += 1; continue;}
    if (character === ']' && subsetDepth > 0) {subsetDepth -= 1; continue;}
    if (character === '>' && subsetDepth === 0) {return index;}
  }
  return -1;
}

function parseStartTagAttributes(value: string): Map<string, string> | undefined {
  const attributes = new Map<string, string>();
  let cursor = 0;
  while (cursor < value.length) {
    while (/\s|\//u.test(value[cursor] ?? '')) {cursor += 1;}
    if (cursor >= value.length) {break;}
    const nameMatch = /^[^\s=/>]+/u.exec(value.slice(cursor));
    if (!nameMatch) {return undefined;}
    const name = nameMatch[0];
    cursor += name.length;
    while (/\s/u.test(value[cursor] ?? '')) {cursor += 1;}
    if (value[cursor] !== '=') {return undefined;}
    cursor += 1;
    while (/\s/u.test(value[cursor] ?? '')) {cursor += 1;}
    const quote = value[cursor];
    if (quote !== '"' && quote !== "'") {return undefined;}
    const end = value.indexOf(quote, cursor + 1);
    if (end < 0 || attributes.has(name)) {return undefined;}
    attributes.set(name, value.slice(cursor + 1, end));
    cursor = end + 1;
  }
  return attributes;
}
