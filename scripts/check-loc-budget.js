#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const defaultSourceRoot = path.join(repoRoot, 'src');
const defaultBaselinePath = path.join(repoRoot, '.github', 'loc-budget-baseline.json');
const DEFAULT_THRESHOLD = 1000;

function readOptions(argv) {
  const options = {
    sourceRoot: defaultSourceRoot,
    baselinePath: defaultBaselinePath,
    writeBaseline: false,
    threshold: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write-baseline') {
      options.writeBaseline = true;
    } else if (arg === '--source-root' && argv[i + 1]) {
      options.sourceRoot = path.resolve(argv[++i]);
    } else if (arg === '--baseline' && argv[i + 1]) {
      options.baselinePath = path.resolve(argv[++i]);
    } else if (arg === '--threshold' && argv[i + 1]) {
      options.threshold = parseInt(argv[++i], 10);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/check-loc-budget.js [options]

Options:
  --source-root <path>  Source directory to scan (default: src)
  --baseline <path>     Baseline JSON path (default: .github/loc-budget-baseline.json)
  --threshold <lines>   Maximum allowed lines without baseline exception (default: 1000)
  --write-baseline      Update baseline with current scan results
`);
}

function collectSourceFiles(dir, rootDir, results = []) {
  if (!fs.existsSync(dir)) {
    return results;
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(fullPath, rootDir, results);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      const relInsideSource = path.relative(rootDir, fullPath).split(path.sep).join('/');
      const relPath = `src/${relInsideSource}`;
      results.push({ fullPath, relPath });
    }
  }
  return results;
}

function countLines(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content.split('\n').length;
}

function loadBaseline(baselinePath) {
  if (fs.existsSync(baselinePath)) {
    try {
      return JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    } catch (err) {
      console.error(`Failed to parse baseline JSON at ${baselinePath}:`, err);
    }
  }
  return { version: 1, threshold: DEFAULT_THRESHOLD, allowedHotspots: {} };
}

function runCheck(options) {
  const baseline = loadBaseline(options.baselinePath);
  const threshold = options.threshold ?? baseline.threshold ?? DEFAULT_THRESHOLD;
  const allowedHotspots = baseline.allowedHotspots || {};

  const files = collectSourceFiles(options.sourceRoot, options.sourceRoot);
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));

  if (options.writeBaseline) {
    const newHotspots = {};
    for (const file of files) {
      const lines = countLines(file.fullPath);
      if (lines > threshold) {
        const existingReason = allowedHotspots[file.relPath]?.reason;
        newHotspots[file.relPath] = {
          maxLines: lines,
          reason: existingReason || 'Module exceeds threshold; scheduled for decomposition (#201)',
        };
      }
    }
    const updated = {
      version: 1,
      threshold,
      allowedHotspots: newHotspots,
    };
    fs.writeFileSync(options.baselinePath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
    console.log(`Updated baseline at ${options.baselinePath} with ${Object.keys(newHotspots).length} hotspots.`);
    return { success: true, violations: [] };
  }

  const violations = [];
  const improvements = [];
  let checkedCount = 0;
  let baselinedCount = 0;

  for (const file of files) {
    checkedCount += 1;
    const lines = countLines(file.fullPath);
    const hotspot = allowedHotspots[file.relPath];

    if (lines > threshold) {
      if (!hotspot) {
        violations.push({
          type: 'NEW_LARGE_FILE',
          file: file.relPath,
          lines,
          limit: threshold,
          message: `${file.relPath} (${lines} lines) exceeds LOC threshold of ${threshold} lines without architecture exception (#201).`,
        });
      } else if (lines > hotspot.maxLines) {
        violations.push({
          type: 'BASELINE_GROWTH',
          file: file.relPath,
          lines,
          limit: hotspot.maxLines,
          message: `${file.relPath} has grown to ${lines} lines, exceeding its baseline limit of ${hotspot.maxLines} lines (#201).`,
        });
      } else {
        baselinedCount += 1;
      }
    } else if (hotspot) {
      improvements.push({
        file: file.relPath,
        lines,
        prevLimit: hotspot.maxLines,
      });
    }
  }

  return {
    success: violations.length === 0,
    checkedCount,
    baselinedCount,
    violations,
    improvements,
  };
}

function main() {
  let options;
  try {
    options = readOptions(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const result = runCheck(options);
  if (options.writeBaseline) {
    process.exit(0);
  }

  if (result.improvements && result.improvements.length > 0) {
    console.log('\n[LOC Budget Guard] Progress notices:');
    for (const imp of result.improvements) {
      console.log(`  - ${imp.file} reduced to ${imp.lines} lines (<= threshold)! Can be removed from baseline via --write-baseline.`);
    }
  }

  if (!result.success) {
    console.error('\n[LOC Budget Guard] Architecture violations found (#201):');
    for (const v of result.violations) {
      console.error(`  FAIL [${v.type}]: ${v.message}`);
    }
    console.error(`\nAction required: Decompose module, reduce lines, or document architecture exception in .github/loc-budget-baseline.json.`);
    process.exit(1);
  }

  console.log(`[LOC Budget Guard] Passed: verified ${result.checkedCount} TypeScript files. ${result.baselinedCount} legacy hotspots within approved baseline limits.`);
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  runCheck,
  collectSourceFiles,
  countLines,
  loadBaseline,
  DEFAULT_THRESHOLD,
};
