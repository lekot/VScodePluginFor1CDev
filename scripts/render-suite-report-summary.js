const fs = require('fs');
const path = require('path');

function readReport(reportPath) {
  const raw = fs.readFileSync(reportPath, 'utf8');
  return JSON.parse(raw);
}

function formatReport(report) {
  const lines = [];
  lines.push(`### ${report.job}`);
  lines.push(`- discovered suites: ${report.discoveredSuites.length}`);
  lines.push(`- executed suites: ${report.executedSuites.length}`);
  lines.push(`- tests: total=${report.testStats.total}, pass=${report.testStats.passes}, fail=${report.testStats.failures}, pending=${report.testStats.pending}`);
  if (report.missingMandatorySuites.length > 0) {
    lines.push(`- missing mandatory: ${report.missingMandatorySuites.join(', ')}`);
  } else {
    lines.push('- missing mandatory: none');
  }
  lines.push('');
  lines.push('Executed suites:');
  for (const suite of report.executedSuites) {
    lines.push(`- \`${suite}\``);
  }
  lines.push('');
  return lines.join('\n');
}

function main() {
  const outputPath = process.argv[2];
  const reportPaths = process.argv.slice(3);
  if (!outputPath || reportPaths.length === 0) {
    console.error('Usage: node scripts/render-suite-report-summary.js <output.md> <report1.json> [report2.json...]');
    process.exit(1);
  }

  const sections = ['## Executed Test Suites'];
  for (const reportPath of reportPaths) {
    const report = readReport(reportPath);
    sections.push(formatReport(report));
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${sections.join('\n')}\n`, 'utf8');
}

main();
