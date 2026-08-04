const fs = require('fs');
const Module = require('module');
const path = require('path');

const bundlePath = path.resolve(__dirname, '..', 'dist', 'agent', 'mcpAdapter', 'sessionRouter.js');

if (!fs.existsSync(bundlePath)) {
  throw new Error(`MCP session router bundle is missing: ${bundlePath}`);
}

const bundle = fs.readFileSync(bundlePath, 'utf8');
const externalDependencyPattern = /\b(?:require|import)\(\s*['"](?:@modelcontextprotocol\/sdk|zod)(?:\/[^'"]*)?['"]\s*\)/;
if (externalDependencyPattern.test(bundle)) {
  throw new Error('MCP session router bundle still loads @modelcontextprotocol/sdk or zod externally');
}

const originalLoad = Module._load;
Module._load = function loadWithVscodeStub(request, parent, isMain) {
  if (request === 'vscode') {
    return { commands: { executeCommand: () => undefined } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const bundledModule = require(bundlePath);
  if (typeof bundledModule.createMcpSessionRouter !== 'function') {
    throw new Error('MCP session router bundle does not export createMcpSessionRouter');
  }
} finally {
  Module._load = originalLoad;
}

console.log('MCP session router bundle verification passed');
