# CDT 41 Agent API — Skill Reference

Расширение CDT 41 для VS Code предоставляет **74** runtime-команды Agent API для программного
управления метаданными, CFE-проектами, поддержкой конфигурации, привязками, раскаткой, отладкой, формами enterprise,
СКД, XDTO-пакетами и внешними EPF/ERF 1С:Предприятие. Основной транспорт для агента — стандартный Streamable HTTP MCP;
прямой вызов через `vscode.commands.executeCommand` и legacy `/command` остаются совместимыми.

## MCP (Streamable HTTP) и discovery

Расширение поднимает локальный MCP endpoint на случайном порту при активации. Координаты записываются
в discovery-файл:

```
<workspaceFolder>/.vscode/cdt-agent-bridge.json
```

Формат:
```json
{
  "schemaVersion": 2,
  "instanceId": "7ef1b2b7-...",
  "port": 63088,
  "token": "baf0b38e...hex64...",
  "pid": 42144,
  "workspaceFolder": "C:/workspaces/my-configuration",
  "createdAt": "<ISO-8601 activation time>",
  "extensionVersion": "<installed extension version>",
  "docs": "https://github.com/lekot/VScodePluginFor1CDev/blob/main/docs/features/agent-api/agent-skill.md",
  "quickstart": "POST http://127.0.0.1:<port>/command ...",
  "mcp": {
    "url": "http://127.0.0.1:63088/mcp",
    "transport": "streamable-http",
    "authorization": "bearer"
  },
  "helperScriptPath": "<extensionPath>/resources/agent-bridge/call.sh",
  "discoverScriptPath": "<extensionPath>/resources/agent-bridge/discover.sh"
}
```

Поля `helperScriptPath` / `discoverScriptPath` относятся к legacy `/command` и сохранены для
совместимости.

`schemaVersion: 2` добавляет стандартный MCP endpoint, не удаляя ни одного legacy-поля. Discovery записывается атомарно; клиент должен перечитывать его после каждой активации расширения, потому что порт и token меняются. Token передаётся только в заголовке и не должен добавляться к URL или попадать в логи.

### Подключение MCP

Подключите MCP-клиент к `mcp.url` и настройте заголовок `Authorization: Bearer <token>` из того же discovery-файла. Endpoint принимает `POST`, `GET` и `DELETE`, использует stateful sessions и отклоняет запросы без token, не с loopback-интерфейса либо с посторонним `Host`/`Origin`.

MCP публикует полный Agent API: **74 tools для 74 runtime-команд**.

| Домен | MCP tools |
|---|---|
| Configuration/CRUD (13) | `cdt_list_configurations`, `cdt_create_object`, `cdt_get_yaml`, `cdt_list_objects`, `cdt_get_properties`, `cdt_add_attribute`, `cdt_add_tabular_section`, `cdt_add_tabular_section_column`, `cdt_delete_attribute`, `cdt_delete_tabular_section`, `cdt_delete_object`, `cdt_rename_object`, `cdt_set_properties` |
| CFE project lifecycle (5) | `cdt_cfe_list_projects`, `cdt_cfe_get_context`, `cdt_cfe_validate`, `cdt_cfe_create_project`, `cdt_cfe_borrow_object` |
| Debug (15) | `cdt_debug_start`, `cdt_debug_stop`, `cdt_debug_set_breakpoint`, `cdt_debug_clear_breakpoints`, `cdt_debug_set_exception_filter`, `cdt_debug_wait_for_stop`, `cdt_debug_get_stack_trace`, `cdt_debug_get_scopes`, `cdt_debug_get_variables`, `cdt_debug_evaluate`, `cdt_debug_continue`, `cdt_debug_step_over`, `cdt_debug_step_in`, `cdt_debug_step_out`, `cdt_debug_start_from_binding` |
| Bindings/deploy (7) | `cdt_resolve_binding`, `cdt_list_bindings`, `cdt_deploy`, `cdt_deploy_selected_objects`, `cdt_deploy_changed_files`, `cdt_pull_selected_objects`, `cdt_export_status` |
| Support (6) | `cdt_support_get_status`, `cdt_support_set_object_mode`, `cdt_support_enable_object_rules`, `cdt_support_sync`, `cdt_support_verify`, `cdt_support_get_last_run` |
| External EPF/ERF (2) | `cdt_dump_external_processor`, `cdt_build_external_processor` |
| Types/subsystems/characteristics (10) | `cdt_get_type`, `cdt_set_type`, `cdt_get_subsystem_command_interface`, `cdt_set_subsystem_command_visibility`, `cdt_set_subsystem_command_order`, `cdt_set_subsystem_subsystems_order`, `cdt_list_predefined_characteristics`, `cdt_get_predefined_characteristic_type`, `cdt_set_predefined_characteristic_type`, `cdt_get_characteristic_value_registers` |
| Forms (5) | `cdt_forms_start`, `cdt_forms_exec`, `cdt_forms_stop`, `cdt_forms_shot`, `cdt_forms_status` |
| SKD (4) | `cdt_skd_compile`, `cdt_skd_info`, `cdt_skd_edit`, `cdt_skd_validate` |
| XDTO (7) | `cdt_xdto_list_packages`, `cdt_xdto_get_package`, `cdt_xdto_export_xsd`, `cdt_xdto_import_xsd`, `cdt_xdto_create_from_xsd`, `cdt_xdto_compare`, `cdt_xdto_merge` |

Имена и inputs соответствуют описанным ниже Agent-командам: например, `cdt_debug_get_variables` вызывает `1c-metadata-tree.agent.debug.getVariables`, а `cdt_xdto_export_xsd` — `1c-metadata-tree.agent.xdto.exportXsd`. Полный нормативный mapping и annotations находятся в [MCP specification](../mcp-agent-adapter/spec.md).

Каждый tool вызывает ровно одну существующую Agent-команду и возвращает исходный `AgentResult` в `structuredContent` и JSON-копию в text content. Input objects строгие: неизвестные поля запрещены. Mutating tools сохраняют очереди Agent API.

### CFE project lifecycle

