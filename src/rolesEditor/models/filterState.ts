/**
 * Filter state model for the Roles and Rights Editor
 */

import { MetadataType } from '../../models/treeNode';

/**
 * Represents the current filter state for the cross-table matrix
 */
export interface FilterState {
  /**
   * If true, show all metadata objects in configuration
   * If false (default), show only objects with assigned rights
   */
  showAll: boolean;

  /**
   * Case-insensitive search query to filter objects by name or display name
   * Empty string means no search filtering
   */
  searchQuery: string;

  /**
   * Array of metadata types to filter by
   * Empty array means no type filtering (show all types)
   */
  typeFilter: MetadataType[];
}

/**
 * Create a default FilterState instance
 */
export function createDefaultFilterState(): FilterState {
  return {
    showAll: false,
    searchQuery: '',
    typeFilter: []
  };
}
