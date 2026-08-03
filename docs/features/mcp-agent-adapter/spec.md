# MCP Agent Adapter — спецификация полного каталога

## Цель

Дать стандартному MCP-клиенту полный доступ к существующему Agent API расширения без дублирования предметной логики. MCP является новым транспортом над теми же VS Code Agent-командами: каждый tool валидирует input и вызывает ровно одну команду через `vscode.commands.executeCommand`. Legacy Agent Bridge `/command` остаётся совместимым.

Нормативная граница каталога — функция `registerAgentCommands` в `src/agent/agentCommands.ts`. В текущей версии она регистрирует 69 Agent-команд, и MCP публикует их все в отношении 1:1.

Четыре UI-команды расширения не являются Agent API, не возвращают `AgentResult` и находятся вне scope:

- `1c-metadata-tree.borrowToExtension`;
- `1c-metadata-tree.navigateToMainObject`;
- `1c-metadata-tree.showRelatedObjects`;
- `1c-metadata-tree.showInterceptors`.

## Полное отображение tools

Обозначения annotations: `R` — `readOnlyHint`, `D` — `destructiveHint`, `I` — `idempotentHint`, `O` — `openWorldHint`. Значения статические и консервативные: если хотя бы один допустимый режим tool пишет данные или взаимодействует с внешней системой, применяется худший случай ко всему tool.

### Конфигурации и metadata CRUD

| Tool | Agent command | R/D/I/O |
|---|---|---|
| `cdt_list_configurations` | `1c-metadata-tree.agent.listConfigurations` | T/F/T/F |
| `cdt_create_object` | `1c-metadata-tree.agent.createObject` | F/T/F/F |
| `cdt_get_yaml` | `1c-metadata-tree.agent.getYaml` | T/F/T/F |
| `cdt_list_objects` | `1c-metadata-tree.agent.listObjects` | T/F/T/F |
| `cdt_get_properties` | `1c-metadata-tree.agent.getProperties` | T/F/T/F |
| `cdt_add_attribute` | `1c-metadata-tree.agent.addAttribute` | F/T/F/F |
| `cdt_add_tabular_section` | `1c-metadata-tree.agent.addTabularSection` | F/T/F/F |
| `cdt_add_tabular_section_column` | `1c-metadata-tree.agent.addTabularSectionColumn` | F/T/F/F |
| `cdt_delete_attribute` | `1c-metadata-tree.agent.deleteAttribute` | F/T/F/F |
| `cdt_delete_tabular_section` | `1c-metadata-tree.agent.deleteTabularSection` | F/T/F/F |
| `cdt_delete_object` | `1c-metadata-tree.agent.deleteObject` | F/T/F/F |
| `cdt_rename_object` | `1c-metadata-tree.agent.renameObject` | F/T/F/F |
| `cdt_set_properties` | `1c-metadata-tree.agent.setProperties` | F/T/F/F |

### Debug

| Tool | Agent command | R/D/I/O |
|---|---|---|
| `cdt_debug_start` | `1c-metadata-tree.agent.debug.start` | F/T/F/T |
| `cdt_debug_stop` | `1c-metadata-tree.agent.debug.stop` | F/T/F/T |
| `cdt_debug_set_breakpoint` | `1c-metadata-tree.agent.debug.setBreakpoint` | F/T/F/T |
| `cdt_debug_clear_breakpoints` | `1c-metadata-tree.agent.debug.clearBreakpoints` | F/T/F/T |
| `cdt_debug_set_exception_filter` | `1c-metadata-tree.agent.debug.setExceptionFilter` | F/T/F/T |
| `cdt_debug_wait_for_stop` | `1c-metadata-tree.agent.debug.waitForStop` | T/F/T/T |
| `cdt_debug_get_stack_trace` | `1c-metadata-tree.agent.debug.getStackTrace` | T/F/T/T |
| `cdt_debug_get_scopes` | `1c-metadata-tree.agent.debug.getScopes` | T/F/T/T |
| `cdt_debug_get_variables` | `1c-metadata-tree.agent.debug.getVariables` | T/F/T/T |
| `cdt_debug_evaluate` | `1c-metadata-tree.agent.debug.evaluate` | F/T/F/T |
| `cdt_debug_continue` | `1c-metadata-tree.agent.debug.continue` | F/T/F/T |
| `cdt_debug_step_over` | `1c-metadata-tree.agent.debug.stepOver` | F/T/F/T |
| `cdt_debug_step_in` | `1c-metadata-tree.agent.debug.stepIn` | F/T/F/T |
| `cdt_debug_step_out` | `1c-metadata-tree.agent.debug.stepOut` | F/T/F/T |
| `cdt_debug_start_from_binding` | `1c-metadata-tree.agent.debug.startFromBinding` | F/T/F/T |

