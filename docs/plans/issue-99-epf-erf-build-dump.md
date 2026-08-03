# Issue #99: сборка и разборка EPF/ERF

## Discovery

Нужны две операции пакетного Конфигуратора:

- разборка `.epf`/`.erf` в XML format 2.0;
- сборка `.epf`/`.erf` из корневого XML.

Операции доступны из UI, Agent API и стандартного MCP. Они не должны молча терять ссылочные типы, перезаписывать существующие результаты или скрывать неопределённый исход процесса.

Официальный контракт платформы:

- `/DumpExternalDataProcessorOrReportToFiles <output prefix> <epf-or-erf> -Format <Plain|Hierarchical>`;
- `/LoadExternalDataProcessorOrReportFromFiles <root xml> <epf-or-erf>`;
- для load параметр `-Format` не используется;
- без подключения к ИБ разрешены только автономные EPF/ERF; ссылочные типы конфигурации могут быть потеряны.

`output prefix` не является каталогом: Plain создаёт `<prefix>.xml` и вспомогательные sibling-файлы, Hierarchical — `<prefix>.xml` и каталог `<prefix>/...`. Сервис создаёт prefix внутри staging-wrapper и атомарно публикует весь wrapper как `outputDirectory`.

## Доказанные факты

На 1С 8.3.27.1859 проверено напрямую:

- EPF `СделатьПаузу.epf`: standalone dump Hierarchical завершился с exit code 0, создал корневой `СделатьПаузу.xml`; load корневого XML в новый EPF завершился с exit code 0, размер результата 7445 байт;
- передача каталога вместо корневого XML в load завершилась с exit code 1 и сообщением, что ожидается путь к файлу;
- ERF `подразделения.erf`: standalone dump и load завершились с exit code 0, корневой файл `ВнешнийОтчет1.xml`, размер результата 5451 байт.

Эти прогоны подтверждают контракт платформы. Перед релизом тот же EPF- и ERF-round-trip должен пройти через реализованный сервис/Agent API.

## Архитектурные варианты

### 1. Минимальные изменения

Всегда запускать standalone и писать сразу в целевой путь.

Плюсы: мало кода. Минусы: возможная потеря ссылочных типов, коллизии параллельных запусков, частичные результаты и неразличимый `inDoubt`. Для релиза неприемлемо.

### 2. Только привязанная ИБ

Требовать существующую файловую ИБ и автоматически разрешать её через bindings.

Плюсы: ссылочные типы всегда разрешаются в контексте конфигурации. Минусы: автономные EPF/ERF без проекта становятся недоступны; внешний файл не всегда однозначно связан с конфигурацией; UI и Agent API получают лишнюю зависимость от bindings.

### 3. Явный контекст выполнения — выбранный вариант

Вызывающий обязан выбрать ровно один режим:

- `infobasePath` и, при необходимости, credentials;
- `standalone: true`, явно подтверждающий риск потери ссылочных типов.

При отсутствии режима или при передаче обоих режимов операция отклоняется до запуска процесса. Фиктивная или временная ИБ не создаётся.

Это сохраняет безопасный default, поддерживает автономные артефакты и не связывает домен EPF/ERF с конкретной конфигурацией.

## Компоненты и data flow

UI или Agent/MCP передаёт запрос в External Processor Service. Сервис:

1. валидирует вход, execution context и отсутствие целевого результата;
2. определяет тип EPF/ERF по расширению бинарника или корневому XML;
3. получает блокировки общей очереди по canonical ID реальной ИБ и по нормализованным input/output resource IDs;
4. создаёт sibling staging;
5. строит argv Конфигуратора и запускает общий process runner;
6. использует только redacted `outcome.combinedLog`;
7. проверяет постусловия;
8. атомарно публикует staging в отсутствующий целевой путь;
9. возвращает точный `completed`, `failed` или `inDoubt`.

Deploy/support и EPF/ERF используют одну `InfobaseConfigurationOperationQueue`, поэтому два Конфигуратора не меняют одну ИБ параллельно.

## Контракты

### Core

- `ExternalProcessorExecutionContext` — discriminated union:
  - `{ kind: 'infobase'; infobasePath: string; credentials?: { user?: string; password?: string } }`;
  - `{ kind: 'standalone'; acknowledgeTypeLoss: true }`.
- `DumpExternalProcessorOptions` — `externalFilePath`, `outputDirectory`, `format: 'Plain' | 'Hierarchical'`, `context`, `timeoutMs`, `cancellation`.
- `BuildExternalProcessorOptions` — `rootXmlPath`, optional `destinationPath`, `context`, `timeoutMs`, `cancellation`.
- `ExternalProcessorOperationResult` — discriminated union:
  - `{ state: 'completed'; artifactPath: string; rootXmlPath?: string; warning?: string; combinedLog: string }`;
  - `{ state: 'failed'; code: ExternalProcessorErrorCode; message: string; retryable: boolean; effectPossible: boolean; combinedLog: string }`;
  - `{ state: 'inDoubt'; code: 'CONFIGURATOR_IN_DOUBT' | 'EXTERNAL_POSTCONDITION_IN_DOUBT'; message: string; retryable: false; effectPossible: true; stagingPath: string; combinedLog: string; processErrorCode?: string }`.

