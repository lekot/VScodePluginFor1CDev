# BSL Debug Adapter — Summary (актуализация 2026-04-05)

## Цель

Встроенный отладчик BSL в VS Code/Cursor: DAP-сессия напрямую к **dbgs** (HTTP RDBG), **без Java** и без запуска JAR yukon39.

## Архитектура

| Компонент | Роль |
|-----------|------|
| **Реализация** | Полностью **TypeScript** в расширении: `BslDebugSession`, `RdbgClient`, `RdbgTransport`, `rdbgXmlCodec.ts`, `moduleIdResolver.ts`, `debugLauncher.ts`. |
| **HTTP** | `RdbgTransport.send` **сериализует** все запросы в одну цепочку (без параллельных POST на dbgs — иначе при остановке гонка ping + stack + variables). |
| **yukon39/bsl-debug-server** | Только **справочник** по XML/XSD и именам HTTP-команд (`HTTPDebugClient.java`, классы запросов). В рантайме **не подключается**. |

## Текущее состояние (прогресс)

### Работает (подтверждено на живом dbgs 8.3.27)
- Запуск из дерева: dbgs → attach DAP → клиент 1С.
- `initSettings`, `setAutoAttachSettings` (с `autoAttachIdleTargets=true`), ping, обнаружение таргетов, auto-attach.
- **Breakpoints** — множественные точки в одном модуле (группировка в один `bpWorkspace`). Динамическое добавление/удаление во время паузы.
- **Остановка на точке** — подтверждена, включая вложенные вызовы.
- **Step (over/into/out) / Continue** — работает, `xsi:type="DebugTargetIdLight"` на targetID.
- **Call stack** — кадры из ping `DBGUIExtCmdInfoCallStackFormed` (кэш), fallback HTTP `getCallStack`. **Реверс** bottom-up → top-down для DAP.
- **Открытие исходника по стеку** — `resolveBslPathFromRdbgModule` через `ConfigDumpInfo.xml`.
- **Дедупликация stopped** — платформа шлёт `CallStackFormed` на каждый ping; повторный `StoppedEvent` не отправляется.

### Не работает / отключено
- **Локальные переменные** — `evalLocalVariables` **отключён** (вызывает TCP reset / crash dbgs). Возвращает пустой список. XML-формат сверен с yukon39 XSD, `xsi:type` убран с targetID, но сервер всё равно роняет соединение. Требуется отладка формата.
- **Evaluate (watch)** — не тестировалось (evalExpr аналогичен evalLocalVariables по структуре, может иметь те же проблемы).
- **Popup «Неизвестный модуль»** — при возврате из вложенной процедуры платформа может показать `{<Неизвестный модуль>(1,1)}: Переменная не определена (Отказ)`. Косметический баг, не блокирует.

## Обязательно знать при продолжении работ

### 1. Имя метода DAP в `@vscode/debugadapter`

Диспетчер вызывает **`setBreakPointsRequest`** (с **P** в `Points`). Обработчик с именем `setBreakpointsRequest` **не вызывается** — точки «молча» не уходят на сервер. Файл: `bslDebugSession.ts`.

### 2. Параметр `cmd` в URL (не суффикс `Request`)

Формат: `POST …/e1crdbg/rdbg?cmd=<имя>&dbgui=<uuid>`. Имена как в платформе / yukon39 `HTTPDebugClient`:

| Действие | `cmd` |
|----------|--------|
| Шаг (over/in/out), продолжение | **`step`** (continue = тот же `step`, в XML `action=Continue`) |
| Стек | **`getCallStack`** |
| Локальные переменные | **`evalLocalVariables`** |
| Выражение (watch) | **`evalExpr`** |
| Точки останова | `setBreakpoints` |
| Ping | у нас `pingDebugUI` (в Java — `pingDebugUIParams`; при сбоях ping сверить с платформой) |
| Цели | `getDbgTargets`, `attachDetachDbgTargets` |

Неверное имя → **HTTP 501** «Not implemented» для ресурса `/e1crdbg/rdbg`.

### 3. Значения `action` для `RDBGStepRequest` (enum платформы)

| DAP | XML `action` |
|-----|----------------|
| Step over (next) | **`Step`** |
| Step into | **`StepIn`** |
| Step out | **`StepOut`** |
| Continue | **`Continue`** |

Не использовать выдуманное `StepOver`.

### 4. Периодическое обнаружение таргетов

В `_poll` перед `getTargets()` сохранять **`knownBefore = new Set(_seanceMap.keys())`**. После `getTargets()` эмитить `targetStarted` только для `id`, которых **не было** в `knownBefore`. Иначе `getTargets()` сам заполняет карту — условие «новый таргет» никогда не выполняется.

### 5. Неразрешённый путь к модулю

Если `resolveModuleId` вернул `undefined`, **не слать** в RDBG заглушку с путём файла в `<objectID>` — будет **400 XDTO**. Ответ DAP: точки `verified: false`, сообщение в консоль. Лишние `.bsl` в `Ext/` (не `ObjectModule` / `ManagerModule` / формы / команды и т.д.) — **UNRESOLVED**, пока нет явного правила в `moduleIdResolver`.

