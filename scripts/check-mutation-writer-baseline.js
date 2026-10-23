#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '..');
const defaultSourceRoot = path.join(repoRoot, 'src');
const defaultBaselinePath = path.join(repoRoot, '.github', 'mutation-writer-baseline.json');
const mutationMethods = new Set([
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
  'rename', 'renameSync', 'unlink', 'unlinkSync', 'rm', 'rmSync',
  'rmdir', 'rmdirSync', 'copyFile', 'copyFileSync', 'link', 'linkSync',
  'symlink', 'symlinkSync', 'truncate', 'truncateSync', 'mkdir', 'mkdirSync',
  'createWriteStream',
]);
const fileOpenMethods = new Set(['open', 'openSync']);
const allowedBoundaryPrefix = 'src/services/configurationSession/';

function readOptions(argv) {
  const options = {
    sourceRoot: defaultSourceRoot,
    baselinePath: defaultBaselinePath,
    writeBaseline: false,
    enforceFiles: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write-baseline') {
      options.writeBaseline = true;
    } else if (arg === '--source-root' && argv[i + 1]) {
      options.sourceRoot = path.resolve(argv[++i]);
    } else if (arg === '--baseline' && argv[i + 1]) {
      options.baselinePath = path.resolve(argv[++i]);
    } else if (arg === '--enforce-files' && argv[i + 1]) {
      options.enforceFiles.push(...argv[++i].split(',').map((file) => file.trim()).filter(Boolean));
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
  console.log(`Usage: node scripts/check-mutation-writer-baseline.js [options]

Options:
  --source-root <path>  Source directory to scan (default: src)
  --baseline <path>     Baseline JSON path
  --enforce-files <list> Comma-separated src-relative files where direct mutations fail
  --write-baseline      Replace the baseline with the current scan

Normal checks are warning-only so existing direct writers can be migrated incrementally.`);
}

function isFileSystemModule(moduleName) {
  return moduleName === 'fs' || moduleName === 'node:fs'
    || moduleName === 'fs/promises' || moduleName === 'node:fs/promises';
}

function isPromisesModule(moduleName) {
  return moduleName === 'fs/promises' || moduleName === 'node:fs/promises';
}

function collectFileSystemAliases(sourceFile) {
  const namespaceAliases = new Set();
  const promisesAliases = new Set();
  const directFunctionAliases = new Set();
  const fsDestructuredPromisesAliases = new Set();

  const registerImport = (moduleName, clause, defaultName) => {
    if (!isFileSystemModule(moduleName)) {
      return;
    }
    if (defaultName && !isPromisesModule(moduleName)) {
      namespaceAliases.add(defaultName);
    }
    if (!clause) {
      return;
    }
    if (ts.isNamespaceImport(clause)) {
      (isPromisesModule(moduleName) ? promisesAliases : namespaceAliases).add(clause.name.text);
      return;
    }
    if (ts.isNamedImports(clause)) {
      for (const element of clause.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        if (!isPromisesModule(moduleName) && importedName === 'promises') {
          promisesAliases.add(element.name.text);
        } else if (mutationMethods.has(importedName) || fileOpenMethods.has(importedName)) {
          directFunctionAliases.add(element.name.text);
        }
      }
    }
  };

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause?.namedBindings;
      registerImport(statement.moduleSpecifier.text, clause, statement.importClause?.name?.text);
    } else if (ts.isImportEqualsDeclaration(statement)
      && ts.isExternalModuleReference(statement.moduleReference)
      && statement.moduleReference.expression
      && ts.isStringLiteral(statement.moduleReference.expression)) {
      registerImport(statement.moduleReference.expression.text, undefined, statement.name.text);
    }
  }

  const visitRequires = (node) => {
    if (ts.isVariableDeclaration(node)
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression)
      && node.initializer.expression.text === 'require'
      && node.initializer.arguments.length === 1
      && ts.isStringLiteral(node.initializer.arguments[0])
      && isFileSystemModule(node.initializer.arguments[0].text)) {
      const moduleName = node.initializer.arguments[0].text;
      if (ts.isIdentifier(node.name)) {
        (isPromisesModule(moduleName) ? promisesAliases : namespaceAliases).add(node.name.text);
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) {
            continue;
          }
          const importedName = element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.name.text;
          if (moduleName === 'fs' || moduleName === 'node:fs') {
            if (importedName === 'promises') {
              fsDestructuredPromisesAliases.add(element.name.text);
            } else if (mutationMethods.has(importedName) || fileOpenMethods.has(importedName)) {
              directFunctionAliases.add(element.name.text);
            }
          } else if (mutationMethods.has(importedName) || fileOpenMethods.has(importedName)) {
            directFunctionAliases.add(element.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visitRequires);
  };
  visitRequires(sourceFile);

  return { namespaceAliases, promisesAliases, directFunctionAliases, fsDestructuredPromisesAliases };
}

