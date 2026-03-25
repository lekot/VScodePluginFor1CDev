# Разработка расширения CDT 41 (Community Development Tools for 1C)

Указатель документации (gap, архитектура, backlog): [docs/documentation-map.md](docs/documentation-map.md).

## Сборка и тесты

### Компиляция

```bash
npm run compile
```

Результат в `dist/` (основной tsconfig). Для тестов используется `tsconfig.test.json`, выход в `out/`.

### Запуск тестов

**Все тесты** (компиляция по tsconfig.test.json + линт + Mocha):

```bash
npm test
```

**Быстрый прогон** (Windows): компиляция, копирование фикстур в `out/test/fixtures`, запуск набора тестов (парсеры, xmlWriter и др.):

```bash
.\test-suite.bat
```

Тесты лежат в `test/suite/*.test.ts`, компилируются в `out/test/suite/*.test.js`. Фикстуры — `test/fixtures/` (например `designer-config` с Configuration.xml и каталогами).

Тесты, использующие API VS Code (`vscode`), — treeDataProvider, integration, metadataWatcherService — запускаются через **Testing** в VS Code (Run/Debug Tests), а не через `node mocha` в командной строке.

### Добавление теста

1. Создайте файл `test/suite/<name>.test.ts`.
2. Импорты из `../../src/...`.
3. Используйте `suite('...', () => { ... })` и `test('...', () => { ... })` (Mocha TDD).
4. Запустите `npm test` — в прогон попадут все `out/test/suite/*.test.js`.
5. При использовании `test-suite.bat` при необходимости добавьте новый файл в список вызовов mocha в батнике.

### Линтинг и форматирование

```bash
npm run lint
npm run format
```

## Отладка расширения

1. Откройте проект в VS Code.
2. F5 или Run → Start Debugging — запустится Extension Development Host с установленным расширением.
3. В новом окне откройте папку с конфигурацией 1С (EDT или Designer) и проверьте панель «CDT 41».

## IBCMD: задачи VS Code и артефакты отчёта

Для сценария без EDT доступны задачи:

- `CDT: ibcmd — check infobase configuration`
- `CDT: ibcmd — import configuration from XML`

Обе задачи вызывают `node scripts/ibcmd-cli.cjs ...` и используют переменные окружения:

- `IBCMD_PATH` — путь к `ibcmd(.exe)`.
- `IBCMD_INFOBASE_CONFIG` — путь к YAML-конфигу ИБ.
- `IBCMD_USER` / `IBCMD_PASSWORD` — опционально.
- `IBCMD_CONFIG_CHECK_FORCE=1` — только для `check`, добавляет `--force`.
- `MATRIX_WORK_DIR` — только для `import`, корень выгрузки Designer (с `Configuration.xml`).
- `IBCMD_REPORT_DIR` — опционально, каталог отчётов (по умолчанию `.ibcmd-reports` в workspace).

После каждого запуска helper пишет артефакт отчёта:

- `check`: `.ibcmd-reports/check-last.log`
- `import`: `.ibcmd-reports/import-last.log`

Также можно открыть последний отчёт прямо из палитры команд CDT 41:

- `CDT 41: Open last ibcmd check report`
- `CDT 41: Open last ibcmd import report`

В логах задачи печатается путь вида `[ibcmd-cli] report: ...`, а в файле есть команда, exit code, stdout/stderr.

## Структура тестов

- **Парсеры и дерево**: `xmlParser.test.ts`, `designerParser.test.ts`, `metadataParser.test.ts`, `formatDetector.test.ts`, `treeDataProvider.test.ts`.
- **Операции и утилиты**: `elementOperations.test.ts`, `referenceFinder.test.ts`, `elementNameValidator.test.ts`.
- **Сервисы**: `metadataWatcherService.test.ts`.
- **Интеграция**: `integration.test.ts` (загрузка конфигурации из фикстур, отображение в дереве).
- **Панель свойств и редактор типа**: `propertiesProvider.test.ts`, тесты в `src/providers/test/`.

Фикстуры в `test/fixtures/designer-config/` повторяют минимальную структуру конфигурации Designer (Configuration.xml, Catalogs, Documents и т.д.) и используются в интеграционных и парсер-тестах.

## Примеры конфигураций и расширений

В корне проекта могут находиться папки-примеры (не коммитятся, указаны в `.gitignore`):

- **extensions_samples** — пример расширения конфигурации (Configuration.xml, Catalogs, форма с папкой Ext: Form.xml, Module.bsl). Удобно использовать для ручной проверки поддержки расширений: откройте папку `extensions_samples` в VS Code как workspace и убедитесь, что дерево метаданных отображает конфигурацию и узлы Ext (например, форма элемента справочника с Ext/Form).
- **structure_samples**, **structure_backup** — образцы структуры конфигурации Designer для разработки и отладки.

Содержимое этих папок не попадает в VSIX (указано в `.vscodeignore`).