### 6. Пустой ответ `setBreakpoints`

Часто **200 с пустым телом**. Клиент трактует переданные точки как подтверждённые, иначе в UI они «неверифицированы».

### 7. Пустой `attachTargets` в логе

Нормально, если тело ответа пустое и HTTP успешен.

### 8. `RDBGEvalLocalVariablesRequest` — эталон yukon39 + XSD

Сверено с `RDBGEvalLocalVariablesRequest.java`, `CalculationSourceDataStorage.java`, `debugRDBGRequestResponse.xsd`, `debugCalculations.xsd` из yukon39/bsl-debug-server.

**Порядок полей XSD** (xs:sequence, строгий):
1. `infoBaseAlias` (из `RDbgBaseRequest`)
2. `idOfDebuggerUI` (из `RDbgBaseRequest`)
3. `calcWaitingTime` (xs:decimal)
4. `targetID` (тип `DebugTargetIdLight`)
5. `expr` (0..N, тип `CalculationSourceDataStorage`)

**`CalculationSourceDataStorage`** — все дочерние элементы namespace-qualified через `http://v8.1c.ru/8.3/debugger/debugCalculations` (`calc:` prefix). Поля: `stackLevel` → `srcCalcInfo` (опц.) → `presOptions` (опц.). Для получения всех локальных переменных фрейма достаточно только `calc:stackLevel`.

**Ответ** — `result.calculationResult.valueOfContextPropInfo[]` (propInfo + valueInfo), а не плоский список `variable`.

### 9. `xsi:type` на `<rdbg:targetID>` — не ставить для eval/callstack

**Эталон:** JAXB **не добавляет** `xsi:type` когда объявленный тип совпадает с фактическим. Для `evalLocalVariables`, `evalExpr`, `getCallStack` в XSD объявлен конкретный тип `DebugTargetIdLight` — `xsi:type` **избыточен**.

**Факт:** `test/fixtures/rdbg/live/callstack_final.xml` содержит ошибку XDTO именно на `xsi:type="DebugTargetIdLight"` у `targetID`. `localvars_final.xml` — ошибка про `callStackLevel` (устаревшая, убран в текущем коде). Однако `xsi:type` на targetID в `evalLocalVariables` **тоже является проблемой**.

**Правило:** `xsi:type` нужен только для полиморфных полей (когда фактический тип — подтип объявленного). В текущих encode-функциях `step`/`continue` работают с `xsi:type` (платформа прощает), но для eval/callstack вызывает ошибку XDTO или TCP reset.

**Решение:** `xsi:type` **оставлен** на targetID для `step`/`continue` (работает). **Убран** для `evalLocalVariables`, `evaluate`, `getCallStack` (вызывает XDTO-ошибку или TCP reset). Две хелпер-функции: `targetIdTypedToXml` (с xsi:type) и `targetIdToXml` (без).

## Краткая история фиксов (без устаревших гипотез)

- **InitializedEvent** — только в конце `attachRequest` (после создания `_client` и attach), иначе гонка с `setBreakpoints`.
- **initSettings / setAutoAttachSettings** — минимальный XDTO под 8.3.27; вызов из `attach`, ошибки non-fatal.
- **`_seanceMap`**, reapply точек при новом таргете, `DefAlias` для `infobaseAlias` в лаунчере.
- **Остановка в UI**: `Event('stopped', { threadId, allThreadsStopped, description, … })`, резервный `threadId` если `targetId` из ping не сопоставился.
- **Call stack из ping** — кэш `_stackTraceCacheByThreadId` из `DBGUIExtCmdInfoCallStackFormed`; HTTP `getCallStack` — резервный fallback, до исправления `xsi:type` может давать XDTO ошибку.
- **`_pausedThreadId`** — threadId остановленного потока; Locals/Evaluate используют его targetId, а не произвольный из Map.
- **CallStack bottom-up** — платформа отдаёт стек снизу вверх (caller first), DAP ожидает сверху вниз (current frame first). Реверсируем в `_rdbgItemsToStackFramesAsync`.
- **setBreakpoints: один bpWorkspace** — все breakpoints одного модуля в одном `<bp:moduleBPInfo>` с множеством `<bp:bpInfo>`. Ранее каждый breakpoint был в отдельном bpWorkspace — сервер трактовал каждый как замену, выживал только последний.
- **Порядок полей XSD** — `infoBaseAlias` → `idOfDebuggerUI` (из RDbgBaseRequest). Ранее initSettings и setAutoAttachSettings имели обратный порядок → XDTO-ошибка.
- **Дедупликация stopped** — платформа шлёт `CallStackFormed` на каждый ping пока цель стоит; повторный `StoppedEvent` не отправляется если targetId+lineNo+reason не изменились.

## Тестовое окружение (эталон для проверок)

