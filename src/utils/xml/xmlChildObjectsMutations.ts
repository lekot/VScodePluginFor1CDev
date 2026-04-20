/**
 * Pure structural mutations for nested Designer XML elements:
 * add / remove Attribute and TabularSection inside ChildObjects.
 */
import { generateSimpleUuid } from './xmlHelpers';
import { getDefaultPropertiesForNestedElement } from '../../constants/metadataDefaultValues';
import { MetadataType } from '../../models/treeNode';
import { buildTabularSectionInternalInfoObject } from './internalInfoGenerator';
import { TOP_LEVEL_TYPES, ROOT_TAGS_WITHOUT_CHILDOBJECTS } from './xmlChildObjectsConstants';
import {
  buildDesignerEnumValueBlock,
  buildDesignerDimensionBlock,
  buildDesignerResourceBlock,
} from './childObjectsMutator';

// ---------------------------------------------------------------------------
// Name extraction helpers
// ---------------------------------------------------------------------------

export function extractNameFromElementArray(elementArray: unknown[]): string {
  for (const it of elementArray) {
    if (!it || typeof it !== 'object') {continue;}
    const o = it as Record<string, unknown>;
    if ('Name' in o && Array.isArray(o.Name) && o.Name.length > 0) {
      const first = o.Name[0];
      if (first && typeof first === 'object' && '#text' in (first as object)) {
        return String((first as Record<string, unknown>)['#text']);
      }
    }
    if ('Properties' in o && Array.isArray(o.Properties)) {
      const inner = extractNameFromElementArray(o.Properties as unknown[]);
      if (inner) {return inner;}
    }
  }
  return '';
}