### Bindings и deploy

| Tool | Agent command | R/D/I/O |
|---|---|---|
| `cdt_resolve_binding` | `1c-metadata-tree.agent.resolveBinding` | T/F/T/F |
| `cdt_list_bindings` | `1c-metadata-tree.agent.listBindings` | T/F/T/F |
| `cdt_deploy` | `1c-metadata-tree.agent.deploy` | F/T/F/T |
| `cdt_deploy_selected_objects` | `1c-metadata-tree.agent.deploySelectedObjects` | F/T/F/T |
| `cdt_deploy_changed_files` | `1c-metadata-tree.agent.deployChangedFiles` | F/T/F/T |
| `cdt_pull_selected_objects` | `1c-metadata-tree.agent.pullSelectedObjects` | F/T/F/T |
| `cdt_export_status` | `1c-metadata-tree.agent.exportStatus` | T/F/T/T |

### Поддержка конфигурации

| Tool | Agent command | R/D/I/O |
|---|---|---|
| `cdt_support_get_status` | `1c-metadata-tree.agent.supportGetStatus` | T/F/T/F |
| `cdt_support_set_object_mode` | `1c-metadata-tree.agent.supportSetObjectMode` | F/T/F/T |
| `cdt_support_enable_object_rules` | `1c-metadata-tree.agent.supportEnableObjectRules` | F/T/F/T |
| `cdt_support_sync` | `1c-metadata-tree.agent.supportSync` | F/T/F/T |
| `cdt_support_verify` | `1c-metadata-tree.agent.supportVerify` | F/F/F/T |
| `cdt_support_get_last_run` | `1c-metadata-tree.agent.supportGetLastRun` | T/F/T/F |

`getStatus` и `getLastRun` читают только локальные master/journal. `verify` не меняет master или
информационные базы, но запускает внешний Configurator dump и записывает новый durable audit run:
поэтому его annotations — non-readonly, non-destructive, non-idempotent и open-world. Три
destructive операции могут изменить `ParentConfigurations.bin` и/или связанные информационные базы.

`SupportStatusResult` является discriminated contract: при `master.kind: "ready"`
`metadataUniverse` обязателен, при `unmanaged | unknown` это поле отсутствует; `lastRun` optional в
обоих случаях. `TargetSelection.ids.targetIds` — непустой массив уникальных canonical IDs и точное
подмножество replicated targets. Empty/duplicate/unknown/no-match selection не расширяется до
`all`, а возвращает typed `targetSelectionRejected` / `SUPPORT_TARGET_SELECTION_REJECTED`.
Retryable selection учитывает только текущую master generation, исключает permanent failures и
для `inDoubt` требует reconcile вместо blind apply.

### Внешние обработки и отчёты

| Tool | Agent command | R/D/I/O |
|---|---|---|
| `cdt_dump_external_processor` | `1c-metadata-tree.agent.dumpExternalProcessor` | F/T/F/T |
| `cdt_build_external_processor` | `1c-metadata-tree.agent.buildExternalProcessor` | F/T/F/T |

Оба tool записывают локальные файлы, запускают внешний Configurator и могут обращаться к
информационной базе, поэтому имеют консервативный контракт `WRITE_OPEN`. Dump никогда не
перезаписывает существующий каталог, build — существующий `.epf`/`.erf`. Для обоих вызовов обязателен
явный execution context: файловая информационная база либо standalone с подтверждённым риском потери
типов. Временная информационная база не создаётся и не выбирается неявно.

