const fs = require('fs');
const path = require('path');

const repoRoot = process.cwd();
const summaryPath = path.join(repoRoot, 'coverage', 'coverage-summary.json');
const baselinePath = path.join(repoRoot, '.github', 'coverage-baseline.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function pct(totalSection, key) {
  return Number(totalSection[key] && totalSection[key].pct ? totalSection[key].pct : 0);
}

if (!fs.existsSync(summaryPath)) {
  console.error(`Coverage summary not found: ${summaryPath}`);
  process.exit(1);
}

if (!fs.existsSync(baselinePath)) {
  console.error(`Coverage baseline not found: ${baselinePath}`);
  process.exit(1);
}

const summary = readJson(summaryPath);
const baseline = readJson(baselinePath);
const total = summary.total || {};
const current = {
  lines: pct(total, 'lines'),
  statements: pct(total, 'statements'),
  functions: pct(total, 'functions'),
  branches: pct(total, 'branches'),
};

const metrics = ['lines', 'statements', 'functions', 'branches'];
const failures = [];
const rows = [];

console.log('Coverage report:');
for (const metric of metrics) {
  const baseValue = Number(baseline[metric] || 0);
  const currentValue = Number(current[metric] || 0);
  const delta = Number((currentValue - baseValue).toFixed(2));
  const deltaText = delta >= 0 ? `+${delta.toFixed(2)}` : `${delta.toFixed(2)}`;
  console.log(`- ${metric}: ${currentValue.toFixed(2)}% (baseline ${baseValue.toFixed(2)}%, delta ${deltaText}%)`);
  rows.push(`| ${metric} | ${currentValue.toFixed(2)}% | ${baseValue.toFixed(2)}% | ${deltaText}% |`);
  if (currentValue + 1e-9 < baseValue) {
    failures.push(`${metric} dropped: ${currentValue.toFixed(2)}% < ${baseValue.toFixed(2)}%`);
  }
}

if (process.env.GITHUB_STEP_SUMMARY) {
  const summaryLines = [
    '## Coverage delta',
    '',
    '| Metric | Current | Baseline | Delta |',
    '| --- | ---: | ---: | ---: |',
    ...rows,
    '',
  ];
  if (failures.length > 0) {
    summaryLines.push('**Status:** failed (coverage dropped)');
  } else {
    summaryLines.push('**Status:** passed (no metric dropped)');
  }
  summaryLines.push('');
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summaryLines.join('\n')}\n`);
}

if (failures.length > 0) {
  console.error('\nCoverage check failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('\nCoverage check passed: no metric decreased vs baseline.');
