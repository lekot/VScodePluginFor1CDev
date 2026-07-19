# MCP Agent Adapter — спецификация первой вертикали

## Цель

Дать стандартному MCP-клиенту read-only доступ к существующему Agent API расширения без дублирования XML, маршрутизации конфигураций, bindings и `ibcmd`-логики. MCP — новый транспорт над теми же VS Code Agent-командами; legacy Agent Bridge остаётся совместимым.

## Границы

В первую вертикаль входят tools:

| Tool | Agent command | Input |
|---|---|---|
| `cdt_list_configurations` | `1c-metadata-tree.agent.listConfigurations` | `{}` |
| `cdt_list_objects` | `1c-metadata-tree.agent.listObjects` | `{ configurationId?: string, type?: string, query?: string }` |
| `cdt_get_yaml` | `1c-metadata-tree.agent.getYaml` | `{ configurationId?: string, path: string }` |
| `cdt_get_properties` | `1c-metadata-tree.agent.getProperties` | `{ configurationId?: string, path: string }` |
| `cdt_list_bindings` | `1c-metadata-tree.agent.listBindings` | `{}` |
| `cdt_export_status` | `1c-metadata-tree.agent.exportStatus` | `{ configurationId?: string, configPath?: string }` |

`query` сначала становится частью общего `listObjects`: значение обрезается, затем применяется регистронезависимый substring-поиск по имени; пустая строка не фильтрует. `type` сохраняет текущее точное регистрозависимое сравнение. MCP-only поиск запрещён.

Мутации, формы, СКД, XDTO, deploy и debug tools не входят. `exportStatus` включён как read-only status, хотя запускает `ibcmd` и требует process capability.

## Результаты и ошибки

- Все input schemas запрещают неизвестные поля.
- Валидный вызов исполняет ровно одну существующую Agent-команду через `vscode.commands.executeCommand`.
- Исходный `AgentResult` без изменения семантики возвращается в `structuredContent` и JSON-копией в text content.
- `AgentResult.success === false` даёт MCP tool result с `isError: true`.
- Исключение Agent-команды нормализуется в нейтральный внешний envelope `{ success: false, code: "AGENT_COMMAND_FAILED", error: "Agent command failed" }`; исходный текст и stack trace клиенту не возвращаются.
- Ошибка схемы не вызывает Agent-команду и остаётся стандартной ошибкой MCP tool invocation.
- Cancellation проверяется перед dispatch и после его завершения. Если запрос уже отменён до dispatch, Agent-команда не запускается. Если отмена пришла во время исполнения, обёртка дожидается текущей Agent-команды, отбрасывает её результат и возвращает `{ success: false, code: "REQUEST_CANCELLED", error: "MCP request was cancelled" }` с `isError: true`. Принудительная остановка уже запущенного `exportStatus` в первой вертикали не обещается.

## Транспорт и безопасность

- Один listener существующего Agent Bridge на `127.0.0.1:0` обслуживает legacy `/command` и Streamable HTTP `/mcp`.
- `/mcp` поддерживает `POST`, `GET`, `DELETE` и stateful sessions официального MCP SDK.
- Каждый запрос `/mcp` требует существующий Bearer token; session id не является авторизацией, token в query string запрещён.
- До MCP SDK проверяются loopback peer, `Host` (`127.0.0.1`, `localhost`, `[::1]`) и, если передан, loopback `Origin`; отказ — до dispatch.
- Максимальный POST body — 16 MiB. Наружу не уходят stack traces и credentials.
- Используются `@modelcontextprotocol/sdk` `^1.29.0` и `zod` `^4`; минимальный VS Code поднимается до `^1.82.0` (Node 18). На Node 18 до загрузки SDK обеспечивается `globalThis.crypto` через `node:crypto.webcrypto`; MCP SDK загружается лениво только после bootstrap, статический import SDK запрещён.

## Discovery и lifecycle

`.vscode/cdt-agent-bridge.json` сохраняет старые top-level поля и аддитивно получает `schemaVersion: 2`, `instanceId` и `mcp: { url, transport: "streamable-http", authorization: "bearer" }`. Запись атомарная. При stop файл удаляется только если всё ещё принадлежит текущему `instanceId`/token.

Остановка идёт в порядке: запрет новых запросов → закрытие MCP sessions/SSE → закрытие активных HTTP connections → listener → remove-if-owned discovery. Повторный stop безопасен.

## Критерии приёмки

1. Официальный SDK client проходит `initialize → tools/list → tools/call → DELETE session` по discovery URL и token.
2. Каталог содержит ровно шесть tools первой вертикали с зафиксированными schemas.
3. MCP и прямой Agent-вызов дают семантически одинаковый `AgentResult`, включая error envelope.
4. Невалидный input не dispatch-ится; неизвестная/закрытая session отклоняется.
5. Нет/неверный token, hostile Host/Origin и non-loopback peer отклоняются.
6. Legacy `/command` и старые discovery fields продолжают работать.
7. Deactivate закрывает открытые sessions и освобождает порт без зависания.
8. Contract, transport, security, lifecycle и официальный client smoke включены в test suites.
