/**
 * Parse Module.bsl to get procedure/function names and their declaration line numbers.
 */

import * as fs from 'fs';
import { Logger } from '../utils/logger';

export interface BslProcedureInfo {
  name: string;
  line: number;
}

/** Match "Процедура Имя(" or "Функция Имя(" (BSL). */
const PROC_FUNC_REGEX = /^\s*(?:Процедура|Функция)\s+(\w+)\s*\(/i;

/**
 * Read Module.bsl and return list of procedure/function names with line numbers (1-based).
 */
export async function parseBslModuleProcedures(modulePath: string): Promise<BslProcedureInfo[]> {
  let content: string;
  try {
    content = await fs.promises.readFile(modulePath, 'utf-8');
  } catch (err) {
    Logger.debug(`Cannot read Module.bsl: ${modulePath}`, err);
    return [];
  }
  const result: BslProcedureInfo[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(PROC_FUNC_REGEX);
    if (match) {
      result.push({ name: match[1], line: i + 1 });
    }
  }
  return result;
}
