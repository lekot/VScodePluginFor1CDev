# Дизайн рефакторинга «красных» модулей

**Дата:** 2026-03-25  
**Обновление:** 2026-03-26 — шаг 6 (xmlTabularSectionService) выполнен в коде.  
**Статус:** Draft  
**Scope:** `src/utils/XMLWriter.ts` (~700 строк после шага 6; было ~3150), `src/extension.ts` (~1410 строк)

---

## 1. Цель

Разбить два крупнейших модуля проекта на поддерживаемые, тестируемые единицы без изменения внешнего API и поведения.

---

## 2. XMLWriter.ts — текущее состояние

### 2.1 Метрики
| Показатель | Значение |
|------------|----------|
| Строк кода (`XMLWriter.ts`, после шагов 1–6) | ~700 |
| Публичных методов | 25+ |
| Приватных helper'ов | 40+ |
| Зависимости | `fast-xml-parser`, `fs`, внутренние (`Logger`, `TypeParser`, `TypeFormatter`, `internalInfoGenerator`, …) |

### 2.2 Логические блоки (по анализу кода)

1. **Core I/O** — чтение/запись XML с backup/rollback (`readProperties`, `writeProperties`, общий паттерн backup → write → cleanup).
2. **Properties** — извлечение и обновление `<Properties>` в структуре (`extractProperties`, `updatePropertiesInStructure`).
3. **ChildObjects / Nested Elements** — добавление/удаление/дублирование `Attribute`, `TabularSection`, `Form` (`addNestedElement`, `removeNestedElement`, `addAttributeToTabularSection`, …).
4. **TabularSection Columns** — специфика колонок ТЧ: порядок, дублирование, удаление (`duplicateAttributeInTabularSection`, `removeAttributeFromTabularSection`, …).
5. **Form References** — добавление/удаление ссылок на формы в ChildObjects владельца (`addDesignerFormReferenceToOwnerMetadata`, `removeDesignerFormFromOwnerMetadata`).
6. **Helpers / Utilities** — `generateSimpleUuid`, извлечение имени из элемента, поиск элемента по имени, нормализация типов.

### 2.3 Проблемы
- Один класс = god object; невозможно читать и тестировать изолированно.
- Дублирование паттерна «backup → write → cleanup» в каждом публичном методе записи.
- Смешение уровней абстракции: низкоуровневый I/O + бизнес-логика 1С-метаданных.
- Тесты вынуждены мокать весь класс или работать с файловой системой.

---

## 3. XMLWriter.ts — целевая архитектура

```
src/utils/xml/
├── index.ts                      # re-export public API (XMLWriter facade)
├── xmlCore.ts                    # XMLParser/XMLBuilder instances, options
├── xmlFileIo.ts                  # readXml, writeXmlAtomic (backup/rollback)
├── xmlPropertiesService.ts       # extractProperties, updatePropertiesInStructure
├── xmlChildObjectsService.ts     # addNestedElement, removeNestedElement, findElement
├── xmlTabularSectionService.ts   # addAttributeToTabularSection, removeAttribute, duplicate
├── xmlFormReferenceService.ts    # addDesignerFormReference, removeDesignerForm
└── xmlHelpers.ts                 # generateSimpleUuid, extractNameFromElement, etc.
```

### 3.1 Принципы разбиения
1. **Single Responsibility** — каждый файл ≤ 400 строк, одна область ответственности.
2. **Dependency Injection** — сервисы принимают `XmlFileIo` и `XmlCore` через параметры или DI-контейнер (опционально).
3. **Facade** — `XMLWriter` остаётся точкой входа (backward-compatible), делегирует в сервисы.
4. **Testability** — сервисы работают с `parsed` объектом; I/O изолирован в `xmlFileIo`.

### 3.2 Контракты (упрощённо)

```ts
// xmlFileIo.ts
export async function readXml(filePath: string): Promise<unknown>;
export async function writeXmlAtomic(filePath: string, data: unknown): Promise<void>;

// xmlPropertiesService.ts
export function extractProperties(parsed: unknown): Record<string, unknown>;
export function updatePropertiesInStructure(parsed: unknown, props: Record<string, unknown>): unknown;

// xmlChildObjectsService.ts
export function addNestedElementInStructure(parsed: unknown, elementType: string, name: string, props: Record<string, unknown>): unknown;
export function removeNestedElementInStructure(parsed: unknown, elementType: string, name: string): unknown;

// ... и т.д.
```

### 3.3 План миграции (инкрементальный)

