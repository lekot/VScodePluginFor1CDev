import * as fs from 'fs';
import * as path from 'path';

export interface SuiteExecutionReport {
  job: string;
  discoveredSuites: string[];
  executedSuites: string[];
  mandatorySuites: string[];
  missingMandatorySuites: string[];
  testStats: {
    passes: number;
    failures: number;
    pending: number;
    total: number;
  };
}

function normalizeSuitePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function parseMandatorySuites(raw?: string): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map(normalizeSuitePath);
}

export function resolveMissingMandatorySuites(executedSuites: string[], mandatoryRaw?: string): string[] {
  const mandatorySuites = parseMandatorySuites(mandatoryRaw);
  const executedSet = new Set(executedSuites.map(normalizeSuitePath));
  return mandatorySuites.filter((suite) => !executedSet.has(suite));
}

export function writeSuiteExecutionReport(
  reportPath: string | undefined,
  report: SuiteExecutionReport
): void {
  if (!reportPath) {
    return;
  }

  const absolutePath = path.resolve(reportPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, JSON.stringify(report, null, 2), 'utf8');
}
