# Разработка расширения CDT 41 (Community Development Tools for 1C)

Указатель документации (gap, архитектура, backlog): [docs/documentation-map.md](docs/documentation-map.md).

## Сборка и тесты

### Компиляция

```bash
npm run compile
```

`compile` сначала компилирует весь `src/` в `dist/`, затем собирает
`dist/agent/mcpAdapter/sessionRouter.js` в CommonJS-bundle со всеми MCP SDK и Zod.
Проверить этот артефакт отдельно можно командой `npm run verify:session-router-bundle`.

Результат в `dist/` (основной tsconfig). Для тестов используется `tsconfig.test.json`, выход в `out/`.

### Запуск тестов

**Все тесты** (компиляция по tsconfig.test.json + линт + Mocha):

```bash
npm test
```

**Быстрый прогон** (Windows): компиляция, копирование фикстур в `out/test/fixtures`, запуск динамически зарегистрированного core-набора:

```bash
.\test-suite.bat
```

Тесты лежат в `test/suite/*.test.ts`, компилируются в `out/test/suite/*.test.js`. `npm test` обнаруживает все скомпилированные `out/test/suite/*.test.js` по glob и не требует регистрации в core-наборе. Изолированные фикстуры находятся в `test/fixtures/`; репозиторный пример выгрузки Designer — `FormatSamples/empty_conf/` (с `Configuration.xml`, `ConfigDumpInfo.xml` и каталогами метаданных).

Тесты, использующие API VS Code (`vscode`), — treeDataProvider, integration, metadataWatcherService — запускаются через **Testing** в VS Code (Run/Debug Tests), а не через `node mocha` в командной строке.

### Добавление теста

1. Создайте файл `test/suite/<name>.test.ts`.
2. Импорты из `../../src/...`.
3. Используйте `suite('...', () => { ... })` и `test('...', () => { ... })` (Mocha TDD).
4. Если suite должен постоянно выполняться через `test-suite.bat` и `npm run test:ci`, зарегистрируйте его в `test/suite/coreSuites.ts`.
5. Запустите `npm test`; `test-suite.bat` и `test:ci` используют динамический core-список через `out/test/runCore.js`, поэтому список файлов в батнике не редактируется.

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

- `CDT 41: Открыть последний отчёт ibcmd check`
- `CDT 41: Открыть последний отчёт ibcmd import`

В логах задачи печатается путь вида `[ibcmd-cli] report: ...`, а в файле есть команда, exit code, stdout/stderr.

## Структура тестов

- **Парсеры и дерево**: `xmlParser.test.ts`, `designerParser.test.ts`, `metadataParser.test.ts`, `formatDetector.test.ts`, `treeDataProvider.test.ts`.
- **Операции и утилиты**: `elementOperations.test.ts`, `referenceFinder.test.ts`, `elementNameValidator.test.ts`.
- **Сервисы**: `metadataWatcherService.test.ts`.
- **Интеграция**: `integration.test.ts` (загрузка конфигурации из фикстур, отображение в дереве).
- **Панель свойств и редактор типа**: `propertiesProvider.test.ts`, тесты в `src/providers/test/`.

`FormatSamples/empty_conf/` — полная репозиторная выгрузка Designer для ручной проверки и тестов целостности; `FormatSamples/form_preview_block3b/Form.xml` — отдельный пример формы, а `FormatSamples/cf/1Cv8.cf` — пример CF. Минимальные изолированные fixtures для unit-тестов остаются в `test/fixtures/designer-config/`.

## Примеры конфигураций и расширений

Коммитируемые примеры находятся в `FormatSamples/` и не включаются в VSIX (см. `.vscodeignore`). Используйте `FormatSamples/empty_conf/` как workspace для ручной проверки дерева метаданных.