### Типы, командный интерфейс и характеристики

| Tool | Agent command | R/D/I/O |
|---|---|---|
| `cdt_get_type` | `1c-metadata-tree.agent.getType` | T/F/T/F |
| `cdt_set_type` | `1c-metadata-tree.agent.setType` | F/T/F/F |
| `cdt_get_subsystem_command_interface` | `1c-metadata-tree.agent.getSubsystemCommandInterface` | T/F/T/F |
| `cdt_set_subsystem_command_visibility` | `1c-metadata-tree.agent.setSubsystemCommandVisibility` | F/T/F/F |
| `cdt_set_subsystem_command_order` | `1c-metadata-tree.agent.setSubsystemCommandOrder` | F/T/F/F |
| `cdt_set_subsystem_subsystems_order` | `1c-metadata-tree.agent.setSubsystemSubsystemsOrder` | F/T/F/F |
| `cdt_list_predefined_characteristics` | `1c-metadata-tree.agent.listPredefinedCharacteristics` | T/F/T/F |
| `cdt_get_predefined_characteristic_type` | `1c-metadata-tree.agent.getPredefinedCharacteristicType` | T/F/T/F |
| `cdt_set_predefined_characteristic_type` | `1c-metadata-tree.agent.setPredefinedCharacteristicType` | F/T/F/F |
| `cdt_get_characteristic_value_registers` | `1c-metadata-tree.agent.getCharacteristicValueRegisters` | T/F/T/F |

### Forms

| Tool | Agent command | R/D/I/O |
|---|---|---|
| `cdt_forms_start` | `1c-metadata-tree.agent.forms.start` | F/T/F/T |
| `cdt_forms_exec` | `1c-metadata-tree.agent.forms.exec` | F/T/F/T |
| `cdt_forms_stop` | `1c-metadata-tree.agent.forms.stop` | F/T/F/T |
| `cdt_forms_shot` | `1c-metadata-tree.agent.forms.shot` | F/T/F/T |
| `cdt_forms_status` | `1c-metadata-tree.agent.forms.status` | T/F/T/T |

### SKD

| Tool | Agent command | R/D/I/O |
|---|---|---|
| `cdt_skd_compile` | `1c-metadata-tree.agent.skd.compile` | F/T/F/T |
| `cdt_skd_info` | `1c-metadata-tree.agent.skd.info` | F/T/F/T |
| `cdt_skd_edit` | `1c-metadata-tree.agent.skd.edit` | F/T/F/T |
| `cdt_skd_validate` | `1c-metadata-tree.agent.skd.validate` | F/T/F/T |

`skd.info` и `skd.validate` имеют optional `outFile`, поэтому статически не считаются read-only. `skd.compile` всегда пишет `outputPath`, `skd.edit` изменяет шаблон.

### XDTO

| Tool | Agent command | R/D/I/O |
|---|---|---|
| `cdt_xdto_list_packages` | `1c-metadata-tree.agent.xdto.listPackages` | T/F/T/F |
| `cdt_xdto_get_package` | `1c-metadata-tree.agent.xdto.getPackage` | T/F/T/F |
| `cdt_xdto_export_xsd` | `1c-metadata-tree.agent.xdto.exportXsd` | F/T/F/F |
| `cdt_xdto_import_xsd` | `1c-metadata-tree.agent.xdto.importXsd` | F/T/F/F |
| `cdt_xdto_create_from_xsd` | `1c-metadata-tree.agent.xdto.createFromXsd` | F/T/F/F |
| `cdt_xdto_compare` | `1c-metadata-tree.agent.xdto.compare` | T/F/T/F |
| `cdt_xdto_merge` | `1c-metadata-tree.agent.xdto.merge` | F/T/F/F |

`xdto.exportXsd` без `outputPath` читает XSD, а с `outputPath` пишет файл через mutation plan. Статическая annotation отражает пишущий режим.

## Input schemas