export function extractNameFromNestedElement(element: unknown): string {
  if (!element || typeof element !== 'object') {
    return '';
  }
  const elementObj = element as Record<string, unknown>;
  const props = elementObj.Properties;
  if (!props) {
    return '';
  }
  if (Array.isArray(props)) {
    return extractNameFromElementArray(props);
  }
  if (typeof props === 'object' && props !== null) {
    const propsObj = props as Record<string, unknown>;
    const rawName = propsObj.Name;
    if (typeof rawName === 'string') {
      return rawName;
    }
    if (Array.isArray(rawName) && rawName.length > 0) {
      const first = rawName[0];
      if (first && typeof first === 'object' && '#text' in (first as object)) {
        return String((first as Record<string, unknown>)['#text']);
      }
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Element builder
// ---------------------------------------------------------------------------

export function buildMinimalNestedElement(
  elementType: string,
  elementName: string,
  minimalProperties: Record<string, unknown>,
  parentRootType?: MetadataType,
  parentObjectName?: string
): Record<string, unknown> {
  const cleanProps = { ...minimalProperties };
  const primaryDimension =
    cleanProps['__isPrimaryDimension'] === false || cleanProps['__isPrimaryChildObject'] === false
      ? false
      : true;
  delete cleanProps['__isPrimaryDimension'];
  delete cleanProps['__isPrimaryChildObject'];

  if (elementType === 'EnumValue') {
    return buildDesignerEnumValueBlock(elementName);
  }
  if (elementType === 'Dimension') {
    return buildDesignerDimensionBlock(elementName, parentRootType, primaryDimension);
  }
  if (elementType === 'Resource') {
    return buildDesignerResourceBlock(elementName, parentRootType, parentObjectName);
  }

  const uuid = generateSimpleUuid();
  const defaults =
    elementType === 'Attribute' || elementType === 'TabularSection'
      ? getDefaultPropertiesForNestedElement(
          elementType as 'Attribute' | 'TabularSection',
          parentRootType
        )
      : {};
  const merged = { ...defaults, ...cleanProps, Name: elementName };

  // Build the Properties object (representation of the Properties element)
  const propertiesObject: Record<string, unknown> = {};

  // Add Name property
  propertiesObject.Name = [{ '#text': elementName }];

  // Add Synonym property
  propertiesObject.Synonym = [
    {
      'v8:item': [
        {
          'v8:lang': [{ '#text': 'ru' }],
          'v8:content': [{ '#text': elementName }],
        },
      ],
    },
  ];

  // Add Type property if elementType is Attribute
  if (elementType === 'Attribute') {
    propertiesObject.Type = [
      {
        'v8:Type': [{ '#text': 'xs:string' }],
        'v8:StringQualifiers': [
          {
            'v8:Length': [{ '#text': '50' }],
            'v8:AllowedLength': [{ '#text': 'Variable' }],
          },
        ],
      },
    ];
  }

  // Add other properties
  for (const [key, value] of Object.entries(merged)) {
    if (key === 'Name' || key === 'Synonym' || key === 'Type') {continue;}
    // Handle special case for ToolTip object
    if (key === 'ToolTip' && typeof value === 'object' && value !== null) {
      // Build ToolTip with empty content if not provided
      const tooltipContent =
        typeof value === 'object' && value !== null && '#text' in value
          ? String((value as Record<string, unknown>)['#text'])
          : '';
      propertiesObject[key] = [
        {
          'v8:item': [
            {
              'v8:lang': [{ '#text': 'ru' }],
              'v8:content': [{ '#text': tooltipContent }],
            },
          ],
        },
      ];
    } else {
      // Handle null values for properties that should be xsi:nil="true"
      if (value === null) {
        const xsiNilProperties = ['MinValue', 'MaxValue', 'FillValue'];
        if (xsiNilProperties.includes(key)) {
          // For xsi:nil=true, represent as an object with the attribute
          // This will produce <key xsi:nil="true"/>
          propertiesObject[key] = { '@_xsi:nil': 'true' };
        }
        // For other null values, we skip them (don't add to properties)
      } else if (value !== undefined) {
        // For all other properties, include them even if they are empty strings
        // Represent as an element with text content
        propertiesObject[key] = [{ '#text': String(value) }];
      }
    }
  }

  // Return the element representation: element with uuid attribute and Properties child
  if (elementType === 'TabularSection') {
    return {
      [elementType]: {
        '@_uuid': uuid,
        ...(parentRootType && parentObjectName
          ? {
              InternalInfo: buildTabularSectionInternalInfoObject(
                String(parentRootType),
                parentObjectName,
                elementName
              ),
            }
          : {}),
        Properties: propertiesObject,
        ChildObjects: {},
      },
    };
  }

  return {
    [elementType]: {
      '@_uuid': uuid,
      Properties: propertiesObject,
    },
  };
}

// ---------------------------------------------------------------------------
// Internal structural mutation helpers
// ---------------------------------------------------------------------------

function mutateChildObjectsArray(
  parsed: unknown,
  containerName: string,
  _elementType: string,
  mutate: (arr: unknown[]) => void
): unknown {
  if (!parsed || typeof parsed !== 'object') {return parsed;}
  if (Array.isArray(parsed)) {
    return parsed.map(item => mutateChildObjectsArray(item, containerName, _elementType, mutate));
  }
  // Handle object (non-array)
  const obj = parsed as Record<string, unknown>;
  const result = { ...obj }; // Shallow copy
  // Check if containerName property exists
  if (containerName in obj) {
    const value = obj[containerName];
    if (Array.isArray(value)) {
      // It's an array, mutate it
      mutate(value);
      result[containerName] = value;
    } else if (value === '' || value === null || value === undefined) {
      // Convert empty string/null/undefined to empty array and mutate
      const arr: unknown[] = [];
      mutate(arr);
      result[containerName] = arr;
    } else if (typeof value === 'object') {
      // With preserveOrder:false, parser gives ChildObjects as { Attribute: [...] } or { Attribute: {...} }.
      // Get or create the element array and mutate it instead of recursing (recursion would look for
      // containerName inside this object and wipe existing elements).
      const inner = value as Record<string, unknown>;
      const key = _elementType;
      let arr: unknown[];
      if (key in inner) {
        const existing = inner[key];
        if (Array.isArray(existing)) {
          arr = existing;
        } else if (existing !== null && existing !== undefined && typeof existing === 'object') {
          arr = [existing];
          inner[key] = arr;
        } else {
          arr = [];
          inner[key] = arr;
        }
      } else {
        arr = [];
        inner[key] = arr;
      }
      // Normalize: parser may give unwrapped items (no elementType key). Ensure same shape so mutate pushes consistent form.
      if (arr.length > 0) {
        const first = arr[0];
        const isWrapped =
          first &&
          typeof first === 'object' &&
          _elementType in (first as Record<string, unknown>);
        if (!isWrapped) {
          inner[key] = arr.map((item) =>
            item && typeof item === 'object' && !(_elementType in (item as Record<string, unknown>))
              ? { [_elementType]: item }
              : item
          );
          arr = inner[key] as unknown[];
        }
      }
      mutate(arr);
      result[containerName] = value;
    }
    // For other values (string, number, boolean, etc.), leave as-is
  } else {
    // Property doesn't exist, create it as an empty array and mutate
    const arr: unknown[] = [];
    mutate(arr);
    result[containerName] = arr;
  }
  // Now recurse into all other properties (excluding containerName since we've handled it)
  for (const [key, value] of Object.entries(obj)) {
    if (key === containerName) {
      // Skip containerName as we've already handled it
      continue;
    }
    if (Array.isArray(value)) {
      result[key] = mutateChildObjectsArray(value, containerName, _elementType, mutate) as unknown[];
    } else if (value && typeof value === 'object') {
      result[key] = mutateChildObjectsArray(value, containerName, _elementType, mutate);
    }
    // For primitive values, copy as-is (already done by the spread above)
  }
  return result;
}

function addNestedElementInRootStructure(
  parsed: unknown,
  containerName: string,
  elementType: string,
  newBlock: Record<string, unknown>
): unknown {
  if (!parsed || typeof parsed !== 'object') {return parsed;}

  if (Array.isArray(parsed)) {
    return parsed.map(item => addNestedElementInRootStructure(item, containerName, elementType, newBlock));
  }

  const obj = parsed as Record<string, unknown>;
  const result: Record<string, unknown> = { ...obj };

  // Find and add to ChildObjects of any TOP_LEVEL_TYPES element (Catalog, Document, etc)
  for (const typeName of TOP_LEVEL_TYPES) {
    if (typeName in obj) {
      const elementContent = obj[typeName as string];
      if (elementContent && typeof elementContent === 'object' && !Array.isArray(elementContent)) {
        const elemObj = elementContent as Record<string, unknown>;
        if ('ChildObjects' in elemObj) {
          const childObjects = elemObj.ChildObjects;
          let innerObj: Record<string, unknown>;
          let arr: unknown[];

          if (childObjects && typeof childObjects === 'object' && !Array.isArray(childObjects)) {
            // preserveOrder:false normal form: { Attribute: { @_uuid, Properties } } or
            // { Attribute: [ { @_uuid, Properties }, ... ] }
            innerObj = childObjects as Record<string, unknown>;
          } else if (Array.isArray(childObjects)) {
            // Broken array form (from previous bug): [ { Attribute: {...} }, ... ]
            // Reconstruct to object form: { Attribute: [ { @_uuid, Properties }, ... ] }
            innerObj = {};
            for (const item of childObjects) {
              if (item && typeof item === 'object') {
                for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
                  if (!innerObj[k]) {
                    innerObj[k] = [];
                  }
                  (innerObj[k] as unknown[]).push(v);
                }
              }
            }
          } else {
            // Empty string, null, undefined
            innerObj = {};
          }

          const existing = innerObj[elementType];
          if (Array.isArray(existing)) {
            arr = existing;
          } else if (existing !== null && existing !== undefined) {
            arr = [existing];
          } else {
            arr = [];
          }

          // newBlock is { Attribute: { @_uuid, Properties } } — extract inner content
          const unwrapped = (newBlock as Record<string, unknown>)[elementType];
          arr.push(unwrapped);
          innerObj[elementType] = arr;
          result[typeName as string] = { ...elemObj, ChildObjects: { ...innerObj } };
          return result;
        }
        // Только типы, у которых в выгрузке бывает ChildObjects (Catalog, Document, …). Не Role/CommonModule/…
        if (!ROOT_TAGS_WITHOUT_CHILDOBJECTS.has(String(typeName))) {
          const unwrapped = (newBlock as Record<string, unknown>)[elementType];
          if (unwrapped !== undefined && unwrapped !== null) {
            const innerObj: Record<string, unknown> = {
              [elementType]: [unwrapped],
            };
            result[typeName as string] = { ...elemObj, ChildObjects: innerObj };
            return result;
          }
        }
      }
    }
  }

  // Recurse into other properties
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      result[key] = addNestedElementInRootStructure(value, containerName, elementType, newBlock) as unknown[];
    } else if (value && typeof value === 'object') {
      result[key] = addNestedElementInRootStructure(value, containerName, elementType, newBlock);
    }
  }

  return result;
}