`cfe.listProjects`, `cfe.getContext` и `cfe.validate` читают устойчивые связи из
`.vscode/cfe-projects.json`. `cfe.createProject` принимает `baseConfigurationId`, имя расширения,
назначение, префикс и режим совместимости; необязательный `target` допускается только как путь
внутри workspace без абсолютных путей и переходов `..`. `cfe.borrowObject` принимает
`extensionConfigurationId` и ровно один источник: `sourceDotPath` (`Type.Name`) либо `sourceUuid`.
Заимствование идемпотентно по UUID, выполняется только из связанной основной конфигурации и пока
поддерживает Catalog, Document, Enum и CommonModule; неподтверждённые замыкания зависимостей
отклоняются с `CFE_DEPENDENCY_UNSUPPORTED`. Ответы содержат JSON-safe DTO: идентификаторы
конфигураций и метаданные связи, но не сессии VS Code и не абсолютные пути. Создание и заимствование
обновляют discovery конфигураций и дерево метаданных.

### Доверие и опасные операции

Bearer даёт аутентифицированному локальному MCP-клиенту ту же authority, что legacy `/command`, то есть доступ ко всему Agent API. В частности:

- `cdt_forms_exec` исполняет произвольный JavaScript в browser session;
- `cdt_debug_evaluate` исполняет BSL-выражение, которое может иметь side effects;
- deploy/pull меняют информационные базы или workspace;
- support set/enable/sync меняют master-файл и могут запускать Configurator для связанных ИБ;
- support verify не меняет master или информационные базы, но запускает внешние Configurator dump-процессы и записывает durable audit run в локальный журнал;
- `cdt_dump_external_processor` и `cdt_build_external_processor` запускают Configurator и создают файлы; standalone может потерять ссылочные типы и требует явного `acknowledgeTypeLoss: true`;
- debug/forms/SKD запускают и останавливают дочерние процессы; SKD принимает локальные input/output paths;
- XDTO export с `outputPath`, import/create/merge и metadata tools изменяют файлы конфигурации.

Подключайте только доверенный локальный MCP-клиент и не передавайте token в URL или логи. MCP annotations описывают риск, но не являются дополнительной авторизацией. Отмена запроса до dispatch не запускает Agent-команду; отмена после dispatch не прерывает уже запущенный процесс или мутацию, а только отбрасывает итоговый результат.

Legacy `POST /command`, helper-скрипты и все Agent-команды продолжают работать по прежнему контракту.

### Legacy `/command`

- **Health check:** `GET /health` → `{ "ok": true, "pid": ... }`
- **Команда:** `POST /command` с JSON-телом `{ "name": "...", "args": { ... } }`
- **Аутентификация:** заголовок `Authorization: Bearer <token>`
- **Content-Type:** `application/json; charset=utf-8` (важно для кириллицы)

Пример вызова через curl:
```bash
curl -X POST "http://127.0.0.1:$PORT/command" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d '{"name":"1c-metadata-tree.agent.listObjects","args":{"type":"Catalog"}}'
```

Пример вызова через Node.js (корректная кодировка для кириллицы):
```javascript
const data = JSON.stringify({
  name: '1c-metadata-tree.agent.debug.evaluate',
  args: { sessionId, frameId: 1, expression: 'Сумма' }
});
const req = http.request({
  hostname: '127.0.0.1', port: PORT, path: '/command', method: 'POST',
  headers: {
    'Authorization': `Bearer ${TOKEN}`,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data)
  }
}, res => { /* ... */ });
req.end(data);
```

#### Whitelist команд

Через bridge доступны только команды, соответствующие паттерну:
```
/^1c-metadata-tree\.agent(\.debug|\.forms|\.skd|\.xdto)?\.[a-zA-Z]+$/
```

#### Вызов через helper-скрипт

Расширение поставляет два bash-скрипта в `resources/agent-bridge/`, которые раскатываются вместе с VSIX и доступны любому агенту через абсолютный путь из `bridge.json`:

- **`call.sh <cmd-suffix> '<JSON-args>'`** — парсит `bridge.json`, делает `curl POST /command` c корректным UTF-8 и возвращает JSON-ответ.
- **`discover.sh`** — печатает координаты bridge и делает `GET /health`.

Discovery `bridge.json` в скриптах: `$CDT_AGENT_BRIDGE_FILE` → `./.vscode/cdt-agent-bridge.json` → обход каталогов вверх.

Пример (агент уже прочитал `bridge.json` и взял `helperScriptPath`):
```bash
HELPER=$(node -p "JSON.parse(require('fs').readFileSync('./.vscode/cdt-agent-bridge.json','utf8')).helperScriptPath")
bash "$HELPER" listObjects '{"type":"Catalog"}'
bash "$HELPER" debug.start '{"rootProject":"C:/conf","infobase":"File=...","platformPath":"C:/Program Files/1cv8/.../bin","debuggeeType":"webServer","databasePath":"C:/bases/my"}'
```

Helper-скрипт удобнее ручного legacy `curl`, но новые интеграции должны подключаться к стандартному
MCP endpoint через `mcp.url`.

---

## Адресация объектов (dot-path)

Все команды принимают путь в формате dot-path:

| Формат | Пример | Что адресует |
|--------|--------|-------------|
| `Тип.Имя` | `Catalog.Товары` | Корневой объект |
| `Тип.Имя.Attribute.Реквизит` | `Catalog.Товары.Attribute.Артикул` | Реквизит объекта |
| `Тип.Имя.TabularSection.ТЧ` | `Document.Заказ.TabularSection.Состав` | Табличная часть |
| `Тип.Имя.TabularSection.ТЧ.Attribute.Колонка` | `Document.Заказ.TabularSection.Состав.Attribute.Количество` | Колонка ТЧ |

Тип — английское имя rootTag: `Catalog`, `Document`, `Enum`, `InformationRegister`, `CommonModule`, `Subsystem`, `Report`, `DataProcessor`, `ChartOfAccounts`, `ChartOfCharacteristicTypes`, `AccumulationRegister`, `AccountingRegister`, `CalculationRegister`, `BusinessProcess`, `Task`, `ExchangePlan`, `Constant`, `Role`, `ScheduledJob`, `HTTPService`, `WebService` и др. (46 типов).

## Команды

Все команды возвращают единый envelope:

`{ success: boolean, data?: T, error?: string, code?: string, configurationId?: string, operationId?: string, snapshotVersion?: number }`.