Все schemas — strict objects: неизвестные поля запрещены, coercion строк/чисел/boolean отсутствует. Нормативный источник shape каждого input — соответствующий TypeScript DTO, импортированный `agentCommands.ts`, и фактическая runtime-валидация вызываемой Agent operation. MCP schema не вводит более узких ограничений ради удобства клиента. `properties` — `Record<string, unknown>`. Пустой объект является явным input для tools без параметров.

Общие правила:

- строковые поля задаются JSON string без общего `min(1)`; non-empty refinement добавляется только там, где текущий Agent source явно проверяет непустое значение;
- `configurationId?: string` включается только в configuration-scoped Agent-команды;
- числовые поля задаются конечным JSON number без общего `int`, min/max или port range; дополнительные ограничения добавляются только при наличии такой проверки в текущем runtime (например, `debug.setBreakpoint.line` требует целое `> 0`);
- enum ограничивается точными литералами исходных TypeScript unions;
- `files` и `objectIds` — массивы строк; refinement требует непустой массив, потому что Agent-команды явно отклоняют пустые списки, но не вводит общий `min(1)` для элементов;
- `types` и `selectedIds` остаются массивами строк без искусственного `min(1)`: пустой список имеет определённую Agent-семантику;
- optional `query` допускает пустую строку; Agent API сам делает trim и трактует её как отсутствие name-фильтра;
- `inputPath` и inline `source` для XDTO import/create взаимоисключающие и требуют ровно одно значение;
- XDTO compare/merge требуют хотя бы одно из `inputPath`/`source`; при наличии обоих сохраняется существующий приоритет Agent API;
- XDTO package selector требует хотя бы одно из `packageName`/`metadataPath`; если присутствуют оба, сохраняется существующее разрешение Agent API;
- SKD compile требует ровно одно из `definitionFile`/`value` и обязательный `outputPath`;
- forms start требует хотя бы одно из `url`/`dbPath`; оба поля одновременно разрешены, и существующий Agent runtime отдаёт приоритет `dbPath`;
- `debuggeeType` — только `thinClient | webServer`; SKD `mode`, `operation`, XDTO `joinStrategy` и command visibility задаются исчерпывающими enums.
- support UUID — канонический UUID без coercion; `configurationId` и generation ids непустые;
  `TargetSelection` является strict discriminated union `all | retryable | ids`, а `ids.targetIds`
  и `retryable.include` — непустые массивы уникальных значений.
- контекст внешней обработки — strict discriminated union:
  `{kind:"infobase",infobasePath:string,credentials?:{user?:string,password?:string}}` либо
  `{kind:"standalone",acknowledgeTypeLoss:true}`; `infobasePath` непустой, standalone требует
  буквального `true`, неизвестные поля запрещены также внутри `credentials`;
- `timeoutMs` внешней обработки — положительное целое; обязательные и optional пути непустые,
  dump format — только `Plain | Hierarchical`.

Точные shapes по доменам:

- metadata: `{}`, `{configurationId?,type,name,synonym?,properties?}`, `{configurationId?,path}`, `{configurationId?,type?,query?}`, `{configurationId?,path,name}`, `{configurationId?,path,newName}`, `{configurationId?,path,properties}`, `{configurationId?,path,types}`;
- debug: `{rootProject,infobase,platformPath,extensions?,debugServerHost?,debugServerPort?,debuggeeType?,databasePath?}`, `{sessionId}`, `{file,line,condition?,hitCondition?,logMessage?}`, `{file?}`, `{sessionId,enabled,substring?}`, `{sessionId,timeoutMs?}`, `{sessionId,threadId}`, `{sessionId,frameId}`, `{sessionId,varRef}`, `{sessionId,expression,frameId?}`, `{configPath?,debuggeeType?}`;
- bindings/deploy: `{configPath?}`, `{}`, `{configurationId?,configPath?}`, `{configurationId?,configPath?,files}`, `{configurationId?,configPath?,objectIds,infobaseName?}`;
- support: `{configurationId,objectIds?}`, `{configurationId,objectId,targetMode,expectedGenerationId}`,
  `{configurationId,targetObjectId,targetMode,expectedGenerationId,expectedMetadataUniverseGenerationId}`,
  `{configurationId,targets,verification?}`, `{configurationId,targets}`, `{configurationId}`;