| Шаг | Действие | Риск | Покрытие тестами | Статус |
|-----|----------|------|------------------|--------|
| 1 | Создать `src/utils/xml/` и `xmlCore.ts` с экспортом parser/builder | Низкий | Существующие тесты |+|
| 2 | Извлечь `xmlFileIo.ts` (readXml, writeXmlAtomic) | Низкий | Unit-тесты на I/O |+|
| 3 | Извлечь `xmlHelpers.ts` | Низкий | Unit-тесты |+|
| 4 | Извлечь `xmlPropertiesService.ts` | Средний | Регрессия через e2e |+|
| 5 | Извлечь `xmlChildObjectsService.ts` | Средний | Регрессия через e2e |+|
| 6 | Извлечь `xmlTabularSectionService.ts` | Средний | e2e + регресс в `xmlWriter.tabularColumn.test.ts` |+|
| 7 | Извлечь `xmlFormReferenceService.ts` | Низкий | Регрессия через e2e | |
| 8 | Превратить `XMLWriter` в facade, удалить дублирование | Низкий | Полный прогон test-suite | |

**Критерий готовности шага:** `.\test-suite.bat` проходит, `.\instrument-smoke.bat` (ibcmd slice) проходит.

*Применяется ко всем шагам таблицы, если для шага нет отдельного уточнения.*

#### 3.3.1 Шаг 6 — `xmlTabularSectionService`: границы, зависимости, замечания

**Статус реализации (2026-03-26):** модуль `src/utils/xml/xmlTabularSectionService.ts` добавлен; `XMLWriter` делегирует add/remove/duplicate колонок ТЧ в экспорты `*InParsed`; barrel `src/utils/xml/index.ts` реэкспортирует их. Во вложенной ветке `removeAttributeFromTabularSectionInParsed` учитывается факт удаления колонки (если имя ТЧ совпало, а колонки не было — ошибка «не найдена», без «тихого» успеха). JSDoc на трёх публичных функциях сервиса.

**Регресс-тесты** (`test/suite/xmlWriter.tabularColumn.test.ts`): второй XML на диске с той же ТЧ/колонкой не меняется при удалении только из первого файла; в одном объекте две ТЧ (**Товары** / **Заказы**) с одноимённой колонкой **Номенклатура** — удаление из **Товары** не трогает **Заказы**. Фикстуры: `CatalogTovaryNomenklatura.xml`, `CatalogTovaryIZakazyNomenklatura.xml`.

**Граница модуля (фактически вынесено):**

- Обход корня (`MetaDataObject` vs плоский корень), ветка «отдельный файл ТЧ» (`unwrapSingleTabularSection`) и ветка `ChildObjects` + `TOP_LEVEL_TYPES` с поиском блока `TabularSection` по имени из `Properties`.
- Мутации `ChildObjects` внутри блока ТЧ: вставка / удаление / дублирование `Attribute`, включая `tryAlignSynonymWithNewColumnName`, клон с новым uuid.

**Зависимости сервиса:** из `xmlChildObjectsService` — `TOP_LEVEL_TYPES`, `buildMinimalNestedElement`, `extractNameFromElementArray`, `extractNameFromNestedElement`; из `xmlHelpers` — `generateSimpleUuid`. Контракт: экспорт чистых `*InParsed(parsed, …): unknown`; публичные async-методы `XMLWriter` сохраняют паттерн read → parse → сервис → `buildXmlString` → `writeUtf8FileWithBackup`.

**Замечания на сопровождение:**

1. **Пересечение с `xmlChildObjectsService`:** scoped nested writes vs имя ТЧ из блока — по-прежнему два контекста; при доработках сверять правила.
2. **Дублирование каркаса:** три `*InParsed` повторяют схему обхода — опционально вынести общий helper без смены поведения.
3. **Остаётся в `XMLWriter`:** `escapeXml` и смежный код — не часть сервиса ТЧ.
4. **Регрессии:** оба layout; тексты ошибок на русском — сохранять дословно.

**Критерий после шага 6:** общий критерий готовности шага; дополнительно — регресс-тесты выше (и при желании unit на `*InParsed`).

---

## 4. extension.ts — текущее состояние

### 4.1 Метрики
| Показатель | Значение |
|------------|----------|
| Строк кода | ~1410 |
| Команд (registerCommand) | 27 |
| Глобальных переменных | 9 |
| Функция `activate` | ~920 строк |

### 4.2 Логические блоки

