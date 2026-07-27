# План реализации Issue #99: Сборка и разборка внешних обработок (EPF) и отчётов (ERF)

## Описание задачи
Реализация функционала сборки (паковки) и разборки (распаковки) внешних обработок (`.epf`) и внешних отчётов (`.erf`) в файлы исходных кодов XML (Designer/EDT формат) с использованием пакетного режима Конфигуратора 1С (Designer Batch Operations).

Задача также частично затрагивает **Issue #108** в части расширения движка аргументов пакетного режима Конфигуратора (`configuratorBatchArgs.ts`) и интеграции с очередью процессов Конфигуратора.

---

## Архитектура и компоненты

### 1. Configurator Batch Args (`src/services/configurator/configuratorBatchArgs.ts`)
Расширение конструктора аргументов командной строки 1С:Предприятия (`1cv8 DESIGNER`):
- `buildConfiguratorDumpExternalArgs(options)`:
  - Флаг `/DumpExternalDataProcessorOrReportToFiles <outDir> <epfOrErfPath> [-Format Hierarchical]`
- `buildConfiguratorLoadExternalArgs(options)`:
  - Флаг `/LoadExternalDataProcessorOrReportFromFiles <epfOrErfPath> <srcDir> [-Format Hierarchical]`
- Безопасная фильтрация маскирование учетных данных в `diagnosticArgs`.

### 2. External Processor Service (`src/services/externalProcessor/externalProcessorService.ts`)
Центральный сервис для управления операциями сборки/разборки:
- Проверка доступности исполнения Конфигуратора через `configuratorExecutableResolver`.
- Подготовка временной или рабочей информационной базы (если отсутствует привязанная ИБ, используется disposable ИБ для работы Конфигуратора).
- Вызов `configuratorProcessRunner` под блокировкой `InfobaseConfigurationOperationQueue`.
- Очистка временных ресурсов и логирование результата.

### 3. UI Commands & Menus (`src/commands/`, `package.json`)
- `1c-metadata-tree.dumpExternalProcessor` — разборка файла `.epf`/`.erf` в указанный каталог.
- `1c-metadata-tree.buildExternalProcessor` — сборка каталога с XML-исходниками в файл `.epf`/`.erf`.
- Регистрация пунктов меню в `explorer/context` для файлов с расширениями `.epf` и `.erf`, а также для папок внешних обработок.

### 4. Agent API & MCP Tools (`src/agent/`, `src/agent/mcpAdapter/`)
- Agent API команды:
  - `1c-metadata-tree.agent.dumpExternalProcessor`
  - `1c-metadata-tree.agent.buildExternalProcessor`
- MCP Tools:
  - `cdt_dump_external_processor`
  - `cdt_build_external_processor`

---

## Этапы выполнения

1. **Этап 1 (Batch Engine & Service)**:
   - Добавление билдеров аргументов в `configuratorBatchArgs.ts`.
   - Создание `externalProcessorService.ts` с методами `dumpExternalProcessor` и `buildExternalProcessor`.
   - Написание юнит-тестов для аргументов и сервисов (`test/suite/configuratorBatchArgs.test.ts`, `test/suite/externalProcessorService.test.ts`).

2. **Этап 2 (UI Integration & Explorer Context)**:
   - Регистрация VS Code команд в `package.json` и `src/commands/`.
   - Обработка выбора файлов/папок через проводник VS Code.

3. **Этап 3 (Agent API & MCP Tools)**:
   - Реализация Agent API операторов в `src/agent/agentExternalProcessorOperations.ts`.
   - Добавление MCP схем и инструментов в каталог MCP adapter.
   - Обновление счетчиков тестов и документации (67 -> 69 tools).

4. **Этап 4 (Quality Gate)**:
   - Запуск `npx tsc --noEmit` и `test-suite.bat`.
   - Проверка работоспособности и отсутствие регрессий.

---

## План тестирования
- Unit-тесты генерации командной строки Designer (`configuratorBatchArgs.test.ts`).
- Unit-тесты валидации путей и обработки ошибок (`externalProcessorService.test.ts`).
- Integration/Agent API тесты для вызова сборки/разборки (`agentExternalProcessorOperations.test.ts`, `mcpAgentCoverage.test.ts`).