В multi-root workspace сначала вызовите `1c-metadata-tree.agent.listConfigurations`. Команда возвращает
`data.configurations[]` с `configurationId`, путями, форматом, capabilities и health. Передавайте выбранный
`configurationId` во все последующие команды. Селектор можно опустить только когда открыта ровно одна
конфигурация, поддерживающая требуемую capability. Для мутаций `operationId` идентифицирует операцию, а
`snapshotVersion` — подтверждённую версию конфигурационной сессии.

#### `1c-metadata-tree.agent.listConfigurations`

Параметры не требуются. Команда не изменяет файлы и является публичной точкой discovery для multi-root workspace.

---

### Создание

#### `1c-metadata-tree.agent.createObject`

Создать корневой объект метаданных.

```json
{
  "type": "Catalog",
  "name": "Товары",
  "synonym": "Товары",
  "properties": {}
}
```

- `type` — тип объекта (обязательно)
- `name` — имя (обязательно)
- `synonym` — синоним (необязательно, по умолчанию = name)
- `properties` — дополнительные свойства для override (необязательно)

Возвращает: `{ filePath: string }` — путь к созданному XML-файлу.

#### `1c-metadata-tree.agent.addAttribute`

Добавить реквизит к объекту.

```json
{
  "path": "Catalog.Товары",
  "name": "Артикул"
}
```

#### `1c-metadata-tree.agent.addTabularSection`

Добавить табличную часть к объекту.

```json
{
  "path": "Document.Заказ",
  "name": "Состав"
}
```

#### `1c-metadata-tree.agent.addTabularSectionColumn`

Добавить колонку в табличную часть.

```json
{
  "path": "Document.Заказ.TabularSection.Состав",
  "name": "Количество"
}
```

---

### Чтение

#### `1c-metadata-tree.agent.getYaml`

Получить компактное YAML-представление объекта. Дефолтные свойства опущены — показаны только изменённые.

```json
{
  "path": "Catalog.Товары"
}
```

Возвращает: `{ yaml: string }`.

Пример YAML:
```yaml
Тип: Catalog
Имя: Товары
uuid: a1b2c3d4-...
ДлинаКода: 11
ДлинаНаименования: 150
Иерархический: true
Синоним: Товары
```

#### `1c-metadata-tree.agent.getProperties`

Получить все свойства объекта как JSON (включая дефолтные).

```json
{
  "path": "Catalog.Товары"
}
```

Возвращает: `{ properties: Record<string, unknown>, ownership?, sourceUuid? }`. В основной
конфигурации поля CFE отсутствуют; в CFE `ownership` равен `own` либо `adopted`, а `sourceUuid`
присутствует только для заимствованного объекта.

#### `1c-metadata-tree.agent.listObjects`

Список объектов конфигурации.

```json
{
  "type": "Catalog"
}
```

Без `type` — все объекты. Возвращает: `{ objects: [{ type, name, filePath, ownership?, sourceUuid? }] }`.
Поля CFE добавляются только при чтении расширения конфигурации и позволяют выбрать допустимую
специализированную операцию до мутации.

---

### Изменение

#### `1c-metadata-tree.agent.setProperties`

Изменить свойства существующего объекта. Нельзя менять `Name` (используйте `renameObject`).

```json
{
  "path": "Catalog.Товары",
  "properties": {
    "Hierarchical": true,
    "CodeLength": 11
  }
}
```

#### `1c-metadata-tree.agent.renameObject`

Переименовать объект (обновляет XML, файл, директорию, Configuration.xml).

```json
{
  "path": "Catalog.Товары",
  "newName": "Номенклатура"
}
```

Возвращает: `{ filePath: string }` — новый путь.

---

### Удаление

#### `1c-metadata-tree.agent.deleteObject`

Удалить корневой объект (XML-файл, директория, запись в Configuration.xml).

```json
{
  "path": "Catalog.Товары"
}
```

#### `1c-metadata-tree.agent.deleteAttribute`

Удалить реквизит объекта или колонку табличной части.

```json
{ "path": "Catalog.Товары.Attribute.Артикул" }
```

или колонку ТЧ:

```json
{ "path": "Document.Заказ.TabularSection.Состав.Attribute.Количество" }
```

#### `1c-metadata-tree.agent.deleteTabularSection`

Удалить табличную часть.

```json
{ "path": "Document.Заказ.TabularSection.Состав" }
```

---

### Привязки

#### `1c-metadata-tree.agent.resolveBinding`

Резолвит фикстуру конфигурации в информационную базу. Принимает полный путь, относительный, или просто имя фикстуры.

```json
{ "configPath": "uh" }
```

- `configPath` — имя фикстуры ("uh", "empty_conf"), относительный путь ("FormatSamples/uh") или полный путь (необязательно, по умолчанию — из дерева)

Fuzzy match: `"uh"` → `FormatSamples/uh/Configuration.xml`.

Возвращает: `{ configPath, configRelativePath, workspaceFolder, infobase: { id, name, type, filePath?, server?, database?, webUrl? } }`.

#### `1c-metadata-tree.agent.listBindings`

Список всех привязок с резолвленными инфобазами.

```json
{}
```

Возвращает: `[{ configRelativePath, workspaceFolder, infobaseCount, infobases: [...] }]`.

---

### Раскатка

#### `1c-metadata-tree.agent.deploy`

Раскатка конфигурации в привязанные информационные базы (ibcmd import + apply).

```json
{
  "configPath": "C:/reps/project/conf"
}
```

- `configPath` — путь к каталогу конфигурации (необязательно, по умолчанию — из дерева метаданных)

Возвращает: `{ summary: { success, error, skipped, hasPartial }, results: [{ infobase, status, message, errorCode?, skippedFiles? }] }`.

Требует предварительной привязки базы через UI («Привязать базы…»).
Для конфигурации с управляемым `ParentConfigurations.bin` полный directory import небезопасен и
отклоняется до запуска `ibcmd` с кодом `SUPPORT_MANAGED_FULL_DEPLOY_UNSAFE`. Используйте файловую
раскатку, которая умеет маршрутизировать master поддержки и исключать заблокированные объекты.

#### `1c-metadata-tree.agent.deploySelectedObjects`

