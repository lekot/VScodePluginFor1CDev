import type { ResolvedPicture } from '../../services/picture/commonPictureResolver';

/** Metadata-to-command routing kept public for message-handler compatibility. */
export const CONTENT_EDITOR_COMMANDS = new Map<string, string>([
  ['Subsystem', '1c-metadata-tree.editSubsystemComposition'],
  ['ExchangePlan', '1c-metadata-tree.editExchangePlanContent'],
  ['CommonAttribute', '1c-metadata-tree.editCommonAttributeContent'],
  ['FunctionalOption', '1c-metadata-tree.editFunctionalOptionContent'],
  ['FilterCriterion', '1c-metadata-tree.editFilterCriterionContent'],
]);

export interface WebviewContentOptions {
  picture?: ResolvedPicture;
  sessionToken?: string;
}
