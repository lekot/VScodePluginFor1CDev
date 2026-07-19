# MCP Agent Adapter — план полного каталога

## Коммит 1: полный MCP catalog Agent API

### Документация контрактов

- `docs/features/mcp-agent-adapter/spec.md`: заменить границу первой вертикали на полный mapping 61/61, exact schemas/refinements, статические annotations, trust boundary и критерии покрытия.
- `docs/features/mcp-agent-adapter/design.md`: зафиксировать доменное разбиение каталога, thin dispatch и coverage invariant.
- `docs/features/mcp-agent-adapter/plan.md`: оставить один финальный вариант реализации.

Контракт: только команды из `registerAgentCommands`; четыре перечисленные UI-команды расширения вне scope.

### Доменные catalog modules

- `src/agent/mcpAdapter/catalog/types.ts`: общий immutable контракт tool definition.
- `src/agent/mcpAdapter/catalog/schemas.ts`: переиспользуемые strict schemas и refinements без business logic; shapes следуют исходным TypeScript DTO и существующей runtime-валидации, без искусственного сужения строк/чисел.
- `src/agent/mcpAdapter/catalog/metadataTools.ts`: configurations и metadata CRUD.
- `src/agent/mcpAdapter/catalog/debugTools.ts`: полный debug API.
- `src/agent/mcpAdapter/catalog/bindingDeployTools.ts`: bindings, deploy, pull и export status.
- `src/agent/mcpAdapter/catalog/configurationTools.ts`: types, subsystem command interface и predefined characteristics.
- `src/agent/mcpAdapter/catalog/formsTools.ts`: forms lifecycle, arbitrary script и screenshot.
- `src/agent/mcpAdapter/catalog/skdTools.ts`: compile/info/edit/validate.
- `src/agent/mcpAdapter/catalog/xdtoTools.ts`: list/get/export/import/create/compare/merge.
- `src/agent/mcpAdapter/toolCatalog.ts`: агрегировать modules в единый `MCP_TOOL_CATALOG`; сохранить единые executor, registration loop, result/error/cancellation mapping.

Контракты: 61 уникальный tool и 61 уникальный command id; names/mapping/schemas/annotations строго из `spec.md`; неизвестные поля запрещены; cross-field constraints сохраняют parity (`forms.start` разрешает оба источника с приоритетом `dbPath`); nested DTO являются strict objects; каждый tool вызывает ровно одну Agent-команду.

### Security logging

- `src/agent/agentDebugOperations.ts`: заменить логирование launch config в `debugStart` и `debugStartFromBinding` на redacted operational metadata; заменить failure, включающий launch config/infobase, на generic error.

Контракт: ни лог, ни unsuccessful `AgentResult.error` не содержат `infobase`, connection strings, credentials или полный launch config; success DTO не меняется.

### Contract и coverage tests

- `test/suite/mcpToolCatalog.test.ts`: проверить полный mapping, strict schemas, cross-field refinements, annotations, duplicate guards и отсутствие dispatch при invalid input.
- `test/suite/mcpAgentCoverage.test.ts`: вызвать `registerAgentCommands` на общем VS Code stub, получить runtime-capture `vscodeTestState.registeredCommandIds` и сравнить с command ids единого каталога; зафиксировать 61/61 и exclusion четырёх UI-команд. Source regex запрещён как доказательство покрытия.
- `test/suite/agentDebugOperations.lifecycle.test.ts`, `test/suite/agentDebugOperations.startFromBinding.test.ts`: проверить отсутствие чувствительных debug launch fields и в capture логов, и в failure `AgentResult.error`.
- `test/suite/coreSuites.ts`: включить новые MCP suites и существующий `suite/agentXdtoOperations.test.js`; `test/suite/index.ts` менять только если suite требует VS Code runner.

Контракты: drift Agent API ↔ MCP catalog всегда ломает тест; mutations dispatch-ятся через Agent command executor; `AgentResult`, `AGENT_COMMAND_FAILED` и `REQUEST_CANCELLED` сохраняют существующую семантику.

### Integration и документация клиента

- `test/suite/smoke/mcpAgentBridge.smoke.test.ts`: обновить expected tool count и проверить representative read, mutation, process и open-world definitions через официальный SDK client без выполнения опасных внешних действий.
- README и Agent API documentation: заменить перечень первой вертикали ссылкой/таблицей полного каталога, описать dangerous/open-world tools и неизменную local authenticated trust boundary.

Контракт: transport, Bearer, discovery v2, legacy `/command`, sessions и lifecycle не меняются.

### Quality Gate

- Typecheck и compile.
- Полный core unit suite.
- Явная проверка, что `agentXdtoOperations.test.js` входит в `coreSuiteFiles` и реально выполняется core runner.
- VS Code smoke suite с official MCP client.
- Проверка VSIX contents.
- Независимый code review без правок; замечания проходят повторный review.
- После зелёного gate создать один локальный коммит, push не выполнять.