`BuildExternalProcessorOptions.destinationPath` по умолчанию вычисляется строго так:

- direct child `ExternalDataProcessor` у `MetaDataObject` даёт расширение `.epf`;
- direct child `ExternalReport` даёт `.erf`;
- namespace prefix и `MetaDataObject@version` не влияют на распознавание: сравнивается XML local name;
- другие, отсутствующие или неоднозначные metadata roots дают `EXTERNAL_ROOT_UNSUPPORTED`;
- basename берётся из каталога root XML, суффикс `_src` удаляется case-insensitively, добавляется `_built`, файл создаётся рядом с каталогом XML: `<parent>/<source-directory-without-_src>_built.<epf|erf>`.

Agent/MCP `outDir` допускается не передавать. В этом случае используется отсутствующий sibling-каталог `<dirname(srcPath)>/<binary-basename-without-extension>_src`; существующий каталог не переиспользуется и даёт `EXTERNAL_OUTPUT_EXISTS`.

### Configurator argv

- Dump всегда передаёт явный `-Format Plain` или `-Format Hierarchical`.
- Build передаёт сначала корневой XML, затем staging destination; `-Format` отсутствует.
- `/F` и credentials добавляются только для file-infobase context.
- Диагностические токены остаются JSON-encoded после redaction; security hardening #82 не ослабляется.

### Файловые инварианты

- Входной `.epf`/`.erf` или root XML должен существовать и быть файлом.
- Целевой каталог/файл не должен существовать; overwrite в #99 не поддерживается.
- Конфигуратор пишет только в sibling staging.
- `completed` возможен только после проверки ожидаемого непустого артефакта и атомарной публикации.
- `failed` staging очищается; `inDoubt` staging сохраняется и возвращается вызывающему.

### Agent/MCP

- Dump input: `{ srcPath: string; outDir?: string; format: 'Plain' | 'Hierarchical'; context: ExternalProcessorExecutionContext; timeoutMs?: number }`.
- Build input: `{ rootXmlPath: string; dstPath?: string; context: ExternalProcessorExecutionContext; timeoutMs?: number }`.
- Обе Agent-команды возвращают `AgentResult<ExternalProcessorAgentData>`.
- `ExternalProcessorAgentData` содержит полный service result; при `completed` `AgentResult.success === true`, при `failed`/`inDoubt` — `false`, а `AgentResult.code/error` дублируют стабильный machine-readable code и message.
- MCP schemas strict на корне, context и credentials; взаимоисключение выражено discriminated union, а standalone принимает только literal `acknowledgeTypeLoss: true`.
- Оба MCP-инструмента используют `WRITE_OPEN`: обе операции создают файлы.
- Полный каталог после #99 содержит 69/69 инструментов.

### UI

- Dump принимает `.epf`/`.erf` и предлагает отсутствующий каталог результата.
- Build принимает корневой `.xml`, определяет `.epf` или `.erf` по metadata root и предлагает отсутствующий файл результата.
- Перед standalone запуском UI требует явного подтверждения; для контекста ИБ позволяет выбрать каталог существующей файловой ИБ.
- Сообщения пользователю — русские; `inDoubt` не называется обычной ошибкой и показывает staging path.

## Ошибки

`ExternalProcessorErrorCode` — закрытый union:

- `EXTERNAL_CONTEXT_INVALID`;
- `EXTERNAL_INPUT_MISSING`;
- `EXTERNAL_INPUT_NOT_FILE`;
- `EXTERNAL_EXTENSION_UNSUPPORTED`;
- `EXTERNAL_ROOT_UNSUPPORTED`;
- `EXTERNAL_OUTPUT_EXISTS`;
- `CONFIGURATOR_UNAVAILABLE`;
- `CONFIGURATOR_FAILED`;
- `CONFIGURATOR_IN_DOUBT`;
- `EXTERNAL_POSTCONDITION_FAILED`;
- `EXTERNAL_POSTCONDITION_IN_DOUBT`;
- `EXTERNAL_PUBLISH_CONFLICT`;
- `EXTERNAL_IO_FAILED`.

Отклонение до старта имеет `effectPossible: false`. `failed` после старта сохраняет реальный `effectPossible` process runner. Timeout, cancellation или потеря подтверждения после старта сохраняются как `inDoubt`; автоматический повтор не предлагается.

## Locking

