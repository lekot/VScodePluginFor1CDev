export type SupportConfigurationStrategy = 'main' | 'extension';
export type SupportTargetKind = 'file' | 'server' | 'web';

export interface SupportCapabilityQuery {
  readonly targetKind: SupportTargetKind;
  readonly platformVersion: string;
  readonly formatRevision: string;
  readonly configurationStrategy: SupportConfigurationStrategy;
}

export interface CertifiedSupportStrategy {
  readonly id: 'file-main-8.3.27.1859-revision6';
  readonly targetKind: 'file';
  readonly platformVersion: '8.3.27.1859';
  readonly formatRevision: '6';
  readonly configurationStrategy: 'main';
  readonly includeConfigDumpInfo: false;
}

export type SupportCapabilityResolution =
  | { readonly supported: true; readonly strategy: CertifiedSupportStrategy }
  | {
      readonly supported: false;
      readonly errorCode: 'SUPPORT_TARGET_UNSUPPORTED';
      readonly reason:
        | 'targetType'
        | 'platformVersion'
        | 'formatRevision'
        | 'configurationStrategy';
    };

const FILE_MAIN_8_3_27_REVISION_6: CertifiedSupportStrategy = Object.freeze({
  id: 'file-main-8.3.27.1859-revision6',
  targetKind: 'file',
  platformVersion: '8.3.27.1859',
  formatRevision: '6',
  configurationStrategy: 'main',
  includeConfigDumpInfo: false,
});

/** Closed capability allow-list. Unknown combinations remain read-only. */
export class SupportCapabilityRegistry {
  resolve(query: SupportCapabilityQuery): SupportCapabilityResolution {
    if (query.targetKind !== FILE_MAIN_8_3_27_REVISION_6.targetKind) {
      return unsupported('targetType');
    }
    if (query.platformVersion !== FILE_MAIN_8_3_27_REVISION_6.platformVersion) {
      return unsupported('platformVersion');
    }
    if (query.formatRevision !== FILE_MAIN_8_3_27_REVISION_6.formatRevision) {
      return unsupported('formatRevision');
    }
    if (query.configurationStrategy !== FILE_MAIN_8_3_27_REVISION_6.configurationStrategy) {
      return unsupported('configurationStrategy');
    }
    return { supported: true, strategy: FILE_MAIN_8_3_27_REVISION_6 };
  }
}

function unsupported(reason: Extract<SupportCapabilityResolution, { supported: false }>['reason']):
Extract<SupportCapabilityResolution, { supported: false }> {
  return { supported: false, errorCode: 'SUPPORT_TARGET_UNSUPPORTED', reason };
}