- external processors: `{srcPath,outDir?,format,context,timeoutMs?}`,
  `{rootXmlPath,dstPath?,context,timeoutMs?}`;
- subsystem/characteristics: `{configurationId?,subsystemPath}`, `{configurationId?,subsystemPath,commandName,common}`, `{configurationId?,subsystemPath,entries: strict {commandName:string,commandGroup:string}[]}`, `{configurationId?,subsystemPath,order:string[]}`, `{configurationId?,path}`, `{configurationId?,path,predefinedName}`, `{configurationId?,path,predefinedName,types:string[]}`;
- forms: `{url?,dbPath?,platformPath?,readyTimeoutMs?}`, `{script,timeoutMs?}`, `{}`, `{file?}`, `{}`;
- SKD: `{definitionFile?,value?,outputPath}`, `{templatePath,mode?,name?,batch?,limit?,offset?,outFile?}`, `{templatePath,operation,value,dataSet?,variant?,noSelection?}`, `{templatePath,detailed?,maxErrors?,outFile?}`;
- XDTO: `{configurationId?}`, selector + `{includeSource?}`, selector + `{outputPath?,includeSource?}`, selector + `{inputPath?,source?}`, `{configurationId?,packageName,inputPath?,source?}`, selector + `{inputPath?,source?,includeTree?,joinStrategy?}`, selector + `{inputPath?,source?,selectedIds,joinStrategy?}`.

## Dispatch, результаты и ошибки

- Валидный вызов исполняет ровно одну существующую Agent-команду через `vscode.commands.executeCommand`.
- MCP не реализует XML, support, queue, binding, deploy, debug, forms, SKD или XDTO business logic.
- Исходный `AgentResult` без изменения семантики возвращается в `structuredContent` и JSON-копией в text content.
- `AgentResult.success === false` даёт MCP tool result с `isError: true`.
- Исключение Agent-команды нормализуется в `{ success: false, code: "AGENT_COMMAND_FAILED", error: "Agent command failed" }`; исходный exception и stack trace клиенту не возвращаются.
- Неуспешный `debug.start`/`debug.startFromBinding` возвращает generic `AgentResult.error`, который не содержит `infobase`, connection string, credentials или сериализованный launch config; это ограничение действует до общего MCP mapper и для прямого Agent-вызова.
- Ошибка schema/refinement не вызывает Agent-команду и остаётся стандартной ошибкой MCP tool invocation.
- Mutating configuration tools сохраняют существующие `ConfigurationSession.enqueue`/`enqueuePlan`, потому что MCP вызывает Agent command, а не нижележащий service.
- Support Agent-команды возвращают полный discriminated facade outcome в `AgentResult.data`.
  `committedWithReplicationIssue`, `incomplete`, rejected и recovery outcomes имеют
  `AgentResult.success=false`; локальный commit при незавершённой репликации не маскируется как успех.
  `MasterSupportSnapshot.objectModes` сериализуется как JSON object с UUID-ключами.
- External processor Agent-команды являются тонкими обёртками над общим service: `completed`
  даёт `AgentResult.success=true`, `failed` и `inDoubt` — `success=false` с исходными `code`,
  `message` и полным discriminated result в `data`. Missing или malformed execution context прямого
  и legacy Agent-вызова нормализуется в `EXTERNAL_CONTEXT_INVALID` до path resolution и без
  исключения наружу. Для `inDoubt` обязательный `stagingPath` указывает staging/evidence;
  optional `publishedArtifactPath` присутствует только если canonical destination уже опубликован
  или мог стать видимым. Клиент не должен считать отсутствие файла по `stagingPath` доказательством
  отсутствия опубликованного эффекта, когда задан `publishedArtifactPath`.

