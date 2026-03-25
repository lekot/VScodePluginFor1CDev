# Архитектура исходников CDT 41

Расширение на **TypeScript**; сборка основного кода в `dist/`, тесты — `out/` (см. [DEVELOPING.md](../DEVELOPING.md)).

## Поток данных (упрощённо)

```
Workspace (Designer XML / EDT layout)
    → FormatDetector + MetadataParser (DesignerParser | EdtParser)
    → TreeNode (модель)
    → MetadataTreeDataProvider → VS Code Tree View
    ↔ PropertiesProvider / TypeEditorProvider (webview)
    ↔ FormEditorProvider (custom editor, Form.xml)
    ↔ RolesRightsEditorProvider (права роли)
MetadataWatcherService + ReloadCoordinatorService → инкрементальное обновление дерева
elementOperations + XMLWriter + configurationXmlUpdater → CRUD и правка XML
```

## Каталог `src/`

| Путь | Ответственность |
|------|-----------------|
| `extension.ts` | Активация, регистрация команд, связка провайдеров, кэш дерева, команды пользователя. |
| `models/` | `TreeNode`, типы узлов (`MetadataType`), индекс моделей. |
| `parsers/` | Разбор конфигурации: `metadataParser` (фасад), `designerParser`, `edtParser`, `xmlParser`, `formatDetector`, `typeParser`, `subsystemTreeBuilder`, специализированные парсеры. |
| `providers/` | `treeDataProvider` (дерево), `propertiesProvider` (свойства), `typeEditorProvider` (редактор типа). |
| `services/` | `elementOperations` (создание/копия/удаление/переименование), `metadataWatcherService`, `reloadCoordinatorService`, шаблоны Designer, связывание регистров, восстановление после delete/reconcile и др. |
| `utils/` | `XMLWriter`, логирование, кэш на диске, валидация имён, поиск ссылок, нормализация дерева, сводка диагностик, маппинг типов ↔ папок Designer. |
| `constants/` | Сообщения UI, подписи свойств, секции, перечисления для метаданных. |
| `types/` | Контракты перезагрузки и прочие разделяемые типы. |
| `serializers/` | Сериализация типов для UI. |
| `formEditor/` | Кастомный редактор `Ext/Form.xml`: модель, парсер/писатель, webview, операции дерева формы. |
| `rolesEditor/` | Парсинг/запись Role.xml, webview редактора прав, валидация, таблица крест-навигации. |

## Внешние границы

- **BSL / LSP:** семантика кода модулей — внешние расширения; CDT отвечает за пути к `.bsl` и дерево метаданных (см. README, раздел «Границы продукта»).
- **Платформа 1С:** проверка конфигурации и загрузка в ИБ — `ibcmd`/конфигуратор; CDT пишет файлы на диск согласно парсерам и писателям.

## Тесты

- Модульные и интеграционные сьюты: `test/suite/`, прогон через `npm test` / `runCore`.
- Матрица контейнеров и опциональный `ibcmd`: `test/matrix/` (см. [design/e2e-container-matrix-ibcmd.md](design/e2e-container-matrix-ibcmd.md)).
- Smoke VS Code: `test/suite/smoke/`, `runSmoke.js`.