- Для существующего input используется realpath.
- Для отсутствующего output используется realpath ближайшего существующего родительского каталога плюс нормализованный относительный хвост.
- На Windows canonical resource path сравнивается case-insensitively; на остальных платформах сохраняется регистр.
- Resource ID имеет вид `external-resource:<canonical-path>`.
- ИБ представлена существующим `canonicalTargetId` из `resolveInfobaseCanonicalIdentity`.
- Все IB/input/output identities передаются одним массивом в один вызов `InfobaseConfigurationOperationQueue.runComposite`; очередь дедуплицирует и сортирует ключи до захвата. Последовательного расширения lease нет, поэтому deadlock исключён.
- Standalone использует ту же shared queue с input/output resource IDs и без IB identity.

## План реализации

### Коммит 1 — интеграция актуального main

Файлы: `package.json`, `src/agent/mcpAdapter/catalog/schemas.ts`, `src/commands/index.ts`, `src/services/configurator/configuratorBatchArgs.ts`, `test/suite/configuratorBatchArgs.test.ts`, `test/suite/coreSuites.ts`, `test/suite/extensionManifestContracts.test.ts`, `test/suite/mcpAgentCoverage.test.ts`.

Изменения: объединить ветку с `origin/main`; сохранить support hardening, JSON-encoding diagnostic argv, security tests, README MCP-first и версию 0.51.1.

Контракты: существующие 67 Agent/MCP-команд до добавления #99 остаются без изменений.

### Коммит 2 — core и service

Файлы: `src/services/configurator/configuratorBatchArgs.ts`, `src/services/externalProcessor/externalProcessorTypes.ts`, `src/services/externalProcessor/externalProcessorResourceIdentity.ts`, `src/services/externalProcessor/externalProcessorService.ts`.

Изменения: исправить argv, explicit execution context, валидацию root XML, resource/IB locking, staging, postconditions, atomic publish, cleanup и точную классификацию результатов.

Контракты: `ExternalProcessorExecutionContext`, `DumpExternalProcessorOptions`, `BuildExternalProcessorOptions`, `ExternalProcessorOperationResult`.

### Коммит 3 — Agent, MCP, UI и документация

Файлы: `src/agent/agentCommands.ts`, `src/agent/agentExternalProcessorOperations.ts`, `src/agent/types.ts`, `src/agent/mcpAdapter/catalog/externalProcessorTools.ts`, `src/agent/mcpAdapter/catalog/schemas.ts`, `src/agent/mcpAdapter/toolCatalog.ts`, `src/commands/externalProcessorCommands.ts`, `src/commands/index.ts`, `package.json`, `README.md`, `docs/features/agent-api/agent-skill.md`.

Изменения: общий `AgentResult`, strict schemas, `WRITE_OPEN`, корректная регистрация manifest/UI, EPF/ERF destination, execution-context UX, каталог 69/69.

Контракты: `cdt_dump_external_processor`, `cdt_build_external_processor` и одноимённые Agent-команды.

### Коммит 4 — тесты

Файлы: `test/suite/configuratorBatchArgs.test.ts`, `test/suite/externalProcessorService.test.ts`, `test/suite/externalProcessorCommands.test.ts`, `test/suite/agentExternalProcessorOperations.test.ts`, `test/suite/agentCommands.debug.test.ts`, `test/suite/mcpAdapter.test.ts`, `test/suite/mcpAgentCoverage.test.ts`, `test/suite/mcpBridgeTransport.test.ts`, `test/suite/extensionManifestContracts.test.ts`, `test/suite/smoke/mcpAgentBridge.smoke.test.ts`, `test/suite/coreSuites.ts`.

Изменения: exact argv/order/format/redaction, context validation, no-overwrite, staging/publish, cleanup, failed/inDoubt, queue serialization, EPF/ERF detection, AgentResult, strict MCP schemas, manifest и 69/69.

Контракты: тесты следуют этому документу; старые проверки, которые принимали ожидаемый отказ за успех, удаляются.

### Quality Gate

- production и test TypeScript;
- полный `npm run verify`;
- required smoke и VS Code integration;
- `git diff --check`;
- реальный service/Agent-driven EPF и ERF standalone round-trip на 1С 8.3.27.1859;
- реальный round-trip с существующей файловой ИБ и EPF/ERF, содержащей ссылочный тип этой конфигурации; после dump/build local name ссылочного типа не должен деградировать в примитив;
- behavioral test UI выбора execution context и standalone confirmation;
- фактические MCP-вызовы обеих команд через adapter, а не только manifest/count;
- независимый code review без P0–P2.

После зелёного QG реализация идёт через PR и CI. Следующий релиз — 0.51.2; `build-all.bat` не меняется. Релизный коммит после мержа реализации пушится прямо в `main`, без отдельного release PR, затем создаются tag и GitHub Release.