function expressionMethodName(expression) {
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  if (ts.isElementAccessExpression(expression)
    && expression.argumentExpression
    && ts.isStringLiteral(expression.argumentExpression)) {
    return expression.argumentExpression.text;
  }
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  return undefined;
}

function isWriteOpen(call) {
  const flags = call.arguments[1];
  if (!flags || !ts.isStringLiteralLike(flags)) {
    return Boolean(flags);
  }
  return /[wax]/i.test(flags.text);
}

function isFileMutationCall(call, aliases) {
  const method = expressionMethodName(call.expression);
  if (!method) {
    return undefined;
  }

  if (ts.isIdentifier(call.expression) && aliases.directFunctionAliases.has(method)) {
    return method;
  }

  if (!ts.isPropertyAccessExpression(call.expression)
    && !ts.isElementAccessExpression(call.expression)) {
    return undefined;
  }

  const receiver = call.expression.expression;
  if (mutationMethods.has(method)) {
    if (ts.isIdentifier(receiver)
      && (aliases.namespaceAliases.has(receiver.text) || aliases.promisesAliases.has(receiver.text))) {
      return method;
    }
    if (ts.isPropertyAccessExpression(receiver)
      && receiver.name.text === 'promises'
      && ts.isIdentifier(receiver.expression)
      && aliases.namespaceAliases.has(receiver.expression.text)) {
      return method;
    }
    if (ts.isPropertyAccessExpression(receiver)
      && ts.isIdentifier(receiver.expression)
      && aliases.fsDestructuredPromisesAliases.has(receiver.expression.text)
      && receiver.name.text === method) {
      return method;
    }
  }

  if (fileOpenMethods.has(method) && isWriteOpen(call)) {
    if (ts.isIdentifier(receiver)
      && (aliases.namespaceAliases.has(receiver.text) || aliases.promisesAliases.has(receiver.text))) {
      return method;
    }
    if (ts.isPropertyAccessExpression(receiver)
      && receiver.name.text === 'promises'
      && ts.isIdentifier(receiver.expression)
      && aliases.namespaceAliases.has(receiver.expression.text)) {
      return method;
    }
  }

  if ((method === 'writeFile' || method === 'write') && ts.isIdentifier(receiver)
    && /(?:file)?handle/i.test(receiver.text)) {
    return method;
  }
  return undefined;
}

function getOwnerName(node, sourceFile) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current)) {
      const methodName = current.name?.getText(sourceFile);
      if (ts.isMethodDeclaration(current)) {
        const classDeclaration = current.parent;
        if (ts.isClassLike(classDeclaration) && classDeclaration.name) {
          return `${classDeclaration.name.text}.${methodName ?? '<computed>'}`;
        }
      }
      return methodName ?? '<anonymous-function>';
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const declaration = current.parent;
      if (ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration)) {
        return declaration.name.getText(sourceFile);
      }
      if (ts.isMethodDeclaration(declaration) && ts.isClassLike(declaration.parent)) {
        return `${declaration.parent.name?.text ?? '<class>'}.${declaration.name.getText(sourceFile)}`;
      }
      return '<callback>';
    }
  }
  return '<module>';
}

function listSourceFiles(directory) {
  if (!fs.existsSync(directory)) {
    throw new Error(`Source directory not found: ${directory}`);
  }
  const result = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
        result.push(fullPath);
      }
    }
  };
  visit(directory);
  return result.sort();
}

