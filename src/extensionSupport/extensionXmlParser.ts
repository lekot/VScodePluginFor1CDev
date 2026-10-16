import { ExtensionNodeProperties } from './extensionTypes';

/**
 * Extract extension-specific properties from a parsed Configuration.xml of an extension.
 *
 * Expected XML structure:
 * <MetaDataObject>
 *   <Configuration ...>
 *     <Properties>
 *       <ConfigurationExtensionPurpose>Customization</ConfigurationExtensionPurpose>
 *       <NamePrefix>Расш1_</NamePrefix>
 *       ...
 *     </Properties>
 *   </Configuration>
 * </MetaDataObject>
 */
/**
 * Navigates into root MetaDataObject (if present) and returns the first element's Properties holder
 * or the element itself (for EDT format).
 */
function findFirstPropertiesHolder(parsedXml: Record<string, unknown>): Record<string, unknown> | undefined {
  const root = (parsedXml.MetaDataObject && typeof parsedXml.MetaDataObject === 'object'
    ? parsedXml.MetaDataObject
    : parsedXml) as Record<string, unknown>;

  for (const [key, value] of Object.entries(root)) {
    if (key === '@_' || key.startsWith('#') || typeof value !== 'object' || value === null) {
      continue;
    }
    const element = value as Record<string, unknown>;
    return (element.Properties as Record<string, unknown> | undefined) ?? element;
  }
  return undefined;
}

export function extractExtensionProperties(parsedXml: Record<string, unknown>): ExtensionNodeProperties {
  const result: ExtensionNodeProperties = {};
  const properties = findFirstPropertiesHolder(parsedXml);
  if (!properties) {
    return result;
  }

  const purpose = properties.ConfigurationExtensionPurpose ?? properties.configurationExtensionPurpose ?? properties.extensionPurpose;
  if (typeof purpose === 'string' && (purpose === 'Patch' || purpose === 'Customization' || purpose === 'AddOn')) {
    result.extensionPurpose = purpose;
  }

  const prefix = properties.NamePrefix ?? properties.namePrefix;
  if (typeof prefix === 'string' && prefix.length > 0) {
    result.namePrefix = prefix;
  }

  return result;
}

/**
 * Applies extension-specific properties (extensionPurpose, namePrefix) from parsed XML
 * onto the target properties dictionary if defined.
 */
export function applyExtensionProperties(
  target: { extensionPurpose?: string; namePrefix?: string },
  parsedXml: Record<string, unknown>
): void {
  const extProps = extractExtensionProperties(parsedXml);
  if (extProps.extensionPurpose !== undefined) {
    target.extensionPurpose = extProps.extensionPurpose;
  }
  if (extProps.namePrefix !== undefined) {
    target.namePrefix = extProps.namePrefix;
  }
}

/**
 * Extract ObjectBelonging and ExtendedConfigurationObject from a parsed object XML
 * (e.g. Catalogs/Валюты.xml).
 *
 * Expected XML structure:
 * <MetaDataObject>
 *   <Catalog ...>
 *     <Properties>
 *       <ObjectBelonging>Adopted</ObjectBelonging>
 *       <ExtendedConfigurationObject>7aadbb67-...</ExtendedConfigurationObject>
 *     </Properties>
 *   </Catalog>
 * </MetaDataObject>
 */
export function extractObjectBelonging(
  parsedXml: Record<string, unknown>
): Pick<ExtensionNodeProperties, 'objectBelonging' | 'extendedConfigurationObject'> {
  const result: Pick<ExtensionNodeProperties, 'objectBelonging' | 'extendedConfigurationObject'> = {};
  const properties = findFirstPropertiesHolder(parsedXml);
  if (!properties) {
    return result;
  }

  const belonging = properties.ObjectBelonging ?? properties.objectBelonging;
  if (belonging === 'Adopted') {
    result.objectBelonging = 'Adopted';
  }

  const extendedObj = properties.ExtendedConfigurationObject ?? properties.extendedConfigurationObject;
  if (typeof extendedObj === 'string' && extendedObj.length > 0) {
    result.extendedConfigurationObject = extendedObj;
  }

  return result;
}