function removeNestedElementInRootStructure(
  parsed: unknown,
  containerName: string,
  elementType: string,
  elementName: string
): unknown {
  if (!parsed || typeof parsed !== 'object') {return parsed;}

  if (Array.isArray(parsed)) {
    return parsed.map(item => removeNestedElementInRootStructure(item, containerName, elementType, elementName));
  }

  const obj = parsed as Record<string, unknown>;
  const result: Record<string, unknown> = { ...obj };

  // Remove from ChildObjects of any TOP_LEVEL_TYPES element
  for (const typeName of TOP_LEVEL_TYPES) {
    if (typeName in obj) {
      const elementContent = obj[typeName as string];
      if (elementContent && typeof elementContent === 'object' && !Array.isArray(elementContent)) {
        const elemObj = elementContent as Record<string, unknown>;
        if ('ChildObjects' in elemObj) {
          const childObjects = elemObj.ChildObjects;
          if (Array.isArray(childObjects)) {
            for (let i = childObjects.length - 1; i >= 0; i--) {
              const item = childObjects[i];
              if (item && typeof item === 'object' && elementType in (item as object)) {
                const inner = (item as Record<string, unknown>)[elementType];
                if (Array.isArray(inner)) {
                  const name = extractNameFromElementArray(inner);
                  if (name === elementName) {
                    childObjects.splice(i, 1);
                    result[typeName as string] = { ...elemObj, ChildObjects: childObjects };
                    return result; // Return early after removal
                  }
                }
              }
            }
          } else if (childObjects && typeof childObjects === 'object') {
            // preserveOrder:false object form: { Attribute: {...} | [...], TabularSection: {...} | [...] }
            const childObj = childObjects as Record<string, unknown>;
            if (elementType in childObj) {
              const inner = childObj[elementType];
              const items = Array.isArray(inner) ? inner : inner != null ? [inner] : [];
              const filtered = items.filter((item) => extractNameFromNestedElement(item) !== elementName);
              if (filtered.length !== items.length) {
                const nextChildObj = { ...childObj };
                if (filtered.length === 0) {
                  delete nextChildObj[elementType];
                } else {
                  nextChildObj[elementType] = filtered;
                }
                result[typeName as string] = { ...elemObj, ChildObjects: nextChildObj };
                return result;
              }
            }
          }
        }
      }
      break; // Only process once
    }
  }

  // Recurse
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === 'object') {
      result[key] = removeNestedElementInRootStructure(value, containerName, elementType, elementName);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function addNestedElementInStructure(
  parsed: unknown,
  elementType: string,
  elementName: string,
  minimalProperties: Record<string, unknown>,
  parentRootType?: MetadataType,
  parentObjectName?: string
): unknown {
  const usesRootMetadataChildObjects =
    elementType === 'Attribute' ||
    elementType === 'TabularSection' ||
    elementType === 'EnumValue' ||
    elementType === 'Dimension' ||
    elementType === 'Resource';
  const containerName = usesRootMetadataChildObjects ? 'ChildObjects' : elementType + 's';
  const newBlock = buildMinimalNestedElement(
    elementType,
    elementName,
    minimalProperties,
    parentRootType,
    parentObjectName
  );

  // Special handling for ChildObjects elements: only add to the root metadata object's ChildObjects,
  // not nested ChildObjects. This avoids writing into InternalInfo/GeneratedType branches.
  if (usesRootMetadataChildObjects) {
    return addNestedElementInRootStructure(
      parsed,
      containerName,
      elementType,
      newBlock
    );
  }

  return mutateChildObjectsArray(parsed, containerName, elementType, (arr) => {
    arr.push(newBlock);
  });
}

export function removeNestedElementInStructure(
  parsed: unknown,
  elementType: string,
  elementName: string
): unknown {
  const usesRootMetadataChildObjects =
    elementType === 'Attribute' ||
    elementType === 'TabularSection' ||
    elementType === 'EnumValue' ||
    elementType === 'Dimension' ||
    elementType === 'Resource';
  const containerName = usesRootMetadataChildObjects ? 'ChildObjects' : elementType + 's';
  if (usesRootMetadataChildObjects) {
    return removeNestedElementInRootStructure(parsed, containerName, elementType, elementName);
  }
  return mutateChildObjectsArray(parsed, containerName, elementType, (arr) => {
    for (let i = arr.length - 1; i >= 0; i--) {
      const item = arr[i];
      if (item && typeof item === 'object' && elementType in (item as object)) {
        const inner = (item as Record<string, unknown>)[elementType];
        if (Array.isArray(inner)) {
          const name = extractNameFromElementArray(inner);
          if (name === elementName) {
            arr.splice(i, 1);
            return;
          }
        }
      }
    }
  });
}
