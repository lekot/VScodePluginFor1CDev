# MCP Agent Adapter — компактный каталог и операции

## Цель

Дать стандартному MCP-клиенту полный доступ к существующему Agent API расширения без дублирования предметной логики. MCP является новым транспортом над теми же VS Code Agent-командами: каждый профильный dispatcher валидирует выбранную операцию и вызывает ровно одну команду через `vscode.commands.executeCommand`. `cdt_catalog` описывает закрытый каталог и команду не вызывает. Legacy Agent Bridge `/command` остаётся совместимым.

Нормативная граница Agent API — функция `registerAgentCommands` в `src/agent/agentCommands.ts`. MCP по умолчанию публикует семь компактных tools; закрытый каталог содержит 98 операций: 87 core-операций, 3 task-команды и 8 repository-команд.

Четыре UI-команды расширения не являются Agent API, не возвращают `AgentResult` и находятся вне scope:

- `1c-metadata-tree.borrowToExtension`;
- `1c-metadata-tree.navigateToMainObject`;
- `1c-metadata-tree.showRelatedObjects`;
- `1c-metadata-tree.showInterceptors`.

## Компактные tools по умолчанию

`tools/list` содержит ровно следующие семь инструментов:

| Tool | Profile | Описание |
|---|---|---|
| `cdt_read` | `read` | Чтение Agent API без внешних эффектов |
| `cdt_write` | `write` | Закрытая запись в файлы конфигурации |
| `cdt_write_idempotent` | `write_idempotent` | Повторяемая запись в файлы конфигурации |
| `cdt_read_live` | `read_live` | Чтение из внешней системы |
| `cdt_write_live` | `write_live` | Запись во внешнюю систему |
| `cdt_verify_live` | `verify_live` | Проверка внешней системы |
| `cdt_catalog` | — | Перечень операций и описание одной схемы |

Первые шесть принимают strict input `{ operation, arguments }`. `operation` — имя операции из полного каталога и допустимо только в своём profile; `arguments` валидируется исходной strict Zod-схемой операции до dispatch. Ошибка профиля или аргументов не вызывает Agent-команду. `cdt_catalog({})` возвращает имена, описания и profile всех 98 операций; `cdt_catalog({ operation })` возвращает JSON Schema выбранной операции. Refinements, которые невозможно выразить стандартной JSON Schema, остаются runtime-проверкой Agent/Zod операции. Каталог read-only и closed-world.

Переменная среды `CDT_MCP_LEGACY_TOOLS=1` дополнительно регистрирует все 98 индивидуальных operation tool с исходными схемами. По умолчанию эти индивидуальные имена не публикуются. Direct Agent API и legacy Agent Bridge `/command` от этого флага не зависят.

Annotations профилей совпадают с исходной классификацией операций: `read` = T/F/T/F, `write` = F/T/F/F, `write_idempotent` = F/T/T/F, `read_live` = T/F/T/T, `write_live` = F/T/F/T, `verify_live` = F/F/F/T. Для `cdt_catalog` используется `read` (T/F/T/F).

## Полный каталог операций и legacy mapping

Следующие таблицы фиксируют имя операции (`cdt_*`), её Agent command и annotations. Таблицы используются компактным dispatcher и opt-in legacy регистрацией; это не список имён в default `tools/list`. Обозначения annotations: `R` — `readOnlyHint`, `D` — `destructiveHint`, `I` — `idempotentHint`, `O` — `openWorldHint`. Значения статические и консервативные: если хотя бы один допустимый режим операции пишет данные или взаимодействует с внешней системой, применяется худший случай ко всей операции.

### Конфигурации и metadata CRUD

`cdt_get_properties`, `cdt_set_properties` и `cdt_list_children` передают Agent API path как последовательность type/name-пар от корневого объекта к выбранному вложенному элементу. Поддержаны ExternalDataSource → Function, ExternalDataSource → Table → Field, HTTPService → URLTemplate → Method, WebService → Operation → Parameter, IntegrationService → IntegrationServiceChannel, Task → AddressingAttribute, ChartOfAccounts → AccountingFlag/ExtDimensionAccountingFlag, DocumentJournal → Column и Sequence → Dimension; legacy пути атрибутов и колонок табличных частей сохраняются. Для ExternalDataSource Table текущий путь поддерживает только Designer XML `ExternalDataSources/<источник>/Tables/<таблица>.xml`; EDT `.mdo`-раскладка этим путём пока не поддерживается. Root `listChildren` возвращает scalar-ссылки на Table и inline Function; Table path читает и пишет свойства отдельного XML-файла, а Field selector внутри него начинается с `Table.<таблица>`. Перед доступом к файлу Agent API проверяет наличие ровно одной ссылки на таблицу в source `ChildObjects`. `listChildren` только читает каталог дочерних элементов и возвращает `{ children: [{ type, name, path }] }`; MCP не читает и не меняет XML напрямую. Повторное имя дочернего элемента разрешается только в пределах выбранного родителя; пропущенный или неоднозначный путь возвращает ошибку до записи.