Cancellation проверяется перед dispatch и после его завершения. Отмена до dispatch не запускает Agent-команду. Отмена во время исполнения не прерывает уже запущенную команду: adapter дожидается её, отбрасывает результат и возвращает `{ success: false, code: "REQUEST_CANCELLED", error: "MCP request was cancelled" }` с `isError: true`. Принудительная остановка процессов, debug/forms sessions и мутаций не обещается без отдельного cancellation-контракта Agent API.

## Транспорт, security и trust boundary

- Один listener Agent Bridge на `127.0.0.1:0` обслуживает legacy `/command` и Streamable HTTP `/mcp`.
- `/mcp` поддерживает `POST`, `GET`, `DELETE` и stateful sessions официального MCP SDK.
- Каждый запрос требует Bearer token; session id не является авторизацией, token в URL запрещён.
- До MCP SDK проверяются loopback peer, loopback `Host` и, если передан, loopback `Origin`.
- Максимальный POST body — 16 MiB. Наружу не уходят stack traces и credentials.
- Аутентифицированный локальный MCP-клиент находится в той же trust boundary и обладает теми же правами, что клиент legacy `/command`; annotations являются подсказками клиенту, а не механизмом авторизации.
- `cdt_forms_exec` исполняет произвольный JavaScript, а `cdt_debug_evaluate` — произвольное BSL-выражение. Оба tools явно destructive/open-world.
- SKD tools запускают дочерние процессы и принимают локальные пути, включая выходные; поэтому их `openWorldHint` статически равен `true`.
- `cdt_dump_external_processor` и `cdt_build_external_processor` запускают Configurator, записывают
  локальные артефакты и в режиме `infobase` обращаются к указанной базе. Пароль передаётся только
  процессу, не включается в result/log/error. Режим `standalone` может потерять ссылочные типы и
  доступен только при `acknowledgeTypeLoss: true`.
- До публикации debug tools логи и `AgentResult.error` для `debug.start`/`debug.startFromBinding` не должны содержать `infobase`, connection string, полный launch config или credentials. Допустимы только redacted operational fields и generic внешняя ошибка.

Используются `@modelcontextprotocol/sdk` `^1.29.0` и `zod` `^4`; runtime — Node 18+/VS Code `^1.82.0`, WebCrypto устанавливается до ленивой загрузки SDK.

## Discovery и lifecycle

`.vscode/cdt-agent-bridge.json` сохраняет legacy top-level поля и содержит `schemaVersion: 2`, `instanceId`, `mcp: { url, transport: "streamable-http", authorization: "bearer" }`. Запись атомарная; remove выполняется только владельцем instance/token.

Stop: запрет новых запросов → закрытие MCP sessions/SSE → закрытие активных HTTP connections → listener → remove-if-owned discovery. Повторный stop безопасен.

## Критерии приёмки

1. Official SDK client проходит `initialize → tools/list → tools/call → DELETE session` по discovery URL и Bearer token.
2. `tools/list` содержит ровно 69 уникальных tools и ровно 69 уникальных Agent command mappings.
3. Coverage-invariant test реально вызывает `registerAgentCommands` на VS Code stub, получает зарегистрированные IDs из `vscodeTestState.registeredCommandIds` и требует точного равенства с command IDs каталога; regex/source parsing не считается доказательством покрытия.
4. Четыре перечисленные UI-команды отсутствуют в MCP catalog.
5. Для каждого tool проверены имя, command id, strict schema, refinements и статические annotations.
6. MCP и прямой Agent-вызов дают семантически одинаковый `AgentResult`; invalid input не dispatch-ится.
7. Мутации проходят через существующие очереди Agent API; MCP не создаёт обходной write path.
8. `debug.start`/`startFromBinding` не раскрывают connection strings или полный launch config ни в логах, ни в неуспешном `AgentResult.error`; отдельные тесты покрывают оба канала.
9. Нет/неверный token, hostile Host/Origin и non-loopback peer отклоняются до dispatch.
10. Legacy `/command`, discovery compatibility, lifecycle и cancellation semantics не регрессируют.
11. Contract, coverage, security, lifecycle, `agentXdtoOperations` и official-client smoke tests входят в штатные core/smoke suites.
