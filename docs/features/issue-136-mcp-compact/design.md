# Issue #136: права ролей и компактный MCP

## Discovery

Цель: уменьшить постоянную стоимость `tools/list` для локальных моделей и дать короткую запись прав роли. В scope входят все 78 существующих Agent-операций и новая операция прав. Прямой Agent API и legacy `/command` сохраняют свои идентификаторы и поведение. MCP endpoint, авторизация и формат `AgentResult` сохраняются.

## Research

`MCP_TOOL_CATALOG` содержит 78 отдельных схем; каждая регистрируется при создании MCP-сессии. UI-модель `ObjectRights` знает 15 прав и не представляет `InputByString` и права проведения. EDT хранит конфигурацию в `src/Configuration/Configuration.mdo`, корневые метаданные в `src/<folder>/<name>/<type>.mdo`, метаданные роли в `src/Roles/<name>/Role.mdo` и права в `src/Roles/<name>/Ext/Rights.xml`. EDT inventory читается из каталогов метаданных через `EdtParser`, потому что `Configuration.mdo` может не содержать `ChildObjects`. Designer использует `Configuration.xml`, метаданные роли `Roles/<name>.xml` и отдельный файл прав `Roles/<name>/Ext/Rights.xml`.

## Design

### Варианты

1. **Минимум изменений:** оставить 78 инструментов и сократить описания. Совместимо, но почти не уменьшает число схем в контексте.
2. **Единый вызов:** один `execute(operation,args)` и `describe`. Минимальный каталог, но все вызовы получают консервативные write/open-world annotations, включая чтение.
3. **Баланс — выбран:** семь MCP-инструментов: шесть диспетчеров по точным профилям annotations и один каталог по запросу. Все 79 Agent-операций доступны, но схемы отдельных аргументов выдаются только по запросу. Добавление прав не расширяет корневой каталог.

### MCP contracts

Публичные инструменты: `cdt_read`, `cdt_write`, `cdt_write_idempotent`, `cdt_read_live`, `cdt_write_live`, `cdt_verify_live`, `cdt_catalog`. Первые шесть имеют вход `{ operation: string enum, arguments: object }`, где `operation` — старое `cdt_*` имя, относящееся ровно к этому профилю. `arguments` проходит прежнюю strict Zod-схему до вызова Agent-команды. Ошибка выбора профиля или схемы не выполняет команду. `cdt_catalog({ operation?: string })` возвращает список имён, кратких описаний и профилей или точную JSON Schema выбранной операции. Он read-only/closed-world. По умолчанию `tools/list` возвращает только семь инструментов. Старые индивидуальные MCP-инструменты доступны только при явном opt-in `CDT_MCP_LEGACY_TOOLS=1`; это не влияет на Agent-команды и legacy `/command`.

Диспетчер вызывает ровно одну команду. Успешный или ошибочный `AgentResult`, `structuredContent`, `isError`, обработка исключений и cancellation имеют прежнюю семантику. Никакой свободной передачи имени VS Code-команды: только lookup в закрытом каталоге.

### Roles contracts

Новая Agent-команда `1c-metadata-tree.agent.roles.setRights` и внутренняя запись каталога `cdt_roles_set_rights` относятся к `cdt_write`. Вход: `{ configurationId?: string, roleName: string, objects: string[] }`. Роль должна уже существовать; для создания используется `agent.createObject` с типом `Role`, именем и синонимом. Это оставляет управление метаданными в существующей операции. Повторная запись тех же прав идемпотентна по содержимому, но профиль write остаётся консервативным.

Строка DSL: `Type.Name: @view|@edit|@post|@admin` либо `Type.Name: Right1, Right2`. Пробелы вокруг разделителей допускаются, имена типа/объекта валидируются; пустые, повторные и неизвестные объекты/права/пресеты дают типизированную ошибку без записи. `@post` допустим только для Document. `@view` даёт применимые Read и View, InputByString ссылочным типам и Use типам, у которых это право отвечает за использование (DataProcessor/Report получают Use+View, WebService/HTTPService/IntegrationService/ExternalDataSource — Use). `@edit` сохраняет применимые права `@view` и добавляет фиксированный базовый набор Read, Insert, Update, Delete, View, Edit, InteractiveInsert, InputByString и применимые стандартные права интерактивного удаления, отфильтрованные по типу; права истории данных в него не входят. `@post` добавляет ровно Posting, UndoPosting, InteractivePosting, InteractiveUndoPosting и допустим только для Document. `@admin` даёт все права, допустимые для типа. Для регистров и планов видов характеристик права фильтруются по типу; источник таблицы применимости — локальная спецификация 1С, а не ограниченный `ObjectRights` редактора.

