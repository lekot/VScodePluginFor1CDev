#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '..');
const defaultSourceRoot = path.join(repoRoot, 'src');
const defaultBaselinePath = path.join(repoRoot, '.github', 'mutation-writer-baseline.json');
const mutationMethods = new Set([
  'write', 'writeSync', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
  'rename', 'renameSync', 'unlink', 'unlinkSync', 'rm', 'rmSync',
  'rmdir', 'rmdirSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'link', 'linkSync',
  'symlink', 'symlinkSync', 'truncate', 'truncateSync', 'mkdir', 'mkdirSync',
  'createWriteStream',
]);
const twoPathMutationMethods = new Set([
  'rename', 'renameSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync',
  'link', 'linkSync', 'symlink', 'symlinkSync',
]);
const fileOpenMethods = new Set(['open', 'openSync']);
const allowedBoundaryPrefix = 'src/services/configurationSession/';

function readOptions(argv) {
  const options = {
    sourceRoot: defaultSourceRoot,
    baselinePath: defaultBaselinePath,
    writeBaseline: false,
    writeInventory: undefined,
    enforceFiles: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write-baseline') {
      options.writeBaseline = true;
    } else if (arg === '--write-inventory' && argv[i + 1]) {
      options.writeInventory = path.resolve(argv[++i]);
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
  --baseline <path>     Approved version 2 policy JSON path
  --enforce-files <list> Comma-separated src-relative files where direct mutations fail
  --write-inventory <path> Write observed sites to a separate inventory file
  --write-baseline      Removed; review an inventory and update policy manually

Normal checks fail when observed mutation sites differ from the approved policy.`);
}

function isFileSystemModule(moduleName) {
  return moduleName === 'fs' || moduleName === 'node:fs'
    || moduleName === 'fs/promises' || moduleName === 'node:fs/promises';
}

function isPromisesModule(moduleName) {
  return moduleName === 'fs/promises' || moduleName === 'node:fs/promises';
}

function createScope(parent, kind) {
  const scope = { parent, kind, bindings: new Map(), functionScope: undefined };
  scope.functionScope = kind === 'root' || kind === 'function'
    ? scope
    : parent?.functionScope ?? scope;
  return scope;
}

function isFunctionScopeNode(node) {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node);
}

function isBlockScopeNode(node) {
  return ts.isBlock(node)
    || ts.isModuleBlock(node)
    || ts.isCatchClause(node)
    || ts.isForStatement(node)
    || ts.isForInStatement(node)
    || ts.isForOfStatement(node)
    || ts.isClassDeclaration(node)
    || ts.isClassExpression(node);
}

function unwrapExpression(expression) {
  let current = expression;
  while (current) {
    if (ts.isParenthesizedExpression(current)
      || ts.isAwaitExpression(current)
      || ts.isAsExpression(current)
      || ts.isTypeAssertionExpression(current)
      || ts.isNonNullExpression(current)
      || (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(current))) {
      current = current.expression;
      continue;
    }
    break;
  }
  return current;
}

function staticPropertyName(expression) {
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  if (ts.isElementAccessExpression(expression)
    && expression.argumentExpression
    && ts.isStringLiteralLike(expression.argumentExpression)) {
    return expression.argumentExpression.text;
  }
  return undefined;
}

function createFilesystemBindings(sourceFile) {
  const rootScope = createScope(undefined, 'root');
  const scopeByNode = new WeakMap();
  const variableBindings = [];

  function declare(scope, identifier, declaration, extra = {}) {
    if (!identifier || !ts.isIdentifier(identifier)) {
      return undefined;
    }
    const binding = {
      name: identifier.text,
      declaration,
      patternPath: [],
      origin: undefined,
      ...extra,
    };
    scope.bindings.set(binding.name, binding);
    return binding;
  }

  function declarePattern(name, scope, declaration, patternPath = []) {
    if (ts.isIdentifier(name)) {
      const binding = declare(scope, name, declaration, { patternPath });
      if (binding) {
        variableBindings.push(binding);
      }
      return;
    }
    if (ts.isObjectBindingPattern(name)) {
      for (const element of name.elements) {
        if (element.dotDotToken) {
          declarePattern(element.name, scope, declaration, patternPath);
          continue;
        }
        const key = element.propertyName
          ? (ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName)
            ? element.propertyName.text
            : (ts.isComputedPropertyName(element.propertyName)
              && ts.isStringLiteralLike(element.propertyName.expression)
              ? element.propertyName.expression.text
              : '<computed>'))
          : (ts.isIdentifier(element.name) ? element.name.text : undefined);
        declarePattern(element.name, scope, declaration, key === undefined ? patternPath : [...patternPath, key]);
      }
      return;
    }
    if (ts.isArrayBindingPattern(name)) {
      name.elements.forEach((element, index) => {
        if (ts.isBindingElement(element)) {
          declarePattern(element.name, scope, declaration, [...patternPath, String(index)]);
        }
      });
    }
  }

  function declareImport(statement, scope) {
    const moduleName = statement.moduleSpecifier?.text;
    if (!moduleName || !isFileSystemModule(moduleName)) {
      return;
    }
    const importedOrigin = isPromisesModule(moduleName)
      ? { type: 'promises' }
      : { type: 'namespace' };
    const clause = statement.importClause;
    if (!clause) {
      return;
    }
    if (clause.name) {
      declare(scope, clause.name, clause, { origin: importedOrigin });
    }
    if (!clause.namedBindings) {
      return;
    }
    if (ts.isNamespaceImport(clause.namedBindings)) {
      declare(scope, clause.namedBindings.name, clause, { origin: importedOrigin });
      return;
    }
    if (ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        let origin;
        if (!isPromisesModule(moduleName) && importedName === 'promises') {
          origin = { type: 'promises' };
        } else if (mutationMethods.has(importedName) || fileOpenMethods.has(importedName)) {
          origin = {
            type: 'direct',
            method: importedName,
            ...(isPromisesModule(moduleName) && importedName === 'open' ? { returnsFileHandle: true } : {}),
          };
        }
        declare(scope, element.name, element, { origin });
      }
    }
  }

  function visit(node, parentScope) {
    let scope = parentScope;
    if (node !== sourceFile && isFunctionScopeNode(node)) {
      scope = createScope(parentScope, 'function');
    } else if (node !== sourceFile && isBlockScopeNode(node)) {
      scope = createScope(parentScope, 'block');
    }
    scopeByNode.set(node, scope);

    if (ts.isImportDeclaration(node)) {
      declareImport(node, parentScope);
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
      && ts.isStringLiteral(node.moduleReference.expression)
      && isFileSystemModule(node.moduleReference.expression.text)) {
      declare(parentScope, node.name, node, {
        origin: isPromisesModule(node.moduleReference.expression.text)
          ? { type: 'promises' }
          : { type: 'namespace' },
      });
    } else if (ts.isVariableDeclaration(node)) {
      const flags = node.parent.flags;
      const declarationScope = flags & ts.NodeFlags.BlockScoped || ts.isCatchClause(node.parent)
        ? scope
        : scope.functionScope;
      declarePattern(node.name, declarationScope, node);
    } else if (ts.isParameter(node)) {
      declarePattern(node.name, scope, node);
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      declare(parentScope, node.name, node);
    } else if (ts.isFunctionExpression(node) && node.name) {
      declare(scope, node.name, node);
    } else if (ts.isClassDeclaration(node) && node.name) {
      declare(parentScope, node.name, node);
      declare(scope, node.name, node);
    } else if (ts.isClassExpression(node) && node.name) {
      declare(scope, node.name, node);
    } else if (ts.isEnumDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      if (node.name) {
        declare(parentScope, node.name, node);
      }
    }

    ts.forEachChild(node, (child) => visit(child, scope));
  }

  visit(sourceFile, rootScope);

  function resolve(identifier) {
    if (!identifier || !ts.isIdentifier(identifier)) {
      return undefined;
    }
    for (let scope = scopeByNode.get(identifier); scope; scope = scope.parent) {
      const binding = scope.bindings.get(identifier.text);
      if (binding) {
        return binding;
      }
    }
    return undefined;
  }

  function requireOrigin(expression) {
    const current = unwrapExpression(expression);
    if (!ts.isCallExpression(current)
      || !ts.isIdentifier(current.expression)
      || current.expression.text !== 'require'
      || current.arguments.length !== 1
      || !ts.isStringLiteralLike(current.arguments[0])
      || resolve(current.expression)) {
      return undefined;
    }
    const moduleName = current.arguments[0].text;
    if (!isFileSystemModule(moduleName)) {
      return undefined;
    }
    return isPromisesModule(moduleName) ? { type: 'promises' } : { type: 'namespace' };
  }

  function selectProperty(origin, propertyName) {
    if (!origin || !propertyName) {
      return undefined;
    }
    if (propertyName === '<computed>'
      && (origin.type === 'namespace' || origin.type === 'promises' || origin.type === 'handle')) {
      return { type: 'dynamicFunction', method: '<computed>' };
    }
    if (origin.type === 'namespace' && propertyName === 'promises') {
      return { type: 'promises' };
    }
    if ((origin.type === 'namespace' || origin.type === 'promises')
      && (mutationMethods.has(propertyName) || fileOpenMethods.has(propertyName))) {
      return {
        type: 'direct',
        method: propertyName,
        ...(origin.type === 'promises' && propertyName === 'open' ? { returnsFileHandle: true } : {}),
      };
    }
    if (origin.type === 'handle' && (propertyName === 'writeFile' || propertyName === 'write')) {
      return { type: 'handleWriter', method: propertyName, handleTarget: origin.target };
    }
    return undefined;
  }

  function getOrigin(expression) {
    const current = unwrapExpression(expression);
    if (!current) {
      return undefined;
    }
    if (ts.isIdentifier(current)) {
      return resolve(current)?.origin;
    }
    if (ts.isCallExpression(current)) {
      const callee = unwrapExpression(current.expression);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'bind') {
        const receiverOrigin = getOrigin(callee.expression);
        if (receiverOrigin?.type === 'boundFunction'
          || receiverOrigin?.type === 'direct'
          || receiverOrigin?.type === 'dynamicFunction'
          || receiverOrigin?.type === 'handleWriter') {
          const method = receiverOrigin.method;
          if (receiverOrigin.type === 'dynamicFunction'
            || mutationMethods.has(method)
            || fileOpenMethods.has(method)) {
            const inheritedArguments = receiverOrigin.type === 'boundFunction'
              ? receiverOrigin.boundArguments
              : [];
            return {
              type: 'boundFunction',
              method,
              boundArguments: [...inheritedArguments, ...current.arguments.slice(1)],
              ...(receiverOrigin.returnsFileHandle ? { returnsFileHandle: true } : {}),
              ...(receiverOrigin.handleTarget ? { handleTarget: receiverOrigin.handleTarget } : {}),
            };
          }
        }
      }
    }
    const requiredOrigin = requireOrigin(current);
    if (requiredOrigin) {
      return requiredOrigin;
    }
    if (ts.isBinaryExpression(current)
      && (current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        || current.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      const leftOrigin = getOrigin(current.left);
      const rightOrigin = getOrigin(current.right);
      if (!leftOrigin) {
        return rightOrigin;
      }
      if (!rightOrigin) {
        return leftOrigin;
      }
      if (leftOrigin.type === rightOrigin.type && leftOrigin.method === rightOrigin.method) {
        return leftOrigin;
      }
      if (leftOrigin.type === 'direct' && leftOrigin.method === 'open') {
        return leftOrigin;
      }
      if (rightOrigin.type === 'direct' && rightOrigin.method === 'open') {
        return rightOrigin;
      }
      return { type: 'dynamicFunction', method: '<coalesced>' };
    }
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const propertyName = staticPropertyName(current);
      const receiverOrigin = getOrigin(current.expression);
      if (propertyName !== undefined) {
        return selectProperty(receiverOrigin, propertyName);
      }
      if (receiverOrigin?.type === 'namespace'
        || receiverOrigin?.type === 'promises'
        || receiverOrigin?.type === 'handle') {
        return { type: 'dynamicFunction', method: '<computed>' };
      }
    }
    return undefined;
  }

  function inferVariableOrigin(binding) {
    const initializer = binding.declaration.initializer;
    if (!initializer) {
      return undefined;
    }
    let origin;
    if (binding.patternPath.length > 0) {
      origin = getOrigin(initializer);
      for (const propertyName of binding.patternPath) {
        origin = selectProperty(origin, propertyName);
      }
      return origin;
    }
    const current = unwrapExpression(initializer);
    if (ts.isCallExpression(current)) {
      const required = requireOrigin(current);
      if (required) {
        return required;
      }
      const calledOrigin = getOrigin(current.expression);
      const boundArguments = calledOrigin?.type === 'boundFunction' ? calledOrigin.boundArguments : [];
      if ((calledOrigin?.type === 'direct' || calledOrigin?.type === 'boundFunction')
        && calledOrigin.method === 'open'
        && calledOrigin.returnsFileHandle
        && isWriteOpen(current, boundArguments)) {
        const effectiveArguments = [...boundArguments, ...current.arguments];
        return { type: 'handle', target: effectiveArguments[0] };
      }
    }
    return getOrigin(current);
  }

  for (let pass = 0; pass <= variableBindings.length; pass += 1) {
    let changed = false;
    for (const binding of variableBindings) {
      const origin = inferVariableOrigin(binding);
      if (origin && (!binding.origin || binding.origin.type === 'unknown')) {
        binding.origin = origin;
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }

  return { scopeByNode, resolve, getOrigin };
}

function isWriteOpen(call, boundArguments = []) {
  const flags = [...boundArguments, ...call.arguments][1];
  if (!flags) {
    return false;
  }
  const value = unwrapExpression(flags);
  if (ts.isStringLiteralLike(value)) {
    return /[wax+]/i.test(value.text);
  }
  if (ts.isNumericLiteral(value)) {
    return Number(value.text) !== 0;
  }
  const expressionText = value.getText().replace(/\s+/g, '');
  if (/\bO_RDONLY\b/.test(expressionText)
    && !/\b(?:O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND)\b/.test(expressionText)) {
    return false;
  }
  if (/\b(?:O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND)\b/.test(expressionText)) {
    return true;
  }
  return true;
}

function isFileMutationCall(call, aliases) {
  const current = unwrapExpression(call.expression);
  const origin = aliases.getOrigin(current);
  if (!origin) {
    return undefined;
  }
  if (origin.type === 'dynamicFunction') {
    return { method: origin.method, boundArguments: [] };
  }
  if (origin.type === 'boundFunction') {
    if (fileOpenMethods.has(origin.method)) {
      return isWriteOpen(call, origin.boundArguments)
        ? { method: origin.method, boundArguments: origin.boundArguments }
        : undefined;
    }
    return mutationMethods.has(origin.method)
      ? {
        method: origin.method,
        boundArguments: origin.boundArguments,
        ...(origin.handleTarget ? { handleTarget: origin.handleTarget } : {}),
      }
      : undefined;
  }
  if (origin.type === 'handleWriter') {
    return { method: origin.method, boundArguments: [], handleTarget: origin.handleTarget };
  }
  if (origin.type === 'direct') {
    if (fileOpenMethods.has(origin.method)) {
      return isWriteOpen(call) ? { method: origin.method, boundArguments: [] } : undefined;
    }
    return mutationMethods.has(origin.method)
      ? { method: origin.method, boundArguments: [] }
      : undefined;
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

function mutationTargetExpression(call, method, sourceFile, boundArguments = [], handleTarget) {
  const normalizeArgument = (argument) => argument?.getText(sourceFile).replace(/\s+/g, ' ').trim() ?? '<none>';
  if (handleTarget) {
    return normalizeArgument(handleTarget);
  }
  const argumentsList = [...boundArguments, ...call.arguments];
  const sourceExpression = normalizeArgument(argumentsList[0]);
  if (!twoPathMutationMethods.has(method)) {
    return sourceExpression;
  }
  return JSON.stringify([sourceExpression, normalizeArgument(argumentsList[1])]);
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
    const aliases = createFilesystemBindings(sourceFile);
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const mutation = isFileMutationCall(node, aliases);
        if (mutation) {
          const { method, boundArguments, handleTarget } = mutation;
          const targetExpression = mutationTargetExpression(node, method, sourceFile, boundArguments, handleTarget);
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

function readApprovedPolicy(policyPath) {
  if (!fs.existsSync(policyPath)) {
    throw new Error(`Approved mutation writer policy not found: ${policyPath}`);
  }
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error(`Invalid mutation writer policy: expected an object: ${policyPath}`);
  }
  if (policy.kind === 'observed-inventory') {
    throw new Error(`Observed mutation inventory is not an approved policy: ${policyPath}`);
  }
  if (policy.version !== 2 || !Array.isArray(policy.sites)) {
    throw new Error(`Unsupported mutation writer policy format (expected version 2): ${policyPath}`);
  }
  const policyFields = Object.keys(policy).sort();
  if (JSON.stringify(policyFields) !== JSON.stringify(['sites', 'version'])) {
    throw new Error(`Invalid mutation writer policy: expected exactly version and sites: ${policyPath}`);
  }

  const expectedFields = ['count', 'file', 'method', 'owner', 'reason', 'responsibility', 'target'];
  const seenKeys = new Set();
  for (let index = 0; index < policy.sites.length; index += 1) {
    const site = policy.sites[index];
    if (!site || typeof site !== 'object' || Array.isArray(site)) {
      throw new Error(`Invalid mutation writer policy site ${index + 1}: expected an object`);
    }
    const fields = Object.keys(site).sort();
    if (JSON.stringify(fields) !== JSON.stringify(expectedFields)) {
      throw new Error(`Invalid mutation writer policy site ${index + 1}: expected exactly ${expectedFields.join(', ')}`);
    }
    for (const field of ['file', 'owner', 'method', 'target']) {
      if (typeof site[field] !== 'string' || site[field].trim().length === 0) {
        throw new Error(`Invalid mutation writer policy site ${index + 1}: ${field} must be a nonempty string`);
      }
    }
    if (!Number.isSafeInteger(site.count) || site.count < 1) {
      throw new Error(`Invalid mutation writer policy site ${index + 1}: count must be a positive integer`);
    }
    const emptyApprovalFields = ['reason', 'responsibility'].filter((field) =>
      typeof site[field] !== 'string' || site[field].trim().length === 0);
    if (emptyApprovalFields.length > 0) {
      throw new Error(`Invalid mutation writer policy site ${index + 1}: ${emptyApprovalFields.join(' and ')} must be nonempty`);
    }
    const key = siteKey(site);
    if (seenKeys.has(key)) {
      throw new Error(`Invalid mutation writer policy: duplicate site ${site.file} ${site.owner} ${site.method} ${site.target}`);
    }
    seenKeys.add(key);
  }
  return policy;
}

function recordsFromSites(sites) {
  const counts = countSites(sites);
  return Array.from(counts.entries()).map(([key, count]) => {
    const [file, owner, method, target] = JSON.parse(key);
    return { file, owner, method, target, count };
  }).sort((left, right) => siteKey(left).localeCompare(siteKey(right)));
}

function writeObservedInventory(inventoryPath, sites) {
  const records = recordsFromSites(sites);
  fs.mkdirSync(path.dirname(inventoryPath), { recursive: true });
  fs.writeFileSync(inventoryPath, `${JSON.stringify({ kind: 'observed-inventory', sites: records }, null, 2)}\n`, 'utf8');
  console.log(`Observed mutation inventory written (${sites.length} calls across ${records.length} sites): ${inventoryPath}`);
}

function checkApprovedPolicy(policyPath, sites) {
  const policy = readApprovedPolicy(policyPath);
  const approvedCounts = new Map(policy.sites.map((site) => [siteKey(site), site.count]));
  const observedCounts = countSites(sites);

  const errors = [];
  for (const site of sites.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)) {
    const key = siteKey(site);
    const approved = approvedCounts.get(key) ?? 0;
    const observed = observedCounts.get(key) ?? 0;
    if (approved === 0) {
      errors.push(`Unapproved direct filesystem mutation: ${site.file}:${site.line} ${site.method} in ${site.owner} (target: ${site.target})`);
    } else if (observed > approved) {
      errors.push(`Mutation writer count increased: ${site.file} ${site.method} in ${site.owner} (target: ${site.target}, approved ${approved}, observed ${observed})`);
    }
  }
  for (const approvedSite of policy.sites) {
    const key = siteKey(approvedSite);
    const observed = observedCounts.get(key) ?? 0;
    if (observed === 0) {
      errors.push(`Stale approved mutation writer site: ${approvedSite.file} ${approvedSite.method} in ${approvedSite.owner} (target: ${approvedSite.target})`);
    } else if (observed < approvedSite.count) {
      errors.push(`Mutation writer count reduced: ${approvedSite.file} ${approvedSite.method} in ${approvedSite.owner} (target: ${approvedSite.target}, approved ${approvedSite.count}, observed ${observed})`);
    }
  }

  if (errors.length > 0) {
    console.error(`Mutation writer policy check failed with ${errors.length} violation(s):`);
    for (const error of errors) {
      console.error(`  ERROR ${error}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`Mutation writer policy check passed: ${sites.length} observed mutation call(s) match ${policy.sites.length} reviewed site(s).`);
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
  if (options.writeBaseline) {
    throw new Error('--write-baseline was removed because it auto-approves observed writers. Use --write-inventory <path> and review policy changes explicitly.');
  }
  if (options.writeInventory) {
    const inventoryPath = path.resolve(options.writeInventory);
    const policyPath = path.resolve(options.baselinePath);
    const samePath = process.platform === 'win32'
      ? inventoryPath.toLowerCase() === policyPath.toLowerCase()
      : inventoryPath === policyPath;
    if (samePath) {
      throw new Error('--write-inventory path must differ from the approved policy path.');
    }
  }
  const sites = scanSource(options.sourceRoot);
  enforceNoMutationsInFiles(options.enforceFiles, sites);
  if (options.writeInventory) {
    writeObservedInventory(options.writeInventory, sites);
    return;
  }
  checkApprovedPolicy(options.baselinePath, sites);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