1. **State** — глобальные переменные (`treeDataProvider`, `treeView`, `propertiesProvider`, …).
2. **Providers init** — создание TreeDataProvider, PropertiesProvider, TypeEditorProvider, FormEditorProvider, RolesRightsEditorProvider.
3. **Commands — Element CRUD** — `createElement`, `createForm`, `duplicateElement`, `deleteElement`, `renameElement`.
4. **Commands — Navigation** — `focus`, `nextMatch`, `previousMatch`, `focusSearch`, `clearSearch`.
5. **Commands — Editors** — `openXML`, `openBslModule`, `openFormEditor`, `openRightsEditor`, `saveRightsEditor`.
6. **Commands — Filters** — `filterByType`, `filterBySubsystem`, `clearSubsystemFilter`, `addToSubsystemComposition`, `removeFromSubsystemComposition`.
7. **Commands — Utility** — `copyPathOrName`, `clearCache`, `exportLogs`, `copyDiagnosticsSummary`, ibcmd reports.
8. **Helpers** — `buildOptimisticCreatedNode`, `optimisticAppendCreatedNode`, `getSelectedNode`, `requireDesignerFormat` (дублируется).
9. **Reload coordination** — `scheduleCoordinatedReload`, `scheduleDeleteReconcile`, `recoverDeleteUiState`.
10. **Tree loading** — `loadMetadataTree`, `invalidateCacheAndReload`.

### 4.3 Проблемы
- God object: 27 команд + state + бизнес-логика в одном файле.
- Глобальные `let` переменные — сложно тестировать, race conditions.
- Дублирование паттерна «get configPath → check Designer format» в каждой CRUD-команде.
- Функция `activate` — 920 строк, невозможно читать.

---

## 5. extension.ts — целевая архитектура

```
src/
├── extension.ts                  # activate/deactivate (~100 строк), делегирует
├── state/
│   └── extensionState.ts         # класс ExtensionState (providers, watchers, coordinator)
├── commands/
│   ├── index.ts                  # registerAllCommands(context, state)
│   ├── elementCommands.ts        # create, delete, duplicate, rename
│   ├── navigationCommands.ts     # focus, search, nextMatch, previousMatch
│   ├── editorCommands.ts         # openXML, openBslModule, openFormEditor, openRightsEditor
│   ├── filterCommands.ts         # filterByType, filterBySubsystem, subsystemComposition
│   └── utilityCommands.ts        # copyPath, clearCache, exportLogs, diagnostics, ibcmd
├── helpers/
│   ├── optimisticNodeBuilder.ts  # buildOptimisticCreatedNode
│   └── commandHelpers.ts         # requireDesignerFormat, getSelectedNode
└── reload/
    └── reloadOrchestrator.ts     # scheduleCoordinatedReload, scheduleDeleteReconcile, recovery
```

### 5.1 Принципы разбиения
1. **State encapsulation** — `ExtensionState` хранит providers, watchers, coordinator; методы `init()`, `dispose()`.
2. **Command modules** — каждый файл регистрирует группу команд, получает `state` через параметр.
3. **Helper extraction** — `requireDesignerFormat` — единый helper, убирает дублирование.
4. **Thin activate** — только инициализация state + `registerAllCommands` + auto-load.

### 5.2 Контракты (упрощённо)

```ts
// state/extensionState.ts
export class ExtensionState {
  treeDataProvider: MetadataTreeDataProvider | null = null;
  treeView: vscode.TreeView<TreeNode> | null = null;
  // ...
  init(context: vscode.ExtensionContext): void;
  dispose(): void;
}

// commands/index.ts
export function registerAllCommands(context: vscode.ExtensionContext, state: ExtensionState): void;

// helpers/commandHelpers.ts
export async function requireDesignerFormat(
  state: ExtensionState,
  target: TreeNode
): Promise<{ configPath: string; format: ConfigFormat } | null>;
```

### 5.3 План миграции (инкрементальный)

| Шаг | Действие | Риск | Покрытие тестами |
|-----|----------|------|------------------|
| 1 | Создать `state/extensionState.ts`, перенести глобальные переменные | Средний | e2e smoke |
| 2 | Извлечь `helpers/commandHelpers.ts` (`requireDesignerFormat`, `getSelectedNode`) | Низкий | Unit |
| 3 | Извлечь `helpers/optimisticNodeBuilder.ts` | Низкий | Unit |
| 4 | Извлечь `commands/elementCommands.ts` | Средний | e2e CRUD |
| 5 | Извлечь `commands/navigationCommands.ts` | Низкий | e2e |
| 6 | Извлечь `commands/editorCommands.ts` | Низкий | e2e |
| 7 | Извлечь `commands/filterCommands.ts` | Средний | e2e |
| 8 | Извлечь `commands/utilityCommands.ts` | Низкий | e2e |
| 9 | Извлечь `reload/reloadOrchestrator.ts` | Средний | e2e delete reconcile |
| 10 | Упростить `extension.ts` до ~100 строк | Низкий | Полный прогон |