| Tool | Agent command | R/D/I/O |
|---|---|---|
| `cdt_list_configurations` | `1c-metadata-tree.agent.listConfigurations` | T/F/T/F |
| `cdt_create_object` | `1c-metadata-tree.agent.createObject` | F/T/F/F |
| `cdt_get_yaml` | `1c-metadata-tree.agent.getYaml` | T/F/T/F |
| `cdt_list_objects` | `1c-metadata-tree.agent.listObjects` | T/F/T/F |
| `cdt_list_children` | `1c-metadata-tree.agent.listChildren` | T/F/T/F |
| `cdt_get_properties` | `1c-metadata-tree.agent.getProperties` | T/F/T/F |
| `cdt_add_attribute` | `1c-metadata-tree.agent.addAttribute` | F/T/F/F |
| `cdt_add_tabular_section` | `1c-metadata-tree.agent.addTabularSection` | F/T/F/F |
| `cdt_add_tabular_section_column` | `1c-metadata-tree.agent.addTabularSectionColumn` | F/T/F/F |
| `cdt_delete_attribute` | `1c-metadata-tree.agent.deleteAttribute` | F/T/F/F |
| `cdt_delete_tabular_section` | `1c-metadata-tree.agent.deleteTabularSection` | F/T/F/F |
| `cdt_delete_object` | `1c-metadata-tree.agent.deleteObject` | F/T/F/F |
| `cdt_rename_object` | `1c-metadata-tree.agent.renameObject` | F/T/F/F |
| `cdt_set_properties` | `1c-metadata-tree.agent.setProperties` | F/T/F/F |
| `cdt_roles_set_rights` | `1c-metadata-tree.agent.roles.setRights` | F/T/F/F |

### CFE projects

| Tool | Agent command | R/D/I/O |
|---|---|---|
| `cdt_cfe_list_projects` | `1c-metadata-tree.agent.cfe.listProjects` | T/F/T/F |
| `cdt_cfe_get_context` | `1c-metadata-tree.agent.cfe.getContext` | T/F/T/F |
| `cdt_cfe_validate` | `1c-metadata-tree.agent.cfe.validate` | T/F/T/F |
| `cdt_cfe_create_project` | `1c-metadata-tree.agent.cfe.createProject` | F/T/F/F |
| `cdt_cfe_borrow_object` | `1c-metadata-tree.agent.cfe.borrowObject` | F/T/T/F |
| `cdt_cfe_create_interceptor` | `1c-metadata-tree.agent.cfe.createInterceptor` | F/T/T/F |
| `cdt_cfe_create_own_form` | `1c-metadata-tree.agent.cfe.createOwnForm` | F/T/T/F |
| `cdt_cfe_borrow_form` | `1c-metadata-tree.agent.cfe.borrowForm` | F/T/T/F |
| `cdt_cfe_extend_form` | `1c-metadata-tree.agent.cfe.extendForm` | F/T/T/F |

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

### Фоновые задачи и репозиторий конфигурации

| Tool | Agent command | R/D/I/O |
|---|---|---|
| `cdt_task_status` | `1c-metadata-tree.agent.task.status` | T/F/T/F |
| `cdt_task_result` | `1c-metadata-tree.agent.task.result` | T/F/T/F |
| `cdt_task_cancel` | `1c-metadata-tree.agent.task.cancel` | F/T/F/T |
| `cdt_repository_connect` | `1c-metadata-tree.agent.repository.connect` | F/T/F/T |
| `cdt_repository_disconnect` | `1c-metadata-tree.agent.repository.disconnect` | F/T/F/T |
| `cdt_repository_lock` | `1c-metadata-tree.agent.repository.lock` | F/T/F/T |
| `cdt_repository_unlock` | `1c-metadata-tree.agent.repository.unlock` | F/T/F/T |
| `cdt_repository_commit` | `1c-metadata-tree.agent.repository.commit` | F/T/F/T |
| `cdt_repository_update_object` | `1c-metadata-tree.agent.repository.updateObject` | F/T/F/T |
| `cdt_repository_update_configuration` | `1c-metadata-tree.agent.repository.updateConfiguration` | F/T/F/T |
| `cdt_repository_get_status` | `1c-metadata-tree.agent.repository.getStatus` | T/F/T/F |

