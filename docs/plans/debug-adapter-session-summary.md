# BSL Debug Adapter — Session Summary (2026-04-04)

## Цель
Inline BSL Debug Adapter для отладки 1С прямо в VS Code, без Java-зависимости.

## Что сделано

### Предыдущие сессии (2026-04-03)

1. **seanceId passthrough fix** — `_seanceMap` в `rdbgClient.ts`
2. **Команда «Запустить отладку»** — `src/debug/debugLauncher.ts`, flow: ПКМ на Configuration → binding → infobase → платформа → dbgs → DAP → 1С с debug-флагами → cleanup
3. **RDBG XML Codec реврайт** — JAXB-формат из yukon39/bsl-debug-server
4. **propertyID — платформенные UUID-константы** — замена числовых суффиксов на UUID из `ModulePropertyId.java`
5. **XDTO field order fix** — строгий порядок элементов в encode-функциях
6. **Убран таймаут HTTP** — `DEFAULT_TIMEOUT_MS = 0`
7. **Auto-attach targets при targetStarted**
8. **ibcmd config apply после import**
9. **moduleIdResolver fallback detectConfigRoot**
10. **Диагностическое логирование**

### Сессия 2026-04-04 — fix: race condition, initSettings, target discovery

Найдены и исправлены **3 критических бага**, образующих цепочку отказов — breakpoint не мог сработать ни при каких условиях:

#### Баг #1: DAP Race Condition (CRITICAL)
- **Проблема**: `InitializedEvent` отправлялся в `initializeRequest` ДО создания клиента. `@vscode/debugadapter` диспатчит async-обработчики без await. VS Code отправлял `setBreakpointsRequest` пока `attachRequest` ещё выполнялся → `this._client === undefined` → breakpoints молча терялись.
- **Решение**: `InitializedEvent` перенесён в КОНЕЦ `attachRequest` — после создания клиента, attach, initSettings, startPolling.
- **Файл**: `src/debug/bslDebugSession.ts`

#### Баг #2: Отсутствие initSettings + setAutoAttachSettings (CRITICAL)
- **Проблема**: В кодовой базе полностью отсутствовали `RDBGSetInitialDebugSettingsRequest` и `RDBGSetAutoAttachSettingsRequest`. Без них сервер отладки НЕ отправляет события `targetStarted`/`targetQuit` через ping и НЕ авто-подключает новые таргеты.
- **Доказательство**: `test/fixtures/rdbg/event_targetStarted.xml` — пустой файл (0 байт). За всё время тестирования событие ни разу не было получено.
- **Решение**: Добавлены `encodeInitSettings` и `encodeSetAutoAttachSettings` в codec. Вызываются автоматически после `attachDebugUI` в `rdbgClient.attach()` (non-fatal try/catch).
- **Файлы**: `src/debug/rdbg/rdbgXmlCodec.ts`, `src/debug/rdbg/rdbgClient.ts`
- **Уточнение (коммит 535287a) — XDTO fix**: первоначальная реализация включала элементы `<rdbg:data xsi:type="HTTPServerInitialDebugSettingsData">` и `<rdbg:autoAttachToNewTargets>`, которые сервер 1С 8.3.27 отвергал с HTTP 400 «Ошибка преобразования данных XDTO: НачалоСвойства». Исправление: отправлять минимальные запросы (только `idOfDebuggerUI` + `infoBaseAlias`), соответствующие захваченному фикстуру `02_initSettings_request.xml`.

