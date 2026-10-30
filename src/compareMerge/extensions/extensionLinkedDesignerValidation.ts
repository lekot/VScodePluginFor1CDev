import type { CompareMessage } from '../domain/compareContracts';
import type { ExtensionMetadataIndex } from './extensionMetadataIndex';
import type { ExtensionLinkedDesignerPackage } from './extensionLinkedDesignerPackages';
import type { ExtensionTransferRow } from './extensionTransfer';
import { LINKED_FORM_REFERENCE_PROPERTIES } from '../linkedDesignerUtils';
import { elementChildren, parseXmlDocument, textContent, type XmlElement } from '../xml/xmlDom';
import { namespaceUriForName } from '../adapters/semanticXml/semanticXmlIdentity';

const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';

export interface ExtensionLinkedOutputSnapshot {
  readonly row: ExtensionTransferRow;
  readonly writes: readonly { readonly relativePath: string; readonly content: Buffer }[];
}

export function validateDeletedExtensionFormReferences(input: {
  readonly target: ExtensionMetadataIndex;
  readonly rows: readonly ExtensionTransferRow[];
  readonly packages: ReadonlyMap<string, ExtensionLinkedDesignerPackage>;
  readonly outputs: readonly ExtensionLinkedOutputSnapshot[];
  readonly selectedSemantic: ReadonlyMap<string, readonly import('./extensionTransfer').ExtensionSemanticSelection[]>;
}): CompareMessage[] {
  const diagnostics: CompareMessage[] = [];
  const selectedPackageIds = new Set([...input.selectedSemantic.values()].flat()
    .map((selection) => selection.linkedPackageId).filter((id): id is string => Boolean(id)));
  for (const packageId of selectedPackageIds) {
    const recipe = input.packages.get(packageId);
    if (!recipe || recipe.kind !== 'Form' || recipe.action !== 'delete') {continue;}
    const deletedName = canonical(recipe.qualifiedName);
    for (const targetOwner of input.target.objects) {
      if (!targetOwner.descriptorContent || !targetOwner.descriptorRelativePath) {
        diagnostics.push(blocked(`Нельзя проверить ссылки на удаляемую форму: descriptor владельца ${targetOwner.qualifiedName} не захвачен.`, input.target.sourceId, recipe.rowId));
        continue;
      }
      const descriptorRelativePath = targetOwner.descriptorRelativePath;
      const ownerRow = input.rows.find((candidate) => candidate.target?.descriptorRelativePath
        && samePath(candidate.target.descriptorRelativePath, descriptorRelativePath));
      const output = ownerRow && input.outputs.find((candidate) => candidate.row.id === ownerRow.id);
      const finalDescriptor = output?.writes.find((write) => samePath(write.relativePath, descriptorRelativePath))?.content;
      const ownerXml = tryParse(finalDescriptor?.toString('utf8') ?? targetOwner.descriptorContent.toString('utf8'));
      if (!ownerXml) {
        diagnostics.push(blocked(`Нельзя проверить ссылки на удаляемую форму: descriptor владельца ${targetOwner.qualifiedName} не разбирается.`, input.target.sourceId, recipe.rowId));
        continue;
      }
      const references = defaultFormReferences(ownerXml, targetOwner);
      if (!references.ok) {
        diagnostics.push(blocked(`Нельзя подтвердить namespace и identity descriptor владельца ${targetOwner.qualifiedName} при проверке удаляемой формы.`, input.target.sourceId, recipe.rowId));
        continue;
      }
      for (const reference of references.values) {
        if (!reference.value) {continue;}
        const resolved = resolveFormReference(reference.value, targetOwner, input.target.objects);
        if (resolved.some((qualified) => canonical(qualified) === deletedName)) {
          diagnostics.push(blocked(`${reference.propertyName} ${reference.value} всё ещё ссылается на удаляемую Form ${recipe.name}; выберите явную очистку ссылки.`, input.target.sourceId, recipe.rowId));
        }
      }
    }
  }
  return diagnostics;
}

function defaultFormReferences(root: XmlElement, expectedOwner: ExtensionMetadataIndex['objects'][number]):
  | { ok: true; values: Array<{ propertyName: string; value: string }> }
  | { ok: false } {
  const owners = elementChildren(root);
  const ownerType = expectedOwner.descriptorRootTag ?? expectedOwner.metadataType;
  const owner = root.localName === 'MetaDataObject' && namespaceUriForName(root) === MDCLASSES_NAMESPACE
    && owners.length === 1 && owners[0]!.localName === ownerType
    && namespaceUriForName(owners[0]!) === MDCLASSES_NAMESPACE ? owners[0] : undefined;
  if (!owner) {return { ok: false };}
  const properties = owner && directChild(owner, 'Properties');
  if (!properties) {return { ok: false };}
  const names = elementChildren(properties).filter((item) => item.localName === 'Name');
  const name = names.length === 1 && namespaceUriForName(names[0]!) === MDCLASSES_NAMESPACE ? textContent(names[0]!).trim() : undefined;
  if (name !== expectedOwner.name) {return { ok: false };}
  const uuid = owner.attributes.find((item) => item.name === 'uuid')?.value;
  if (!expectedOwner.identity?.uuid || uuid?.toLocaleLowerCase('en-US') !== expectedOwner.identity.uuid.toLocaleLowerCase('en-US')) {return { ok: false };}
  return {
    ok: true,
    values: elementChildren(properties).filter((item) => LINKED_FORM_REFERENCE_PROPERTIES.includes(item.localName as typeof LINKED_FORM_REFERENCE_PROPERTIES[number])
      && namespaceUriForName(item) === MDCLASSES_NAMESPACE)
      .map((item) => ({ propertyName: item.localName, value: textContent(item).trim() })),
  };
}

function resolveFormReference(
  value: string,
  owner: ExtensionMetadataIndex['objects'][number],
  objects: readonly ExtensionMetadataIndex['objects'][number][],
): string[] {
  const normalizedValue = value.normalize('NFC');
  const forms = objects.filter((object) => object.metadataType === 'Form' || object.metadataType === 'CommonForm');
  if (normalizedValue.includes('.')) {
    return forms.filter((object) => canonical(object.qualifiedName) === canonical(normalizedValue)).map((object) => object.qualifiedName);
  }
  const candidates = new Set<string>();
  const nested = `${owner.qualifiedName}.Form.${normalizedValue}`;
  const common = `CommonForm.${normalizedValue}`;
  for (const form of forms) {
    if (canonical(form.qualifiedName) === canonical(nested) || canonical(form.qualifiedName) === canonical(common)) {
      candidates.add(form.qualifiedName);
    }
  }
  return [...candidates];
}

function directChild(root: XmlElement, name: string): XmlElement | undefined {
  const rootNamespace = namespaceUriForName(root);
  const matches = elementChildren(root).filter((item) => item.localName === name && namespaceUriForName(item) === rootNamespace);
  return matches.length === 1 ? matches[0] : undefined;
}

function tryParse(value: string): XmlElement | undefined {
  try {return parseXmlDocument(value).root;} catch {return undefined;}
}

function canonical(value: string): string {return value.normalize('NFC').toLocaleLowerCase('en-US');}
function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const normalized = value.replace(/\\/gu, '/').normalize('NFC');
    return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
  };
  return normalize(left) === normalize(right);
}

function blocked(message: string, sourceId: string, nodeId?: string): CompareMessage {
  return { severity: 'error', code: 'EXTENSION_TRANSFER_BLOCKED', phase: 'compare', sourceId, nodeId, blocking: true, suggestedAction: message };
}
