# 1C Metadata Tree - VS Code Extension

VS Code extension for visualizing and editing 1C configuration metadata tree.

## Status

**Phase 1: Infrastructure** ✅ COMPLETED  
**Phase 2: Parsers** ✅ COMPLETED (11 марта 2026)

- ✅ XML парсер (fast-xml-parser)
- ✅ Designer format parser
- ✅ EDT format parser
- ✅ Format auto-detection
- ✅ Error handling system
- ✅ Async/await refactoring (performance optimization)
- ✅ MetadataTypeMapper (code deduplication)
- ✅ Unit tests for all parsers

**Next**: Phase 3 - UI Components (Tree View)

## Features

- **Metadata Tree View**: Display complete hierarchy of 1C configuration metadata
- **Properties Panel**: Edit metadata element properties
- **File Synchronization**: Automatic sync between UI and XML files
- **Search & Filter**: Quick search and filtering by metadata type
- **Element Operations**: Create, duplicate, delete, and rename metadata elements

## Supported Formats

- ✅ Designer format (structured XML)
- ✅ EDT format (structured XML with .mdo files)
- ✅ Automatic format detection

## Installation

1. Clone the repository
2. Run `npm install`
3. Press `F5` to start debugging

## Development

### Build

```bash
npm run compile
```

### Watch Mode

```bash
npm run watch
```

### Lint

```bash
npm run lint
```

### Format

```bash
npm run format
```

### Test

```bash
npm run test
```

### Debug in VS Code

Press `F5` to launch the extension in debug mode. A new VS Code window will open with the extension loaded.

## Build Artifacts

- **Source:** `src/` (TypeScript)
- **Compiled:** `dist/` (JavaScript + source maps + type definitions)
- **Archive:** `build/` (copy of dist for backup)

### Compilation Details

- **Compiler:** TypeScript 5.0.0
- **Target:** ES2020, CommonJS
- **Source Maps:** Generated for debugging
- **Type Definitions:** Generated (.d.ts files)
- **Total Files:** 24 (8 JS + 8 D.TS + 8 source maps)

## Project Structure

```
src/
├── extension.ts           # Extension entry point
├── models/               # Data models
├── parsers/              # XML parsers
├── providers/            # VS Code providers
└── utils/                # Utility functions
```

## Architecture

### Phase 1: Infrastructure (✅ COMPLETED)
- Project initialization
- Basic VS Code integration
- Logger setup
- Tree and Properties providers skeleton

### Phase 2: Parsing & Tree Building (NEXT)
- Designer format parser implementation
- Tree node building
- Caching system

### Phase 3: UI Display
- Tree view rendering
- Context menu
- Keyboard shortcuts

### Phase 4: Properties Panel
- Properties view implementation
- Property editing
- Validation

### Phase 5: File Synchronization
- File watcher
- Conflict resolution
- Change persistence

## Solutions & Decisions

### Node.js PATH Issue
**Problem:** npm not found in PATH on Windows
**Solution:** Use full path with cmd.exe: `C:\Program Files\nodejs\npm.cmd`

### TypeScript Strict Mode
**Decision:** Enabled strict mode for type safety
- `noImplicitAny`: true
- `strictNullChecks`: true
- `noUnusedLocals`: true

### Designer Format Priority
**Decision:** Start with Designer format (structured XML)
- Has local test examples
- EDT format will follow after MVP

### Conflict Resolution Strategy
**Decision:** Last write wins (default)
- Merge when possible
- Prompt user on conflicts
- Documented in architecture.md

## Configuration

The extension activates when:
- A workspace contains `1cv8.cf` or `1cv8.cfe` files
- User runs the "1C: Open Metadata Tree" command

## Keyboard Shortcuts

- `Ctrl+Shift+M` (Cmd+Shift+M on Mac): Open/close metadata tree panel

## License

MIT
