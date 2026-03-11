# 1C Metadata Tree - VS Code Extension

VS Code extension for visualizing and editing 1C configuration metadata tree.

## Features

- **Metadata Tree View**: Display complete hierarchy of 1C configuration metadata
- **Properties Panel**: Edit metadata element properties
- **File Synchronization**: Automatic sync between UI and XML files
- **Search & Filter**: Quick search and filtering by metadata type
- **Element Operations**: Create, duplicate, delete, and rename metadata elements

## Supported Formats

- Designer format (structured XML)
- EDT format (coming soon)

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

### Phase 1: Infrastructure (Current)
- Project initialization
- Basic VS Code integration
- Logger setup
- Tree and Properties providers skeleton

### Phase 2: Parsing & Tree Building
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

## Configuration

The extension activates when:
- A workspace contains `1cv8.cf` or `1cv8.cfe` files
- User runs the "1C: Open Metadata Tree" command

## Keyboard Shortcuts

- `Ctrl+Shift+M` (Cmd+Shift+M on Mac): Open/close metadata tree panel

## License

MIT
