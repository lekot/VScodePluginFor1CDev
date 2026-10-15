import type { ConfigFormat } from '../parsers/formatDetector';
import type { ConfigurationId } from '../services/configurationSession/types';

/** Minimal immutable configuration identity needed to load a published metadata tree. */
export interface TreeLoadContext {
  readonly configurationId: ConfigurationId;
  readonly configPath: string;
  readonly format: ConfigFormat;
}
