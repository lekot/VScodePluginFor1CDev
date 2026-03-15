import { RoleModel, ObjectRights } from './models/roleModel';
import { MetadataObject } from './models/metadataObject';
import { FilterState } from './models/filterState';
import { applyFilter } from './filterUtils';

/**
 * Renders the cross-table matrix HTML for the roles rights editor
 */
export class CrossTableRenderer {
  private static readonly RIGHT_TYPES: Array<keyof ObjectRights> = [
    'read',
    'insert',
    'update',
    'delete',
    'view',
    'edit',
    'interactiveInsert',
    'interactiveDelete',
    'interactiveClear',
    'interactiveDeleteMarked',
    'interactiveUndeleteMarked',
    'interactiveDeletePredefinedData',
    'interactiveSetDeletionMark',
    'interactiveClearDeletionMark',
    'interactiveDeleteMarkedPredefinedData',
  ];

  private static readonly RIGHT_LABELS: Record<keyof ObjectRights, string> = {
    read: 'Read',
    insert: 'Insert',
    update: 'Update',
    delete: 'Delete',
    view: 'View',
    edit: 'Edit',
    interactiveInsert: 'Int. Insert',
    interactiveDelete: 'Int. Delete',
    interactiveClear: 'Int. Clear',
    interactiveDeleteMarked: 'Int. Del. Marked',
    interactiveUndeleteMarked: 'Int. Undel. Marked',
    interactiveDeletePredefinedData: 'Int. Del. Predef.',
    interactiveSetDeletionMark: 'Int. Set Del. Mark',
    interactiveClearDeletionMark: 'Int. Clear Del. Mark',
    interactiveDeleteMarkedPredefinedData: 'Int. Del. Marked Predef.',
  };

  /**
   * Render the complete cross-table matrix HTML
   */
  public static renderTable(
    roleModel: RoleModel,
    allObjects: MetadataObject[],
    filterState: FilterState
  ): string {
    const filteredObjects = applyFilter(allObjects, roleModel, filterState);

    if (filteredObjects.length === 0) {
      return this.renderEmptyState();
    }

    let html = '<table class="rights-table">';
    html += this.renderHeaderRow();
    
    for (const obj of filteredObjects) {
      html += this.renderObjectRow(obj, roleModel.rights[obj.fullName]);
    }
    
    html += '</table>';
    return html;
  }

  /**
   * Render the header row with right type columns
   */
  private static renderHeaderRow(): string {
    let html = '<thead><tr>';
    html += '<th class="object-column">Object</th>';
    
    for (const rightType of this.RIGHT_TYPES) {
      const label = this.RIGHT_LABELS[rightType];
      html += `<th class="right-column" title="${this.escapeHtml(label)}">${this.escapeHtml(label)}</th>`;
    }
    
    html += '</tr></thead><tbody>';
    return html;
  }

  /**
   * Render a single object row with checkboxes for each right
   */
  private static renderObjectRow(obj: MetadataObject, rights?: ObjectRights): string {
    let html = '<tr>';
    html += `<td class="object-name" title="${this.escapeHtml(obj.fullName)}">${this.escapeHtml(obj.displayName)}</td>`;
    
    for (const rightType of this.RIGHT_TYPES) {
      const checked = rights && rights[rightType] ? 'checked' : '';
      const objectName = this.escapeAttr(obj.fullName);
      const rightName = this.escapeAttr(rightType);
      
      html += `<td class="right-cell">`;
      html += `<input type="checkbox" ${checked} data-object="${objectName}" data-right="${rightName}" class="right-checkbox">`;
      html += `</td>`;
    }
    
    html += '</tr>';
    return html;
  }

  /**
   * Render empty state when no objects match filters
   */
  private static renderEmptyState(): string {
    return `
      <div class="empty-state">
        <p>No objects match the current filters.</p>
        <p>Try adjusting your search or enabling "Show All Objects".</p>
      </div>
    `;
  }

  /**
   * Escape HTML entities to prevent XSS
   */
  private static escapeHtml(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  }

  /**
   * Escape HTML attributes
   */
  private static escapeAttr(text: string): string {
    return this.escapeHtml(text);
  }
}