Раскатка указанных файлов конфигурации в привязанные ИБ (ibcmd import files + apply).

```json
{
  "configPath": "C:/reps/project/conf",
  "files": ["Catalogs/Товары.xml", "Catalogs/Товары/Ext/ObjectModule.bsl"]
}
```

- `configPath` — путь к каталогу конфигурации (необязательно)
- `files` — массив относительных путей файлов от корня конфигурации (forward slashes, обязательно)

Возвращает общий deploy-result с `summary.hasPartial` и optional `results[].skippedFiles`.
`Ext/ParentConfigurations.bin` не передаётся в `ibcmd import files`, а маршрутизируется через
support facade. Файлы объектов, заблокированных master поддержки, исключаются; оставшиеся
импортируются, а результат считается частичным (`hasPartial: true`) и не маскируется как полный успех.

#### `1c-metadata-tree.agent.deployChangedFiles`

Раскатка файлов, изменённых в git working tree. Автоматически определяет изменённые файлы конфигурации.

```json
{
  "configPath": "C:/reps/project/conf"
}
```

- `configPath` — путь к каталогу конфигурации (необязательно)

Возвращает тот же формат и использует ту же partial-семантику поддержки, что
`deploySelectedObjects`.

#### `1c-metadata-tree.agent.pullSelectedObjects`

Выгрузка объектов из информационной базы в файлы конфигурации (ibcmd config export objects).

```json
{
  "configPath": "C:/reps/project/conf",
  "objectIds": ["Catalog.Товары", "CommonModule.ОбщийМодуль"],
  "infobaseName": "МояБаза"
}
```

- `configPath` — путь к каталогу конфигурации (необязательно)
- `objectIds` — массив идентификаторов объектов в формате `Type.Name` (обязательно)
- `infobaseName` — имя базы-источника, если привязано несколько (необязательно, по умолчанию — первая)

Возвращает тот же формат.

#### `1c-metadata-tree.agent.exportStatus`

Статус конфигурации: сравнение файлов конфигурации с состоянием в ИБ (ibcmd config export status).

```json
{
  "configPath": "C:/reps/project/conf"
}
```

- `configPath` — путь к каталогу конфигурации (необязательно)

Возвращает: `{ message: string }` — текстовый отчёт.

Требует наличия `ConfigDumpInfo.xml` в каталоге конфигурации (создаётся при полной выгрузке).

---

### Поддержка конфигурации (6 команд)

Все support-команды требуют точный `configurationId` из `listConfigurations`. Источник истины —
`Ext/ParentConfigurations.bin`; Agent API вызывает тот же application facade, что UI и deploy.
Ни одна команда не предоставляет force-write или обход expected generation.

Support outcome целиком возвращается в `AgentResult.data`. `success: true` означает только
`available` для чтения или полностью `synchronized` для mutation/sync/verify.
`committedWithReplicationIssue`, `incomplete`, любой rejected outcome и recovery uncertainty
возвращаются с `success: false`, но их полный discriminated outcome остаётся в `data`.

В JSON поле `MasterSupportSnapshot.objectModes` представлено объектом с UUID-ключами:

```json
{
  "objectModes": {
    "8b74b9d6-9d93-4c63-9014-6f42889a20cc": {
      "objectId": "8b74b9d6-9d93-4c63-9014-6f42889a20cc",
      "locked": true,
      "effectiveMode": "notEditable",
      "sources": []
    }
  }
}
```

#### `1c-metadata-tree.agent.supportGetStatus`

Читает актуальный master и последний завершённый sync/verify run. Для `master.kind: "ready"`
дополнительно строит metadata universe. `objectIds` необязателен и ограничивает `objectModes`
заданными UUID.

```json
{
  "configurationId": "cfg-...",
  "objectIds": ["8b74b9d6-9d93-4c63-9014-6f42889a20cc"]
}
```

Outcome:

- `available` с `master.kind: "ready"` — содержит обязательный `metadataUniverse` и optional `lastRun`;
- `available` с `master.kind: "unmanaged" | "unknown"` — не содержит `metadataUniverse`, но может содержать `lastRun`;
- `operationRejected` — чтение или журнал недоступны; `retryable: true`.

`master.kind` равен `ready`, `unmanaged` или `unknown`. Для `unknown` запись, sync и deploy
закрыты fail-closed до восстановления master-файла.

#### `1c-metadata-tree.agent.supportSetObjectMode`

Меняет режим одного UUID при включённых объектных правилах:

```json
{
  "configurationId": "cfg-...",
  "objectId": "8b74b9d6-9d93-4c63-9014-6f42889a20cc",
  "targetMode": "editableWithSupport",
  "expectedGenerationId": "<master.generationId>"
}
```

`targetMode`: `notEditable | editableWithSupport | removedFromSupport`. Generation берётся из
свежего `supportGetStatus`. При `SUPPORT_STALE_GENERATION` автоматического повтора нет: агент читает
новый status и заново принимает решение.

#### `1c-metadata-tree.agent.supportEnableObjectRules`

Явно переводит сертифицированный global lock в объектные правила, оставляя все объекты, кроме
указанной цели, эффективно заблокированными:

```json
{
  "configurationId": "cfg-...",
  "targetObjectId": "8b74b9d6-9d93-4c63-9014-6f42889a20cc",
  "targetMode": "editableWithSupport",
  "expectedGenerationId": "<master.generationId>",
  "expectedMetadataUniverseGenerationId": "<metadataUniverse.metadataUniverseGenerationId>"
}
```

`targetMode`: `editableWithSupport | removedFromSupport`. Операция одновременно проверяет CAS
master generation и полного metadata universe. `SUPPORT_METADATA_UNIVERSE_STALE`,
`SUPPORT_OBJECT_UNIVERSE_INCOMPLETE` и неизвестная capability означают отказ без записи.

Mutation outcomes для `supportSetObjectMode` и `supportEnableObjectRules`:

- `synchronized` — local mutation и весь требуемый fan-out завершены;
- `committedWithReplicationIssue` — master уже committed, но репликация incomplete/inDoubt;
- `masterRejected` — unmanaged/unknown/recovery master;
- `preflightRejected` — invalid binding либо неподдерживаемая цель, до local commit;
- `mutationRejected` — CAS/capability/effective-diff отказ без записи;
- `operationRejected` — безопасно нормализованный внутренний отказ.

