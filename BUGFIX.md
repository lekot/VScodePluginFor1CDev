# Bugfix: Extension Loading Error - Missing Dependencies

## Problem

Extension failed to load with error:
```
at Module.require (node:internal/modules/cjs/loader:1470:12)
at Object.<anonymous> (c:\Users\...\node_modules\fast-xml-parser\src\xmlparser\OrderedObjParser.js:7:18)
```

## Root Cause

The VSIX package was missing transitive dependencies. While `fast-xml-parser` was included in the package, its dependency `strnum` was not, causing the extension to fail during module loading.

## Solution

Modified `.vscodeignore` to include all `node_modules` in the VSIX package instead of selectively including only `fast-xml-parser`.

### Changes Made

**Before:**
```
**/*.map
**/*.ts
node_modules/**
!node_modules/fast-xml-parser/**
```

**After:**
```
**/*.map
**/*.ts
```

This ensures all runtime dependencies (both direct and transitive) are included in the packaged extension.

## Verification

1. Compiled TypeScript: `node node_modules/typescript/bin/tsc -p .`
2. Packaged extension: `node node_modules/@vscode/vsce/vsce package --out 1c-metadata-tree-vscode-0.1.4.vsix`
3. Verified package contents include:
   - `fast-xml-parser/` (53 files, 190.58 KB)
   - `strnum/` (7 files, 18.8 KB)
4. Installed and tested - extension loads successfully and displays metadata tree

## Package Size Impact

- Before: 86 files, 122.27 KB
- After: 92 files, 125.73 KB
- Increase: 6 files, 3.46 KB (acceptable for reliability)

## Alternative Solutions Considered

1. **Bundling with webpack/esbuild** - Would reduce package size but requires additional build configuration
2. **Selective dependency inclusion** - Too fragile, requires manual tracking of transitive dependencies

The current solution prioritizes reliability and maintainability over minimal package size.
