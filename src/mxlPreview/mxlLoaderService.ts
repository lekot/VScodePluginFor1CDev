import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import { MxlParser } from './mxlParser';
import { MxlRenderModel } from './mxlRenderModel';

export type MxlSourceFormat = 'mxl' | 'xml' | 'unknown';

export interface MxlLoadResult {
  uri: vscode.Uri;
  sourceFormat: MxlSourceFormat;
  rawXml: string;
  model: MxlRenderModel;
}

export class MxlLoaderService {
  constructor(private readonly parser: MxlParser = new MxlParser()) {}

  async loadFromUri(uri: vscode.Uri): Promise<MxlLoadResult> {
    const rawXml = await fs.readFile(uri.fsPath, 'utf8');
    return {
      uri,
      sourceFormat: this.detectFormat(uri),
      rawXml,
      model: this.parser.parse(rawXml),
    };
  }

  private detectFormat(uri: vscode.Uri): MxlSourceFormat {
    const lower = uri.fsPath.toLowerCase();
    if (lower.endsWith('.mxl')) {
      return 'mxl';
    }
    if (lower.endsWith('.xml')) {
      return 'xml';
    }
    return 'unknown';
  }
}