`committedWithReplicationIssue.retryOperation` всегда `sync`: local commit не откатывается из-за
ошибки отдельной ИБ и не маскируется как полный успех.

#### Target selection

`supportSync` и `supportVerify` принимают один из трёх strict selectors:

```json
{ "kind": "all" }
```

```json
{
  "kind": "retryable",
  "include": ["failed", "inDoubt", "targetDrift"]
}
```

```json
{
  "kind": "ids",
  "targetIds": ["file:C:/bases/main"]
}
```

Retryable preset использует точные причины `failed | inDoubt | targetDrift`; permanent failure не
становится retryable. Выбор generation-scoped: учитываются только результаты с
`desiredGenerationId`, равным текущей master generation. `inDoubt` сначала проходит reconcile,
blind repeat apply запрещён.

Для `kind: "ids"` массив `targetIds` должен быть непустым и содержать уникальные canonical IDs.
Selector задаёт точное подмножество доступных replicated targets — расширения до `all` нет. Пустой список,
дубликаты, неизвестные IDs и отсутствие совпадений для retryable selector возвращают typed outcome
`targetSelectionRejected` с `SUPPORT_TARGET_SELECTION_REJECTED`, `reason` и диагностическими
списками IDs.

#### `1c-metadata-tree.agent.supportSync`

Применяет текущую неизменяемую master generation к выбранным связанным ИБ:

```json
{
  "configurationId": "cfg-...",
  "targets": { "kind": "all" },
  "verification": "fast"
}
```

`verification`: optional `fast | strict`, по умолчанию `fast`. Outcome:
`synchronized | incomplete | masterRejected | preflightRejected | targetSelectionRejected | operationRejected`.
`incomplete` содержит сохранённый target-by-target run, если он успел сформироваться.

#### `1c-metadata-tree.agent.supportVerify`

Строгая проверка через Configurator dump: информационные базы и master не изменяются, но результат
записывается в durable audit journal как новый verify run. Поэтому операция не является storage
read-only или идемпотентной, хотя не выполняет destructive mutation конфигурации или ИБ:

```json
{
  "configurationId": "cfg-...",
  "targets": { "kind": "ids", "targetIds": ["file:C:/bases/main"] }
}
```

Outcome имеет те же верхнеуровневые статусы, что `supportSync`, включая
`targetSelectionRejected`. `inDoubt`, `stale`, `failed`,
`skipped` и `obsolete` остаются явными terminal states и не преобразуются в success.

#### `1c-metadata-tree.agent.supportGetLastRun`

Читает последний завершённый sync/verify run:

```json
{
  "configurationId": "cfg-..."
}
```

`available.run` может отсутствовать. Если run есть, он содержит `desiredGenerationId`, operation,
scope, terminal state и результаты каждой canonical target. Active run после crash сначала
восстанавливается журналом; неподтверждённый apply остаётся `inDoubt`.

---

### Внешние обработки и отчёты (2 команды)

Обе команды являются мутациями `WRITE_OPEN`: результат публикуется только в отсутствующий путь.
Контекст выполнения обязателен и выбирается ровно одним discriminant:

```json
{ "kind": "infobase", "infobasePath": "C:/bases/main", "credentials": { "user": "Администратор", "password": "..." } }
```

или

```json
{ "kind": "standalone", "acknowledgeTypeLoss": true }
```

Standalone не подменяется временной ИБ и может потерять ссылочные типы конфигурации. Пароль не
попадает в диагностический log. Результат находится в `AgentResult.data`: `state` равен
`completed`, `failed` или `inDoubt`. Для `inDoubt` обязательный `stagingPath` указывает
staging/evidence, а optional `publishedArtifactPath` — canonical destination, который уже
опубликован или мог стать видимым; эти места нельзя считать взаимозаменяемыми.

#### `1c-metadata-tree.agent.dumpExternalProcessor`

Разбирает `.epf` или `.erf` в новый каталог XML. Формат обязателен:

```json
{
  "srcPath": "C:/work/Обработка.epf",
  "outDir": "C:/work/Обработка_src",
  "format": "Hierarchical",
  "context": { "kind": "standalone", "acknowledgeTypeLoss": true }
}
```

`outDir` можно опустить: используется соседний `<имя>_src`. MCP tool:
`cdt_dump_external_processor`.

#### `1c-metadata-tree.agent.buildExternalProcessor`

Собирает `.epf` или `.erf` из корневого XML-файла, а не из каталога:

```json
{
  "rootXmlPath": "C:/work/Обработка_src/Обработка.xml",
  "dstPath": "C:/work/Обработка_built.epf",
  "context": { "kind": "infobase", "infobasePath": "C:/bases/main" }
}
```

Тип результата определяется по metadata root `ExternalDataProcessor` или `ExternalReport`.
`dstPath` можно опустить: сервис предложит соседний `_built.epf` или `_built.erf`. MCP tool:
`cdt_build_external_processor`.

---

### Отладка (15 команд)

Все debug-команды используют `sessionId`, полученный из `debug.start`.

#### `1c-metadata-tree.agent.debug.start`

Запуск отладочной сессии. Два режима:

**thinClient** (по умолчанию) — dbgs.exe + 1cv8c.exe:
```json
{
  "rootProject": "C:/reps/project/conf",
  "infobase": "File=C:/Users/User/Documents/InfoBase",
  "platformPath": "C:/Program Files/1cv8/8.3.27.1859/bin"
}
```

**webServer** — ibsrv с встроенным RDBG (для Playwright / агентской работы с формами):
```json
{
  "rootProject": "C:/reps/project/conf",
  "infobase": "File=C:/Users/User/Documents/InfoBase",
  "platformPath": "C:/Program Files/1cv8/8.3.27.1859/bin",
  "debuggeeType": "webServer",
  "databasePath": "C:/Users/User/Documents/InfoBase"
}
```

- `debuggeeType` — `"thinClient"` (default) или `"webServer"`
- `databasePath` — путь к файловой ИБ (обязателен для webServer, можно опустить если есть в `infobase` как `File=...`)

Возвращает: `{ sessionId: string, webServerUrl?: string }`.

`webServerUrl` — URL веб-клиента ibsrv (только для webServer). Открыть в Playwright для навигации и взаимодействия.

