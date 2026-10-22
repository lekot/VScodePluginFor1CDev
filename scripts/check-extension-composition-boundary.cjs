const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const failures = [];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function parse(relativePath) {
  return parseText(relativePath, read(relativePath));
}

function parseText(relativePath, sourceText) {
  return ts.createSourceFile(
    relativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function visit(node, action) {
  action(node);
  ts.forEachChild(node, (child) => visit(child, action));
}

function assert(condition, message) {
  if (!condition) failures.push(message);
}

const forbiddenStateModules = new Set([
  'src/state/extensionState',
  'src/state/extensionStateComposition',
]);
const forbiddenExtensionEntryModules = new Set(['src/extension']);
const forbiddenCompositionModules = new Set([
  'src/extension/agentFeatureComposition',
  'src/extension/supportFeatureComposition',
  'src/extension/extensionCompositionRoot',
]);
const stateAssemblyImportAllowlist = new Set([
  'src/extension/agentFeatureComposition.ts',
  'src/extension/extensionCompositionRoot.ts',
  'src/extension/extensionFeatureContexts.ts',
  'src/extension/extensionWorkspaceSetup.ts',
  'src/extension/supportFeatureComposition.ts',
  'src/extension.ts',
  'src/state/extensionState.ts',
  'src/state/extensionStateComposition.ts',
]);
const compositionFactoryExports = new Set([
  'createAgentFeatureComposition',
  'createSupportFeatureComposition',
  'createExtensionCompositionRoot',
  'createExtensionState',
]);
const builtInDataConstructors = new Set(['Date', 'Map', 'Promise', 'RegExp', 'Set', 'WeakMap', 'WeakSet']);

function resolveImportPath(relativePath, specifier) {
  if (!specifier.startsWith('.')) return specifier;
  const absolutePath = path.resolve(root, path.dirname(relativePath), specifier).replace(/\\/g, '/');
  const resolved = path.relative(root, absolutePath).replace(/\\/g, '/');
  return resolved.replace(/\.tsx?$/u, '');
}

function calleeName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function analyzeCommandIndexSource(sourceText, relativePath = 'src/commands/index.ts') {
  const source = parseText(relativePath, sourceText);
  const violations = [];
  const importedFactoryAliases = new Set(compositionFactoryExports);
  const factoryNamespaces = new Set();

  visit(source, (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const importedPath = resolveImportPath(relativePath, node.moduleSpecifier.text);
      if (forbiddenStateModules.has(importedPath)) {
        violations.push(`${relativePath} imports the extension state assembly.`);
      }
      const typeOnlyRootContract = importedPath === 'src/extension/extensionCompositionRoot'
        && node.importClause?.isTypeOnly;
      if (forbiddenCompositionModules.has(importedPath) && !typeOnlyRootContract) {
        violations.push(`${relativePath} imports composition module ${importedPath}.`);
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if (compositionFactoryExports.has(element.propertyName?.text ?? element.name.text)) {
              importedFactoryAliases.add(element.name.text);
            }
          }
        } else if (bindings && ts.isNamespaceImport(bindings)) {
          factoryNamespaces.add(bindings.name.text);
        }
      }
    }
    if (ts.isNewExpression(node)) {
      const constructorName = node.expression.getText(source);
      if (!['Error', 'TypeError'].includes(constructorName) && !builtInDataConstructors.has(constructorName)) {
        violations.push(`${relativePath} constructs ${constructorName}.`);
      }
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      const namespaceFactoryCall = ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && factoryNamespaces.has(node.expression.expression.text)
        && compositionFactoryExports.has(node.expression.name.text);
      if ((name && importedFactoryAliases.has(name)) || namespaceFactoryCall) {
        violations.push(`${relativePath} calls composition factory ${node.expression.getText(source)}.`);
      }
    }
  });

  return violations;
}

