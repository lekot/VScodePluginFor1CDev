# План устранения архитектурных findings от 2026-07-18

**Статус исполнения:** Реализация завершена на `feat/architecture-review-hardening`; AR-01..AR-16
закрыты после зелёного Quality Gate. Группы коммитов ниже сохраняются как логическая декомпозиция
плана и не задают обязательную форму итоговой git-истории.

**Итоговый Quality Gate:** `npm run verify` — exit 0; финальная core-приёмка — 3 023 passed,
36 pending; VS Code smoke — 10 passed, 1 pending (opt-in deploy); полная matrix — 336 passed,
0 failed, 0 skipped. `scripts/instrument-smoke` через `ibcmd.setup.example.bat`, ibcmd import и
ibcmd config check выполнены успешно с кодом 0.

**Follow-up приёмки:** Полная matrix выявила и закрыла асимметрию R6 delete и fail-open runner;
concurrency stress выявил и закрыл race допуска в FIFO lock.

Основание: `docs/code-review-findings-2026-07-18.md` и ADR
`docs/architecture/adr-configuration-session-and-safe-mutations.md`.

План фиксирует только состав изменений и контракты. Реализация выполняется
последовательными коммитами; каждый коммит должен проходить профильные тесты и
не ослаблять общий `npm run verify`.

## Коммит 1. Немедленная целостность XML и webview boundary

### Файлы

- `src/services/elementOperations.ts`
- `src/services/configurationXmlUpdater.ts`
- `src/agent/agentOperations.ts`
- `src/utils/xml/xmlPropertiesService.ts`
- `src/providers/typeEditorProvider.ts`
- `src/providers/objectTypeEditorProvider.ts`
- `src/bindings/bindingDialog.ts`
- `src/utils/escapeJsonForScript.ts`
- соответствующие тесты `test/suite/`

### Что менять

- Rename верхнеуровневого объекта атомарно заменяет запись в `ChildObjects`.
- Duplicate генерирует новый UUID и регистрирует копию в `Configuration.xml`.
- `setType` передаёт структурированный Type subtree, а не строку XML.
- Все inline JSON sinks используют общий encoder; webview получают nonce CSP и
  строгую runtime-валидацию входящих сообщений.

### Контракты

- `renameRootObject(oldType, oldName, newType, newName): Promise<void>`.
- `duplicateRootObject(...): Promise<{ name: string; uuid: string }>`.
- Type writer принимает parsed fragment/typed value, но не произвольную XML-строку.
- `escapeJsonForScript(value): string` безопасен для HTML script data state.

## Коммит 2. Явная конфигурация, containment и безопасная запись

### Файлы

- новые сервисы в `src/services/configurationSession/`
- `src/commands/index.ts`
- `src/agent/types.ts`
- `src/agent/agentCommands.ts`
- `src/agent/agentPathResolver.ts`
- `src/agent/agentOperations.ts`
- `src/bindings/bindingPathUtils.ts`
- `src/bindings/deployService.ts`
- `src/services/elementOperations.ts`
- `src/services/configurationXmlUpdater.ts`
- `src/utils/xml/xmlFileIo.ts`
- `src/utils/XMLWriter.ts`
- `src/formEditor/formXmlWriter.ts`
- все UI/Agent mutation callers, которые сейчас вызывают writers напрямую
- тесты identity, containment, concurrency и fault injection

### Что менять

- Ввести `ConfigurationId`, `ConfigurationDescriptor`, `WorkspaceRegistry` и
  `ConfigurationSession` как facade/composition boundary.
- Agent mutation требует явный `configurationId`; single-root сохраняет
  совместимость, multi-root без selector возвращает ambiguity error.
- Все входные имена проходят общий валидатор 1С; все пути проверяют containment
  по существующему canonical parent и повторно перед disk effect.
- Single-file writer использует уникальный temp, expected hash и atomic replace.
- Multi-file mutation выполняется последовательной очередью одной сессии и имеет
  prepared plan, rollback/recovery; внешний процесс использует отдельный lease и
  post-run drift scan без ложного обещания rollback.