#### `1c-metadata-tree.agent.debug.startFromBinding`

Запуск отладки через привязку (без ручного указания путей).

```json
{
  "binding": "empty_conf",
  "debuggeeType": "webServer"
}
```

- `binding` — имя фикстуры (fuzzy match: `"uh"`, `"empty_conf"`), относительный или абсолютный путь
- `debuggeeType` — `"thinClient"` (default) или `"webServer"`

Резолвит binding → rootProject, infobase, platformPath автоматически. Возвращает то же, что `debug.start`.

#### `1c-metadata-tree.agent.debug.stop`

Остановка отладочной сессии.

```json
{ "sessionId": "..." }
```

#### `1c-metadata-tree.agent.debug.setBreakpoint`

Точка останова с опциональным условием, хит-каунтом или логпойнтом.

```json
{
  "file": "C:/conf/Catalogs/Товары/Ext/ObjectModule.bsl",
  "line": 5,
  "condition": "Количество > 0",
  "hitCondition": ">= 3",
  "logMessage": "Вошли в процедуру"
}
```

Возвращает: `{ verified: boolean, id: string }`.

#### `1c-metadata-tree.agent.debug.clearBreakpoints`

Удалить точки останова (по файлу или все).

```json
{ "file": "C:/conf/Catalogs/Товары/Ext/ObjectModule.bsl" }
```

#### `1c-metadata-tree.agent.debug.setExceptionFilter`

Остановка при исключениях с опциональным фильтром.

```json
{ "sessionId": "...", "enabled": true, "substring": "Деление на ноль" }
```

#### `1c-metadata-tree.agent.debug.waitForStop`

Ожидание остановки (breakpoint, step, exception, pause). Возвращает top frame.

```json
{ "sessionId": "...", "timeoutMs": 30000 }
```

Возвращает: `{ reason, threadId, frameId, file, line }`.

#### `1c-metadata-tree.agent.debug.getStackTrace`

Стек вызовов потока.

```json
{ "sessionId": "...", "threadId": 1 }
```

Возвращает: `{ frames: [{ id, name, file, line }] }`.

#### `1c-metadata-tree.agent.debug.getScopes`

Области видимости фрейма.

```json
{ "sessionId": "...", "frameId": 1 }
```

Возвращает: `{ scopes: [{ name, varRef }] }`.

#### `1c-metadata-tree.agent.debug.getVariables`

Переменные по varRef. Для drilldown — рекурсивно вызывать с varRef дочернего элемента.

```json
{ "sessionId": "...", "varRef": 1 }
```

Возвращает: `{ vars: [{ name, type, value, varRef }] }`. `varRef === 0` — примитив.

#### `1c-metadata-tree.agent.debug.evaluate`

Вычислить BSL-выражение в контексте фрейма.

```json
{ "sessionId": "...", "expression": "Массив.Количество()", "frameId": 1 }
```

Возвращает: `{ value, type, varRef }`.

#### `1c-metadata-tree.agent.debug.continue`

Продолжить выполнение после остановки.

```json
{ "sessionId": "...", "threadId": 1 }
```

#### `1c-metadata-tree.agent.debug.stepOver`

Шаг через строку (не заходит в вызовы).

```json
{ "sessionId": "...", "threadId": 1 }
```

#### `1c-metadata-tree.agent.debug.stepIn`

Шаг внутрь вызова.

```json
{ "sessionId": "...", "threadId": 1 }
```

#### `1c-metadata-tree.agent.debug.stepOut`

Шаг наружу из текущей процедуры.

```json
{ "sessionId": "...", "threadId": 1 }
```

---

### Типы (2 команды)

#### `1c-metadata-tree.agent.getType`

Получить тип реквизита или колонки ТЧ.

```json
{ "path": "Catalog.Товары.Attribute.Артикул" }
```

Возвращает: `{ type: string }` — строка типа в формате `"cfg:CatalogRef.Номенклатура"` или `"xs:string"`.

#### `1c-metadata-tree.agent.setType`

Установить тип реквизита или колонки ТЧ.

```json
{ "path": "Catalog.Товары.Attribute.Артикул", "type": "cfg:CatalogRef.Номенклатура" }
```

---

### Интерфейс команд подсистем (4 команды)

#### `1c-metadata-tree.agent.getSubsystemCommandInterface`

Получить интерфейс команд подсистемы (видимость, порядок).

```json
{ "path": "Subsystem.МояПодсистема" }
```

Возвращает: `{ commandInterface: { commands: [{ name, visible, order }], subsystems: [{ name, order }] } }`.

#### `1c-metadata-tree.agent.setSubsystemCommandVisibility`

Установить видимость команды в интерфейсе подсистемы.

```json
{ "path": "Subsystem.МояПодсистема", "commandName": "Catalog.Товары.Form.ФормаСписка.Command.Создать", "visible": true }
```

#### `1c-metadata-tree.agent.setSubsystemCommandOrder`

Установить порядок команды в интерфейсе подсистемы.

```json
{ "path": "Subsystem.МояПодсистема", "commandName": "Catalog.Товары.Form.ФормаСписка.Command.Создать", "order": 5 }
```

#### `1c-metadata-tree.agent.setSubsystemSubsystemsOrder`

Установить порядок дочерней подсистемы в родительской.

```json
{ "path": "Subsystem.МояПодсистема", "subsystemName": "Subsystem.Дочерняя", "order": 2 }
```

---

### Предопределённые характеристики (4 команды)

#### `1c-metadata-tree.agent.listPredefinedCharacteristics`

Список предопределённых характеристик объекта типа ChartOfCharacteristicTypes.

```json
{ "path": "ChartOfCharacteristicTypes.ВидыСубконто" }
```

Возвращает: `{ characteristics: [{ name, synonym, type }] }`.

#### `1c-metadata-tree.agent.getPredefinedCharacteristicType`

Получить тип значения предопределённой характеристики.

```json
{ "path": "ChartOfCharacteristicTypes.ВидыСубконто", "characteristicName": "МойВид" }
```

Возвращает: `{ type: string }`.

#### `1c-metadata-tree.agent.setPredefinedCharacteristicType`

Установить тип значения предопределённой характеристики.

