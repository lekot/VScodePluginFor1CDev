# MCP Agent Adapter — план реализации

## Коммит 1: стандартный MCP transport и read-only vertical

### Файлы зависимостей и упаковки

- `package.json`, `package-lock.json`: поднять минимальный VS Code до `^1.82.0`; добавить production-зависимости official MCP SDK v1 и Zod v4; убедиться, что production bundle попадает в VSIX.
- `.vscodeignore`: проверить, что выбранный каталог production-кода не исключён из пакета; менять только при необходимости.

Контракты: runtime Node 18+, CommonJS/ES2020; bootstrap устанавливает WebCrypto до ленивой загрузки MCP SDK; статический import SDK в загружаемом при activation графе запрещён.

### Agent API

- `src/agent/types.ts`, `src/agent/agentOperations.ts` и связанные регистрации: добавить общий optional `query` к `listObjects` и реализовать trim + регистронезависимый substring по имени после существующего type filter.

Контракт: пустой query не фильтрует; `type` остаётся точным и регистрозависимым; форма `AgentResult` не меняется.

### MCP adapter

- Новые файлы под `src/agent/` (не в исключённом корневом `mcp/`): создать tool catalog, единый result/error mapper и stateful Streamable HTTP session router.
- Каждый из шести tools связать с ровно одной существующей Agent-командой; схемы запретят неизвестные поля.

Контракты: имена и inputs из `spec.md`; Agent error envelope сохраняется; command exception получает `AGENT_COMMAND_FAILED`; отмена до dispatch не запускает команду, а отмена во время исполнения отбрасывает её результат после завершения и возвращает `REQUEST_CANCELLED` с `isError: true`.

### Bridge, activation и discovery

- `src/agent/agentBridge.ts`, `src/agent/agentBridgeActivation.ts` и точка регистрации: подключить `/mcp` к существующему listener; добавить общий security gate, session shutdown, WebCrypto bootstrap и dependency injection для тестов.
- Расширить discovery schema без удаления старых полей; сделать atomic write и remove-if-owned cleanup.

Контракты: loopback-only, Bearer для `GET/POST/DELETE /mcp`, строгие Host/Origin, 16 MiB; stop закрывает MCP до listener и остаётся идемпотентным.

### Документация клиента

- README/документация Agent API: описать discovery, Bearer header, шесть tools, ограничение cancellation `exportStatus` и сохранение legacy bridge.

Контракт: token не помещается в URL или логи; клиент читает актуальный discovery после activation.

### Тесты

- Новые contract tests: точный tool catalog/schema, query parity, result/error mapping, отсутствие dispatch при invalid input.
- Расширить bridge/security/lifecycle tests: auth, Host, Origin, loopback, methods, sessions, ownership-safe discovery, start/stop races и открытый SSE.
- Добавить integration smoke официальным SDK client: initialize, list, call, terminate session; зарегистрировать suites в core runner и VS Code smoke, где требуется реальная command registry.

Контракты приёмки: все восемь критериев `spec.md`; legacy Agent Bridge regression tests остаются зелёными.

### Quality Gate

- Выполнить typecheck/compile, полный core unit suite, smoke suite и проверку VSIX contents.
- Провести независимый code review без правок; исправления проходят повторный review и Quality Gate.
- После зелёного gate создать один локальный коммит, не push.
