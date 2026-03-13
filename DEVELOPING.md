# Разработка расширения 1C Metadata Tree

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
3. В новом окне откройте папку с конфигурацией 1С (EDT или Designer) и проверьте панель «1C Metadata».

## Структура тестов

- **Парсеры и дерево**: `xmlParser.test.ts`, `designerParser.test.ts`, `metadataParser.test.ts`, `formatDetector.test.ts`, `treeDataProvider.test.ts`.
- **Операции и утилиты**: `elementOperations.test.ts`, `referenceFinder.test.ts`, `elementNameValidator.test.ts`.
- **Сервисы**: `metadataWatcherService.test.ts`.
- **Интеграция**: `integration.test.ts` (загрузка конфигурации из фикстур, отображение в дереве).
- **Панель свойств и редактор типа**: `propertiesProvider.test.ts`, тесты в `src/providers/test/`.

Фикстуры в `test/fixtures/designer-config/` повторяют минимальную структуру конфигурации Designer (Configuration.xml, Catalogs, Documents и т.д.) и используются в интеграционных и парсер-тестах.