```json
{ "path": "ChartOfCharacteristicTypes.ВидыСубконто", "characteristicName": "МойВид", "type": "cfg:CatalogRef.Контрагенты" }
```

#### `1c-metadata-tree.agent.getCharacteristicValueRegisters`

Получить список регистров сведений, хранящих значения характеристик данного вида.

```json
{ "path": "ChartOfCharacteristicTypes.ВидыСубконто" }
```

Возвращает: `{ registers: [{ name, filePath }] }`.

---

### Формы (5 команд)

Запуск и управление веб-клиентом 1С для агентской работы с формами. Внутри расширения запускается ibsrv (при dbPath) + playwright (с автоустановкой chromium при первом вызове).

#### `1c-metadata-tree.agent.forms.start`

Запустить сессию. Либо URL готового ibsrv, либо dbPath (ibsrv стартует автоматически). platformPath берётся из настройки `1cMetadataTree.platformPath` если не задан явно.

```json
{ "dbPath": "C:/Users/.../InfoBase", "platformPath": "C:/Program Files/1cv8/8.3.27.1859/bin" }
```

Возвращает: `{ url, ibsrvSpawned, uiAccessHint }`.

#### `1c-metadata-tree.agent.forms.exec`

Выполнить JS-скрипт в контексте browser (run.mjs exec). Скрипт может использовать API browser.mjs (navigateLink, clickElement, fillFields, readTable и т.д.).

```json
{ "script": "await navigateLink('Справочник.Контрагенты'); const t = await readTable(); console.log(JSON.stringify(t));" }
```

Возвращает: `{ output, stderr?, exitCode }`.

#### `1c-metadata-tree.agent.forms.stop`

Закрыть browser и остановить ibsrv (если был запущен расширением).

#### `1c-metadata-tree.agent.forms.shot`

Скриншот текущей страницы в PNG.

```json
{ "file": "C:/tmp/shot.png" }
```

Возвращает `{ file: "C:/tmp/shot.png" }` — абсолютный локальный путь к PNG. MCP не вкладывает
изображение в ответ; вызывающий агент должен прочитать этот файл или приложить его отдельно.

#### `1c-metadata-tree.agent.forms.status`

Статус сессии: жив ли browser, жив ли ibsrv, URL.

Возвращает: `{ browserAlive, url?, ibsrvAlive, ibsrvPid? }`.

---

### SKD (4 команды)

Работа со схемами компоновки данных (DataCompositionSchema). Обёртка над PowerShell-скриптами внутри расширения. Требует pwsh (или Windows PowerShell).

#### `1c-metadata-tree.agent.skd.compile`

JSON-DSL → DataCompositionSchema.xml.

```json
{ "input": "C:/defs/my-skd.json", "output": "C:/conf/Reports/Мой/Templates/Schema.xml" }
```

Обязательно: `output` + (`input` файл либо inline `value`). Возвращает путь к результату и статистику.

#### `1c-metadata-tree.agent.skd.info`

Сводка структуры Template.xml (dataSets, fields, parameters). Режим задаётся через параметр `mode`.

```json
{ "input": "C:/conf/.../Template.xml" }
```

Возвращает: текстовые строки структуры.

#### `1c-metadata-tree.agent.skd.edit`

Точечное редактирование Template.xml. 26 операций (ValidateSet в skd-edit.ps1).

```json
{ "input": "C:/conf/.../Template.xml", "op": "AddField", "value": "Колонка" }
```

Возвращает: строки `[OK]` / `[WARN]` по результату каждой операции.

#### `1c-metadata-tree.agent.skd.validate`

Валидация схемы.

```json
{ "input": "C:/conf/.../Template.xml" }
```

Возвращает: `{ valid, issues? }`. При успехе stdout содержит `=== Validation OK ===`.

---

### XDTO-пакеты (7 команд)

Работа с XDTO-пакетами конфигурации из `XDTOPackages/<Имя>.xml` и `XDTOPackages/<Имя>/Ext/Package.bin`: чтение модели, экспорт/импорт XSD, создание нового пакета из XSD, сравнение и объединение пакетов. Внешний источник для импорта/сравнения/merge можно передать как `inputPath` или inline `source`; поддерживаются XSD и 1C XDTO package XML/BIN.

#### `1c-metadata-tree.agent.xdto.listPackages`

Список XDTO-пакетов конфигурации.

```json
{}
```

Возвращает: `{ packages: [{ name, metadataPath, schemaPath, targetNamespace? }] }`.

#### `1c-metadata-tree.agent.xdto.getPackage`

Прочитать текущий пакет по имени или пути к metadata XML. Если `Package.bin` отсутствует, возвращает минимальный XDTO skeleton с namespace из metadata XML в памяти; файл появится только при явном сохранении или импорте.

```json
{ "packageName": "EnterpriseData_1_20_2", "includeSource": true }
```

Альтернатива: `{ "metadataPath": "XDTOPackages/EnterpriseData_1_20_2.xml" }`.

Возвращает: `{ name, metadataPath, schemaPath, targetNamespace?, model, source? }`.

#### `1c-metadata-tree.agent.xdto.exportXsd`

Экспортировать текущий 1C XDTO package в XSD. Без `outputPath` возвращает XSD inline. Если `outputPath` указан, он должен вести к файлу `.xsd` внутри выбранной конфигурации; относительный путь разрешается от её корня.

```json
{ "packageName": "EnterpriseData_1_20_2", "outputPath": "exports/EnterpriseData_1_20_2.xsd" }
```

Возвращает: `{ schemaPath, outputPath?, xsd? }`.

#### `1c-metadata-tree.agent.xdto.importXsd`

Импортировать XSD в существующий XDTO-пакет и перезаписать его `Package.bin`.

```json
{ "packageName": "EnterpriseData_1_20_2", "inputPath": "C:/tmp/EnterpriseData_1_20_2.xsd" }
```

Inline-вариант: `{ "packageName": "Demo", "source": "<xs:schema .../>" }`.

Возвращает: `{ schemaPath, model }`.

#### `1c-metadata-tree.agent.xdto.createFromXsd`

Создать новый XDTO-пакет из XSD: metadata XML, `Ext/Package.bin` и запись в `Configuration.xml`.