- Все legacy create/rename/delete/property surfaces переводятся на session gateway;
  прямой обход lease/storage из UI или Agent adapters запрещён.

### Контракты

- `ConfigurationId` — непрозрачный random ID из versioned persisted mapping по
  fingerprint root и descriptor UUID; move/replace не меняет identity молча.
- Registry разделяет exact `require(id)`, `resolveResource(uri)` и совместимый
  `resolveLegacyDefault`, допустимый только при строго одной конфигурации.
- `ConfigurationSession.enqueue(request): Promise<MutationOutcome>`; внутренний
  transaction plan, версия и target hashes строятся/перепроверяются только внутри
  очереди при dequeue и не принимаются от вызывающего adapter.
- Раздельные `StorageOutcome`, `MutationOutcome`, `ReconcileOutcome`.
- `AtomicFileStorage.replace(target, bytes, expectedHash): Promise<StorageOutcome>`.
- Durable journal обязателен только для многофайловых/каталожных операций.

## Коммит 3. Reload, watcher и workspace lifecycle

### Файлы

- `src/extension/metadataTreeLifecycle.ts`
- `src/extension/extensionWorkspaceSetup.ts`
- `src/extension/lazyWorkspaceOrchestrator.ts`
- `src/extension.ts`
- `src/agent/agentBridgeActivation.ts`
- `src/agent/agentBridge.ts`
- `src/reload/reloadOrchestrator.ts`
- `src/services/reloadCoordinatorService.ts`
- `src/services/metadataWatcherService.ts`
- `src/providers/treeDataProvider.ts`
- `src/state/extensionState.ts`
- тесты concurrent reload, workspace changes, dispose и retention

### Что менять

- Reload становится single-flight на конфигурацию с generation guard и не более
  одного coalesced follow-up на текущий pass.
- Ошибки reload сохраняют тип и доходят до coordinator/caller.
- Watcher reload обновляет только затронутую сессию; `.xml`, `.mdo` и структурные
  изменения `.bsl` классифицируются отдельно.
- Добавление/удаление workspace folders обновляет registry; partial/cancelled
  discovery не удаляет действующие сессии.
- Warmup получает budget, cancellation и generation fence; disposed watchers не
  накапливаются в `context.subscriptions`.
- Activation регистрирует ресурсы транзакционно и откатывает частичную активацию;
  Agent Bridge start/stop ожидаются и не могут опубликовать discovery после stop.

### Контракты

- `session.reload(reason, token): Promise<ReloadOutcome>`.
- Публикация snapshot допустима только для текущего generation/epoch.
- Иные конфигурации не имеют общей consistency-зависимости; общий scheduler может
  ограничивать параллелизм по ресурсам.
- Dispose запрещает позднюю публикацию и освобождает все session-scoped resources.
- Typed reload failure доходит до delete reconcile и запрещает ложный success.

## Коммит 4. Платформенная модель Designer/EDT и VS Code capabilities

### Файлы

- `package.json`
- `src/parsers/formatDetector.ts`
- `src/parsers/edtParser.ts`
- единый registry в `src/constants/` или `src/types/`
- `src/models/treeNode.ts`
- `src/utils/metadataTypeMapper.ts`
- `src/utils/treeNormalization.ts`
- `src/services/metadataFileLocator.ts`
- `src/rules/`
- `src/constants/metadataTypeReferenceKinds.ts`
- `src/agent/agentFormsOperations.ts`
- Designer/EDT/Sequence/manifest tests

### Что менять

- Discovery и activation распознают чистый EDT root по `.project`/`src/**/*.mdo`
  без синтетического `Configuration.xml`.
- Ввести единый descriptor registry типов 1С; добавить `Sequence` во все derived
  mappings, tree, rules, refs и file locations.
- Manifest честно объявляет отсутствие Virtual Workspace support до URI-native
  реализации.
- Forms читает задокументированный ключ `1cMetadataTree.platform.path`.

### Контракты

- `MetadataTypeDescriptor` содержит enum, Designer folder/root tag, EDT mapping,
  reference kinds, module capabilities и UI capabilities.