#### Баг #3: Нет обнаружения таргетов после запуска 1С (CRITICAL)
- **Проблема**: `getTargets()` вызывался ОДИН РАЗ при attach (строка 92), но 1С клиент запускается ПОСЛЕ (`debugLauncher.ts:216`). Список таргетов пустой. Дальше расширение полагалось только на `targetStarted` события из ping, которые не приходили (баг #2).
- **Решение**: В `_poll()` каждые 5 циклов — вызов `getTargets()` для обнаружения новых таргетов. Для новых таргетов (не в `_seanceMap`) эмитится `targetStarted`.
- **Файл**: `src/debug/rdbg/rdbgClient.ts`

#### Дополнительные фиксы
- **ibInDebug детекция**: ответ `attachDebugUI` теперь парсится, при `ibInDebug` — warning в лог
- **Re-set breakpoints**: при подключении нового таргета все известные breakpoints переставляются через `_reapplyBreakpoints()`
- **infobaseAlias**: всегда `undefined` (DefAlias) вместо `ibcmdExtensionName`

## Что подтверждено

| Операция | Статус | Примечание |
|----------|--------|------------|
| attachDebugUI | ✅ 200 `registered` | С чистым dbgs |
| initSettings | ✅ добавлен | XDTO format исправлен (535287a); ответ сервера после фикса не подтверждён |
| setAutoAttachSettings | ✅ добавлен | XDTO format исправлен (535287a); ответ сервера после фикса не подтверждён |
| getDbgTargets | ✅ 200 | + periodic polling каждые 5 пингов |
| setBreakpoints | ✅ 200 | С правильными UUID propertyID |
| pingDebugUI | ✅ 204 | Без таймаута, стабильное соединение |
| attachDetachDbgTargets | ✅ 200 | + auto-attach на targetStarted |
| DAP race condition | ✅ исправлен | InitializedEvent в конце attachRequest |
| Breakpoint re-set | ✅ добавлен | При каждом новом targetStarted |
| Unit-тесты propertyID | ✅ 7/7 | `test/suite/moduleIdResolver.test.ts` |

## Что ещё НЕ подтверждено

### Breakpoint hit — ключевой тест
**Статус**: Все 3 критических блокера исправлены. Требуется live-тестирование.

**Ожидаемый flow после фиксов**:
1. `attachDebugUI` → `registered`
2. `initSettings` → `autoAttachToNewTargets=true`
3. `setAutoAttachSettings` → auto-attach enabled
4. VS Code шлёт `setBreakpoints` → client существует → breakpoints ставятся
5. 1С запускается с debug-флагами → подключается к dbgs
6. Periodic `getDbgTargets` или `targetStarted` event → таргет обнаружен
7. `attachTargets` → таргет подключен к UI
8. `_reapplyBreakpoints()` → breakpoints переставлены
9. Пользователь записывает Справочник55 → `ПередЗаписью` → breakpoint hit
10. `pingDebugUI` → `DBGUIExtCmdInfoCallStackFormed` с `stopByBP=true`

### Не тестировались (требуют breakpoint hit)
- getCallStack
- evalLocalVariables / evaluate
- step / continue

## Ключевые находки

### Протокол (из расследования 2026-04-04)
1. **`InitializedEvent` в DAP** — НЕЛЬЗЯ отправлять до создания клиента. `@vscode/debugadapter` не ждёт завершения async-обработчиков.
2. **`initSettings` + `setAutoAttachSettings`** — ОБЯЗАТЕЛЬНЫ для получения `targetStarted` событий через ping.
3. **Periodic `getDbgTargets`** — safety net на случай если события targetStarted не приходят.
4. **Re-set breakpoints** — после подключения нового таргета нужно переставить breakpoints.

### XDTO reverse-engineering (из сессии 2026-04-03)
5. **Каждый сложный элемент требует `xsi:type`** — XDTO не инферит типы из контекста
6. **propertyID — платформенные UUID-константы**, не числовые суффиксы
7. **DebugTargetIdLight** — содержит только `<id>UUID</id>`
8. **`ibInDebug` vs `registered`**: attach возвращает `ibInDebug` когда другой UI уже подключен

### Инфраструктурные
9. **HTTP таймауты убивают отладку** — ping ждёт бесконечно, таймаут = 0
10. **1С клиент должен быть запущен С debug-флагами** — `/Debug -http -attach /DebuggerURL http://localhost:1550`

## Файлы затронуты

### Новые
- `src/debug/debugLauncher.ts`
- `test/suite/moduleIdResolver.test.ts`

### Изменённые (коммит 535287a, 2026-04-04)
- `src/debug/rdbg/rdbgXmlCodec.ts` — XDTO fix: убраны лишние элементы из initSettings/setAutoAttachSettings, минимальный запрос

### Изменённые (коммит 10a91a7, 2026-04-04)
- `src/debug/bslDebugSession.ts` — InitializedEvent fix, _knownBreakpoints, _reapplyBreakpoints
- `src/debug/rdbg/rdbgClient.ts` — initSettings/setAutoAttachSettings вызовы, ibInDebug детекция, periodic target discovery
- `src/debug/rdbg/rdbgXmlCodec.ts` — encodeInitSettings, encodeSetAutoAttachSettings
- `src/debug/debugLauncher.ts` — infobaseAlias: undefined

### Изменённые (предыдущие сессии)
- `src/debug/rdbg/rdbgXmlCodec.ts` — реврайт encode-функций + XDTO field order
- `src/debug/rdbg/rdbgClient.ts` — `_seanceMap`, poll diagnostics, `'log'` event
- `src/debug/rdbg/rdbgTransport.ts` — `DEFAULT_TIMEOUT_MS = 0`
- `src/debug/bslDebugSession.ts` — диагностика, auto-attach targetStarted
- `src/debug/bslDebugConfigProvider.ts` — `connectTimeoutMs = 0`
- `src/debug/moduleIdResolver.ts` — UUID propertyID, fallback detectConfigRoot
- `src/commands/editorCommands.ts` — команда startDebugging
- `package.json` — command, context menu

## Тестовое окружение

### Платформа
- **1С:Предприятие 8.3.27.1859**: `C:\Program Files\1cv8\8.3.27.1859\bin\`
- **dbgs.exe**: порт 1550
- **1cv8.exe**: клиент с `/Debug -http -attach /DebuggerURL http://localhost:1550`

### Файловая инфобаза
- **Путь**: `C:\Users\Максим\Documents\InfoBase11`
- **Конфигурация**: `FormatSamples/empty_conf/`

### Тестовый модуль для breakpoint
- **Файл**: `FormatSamples/empty_conf/Catalogs/Справочник55/Ext/ObjectModule.bsl`
- **Содержимое**: `Процедура ПередЗаписью(Отказ) а=0; КонецПроцедуры`
- **Бряка на строке 2** (`а=0;`) — срабатывает при записи элемента
- **objectID**: `c39f6b2f-c005-4039-9d58-fe4565807e54`
- **propertyID**: `a637f77f-3840-441d-a1c3-699c8c5cb7e0` (ObjectModule)

## Next steps

1. **Live-тест**: пересобрать расширение → запустить отладку из контекстного меню → записать Справочник55 → проверить breakpoint hit
2. **Если breakpoint hit работает**: проверить getCallStack, evalLocalVariables, step/continue
3. **Если не работает**: добавить verbose-логирование XML запросов/ответов для initSettings и setAutoAttachSettings, сравнить с Конфигуратором