```json
{ "packageName": "ExchangeDemo", "inputPath": "C:/tmp/ExchangeDemo.xsd" }
```

Возвращает: `{ name, metadataPath, schemaPath, targetNamespace?, model }`.

#### `1c-metadata-tree.agent.xdto.compare`

Сравнить текущий пакет конфигурации с внешним XSD/XML/BIN источником. Сравнение нормализует QName-префиксы и сопоставляет `enumeration` по значению, а не по позиции.

```json
{ "packageName": "EnterpriseData_1_20_2", "inputPath": "C:/tmp/EnterpriseData_1_20_2.xsd", "includeTree": true }
```

Возвращает: `{ stats: { total, different, mergeable }, schemaPath, sourcePath?, tree? }`.

#### `1c-metadata-tree.agent.xdto.merge`

Применить выбранные различия из внешнего источника в текущий `Package.bin`. `selectedIds` берутся из дерева `xdto.compare`.

```json
{
  "packageName": "EnterpriseData_1_20_2",
  "inputPath": "C:/tmp/EnterpriseData_1_20_2.xsd",
  "selectedIds": ["valueTypes:Code:facets:maxLength:0", "objectTypes:Order:properties:Number:type"]
}
```

Возвращает: `{ stats, schemaPath, model }`.

---

## Типичные сценарии

### Сценарий A: CRUD метаданных

```
1. listObjects({ type: 'Catalog' })              → узнать что есть
2. createObject({ type: 'Catalog', name: 'Товары' })  → создать справочник
3. addAttribute({ path: 'Catalog.Товары', name: 'Артикул' })
4. setProperties({ path: 'Catalog.Товары.Attribute.Артикул', properties: { Type: 'cfg:CatalogRef.Номенклатура' } })
5a. deploy({})                                     → раскатать всю конфигурацию
5b. deploySelectedObjects({ files: ['Catalogs/Товары.xml', ...] })  → или только изменённые файлы
5c. deployChangedFiles({})                          → или автодетект из git
6. getYaml({ path: 'Catalog.Товары' })            → проверить результат
```

### Сценарий B: отладка (thin client)

```
1. debug.start({ rootProject: '...', infobase: 'File=...', platformPath: '...' })
2. debug.setBreakpoint({ file: '...ObjectModule.bsl', line: 5 })
3. debug.waitForStop({ sessionId: '...' })         → дождаться breakpoint
4. debug.getScopes({ sessionId: '...', frameId: 1 })
5. debug.getVariables({ sessionId: '...', varRef: 1 })  → прочитать переменные
6. debug.evaluate({ sessionId: '...', frameId: 1, expression: 'МояПеременная' })
7. debug.continue({ sessionId: '...', threadId: 1 })
8. debug.stop({ sessionId: '...' })
```

### Сценарий C: отладка + формы через agent API (Playwright внутри расширения)

Агент управляет и отладчиком и формой одновременно через два разных канала, оба в agent API.

```
1. resolveBinding({ configPath: 'empty_conf' })
   → { infobase: { filePath: 'C:/Users/.../InfoBase11' } }
2. debug.start({ rootProject: '...', infobase: 'File=...', platformPath: '...', debuggeeType: 'webServer', databasePath: 'C:/Users/.../InfoBase11' })
   → { sessionId, webServerUrl: 'http://localhost:52570' }
3. debug.setBreakpoint({ file: '...ObjectModule.bsl', line: 4 })
4. forms.start({ url: 'http://localhost:52570' })   — подключаем playwright к тому же ibsrv
5. forms.exec({ script: 'await navigateLink("Справочник.Контрагенты"); await clickElement("Создать"); await fillFields({Наименование:"Тест"}); await clickElement("Записать");' })
6. debug.waitForStop({ sessionId, timeoutMs: 30000 })
   → { reason: 'breakpoint', threadId: 1, frameId: 1, file: '...', line: 4 }
7. debug.evaluate({ sessionId, frameId: 1, expression: 'Отказ' })
8. debug.continue({ sessionId, threadId: 1 })
9. forms.stop()
10. debug.stop({ sessionId })
```

**Особенности webServer режима:**
- `verified: false` при setBreakpoint — нормально, BP сработает после подключения браузера
- `getVariables` (панель Locals) — пусто; используйте `evaluate` для конкретных переменных
- ibsrv создаёт новые target'ы динамически при серверных операциях — расширение обнаруживает и подключает их автоматически
- `waitForStop` нужно вызывать **до** или **одновременно** с действием forms.exec (иначе stop event будет потерян)

### Сценарий D: XDTO export/compare/merge

```
1. xdto.listPackages({})
   → найти имя пакета и путь к Package.bin
2. xdto.exportXsd({ packageName: 'EnterpriseData_1_20_2', outputPath: 'exports/EnterpriseData_1_20_2.xsd' })
   → выгрузить текущий пакет в XSD
3. xdto.compare({ packageName: 'EnterpriseData_1_20_2', inputPath: 'C:/tmp/vendor.xsd', includeTree: true })
   → получить дерево различий до типов, свойств, атрибутов и facets
4. xdto.merge({ packageName: 'EnterpriseData_1_20_2', inputPath: 'C:/tmp/vendor.xsd', selectedIds: [...] })
   → применить выбранные различия в Package.bin
5. xdto.getPackage({ packageName: 'EnterpriseData_1_20_2' })
   → проверить итоговую модель
```

Для нового пакета используйте `xdto.createFromXsd({ packageName, inputPath })`; для полной замены существующего — `xdto.importXsd({ packageName, inputPath })`.

---

## Ограничения

- Формы конфигуратора через Agent API не создаются/редактируются (используйте UI). Формы enterprise — через agent.forms.*
- Для InformationRegister и AccumulationRegister при `createObject` создаются дефолтные Измерение+Ресурс (шаблонный fallback)
- Тип реквизита при `addAttribute` задаётся дефолтный (строка 50); для изменения используйте `setProperties` с `Type: "cfg:DocumentRef.Больше"` или `Type: "xs:boolean"` и т.д.
- XDTO merge применяет только выбранные `selectedIds`; левосторонние узлы не удаляются автоматически.
- HTTP bridge принимает тело запроса до 16 МБ. Для больших XSD/XDTO передавайте `inputPath`, а не inline `source`.