Каждый repository input является strict object и требует `configurationId`. `lock`, `unlock`,
`commit` и `updateObject` принимают root-only dot-path `RootTag.ObjectName`; команда разрешает
конкретный lazy tree node внутри именно выбранной конфигурации или CFE. `connect` дополнительно
требует `executionInfobaseId`, путь, пользователя и optional password; ID должен указывать на существующую
файловую ИБ CDT. `commit.comment` после trim должен быть непустым и проверяется до импорта или
запуска процесса. Все repository mutations по умолчанию имеют `background: true`;
`background: false` выполняет repository/deploy call синхронно. `task.cancel` синхронно отправляет
запрос отмены и возвращает текущее состояние задачи; у этой команды нет параметра `background`.

В `repository.getStatus` значение `live: false` явно обозначает локальное последнее наблюдавшееся
состояние; live repository не опрашивается. Пароль Connect передаётся сервису/SecretStorage и не
попадает в AgentResult или сообщения task. Исходный repository service result целиком находится в
`AgentResult.data`: `acknowledged`, `failed`, `inDoubt` или `cancelled`, включая affected names и
synchronized files. Только `acknowledged` даёт `success: true`; status нельзя заменять общей ошибкой
отмены после завершения команды.

Длительные deploy/deploySelected/deployChanged/pull/exportStatus и EPF/ERF операции, четыре SKD
команды, четыре операции поддержки (`setObjectMode`, `enableObjectRules`, `sync`, `verify`),
`forms.start`/`exec`/`shot`/`native` и `debug.start`/`startFromBinding`/`waitForStop` поддерживают тот же
`background` input. MCP schema ставит `true` по умолчанию; `background: false` выполняет вызов
синхронно. Прямые Agent-вызовы этих команд без `background` остаются синхронными; операции
Хранилища сохраняют существующий фоновой default. Task receipt содержит `taskId`; status/result/cancel
обращаются к общему Agent-layer TaskManager. Терминальные результаты хранятся 15 минут, запись
ограничена 64 задачами и не вытесняет running task. Receipt возвращает `status: "working"`; task
snapshots используют состояния `running | completed | failed | cancelled` и `elapsedMs`, который
растёт от `createdAt` для running и фиксируется при `finishedAt` для terminal state. `recentMessages`
содержит этапы операции и доступные свежие строки процесса: tail до 24 sanitized сообщений длиной до
320 символов. Output проходит credential redaction до сохранения. Отмена запрашивает VS Code
CancellationTokenSource и не подтверждается до фактического завершения операции; для процессов с
возможным частичным эффектом возвращается typed `inDoubt`, исходный AgentResult вкладывается в
`task.result` без замены ответом на сам запрос отмены.

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
| `cdt_forms_native` | `1c-metadata-tree.agent.forms.native` | F/T/F/T |
| `cdt_form_inspect` | `1c-metadata-tree.agent.forms.inspect` | T/F/T/F |
| `cdt_form_validate` | `1c-metadata-tree.agent.forms.validate` | T/F/T/F |
| `cdt_form_edit` | `1c-metadata-tree.agent.forms.edit` | F/T/F/F |

`cdt_form_inspect` and `cdt_form_validate` read only `Forms/<name>/Ext/Form.xml` or `CommonForms/<name>/Ext/Form.xml` inside the selected configuration or extension. They accept `configurationId` and relative `formPath`; validation also accepts optional `formatVersion` (`2.17`–`2.21`). The inspect DTO includes the form tree, attributes, commands and the source-byte SHA-256 `rev`. Validation checks structural IDs/names and references. Event and command handler existence is checked only when the adjacent `Ext/Form/Module.bsl` exists; otherwise the result contains `MODULE_CHECK_SKIPPED`. `cdt_form_edit` applies a nonempty list of typed XML operations, supports side-effect-free `dryRun` with a diff, and requires the current `rev` as `ifRev` for atomic compare-and-swap commit. All three commands reject absolute paths, traversal and symlink escapes, and do not start a 1C process or browser.

### Справка по синтаксису и стандартам

| Tool | Agent command | R/D/I/O |
|---|---|---|
| `cdt_syntax_help` | `1c-metadata-tree.agent.syntaxHelp` | T/F/T/F |