Каждая указанная запись заменяет только права соответствующего корневого объекта; права прочих объектов, RLS, шаблоны и неизвестные XML-узлы сохраняются. Запись выполняется через очередь `ConfigurationSession.enqueuePlan` с проверкой конфликта, rollback и границы workspace. В обоих форматах меняется отдельный `Rights.xml`: EDT — `src/Roles/<name>/Ext/Rights.xml`, Designer — `Roles/<name>/Ext/Rights.xml`; метаданные Designer-роли остаются в `Roles/<name>.xml`. Для существующего файла сохраняются значения `setForAttributesByDefault` и `independentRightsOfChildObjects`; они не нормализуются и не перезаписываются. При создании отсутствующего Rights.xml применяется платформенный default `setForAttributesByDefault=true`. Значение `<setForNewObjects>` задаёт default для корневых объектов: права с таким значением можно опустить, отличающиеся записываются явно. Некорректный `Rights.xml` отклоняется до создания плана записи. Права атрибутов, табличных частей и колонок не создаются и не переписываются командой: их эффективное наследование следует сохранённому `setForAttributesByDefault`, а явные дочерние права остаются без изменений. Команды объекта получают дочернее View, если у родителя разрешён View; новые дочерние записи без разрешённых прав не создаются, существующие command rights можно очистить. Результат сообщает roleName, число затронутых корневых и дочерних записей, относительные пути файлов; абсолютные пути не выдаются.

### Dataflow

MCP client → compact tool → lookup и strict validation старой схемой → VS Code Agent command → configuration session → role DSL compiler → format-specific XML patch → AgentResult. `cdt_catalog` читает только статический каталог и не исполняет команду.

### Ошибки и границы

Ошибка DSL, отсутствующая роль, неподдерживаемый формат или объект, несуществующий metadata child и конфликт записи не меняют файлы. Поддерживаемые права и типы имеют явный allowlist. Неизвестное право не должно молча удаляться или записываться. При ошибке записи `AgentResult.success=false` и стабильный `code`.

## Planning

### Коммит 1 — компактный MCP

- `src/agent/mcpAdapter/toolCatalog.ts` и при необходимости файлы `catalog/`: добавить компактную регистрацию, lookup, прежнюю валидацию, `cdt_catalog`, opt-in legacy.
- `test/suite/mcpAgentCoverage.test.ts`, `test/suite/mcpAdapter.test.ts`, `test/suite/mcpBridgeTransport.test.ts`: проверка полного покрытия операций, выбора профиля, отказа до dispatch, `tools/list` и вызова official SDK client.
- `docs/features/mcp-agent-adapter/spec.md`, `docs/features/agent-api/agent-skill.md`: обновить публичный контракт и migration.

### Коммит 2 — DSL и запись прав

- `src/agent/agentRole*`, `src/agent/agentCommands.ts`, `src/agent/mcpAdapter/catalog/`: компилятор DSL, типы, command registration и MCP mapping.
- `src/rolesEditor/` при необходимости: общий безопасный XML patch для EDT и Designer с сохранением неизвестных узлов.
- `test/suite/`: parser/preset tests для Catalog, Document, InformationRegister, ChartOfCharacteristicTypes; негативные случаи, дочерние права, сохранение RLS и существующего XML, вызов через Agent/MCP.
- `docs/features/agent-api/agent-skill.md` и этот документ: примеры двух шагов createObject + roles.setRights.

## Spec Review

План задаёт файлы и контракты без кода. MCP lookup ограничен полным каталогом и сохраняет Agent transport. Профиль annotations совпадает с исходной операцией. Правка роли не требует менять 15-полевую UI-модель и не теряет неизвестные XML права. Сначала тесты воспроизводят риск потери прав и дочерних узлов, затем реализация.
