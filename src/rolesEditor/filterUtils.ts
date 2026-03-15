/**
 * Filter utility functions for the Roles and Rights Editor
 * 
 * Implements filtering logic to show/hide metadata objects based on:
 * - showAll flag (default: only objects with rights)
 * - search query (case-insensitive name/displayName matching)
 * - type filter (filter by MetadataType)
 */

import { MetadataObject } from './models/metadataObject';
import { FilterState } from './models/filterState';
import { RoleModel } from './models/roleModel';

/**
 * Apply filter to metadata objects based on FilterState
 * 
 * Preconditions:
 * - allObjects is non-empty array
 * - roleModel is valid
 * - filterState is valid FilterState
 * 
 * Postconditions:
 * - Returns filtered list based on filter criteria
 * - Original allObjects array is not modified
 * - Result maintains original object order
 * 
 * @param allObjects - Array of all metadata objects in configuration
 * @param roleModel - Current role model with rights assignments
 * @param filterState - Current filter state
 * @returns Filtered array of MetadataObject
 */
export function applyFilter(
  allObjects: MetadataObject[],
  roleModel: RoleModel,
  filterState: FilterState
): MetadataObject[] {
  if (allObjects.length === 0) {
    return [];
  }

  const filteredObjects: MetadataObject[] = [];

  for (const obj of allObjects) {
    // Step 1: Check if object has rights
    const hasRights = obj.fullName in roleModel.rights;

    // Step 2: Apply showAll filter
    if (!filterState.showAll && !hasRights) {
      continue; // Skip objects without rights
    }

    // Step 3: Apply search query filter
    if (filterState.searchQuery !== '') {
      const query = filterState.searchQuery.toLowerCase();
      const matchName = obj.name.toLowerCase().includes(query);
      const matchDisplay = obj.displayName.toLowerCase().includes(query);

      if (!matchName && !matchDisplay) {
        continue; // Skip non-matching objects
      }
    }

    // Step 4: Apply type filter
    if (filterState.typeFilter.length > 0) {
      if (!filterState.typeFilter.includes(obj.type)) {
        continue; // Skip objects of filtered-out types
      }
    }

    // Object passed all filters
    filteredObjects.push(obj);
  }

  return filteredObjects;
}