- Остальные mappings выводятся из registry и имеют exhaustive tests.
- `FormatDetector` возвращает root URI и формат без требования Designer marker.

## Коммит 5. Form editor и процессы

### Файлы

- `src/formEditor/formEditorProvider.ts`
- `src/formEditor/formMessageHandler.ts`
- `src/formEditor/formWebviewHtml.ts`
- `src/agent/agentFormsOperations.ts`
- `src/services/forms/FormsContext.ts`
- `src/services/forms/FormsIbsrvLauncher.ts`
- `src/services/forms/runFormsScript.ts`
- `resources/web-test/run.mjs`
- `src/state/extensionState.ts`
- `src/extension.ts`
- composition-root wiring Forms/process scopes
- lifecycle/process tests

### Что менять

- Перевести форму на editable custom document contract с dirty/save/revert/backup;
  закрытие не очищает модель до подтверждённого исхода.
- Удалять model после последнего editor/backup owner.
- Ввести resource scopes extension/workspace/configuration/infobase/operation;
  browser и ibsrv получают фактического владельца, idempotent stop и cleanup.
- Сессии браузера хранятся в workspace/global storage, а не внутри extension.
- stdout/stderr дренируются до завершения; временные каталоги удаляются.

### Контракты

- Custom document реализует VS Code edit/save/saveAs/revert/backup/dispose semantics.
- `ProcessHandle.stop(reason): Promise<ProcessStopOutcome>` идемпотентен.
- Частичный start всегда выполняет компенсационный cleanup в обратном порядке.
- Extension deactivation ожидает disposal всех зарегистрированных process scopes.

## Коммит 6. Отмена и производительность deploy/compare/ibcmd

### Файлы

- `src/bindings/deployService.ts`
- `src/bindings/bindingCommands.ts`
- `src/commands/configurationCompareCommands.ts`
- `src/compareMerge/configurationCompareService.ts`
- `src/compareMerge/metadata/metadataIndexer.ts`
- `src/services/ibcmd/IbcmdPathResolver.ts`
- `src/services/ibcmd/IbcmdService.ts`
- `src/services/ibcmd/IbcmdStreamingRunner.ts`
- все production callers `resolveExecutablePath` либо единый facade, через который
  они получают заранее разрешённый async-result/negative cache
- performance/cancellation/process-tree tests

### Что менять

- Snapshot deploy выполняется асинхронно, bounded-concurrency и проверяет token до
  первого эффекта и между batch-операциями.
- Compare получает cancellation, bounded readers и не удерживает повторные копии
  BSL source; aborted session полностью освобождается.
- Поиск ibcmd становится асинхронным с negative cache и не блокирует Extension Host.
- Миграция call sites выполняется целиком: синхронный getter после неё может только
  читать готовый cache и никогда не запускать filesystem/process discovery.
- Cancellation завершает process tree с grace period и hard escalation; результат
  не считается cancelled до подтверждённого завершения либо typed cleanup error.

### Контракты

- Все долгие операции принимают `CancellationToken`.
- Concurrency и memory limits задаются измеримыми параметрами; нет unbounded
  `Promise.all` по workspace.
- `terminateProcessTree` возвращает verified outcome, включая surviving PIDs/error.

## Коммит 7. Интеграционный Quality Gate и закрытие реестра

### Файлы

- профильные тесты `test/suite/`
- `docs/code-review-findings-2026-07-18.md`
- при необходимости test fixtures/scripts, без production обходов

### Что менять

- Добавить e2e fixtures для multi-root, pure EDT, Sequence, hostile webview input,
  concurrent writes/reloads, process start failure и cancellation.
- Добавить fault-injection matrix для atomic/multi-file storage.
- Для каждого AR-01..AR-16 указать тест и перевести статус в Fixed только после
  зелёного Quality Gate.
- Прогнать compile, lint, core, VS Code smoke и безопасную matrix на копии fixture.

### Контракты

- Ни один finding не закрывается одним unit self-roundtrip: требуется проверка на
  соответствующей границе (DOM/Configuration.xml, VS Code host, filesystem race,
  process tree или bounded large fixture).
- Пользовательские и внешние файлы вне тестовой копии не изменяются.
