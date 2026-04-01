# Инвентарь возможностей CDT 41 (аудит по коду)

**Версия продукта:** см. `package.json` → `version` (на дату анализа — 0.26.0).  
**Назначение:** краткая карта «что уже есть» для команды реализации и QA; функциональный разрыв с EDT — в [cdt-vs-edt-functional-gap.md](./cdt-vs-edt-functional-gap.md).

## 1. Точки расширения VS Code

| Область | Идентификатор / паттерн | Назначение |
|--------|-------------------------|------------|
| Активация | `onStartupFinished` | Панель дерева появляется после старта окна. |
| Дерево | view `1c-metadata-tree` (Explorer) | Иерархия метаданных, команды в title/context. |
| Custom editor | `1c-form-editor` → `**/Ext/Form.xml` | Визуальный редактор форм (прототип). |
| Команды | префикс `1c-metadata-tree.*` | См. полный список в `package.json` → `contributes.commands`. |
| Настройки | `1cMetadataTree.rightsEditor.compactRightsWrite` | Компактная запись прав в редакторе ролей. |

## 2. Слой парсинга и модели

| Путь | Роль |
|------|------|
| `src/parsers/metadataParser.ts` | Фасад парсинга конфигурации. |
| `src/parsers/formatDetector.ts` | EDT vs Designer. |
| `src/parsers/edtParser.ts` / `designerParser.ts` | Формат-специфичная логика. |
| `src/parsers/xmlParser.ts`, `xmlChildObjects.ts`, `typeParser.ts` | XML и типы свойств. |
| `src/parsers/subsystemTreeBuilder.ts` | Фильтр/дерево подсистем. |
| `src/models/treeNode.ts` | Модель узла и `MetadataType`. |

## 3. UI и провайдеры

| Путь | Роль |
|------|------|
| `src/providers/treeDataProvider.ts` | TreeDataProvider, поиск, фильтры, кэш узлов. |
| `src/providers/propertiesProvider.ts` | Панель свойств (webview). |
| `src/providers/typeEditorProvider.ts` | Редактор типа реквизита. |
| `src/formEditor/*` | Парсер/модель/webview редактора форм. |
| `src/rolesEditor/*` | Парсер/сериализация XML прав, webview редактор ролей. |

## 4. Операции с метаданными и файлами

| Путь | Роль |
|------|------|
| `src/services/elementOperations.ts` | Создание, дублирование, удаление, переименование; ссылки. |
| `src/services/metadataWatcherService.ts` | Отслеживание изменений XML на диске. |
| `src/services/configurationXmlUpdater.ts` | Согласованное обновление `Configuration.xml` и связанных файлов. |
| `src/utils/XMLWriter.ts`, `xmlPropertyUtils.ts` | Запись и нормализация XML. |
| `src/utils/referenceFinder.ts` | Поиск/замена ссылок при переименовании. |
| `src/services/reloadCoordinatorService.ts` | Перезагрузка дерева после внешних правок. |
| `src/utils/diskCache.ts` | Кэш сериализованного дерева на диске. |

## 5. Вспомогательные сервисы

| Путь | Роль |
|------|------|
| `src/services/designerTemplateRepository.ts`, `designerTemplateSubstitutor.ts` | Шаблоны объектов Designer. |
| `src/extension.ts` | Регистрация команд, связка провайдеров и сервисов. |
| `src/utils/logger.ts`, `diagnosticsSummary.ts` | Логи и сводка диагностик для поддержки. |

## 6. Тестирование (ориентиры для регрессий)

- **Core:** `npm run test:ci` → `out/test/runCore.js`, фикстуры в `test/fixtures/`.
- **Smoke (VS Code):** `npm run test:smoke` — без проверки содержимого webview; см. README.
- **Матрица / ibcmd:** документированы в README и `docs/design/e2e-container-matrix-ibcmd.md`.

## 7. Явные ограничения текущей версии (кратко)

- BSL: навигация по дереву и открытие `.bsl`; семантика кода — внешний LSP (граница зафиксирована в README).
- Формы: custom editor помечен как прототип; smoke не «кликает» webview.
- СКД, конструктор запросов, отладка ИБ, проверка конфигурации из UI — отсутствуют; дорожная карта привязана к issues в gap-документе.
