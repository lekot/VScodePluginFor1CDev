/**
 * Parse Module.bsl to get procedure/function names and their declaration line numbers.
 */

import * as fs from 'fs';
import { parseBslRoutines } from '../bsl/routineRangeProvider';
import { Logger } from '../utils/logger';

export interface BslProcedureInfo {
  name: string;
  line: number;
}

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
  return parseBslRoutines(content).routines.map((routine) => ({
    name: routine.name,
    line: routine.range.startLine,
  }));
}
