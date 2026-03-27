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

export const MAX_MXL_PREVIEW_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export class MxlLoaderService {
  constructor(private readonly parser: MxlParser = new MxlParser()) {}

  async loadFromUri(uri: vscode.Uri): Promise<MxlLoadResult> {
    const sourceFormat = this.detectFormat(uri);
    const fileStat = await fs.stat(uri.fsPath);
    if (fileStat.size > MAX_MXL_PREVIEW_FILE_SIZE_BYTES) {
      return {
        uri,
        sourceFormat,
        rawXml: '',
        model: {
          version: 'v1',
          tables: [],
          diagnostics: [
            {
              level: 'error',
              code: 'MXL_FILE_SIZE_LIMIT_EXCEEDED',
              message: `File size ${fileStat.size} bytes exceeds preview limit ${MAX_MXL_PREVIEW_FILE_SIZE_BYTES} bytes.`,
            },
          ],
        },
      };
    }
    const buffer = await fs.readFile(uri.fsPath);
    const { rawXml, diagnostics } = this.decodeXmlBuffer(buffer);
    const model = this.parser.parse(rawXml);
    if (diagnostics.length > 0) {
      model.diagnostics.unshift(...diagnostics);
    }
    return {
      uri,
      sourceFormat,
      rawXml,
      model,
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

  private decodeXmlBuffer(buffer: Buffer): { rawXml: string; diagnostics: MxlRenderModel['diagnostics'] } {
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      return { rawXml: buffer.toString('utf8', 3), diagnostics: [] };
    }
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
      return { rawXml: buffer.toString('utf16le', 2), diagnostics: [] };
    }
    if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
      const swapped = Buffer.from(buffer.subarray(2));
      for (let i = 0; i + 1 < swapped.length; i += 2) {
        const tmp = swapped[i];
        swapped[i] = swapped[i + 1];
        swapped[i + 1] = tmp;
      }
      return { rawXml: swapped.toString('utf16le'), diagnostics: [] };
    }

    const rawXml = buffer.toString('utf8');
    if (rawXml.includes('\uFFFD')) {
      return {
        rawXml,
        diagnostics: [
          {
            level: 'error',
            code: 'MXL_ENCODING_DECODE_ERROR',
            message:
              'Cannot reliably decode file as UTF-8/UTF-16 (BOM-aware). Save the file as UTF-8 or UTF-16 with BOM.',
          },
        ],
      };
    }
    return { rawXml, diagnostics: [] };
  }
}
