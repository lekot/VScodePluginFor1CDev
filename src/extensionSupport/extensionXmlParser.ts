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
export function extractExtensionProperties(parsedXml: Record<string, unknown>): ExtensionNodeProperties {
  const result: ExtensionNodeProperties = {};

  const root = (parsedXml.MetaDataObject && typeof parsedXml.MetaDataObject === 'object'
    ? parsedXml.MetaDataObject
    : parsedXml) as Record<string, unknown>;

  // Navigate: root key -> Configuration -> Properties
  for (const [key, value] of Object.entries(root)) {
    if (key === '@_' || key.startsWith('#')) {
      continue;
    }
    if (typeof value !== 'object' || value === null) {
      continue;
    }
    const element = value as Record<string, unknown>;
    const properties = (element.Properties as Record<string, unknown> | undefined) ?? element;

    const purpose = properties.ConfigurationExtensionPurpose ?? properties.configurationExtensionPurpose ?? properties.extensionPurpose;
    if (typeof purpose === 'string' && (purpose === 'Patch' || purpose === 'Customization' || purpose === 'AddOn')) {
      result.extensionPurpose = purpose;
    }

    const prefix = properties.NamePrefix ?? properties.namePrefix;
    if (typeof prefix === 'string' && prefix.length > 0) {
      result.namePrefix = prefix;
    }

    // Found the first relevant element — stop
    break;
  }

  return result;
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

  const root = (parsedXml.MetaDataObject && typeof parsedXml.MetaDataObject === 'object'
    ? parsedXml.MetaDataObject
    : parsedXml) as Record<string, unknown>;

  for (const [key, value] of Object.entries(root)) {
    if (key === '@_' || key.startsWith('#')) {
      continue;
    }
    if (typeof value !== 'object' || value === null) {
      continue;
    }
    const element = value as Record<string, unknown>;
    const properties = (element.Properties as Record<string, unknown> | undefined) ?? element;

    const belonging = properties.ObjectBelonging ?? properties.objectBelonging;
    if (belonging === 'Adopted') {
      result.objectBelonging = 'Adopted';
    }

    const extendedObj = properties.ExtendedConfigurationObject ?? properties.extendedConfigurationObject;
    if (typeof extendedObj === 'string' && extendedObj.length > 0) {
      result.extendedConfigurationObject = extendedObj;
    }

    break;
  }

  return result;
}