**Критерий готовности шага:** `.\test-suite.bat` + `.\instrument-smoke.bat` проходят.

---

## 6. Риски и митигация

| Риск | Вероятность | Митигация |
|------|-------------|-----------|
| Регрессия CRUD-операций | Средняя | e2e-тесты `containerMatrix.e2e.test.js`, ibcmd smoke |
| Нарушение lazy-loading дерева | Низкая | Существующие тесты `treeDataProvider.test.ts` |
| Конфликты при merge | Средняя | Рефакторинг в feature-branch, частые rebase |
| Увеличение времени сборки | Низкая | Файлы небольшие, TypeScript incremental |

---

## 7. Критерии приёмки (Definition of Done)

1. Все существующие тесты проходят (`.\test-suite.bat`).
2. ibcmd smoke (`.\instrument-smoke.bat`) проходит.
3. Ни один файл > 500 строк (кроме автогенерируемых).
4. Публичный API `XMLWriter` и `extension.ts` (экспорты, команды) не изменён.
5. Документация обновлена (JSDoc, README если нужно).

---

## 8. Следующий шаг

Выбрать один из модулей для старта:
- **XMLWriter** — меньше связей с VS Code API, проще тестировать изолированно.
- **extension.ts** — больше влияния на UX, но сложнее из-за глобального state.

**Рекомендация:** начать с XMLWriter (шаги 1–3), затем extension.ts.

---

## Приложение A: Карта методов XMLWriter → целевой модуль

| Метод | Целевой модуль |
|-------|----------------|
| `readProperties` | xmlPropertiesService |
| `writeProperties` | xmlPropertiesService + xmlFileIo |
| `addNestedElement` | xmlChildObjectsService |
| `removeNestedElement` | xmlChildObjectsService |
| `addAttributeToTabularSection` | xmlTabularSectionService |
| `removeAttributeFromTabularSection` | xmlTabularSectionService |
| `duplicateAttributeInTabularSection` | xmlTabularSectionService |
| `addDesignerFormReferenceToOwnerMetadata` | xmlFormReferenceService |
| `removeDesignerFormFromOwnerMetadata` | xmlFormReferenceService |
| `generateSimpleUuid` | xmlHelpers |
| `extractProperties` | xmlPropertiesService |
| `updatePropertiesInStructure` | xmlPropertiesService |
| `addNestedElementInStructure` | xmlChildObjectsService |
| `removeNestedElementInStructure` | xmlChildObjectsService |
| `writeNestedElementProperties` | xmlChildObjectsService |
| … (остальные private helpers) | соответствующие сервисы |

## Приложение B: Карта команд extension.ts → целевой модуль

| Команда | Целевой модуль |
|---------|----------------|
| `createElement` | elementCommands |
| `createForm` | elementCommands |
| `duplicateElement` | elementCommands |
| `deleteElement` | elementCommands |
| `renameElement` | elementCommands |
| `focus` | navigationCommands |
| `focusSearch` | navigationCommands |
| `clearSearch` | navigationCommands |
| `nextMatch` | navigationCommands |
| `previousMatch` | navigationCommands |
| `openXML` | editorCommands |
| `openBslModule` | editorCommands |
| `openFormEditor` | editorCommands |
| `openRightsEditor` | editorCommands |
| `saveRightsEditor` | editorCommands |
| `filterByType` | filterCommands |
| `filterBySubsystem` | filterCommands |
| `clearSubsystemFilter` | filterCommands |
| `addToSubsystemComposition` | filterCommands |
| `removeFromSubsystemComposition` | filterCommands |
| `copyPathOrName` | utilityCommands |
| `clearCache` | utilityCommands |
| `exportLogs` | utilityCommands |
| `copyDiagnosticsSummary` | utilityCommands |
| `openIbcmdCheckReport` | utilityCommands |
| `openIbcmdImportReport` | utilityCommands |
| `showProperties` | editorCommands |
| `refresh` | utilityCommands |
| `openPanel` | utilityCommands |
| `getTreeReadyForTest` | utilityCommands |
