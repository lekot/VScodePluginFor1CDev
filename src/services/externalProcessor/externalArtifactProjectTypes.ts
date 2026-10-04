export type ExternalArtifactKind = 'ExternalDataProcessor' | 'ExternalReport';

export interface CreateExternalArtifactProjectRequest {
  readonly workspaceRoot: string;
  readonly name: string;
  readonly kind: ExternalArtifactKind;
  readonly language: 'ru' | 'en';
  readonly synonym?: string;
}

export interface ExportEmbeddedArtifactRequest {
  readonly workspaceRoot: string;
  readonly sourceRootXmlPath: string;
  /** Absolute path of a new project directory inside the workspace. */
  readonly destinationDirectory: string;
}

export interface ExternalArtifactProjectOutcome {
  readonly rootXmlPath: string;
  readonly kind: ExternalArtifactKind;
  readonly projectDirectory: string;
}