function runFixtureChecks() {
  const validSource = [
    "import { registerAgentCommands } from '../agent/agentCommands';",
    "import type { ConfigurationInfrastructure } from '../extension/extensionCompositionRoot';",
    'const disposables = new Set();',
    'registerAgentCommands(deps);',
  ].join('\n');
  assert(
    analyzeCommandIndexSource(validSource).length === 0,
    'Guard fixture: typed registrar imports and built-in data containers must be allowed.',
  );

  const aliasedFactorySource = [
    "import { createAgentFeatureComposition as buildAgentGraph } from '../extension/agentFeatureComposition';",
    'buildAgentGraph(deps);',
  ].join('\n');
  const aliasedFactoryViolations = analyzeCommandIndexSource(aliasedFactorySource);
  assert(
    aliasedFactoryViolations.some((item) => item.includes('imports composition module'))
      && aliasedFactoryViolations.some((item) => item.includes('calls composition factory buildAgentGraph')),
    'Guard fixture: imported and aliased composition factory calls must be rejected.',
  );

  const namespaceFactorySource = [
    "import * as supportGraph from '../extension/supportFeatureComposition';",
    'supportGraph.createSupportFeatureComposition(deps);',
  ].join('\n');
  const namespaceViolations = analyzeCommandIndexSource(namespaceFactorySource);
  assert(
    namespaceViolations.some((item) => item.includes('calls composition factory')),
    'Guard fixture: namespace composition factory calls must be rejected.',
  );

  const serviceConstructionSource = "import { AgentTaskManager } from '../agent/agentTaskManager'; new AgentTaskManager();";
  assert(
    analyzeCommandIndexSource(serviceConstructionSource).some((item) => item.includes('constructs AgentTaskManager')),
    'Guard fixture: service construction in the command registrar must be rejected.',
  );

  const agentStateImport = "import type { ExtensionState } from '../state/extensionState';";
  assert(
    analyzeStateAssemblyImports('src/agent/agentCommands.ts', agentStateImport).length === 1,
    'Guard fixture: Agent feature modules must not import the extension state facade.',
  );

  const providerCompositionImport = "import type { ExtensionStateCompositionPort } from '../state/extensionStateComposition';";
  assert(
    analyzeStateAssemblyImports('src/providers/exampleProvider.ts', providerCompositionImport).length === 1,
    'Guard fixture: provider feature modules must not import the state composition port.',
  );

  const agentDiagnosticsImport = "import { extensionDiagnostics } from '../extension';";
  assert(
    analyzeStateAssemblyImports('src/agent/agentCommands.ts', agentDiagnosticsImport)
      .some((item) => item.includes('imports the extension activation entry module')),
    'Guard fixture: Agent feature modules must not import the extension entry diagnostics view.',
  );
}

if (process.argv.includes('--self-test')) {
  runFixtureChecks();
  if (failures.length > 0) {
    console.error('Extension composition boundary fixture failures:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('Extension composition boundary fixture checks passed.');
  }
  process.exit();
}

const statePath = 'src/state/extensionState.ts';
const stateFile = parse(statePath);
let stateFacade;
visit(stateFile, (node) => {
  if (ts.isInterfaceDeclaration(node) && node.name.text === 'ExtensionState') {
    stateFacade = node;
  }
  if (ts.isClassDeclaration(node) && node.name?.text === 'ExtensionState') {
    failures.push('ExtensionState implementation must remain private behind the factory.');
  }
});
assert(Boolean(stateFacade), 'ExtensionState readonly facade interface must exist.');
if (stateFacade) {
  for (const member of stateFacade.members) {
    if (ts.isSetAccessorDeclaration(member)) {
      failures.push(`ExtensionState exposes a public setter: ${member.name.getText(stateFile)}.`);
    }
    if (ts.isMethodSignature(member) && member.name.getText(stateFile) === 'init') {
      failures.push('ExtensionState exposes standalone init().');
    }
    if (ts.isMethodSignature(member) && member.name.getText(stateFile) === 'disposeOwnedState') {
      failures.push('ExtensionState owns an independent teardown graph.');
    }
  }
}
assert(/Object\.freeze\(state\)/u.test(read(statePath)), 'ExtensionState facade must be frozen at runtime.');

const commandIndexPath = 'src/commands/index.ts';
failures.push(...analyzeCommandIndexSource(read(commandIndexPath), commandIndexPath));

function collectTypeScriptFiles(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.posix.join(directory.replace(/\\/g, '/'), entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(relativePath);
    return entry.isFile() && relativePath.endsWith('.ts') ? [relativePath] : [];
  });
}
function analyzeStateAssemblyImports(relativePath, sourceText = read(relativePath)) {
  if (stateAssemblyImportAllowlist.has(relativePath)) return [];
  const source = parseText(relativePath, sourceText);
  const violations = [];
  visit(source, (node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
    const specifier = node.moduleSpecifier.text.replace(/\\/g, '/');
    const importedPath = resolveImportPath(relativePath, specifier);
    if (forbiddenStateModules.has(importedPath)) {
      violations.push(`${relativePath} imports the extension state assembly.`);
    }
    if (forbiddenExtensionEntryModules.has(importedPath)) {
      violations.push(`${relativePath} imports the extension activation entry module.`);
    }
  });
  return violations;
}

for (const relativePath of collectTypeScriptFiles('src')) {
  failures.push(...analyzeStateAssemblyImports(relativePath));
}

const lifecyclePath = 'src/extension/metadataTreeLifecycle.ts';
const lifecycle = read(lifecyclePath);
if (/state\.metadataWatchers\s*=/.test(lifecycle)) {
  failures.push('metadataTreeLifecycle publishes watcher ownership through ExtensionState.');
}

if (failures.length > 0) {
  console.error('Extension composition boundary violations:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Extension composition boundary checks passed.');
}
