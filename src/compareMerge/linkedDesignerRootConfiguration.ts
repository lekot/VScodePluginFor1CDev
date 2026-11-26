import * as path from 'path';

import { namespaceUriForName } from './adapters/semanticXml/semanticXmlIdentity';
import { captureMergePath } from './merge/mergeSnapshot';
import type { LinkedDesignerPackageRecipe, LinkedDesignerRootConfigurationSnapshot } from './linkedDesignerTypes';
import { parseXmlDocument, elementChildren, textContent } from './xml/xmlDom';

// This is the Designer XML namespace identifier, not a network endpoint.
const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';

type RootConfigurationFileState = 'file' | 'missing' | 'unavailable';

export interface RootConfigurationCapture {
  readonly targetState: RootConfigurationFileState;
  readonly sourceState: RootConfigurationFileState;
  readonly snapshot?: LinkedDesignerRootConfigurationSnapshot;
}

export async function captureRootConfigurationSnapshot(
  leftRootPath: string,
  rightRootPath: string,
): Promise<RootConfigurationCapture> {
  const [target, source] = await Promise.all([
    captureMergePath(path.join(leftRootPath, 'Configuration.xml'), { retainContent: true }),
    captureMergePath(path.join(rightRootPath, 'Configuration.xml'), { retainContent: true }),
  ]);
  const targetState = rootConfigurationFileState(target.state);
  const sourceState = rootConfigurationFileState(source.state);
  if (target.state !== 'file' || source.state !== 'file' || !target.contentBase64 || !source.contentBase64) {
    return { targetState, sourceState };
  }
  const targetContent = Buffer.from(target.contentBase64, 'base64');
  const sourceContent = Buffer.from(source.contentBase64, 'base64');
  const targetRegistrations = readRootRegistrations(targetContent);
  const sourceRegistrations = readRootRegistrations(sourceContent);
  return {
    targetState,
    sourceState,
    snapshot: {
      targetHash: target.hash,
      targetContent,
      sourceHash: source.hash,
      sourceContent,
      targetHasRegistrations: targetRegistrations.registrations,
      sourceHasRegistrations: sourceRegistrations.registrations,
      targetValid: targetRegistrations.valid,
      sourceValid: sourceRegistrations.valid,
    },
  };
}

export async function captureLinkedRootConfiguration(
  leftRootPath: string,
  rightRootPath: string,
): Promise<RootConfigurationCapture> {
  return captureRootConfigurationSnapshot(leftRootPath, rightRootPath);
}

function rootConfigurationFileState(state: 'file' | 'directory' | 'missing'): RootConfigurationFileState {
  return state === 'file' ? 'file' : state === 'missing' ? 'missing' : 'unavailable';
}

function readRootRegistrations(content: Buffer): { valid: boolean; registrations: Set<string> } {
  try {
    const root = parseXmlDocument(content.toString('utf8')).root;
    const childContainer = rootChildObjectsContainer(root);
    return childContainer.valid
      ? { valid: true, registrations: collectRootRegistrations(childContainer.element) }
      : invalidRootRegistrations();
  } catch {
    return invalidRootRegistrations();
  }
}

type XmlElement = ReturnType<typeof elementChildren>[number];

interface RootChildObjectsContainer {
  readonly valid: boolean;
  readonly element?: XmlElement;
}

function rootChildObjectsContainer(root: XmlElement): RootChildObjectsContainer {
  if (root.localName !== 'MetaDataObject' || namespaceUriForName(root) !== MDCLASSES_NAMESPACE) {return { valid: false };}
  const owners = elementChildren(root);
  if (owners.length !== 1 || owners[0]!.localName !== 'Configuration' || namespaceUriForName(owners[0]!) !== MDCLASSES_NAMESPACE) {return { valid: false };}
  const childContainers = elementChildren(owners[0]!).filter((element) => element.localName === 'ChildObjects' && namespaceUriForName(element) === MDCLASSES_NAMESPACE);
  if (childContainers.length > 1) {return { valid: false };}
  return { valid: true, ...(childContainers[0] ? { element: childContainers[0] } : {}) };
}

function collectRootRegistrations(childContainer: XmlElement | undefined): Set<string> {
  const result = new Set<string>();
  for (const parent of childContainer ? elementChildren(childContainer) : []) {
    if (namespaceUriForName(parent) !== MDCLASSES_NAMESPACE) {continue;}
    collectParentRegistrations(parent, result);
  }
  return result;
}

function collectParentRegistrations(parent: XmlElement, result: Set<string>): void {
  for (const item of elementChildren(parent)) {
    if (namespaceUriForName(item) !== MDCLASSES_NAMESPACE) {continue;}
    const value = textContent(item).trim();
    if (value) {result.add(`${parent.localName}\0${value}`);}
  }
  if (elementChildren(parent).length === 0) {
    const value = textContent(parent).trim();
    if (value) {result.add(`${parent.localName}\0${value}`);}
  }
}

function invalidRootRegistrations(): { valid: false; registrations: Set<string> } {
  return { valid: false, registrations: new Set() };
}

export function rootRegistrationIsAvailable(
  recipe: Pick<LinkedDesignerPackageRecipe, 'action' | 'rootRegistration'>,
  snapshot: LinkedDesignerRootConfigurationSnapshot | undefined,
): boolean {
  if (!snapshot || !snapshot.sourceValid || !snapshot.targetValid || !recipe.rootRegistration) {return false;}
  const key = `${recipe.rootRegistration.rootTag}\0${recipe.rootRegistration.objectName}`;
  return recipe.action === 'copy'
    ? snapshot.sourceHasRegistrations.has(key) && !snapshot.targetHasRegistrations.has(key)
    : snapshot.targetHasRegistrations.has(key) && !snapshot.sourceHasRegistrations.has(key);
}