- Платформа **8.3.27.x**, **dbgs** (например порт **1550**).
- Конфиг для примера: `FormatSamples/empty_conf/`, точка в `Catalogs/Справочник55/Ext/ObjectModule.bsl` (строка с исполняемым кодом, например `ПередЗаписью`).
- UUID объекта каталога и `propertyID` ObjectModule — см. `ConfigDumpInfo.xml` / `moduleIdResolver.test.ts`.

## Следующие шаги

1. **Починить evalLocalVariables** (текущий приоритет):
   - Сейчас отключён (crash dbgs). XML-формат сверен с XSD, `xsi:type` убран, порядок полей исправлен. Нужно: написать standalone тест-скрипт для пробы формата против живого dbgs, итеративно найти правильную разметку.
   - Гипотеза: может быть проблема с `calc:` namespace prefix на дочерних элементах `<rdbg:expr>` — платформа может ожидать unqualified элементы.
2. **Evaluate (watch)** — включить и протестировать `evalExpr` (аналогичная структура).
3. **moduleIdResolver**: явные шаблоны для **RecordSetModule** и прочих `Ext/*.bsl`.
4. **Переменные (расширение)**: раскрытие `isExpandable`, привязка `variablesReference` к кадру/цели.
5. **Popup «Неизвестный модуль»** — при возврате из вложенной процедуры; косметический баг.

## Ключевые пути в репозитории

- `src/debug/bslDebugSession.ts` — DAP, `setBreakPointsRequest`, `stopped`, `_knownBreakpoints`, `_reapplyBreakpoints`
- `src/debug/rdbg/rdbgClient.ts` — state machine, poll, имена **`cmd`** для HTTP
- `src/debug/rdbg/rdbgXmlCodec.ts` — encode/decode XML, **`evalExpr`** тело, `decodeEvalResult`
- `src/debug/rdbg/rdbgTransport.ts` — POST, **очередь** (один запрос за раз), таймаут 0
- `src/debug/moduleIdResolver.ts` — путь BSL → objectId + propertyId
- `src/debug/debugLauncher.ts` — старт dbgs + `startDebugging`
- `test/suite/moduleIdResolver.test.ts` — регрессия UUID модулей

## Диагностика

В Debug Console искать префиксы: `BSL Debug:`, `[bsl-debug] setBreakpoints:`, `[setBreakpoints]`, `[poll #…]`, `[poll] transient failure …`. Полный сырой XML при необходимости временно нарастить в `rdbgClient` / transport.

### Два разных «обрыва» (не путать)

1. **Реальный отказ связи с сервером отладки (сторона 1С)**  
   Тонкий клиент / сеанс 1С показывает сообщение вроде **«нет связи с сервером»** (или аналог) — это обрыв **канала клиент ↔ dbgs**, не интерпретация VS Code. Причины типично на стороне процесса **dbgs**, сети, порта, нехватки ресурсов или **дефекта/нагрузки** на HTTP-слое отладчика платформы. Адаптер VS Code тут лишь перестаёт получать ответы; симптом в IDE может совпасть по времени, но **первичен именно падёж связи в 1С**.

2. **Сессия отладки в VS Code завершилась по логике адаптера**  
   После **ряда подряд неудачных ping** `RdbgClient` эмитит `error` → `TerminatedEvent` в DAP. Это **наше** решение «считать соединение потерянным»; клиент 1С при этом может оставаться подключённым или нет — сценарии разные.

3. **Обрыв при evalLocalVariables / getCallStack (XDTO crash)**  
   Лишний `xsi:type="DebugTargetIdLight"` на элементах `<rdbg:targetID>` / `<rdbg:id>` приводит к тому, что XDTO-процессор платформы сбрасывает TCP-соединение (ECONNRESET). После этого все последующие ping получают ECONNREFUSED → адаптер объявляет потерю сессии (п.2), а 1С-клиент показывает «нет связи» (п.1). **Причина первична на стороне нашего XML, не платформы.**

**Снижение риска для п.1 (на стороне расширения):** все HTTP-запросы к `/e1crdbg/rdbg` идут **последовательно** (`RdbgTransport`), чтобы не создавать параллельную нагрузку на dbgs в момент остановки (ping + стек + переменные). Если после этого **1С по-прежнему** рвёт связь — имеет смысл смотреть логи dbgs/платформы, версию 8.3.x, стабильность порта и обращаться в поддержку 1С как к сбою/ограничению сервера отладки, а не только адаптера.

**Poll:** только **один** асинхронный `_poll` за раз (повторный тик `setInterval`, пока предыдущий ping ещё в `await`, пропускается). Иначе несколько опросов параллельно наращивали `_consecutiveFailures` и вызывали **многократный** `emit('error')` с числами 8, 9, 10… — это артефакт клиента, а не «25 обрывов» сервера.

**Сообщение `fetch failed`:** в лог теперь добавляются **цепочка `cause` и `code` (например `ECONNREFUSED`)** — по ним видно, закрыт ли порт, сброшен ли TCP, и т.д.