function scanSource(sourceRoot) {
  const sites = [];
  for (const filePath of listSourceFiles(sourceRoot)) {
    const relative = `src/${path.relative(sourceRoot, filePath).split(path.sep).join('/')}`;
    if (relative.startsWith(allowedBoundaryPrefix)) {
      continue;
    }

    const sourceText = fs.readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
    const aliases = collectFileSystemAliases(sourceFile);
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const method = isFileMutationCall(node, aliases);
        if (method) {
          const targetExpression = node.arguments[0]?.getText(sourceFile).replace(/\s+/g, ' ').trim() ?? '<none>';
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          sites.push({
            file: relative,
            owner: getOwnerName(node, sourceFile),
            method,
            target: targetExpression,
            line: line + 1,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return sites;
}

function siteKey(site) {
  return JSON.stringify([site.file, site.owner, site.method, site.target]);
}

function countSites(sites) {
  const counts = new Map();
  for (const site of sites) {
    const key = siteKey(site);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function readBaseline(baselinePath) {
  if (!fs.existsSync(baselinePath)) {
    throw new Error(`Baseline file not found: ${baselinePath}`);
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  if (baseline.version !== 1 || !Array.isArray(baseline.sites)) {
    throw new Error(`Unsupported mutation writer baseline format: ${baselinePath}`);
  }
  return baseline;
}

function writeBaseline(baselinePath, sites) {
  const counts = countSites(sites);
  const records = Array.from(counts.entries()).map(([key, count]) => {
    const [file, owner, method, target] = JSON.parse(key);
    return { file, owner, method, target, count };
  }).sort((left, right) => siteKey(left).localeCompare(siteKey(right)));
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, `${JSON.stringify({ version: 1, sites: records }, null, 2)}\n`, 'utf8');
  console.log(`Mutation writer baseline recorded ${sites.length} direct filesystem mutation call(s) across ${records.length} site(s): ${baselinePath}`);
}

function checkBaseline(baselinePath, sites) {
  const baseline = readBaseline(baselinePath);
  const baselineCounts = new Map(baseline.sites.map((site) => [siteKey(site), site.count]));
  const seen = new Map();
  const newSites = [];
  for (const site of sites.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)) {
    const key = siteKey(site);
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    if (occurrence > (baselineCounts.get(key) ?? 0)) {
      newSites.push(site);
    }
  }

  if (newSites.length > 0) {
    console.warn(`Mutation writer architecture guard (warning mode): ${newSites.length} unbaselined direct filesystem mutation call(s).`);
    for (const site of newSites) {
      console.warn(`  WARN ${site.file}:${site.line} ${site.method} in ${site.owner} (target: ${site.target})`);
    }
    console.warn('Route configuration writes through ConfigurationMutationEngine before updating the baseline.');
    return;
  }

  console.log(`Mutation writer architecture guard passed: no new direct filesystem mutation call(s) (${sites.length} observed, warning-only baseline mode).`);
}

function enforceNoMutationsInFiles(files, sites) {
  if (files.length === 0) {
    return;
  }
  const protectedFiles = new Set(files.map((file) => file.replace(/\\/g, '/')));
  const violations = sites.filter((site) => protectedFiles.has(site.file));
  if (violations.length === 0) {
    console.log(`XML writer boundary passed: no direct filesystem mutation in ${files.join(', ')}.`);
    return;
  }

  console.error(`XML writer boundary failed: direct filesystem mutations are forbidden in ${files.join(', ')}.`);
  for (const site of violations) {
    console.error(`  ERROR ${site.file}:${site.line} ${site.method} in ${site.owner} (target: ${site.target})`);
  }
  process.exitCode = 1;
}

function main() {
  const options = readOptions(process.argv.slice(2));
  const sites = scanSource(options.sourceRoot);
  enforceNoMutationsInFiles(options.enforceFiles, sites);
  if (options.writeBaseline) {
    writeBaseline(options.baselinePath, sites);
  } else {
    checkBaseline(options.baselinePath, sites);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