`source` выбирает `syntax`, `standards` или `all` (по умолчанию `all`); `action` выбирает `search`, `get` или `children` (по умолчанию `search`). Поиск требует буквальный `query`, сортирует совпадения по имени, пути и содержимому; `%` и `_` — обычные символы. `limit` по умолчанию 10, диапазон 1–50; `snippetLength` по умолчанию 300, диапазон 40–1000.

`get` принимает ровно один selector: `id` либо точное имя/относительный путь в `query`. Синтаксис ID имеет вид `syntax:<числовой ID>`, ID статей — `standards:<slug>`; для синтаксиса допускается голый числовой ID. Неоднозначное имя возвращает `KNOWLEDGE_ITEM_AMBIGUOUS` и список кандидатов; неизвестный ID/путь — `KNOWLEDGE_ITEM_NOT_FOUND`. `children` принимает `parentId` (или `null`/отсутствующий для корней); дочерние узлы ограничены выбранным источником. DTO содержит только относительные пути. SQLite открывается через sql.js в памяти и используется только для чтения; SQL от клиента не принимается.

Поставляемая SQLite-база содержит 2673 собранных владельцем проекта узла справки. Рядом находятся 12 оригинальных русскоязычных заметок о транзакциях, серверных вызовах, размещении кода, безопасности, совместимости, БСП и метаданных. Они не воспроизводят тексты ИТС и ведут к официальным страницам для проверки актуальности.

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
- forms start для web требует хотя бы одно из `url`/`dbPath`; оба поля одновременно разрешены, и существующий Agent runtime отдаёт приоритет `dbPath`. Native требует `driver: "native"` и целый `port` от 1 до 65535, запрещая `url`/`dbPath`;
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
- forms: `{driver?,url?,dbPath?,platformPath?,readyTimeoutMs?,host?,port?,platformVersion?}`, `{script,timeoutMs?}`, `{}`, `{file?,timeoutMs?}`, `{}`, native action union (`overview`, `commandInterface`, `executeCommand`, `find`, `readField`, `writeField`, `act`, `readTable`, `formContext`, `createSnapshot`, `compareSnapshot`, `listSnapshots`, `deleteSnapshot`, `uiLog`);
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

Cancellation проверяется до dispatch; отменённый до dispatch вызов не запускает Agent-команду. MCP адаптирует `extra.signal` в VS Code CancellationToken и передаёт его синхронным Agent-командам. Для длительных Agent operations отмена передаётся runner/process tree, а очередь остаётся занята до завершения underlying promise. После abort adapter дожидается исхода команды. Typed repository service result (`acknowledged`, `failed`, `inDoubt`, `cancelled`) и task receipt сохраняются без замены на общую ошибку; это предотвращает потерю подтверждённого side effect и неопределённого исхода. Для остальных команд при abort возвращается `{ success: false, code: "REQUEST_CANCELLED", error: "MCP request was cancelled" }` с `isError: true`. Background task отменяется отдельным `cdt_task_cancel`; статус не становится `cancelled`, пока операция не завершилась подтверждённой отменой.

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
2. Default `tools/list` содержит ровно семь уникальных compact tools; opt-in legacy добавляет 98 уникальных individual tools.
3. `MCP_OPERATION_CATALOG` содержит 98 операций и точно покрывает все зарегистрированные Agent command IDs. Coverage-invariant test реально вызывает `registerAgentCommands` на VS Code stub, получает зарегистрированные IDs из `vscodeTestState.registeredCommandIds` и требует точного равенства с command IDs каталога; regex/source parsing не считается доказательством покрытия.
4. Четыре перечисленные UI-команды отсутствуют в MCP catalog.
5. Для всех 98 операций проверены имя, command id, strict schema, refinements и статические annotations; `cdt_catalog` сериализует JSON Schema каждой операции.
6. MCP и прямой Agent-вызов дают семантически одинаковый `AgentResult`; invalid outer/inner input не dispatch-ится.
7. Мутации проходят через существующие очереди Agent API; MCP не создаёт обходной write path.
8. `debug.start`/`startFromBinding` не раскрывают connection strings или полный launch config ни в логах, ни в неуспешном `AgentResult.error`; отдельные тесты покрывают оба канала.
9. Нет/неверный token, hostile Host/Origin и non-loopback peer отклоняются до dispatch.
10. Legacy `/command`, discovery compatibility, lifecycle и cancellation semantics не регрессируют.
11. Contract, coverage, security, lifecycle, `agentXdtoOperations` и official-client smoke tests входят в штатные core/smoke suites.
