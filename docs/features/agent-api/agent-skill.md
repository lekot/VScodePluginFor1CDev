# CDT 41 Agent API — Skill Reference

Расширение CDT 41 для VS Code предоставляет 30 команд для программного управления метаданными, привязками, отладкой и формами конфигурации 1С:Предприятие. Команды вызываются через `vscode.commands.executeCommand` или через HTTP bridge.

## HTTP Bridge

Расширение поднимает HTTP-сервер на рандомном порту при активации. Координаты записываются в файл:

```
<workspaceFolder>/.vscode/cdt-agent-bridge.json
```

Формат:
```json
{
  "port": 63088,
  "token": "baf0b38e...hex64...",
  "pid": 42144,
  "workspaceFolder": "c:\\reps\\1cviewer",
  "createdAt": "2026-04-13T08:56:08.711Z"
}
```

### Протокол

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

### Whitelist команд

Через bridge доступны только команды, соответствующие паттерну:
```
/^1c-metadata-tree\.agent(\.debug|\.forms)?\.[a-zA-Z]+$/
```

---

## Адресация объектов (dot-path)

Все команды принимают путь в формате dot-path:

| Формат | Пример | Что адресует |
|--------|--------|-------------|
| `Тип.Имя` | `Catalog.Товары` | Корневой объект |
| `Тип.Имя.Attribute.Реквизит` | `Catalog.Товары.Attribute.Артикул` | Реквизит объекта |
| `Тип.Имя.TabularSection.ТЧ` | `Document.Заказ.TabularSection.Состав` | Табличная часть |
| `Тип.Имя.TabularSection.ТЧ.Attribute.Колонка` | `Document.Заказ.TabularSection.Состав.Attribute.Количество` | Колонка ТЧ |

Тип — английское имя rootTag: `Catalog`, `Document`, `Enum`, `InformationRegister`, `CommonModule`, `Subsystem`, `Report`, `DataProcessor`, `ChartOfAccounts`, `ChartOfCharacteristicTypes`, `AccumulationRegister`, `AccountingRegister`, `CalculationRegister`, `BusinessProcess`, `Task`, `ExchangePlan`, `Constant`, `Role`, `ScheduledJob`, `HTTPService`, `WebService` и др. (45 типов).

## Команды

Все команды возвращают `{ success: boolean, data?: T, error?: string }`.

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

Возвращает: `{ properties: Record<string, unknown> }`.

#### `1c-metadata-tree.agent.listObjects`

Список объектов конфигурации.

```json
{
  "type": "Catalog"
}
```

Без `type` — все объекты. Возвращает: `{ objects: [{ type, name, filePath }] }`.

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

Возвращает: `{ summary: { success, error, skipped }, results: [{ infobase, status, message }] }`.

Требует предварительной привязки базы через UI («Привязать базы…»).

---

### Отладка (14 команд)

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

## Типичные сценарии

### Сценарий A: CRUD метаданных

```
1. listObjects({ type: 'Catalog' })              → узнать что есть
2. createObject({ type: 'Catalog', name: 'Товары' })  → создать справочник
3. addAttribute({ path: 'Catalog.Товары', name: 'Артикул' })
4. setProperties({ path: 'Catalog.Товары.Attribute.Артикул', properties: { Type: 'cfg:CatalogRef.Номенклатура' } })
5. deploy({})                                     → раскатать в базу
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

### Сценарий C: отладка через ibsrv + Playwright

Для агентской работы с формами — ibsrv поднимает веб-клиент и встроенный отладчик.

```
1. debug.startFromBinding({ binding: 'empty_conf', debuggeeType: 'webServer' })
   → { sessionId, webServerUrl: 'http://localhost:52570' }
2. debug.setBreakpoint({ file: '...ObjectModule.bsl', line: 4 })
3. Playwright: открыть webServerUrl, навигировать к форме, выполнить действие (Записать)
4. debug.waitForStop({ sessionId, timeoutMs: 30000 })
   → { reason: 'breakpoint', threadId: 1, frameId: 1, file: '...', line: 4 }
5. debug.evaluate({ sessionId, frameId: 1, expression: 'Сч' })
   → { value: '1', type: 'Число', varRef: 0 }
6. debug.continue({ sessionId, threadId: 1 })
7. debug.stop({ sessionId })
```

**Особенности webServer режима:**
- `verified: false` при setBreakpoint — нормально, BP сработает после подключения браузера
- `getVariables` (панель Locals) — пусто; используйте `evaluate` для конкретных переменных
- ibsrv создаёт новые target'ы динамически при серверных операциях — расширение обнаруживает и подключает их автоматически
- `waitForStop` нужно вызывать **до** или **одновременно** с действием Playwright (иначе stop event будет потерян)

### Формы enterprise (через skill /1c-forms)

Работа с формами 1С в режиме предприятия выполняется через отдельный skill `/1c-forms` (Playwright + ibsrv), а не через VS Code bridge. Skill автоматически запускает ibsrv и подключает браузер:

```bash
# Резолвить базу по фикстуре (через bridge):
bash .claude/skills/cdt-agent/scripts/call.sh resolveBinding '{"configPath":"uh"}'

# Запустить сессию (ibsrv + Playwright автоматически):
bash .claude/skills/1c-forms/scripts/call.sh start "C:/path/to/infobase"

# Навигация, заполнение, чтение:
bash .claude/skills/1c-forms/scripts/call.sh exec 'await navigateLink("Справочник.Контрагенты"); const t = await readTable(); console.log(JSON.stringify(t));'

# Остановить всё:
bash .claude/skills/1c-forms/scripts/call.sh stop
```

Подробнее: `.claude/skills/1c-forms/SKILL.md`.

### СКД (через skill /skd)

Создание, анализ и редактирование схем компоновки данных (DataCompositionSchema). Построен поверх cc-1c-skills.

```bash
# Скомпилировать СКД из JSON DSL:
bash .claude/skills/skd/scripts/call.sh compile -Value '{
  "dataSets": [{"query": "ВЫБРАТЬ Товары.Наименование, Товары.Цена ИЗ Справочник.Товары КАК Товары", "fields": ["Наименование", "Цена: decimal(15,2)"]}],
  "totalFields": ["Цена: Сумма"],
  "parameters": ["Период: StandardPeriod = LastMonth @autoDates"]
}' -OutputPath Template.xml

# Анализ существующей СКД (11 режимов):
bash .claude/skills/skd/scripts/call.sh info Template.xml                    # overview
bash .claude/skills/skd/scripts/call.sh info Template.xml -Mode query -Name НаборДанных1  # текст запроса
bash .claude/skills/skd/scripts/call.sh info Template.xml -Mode params       # параметры
bash .claude/skills/skd/scripts/call.sh info Template.xml -Mode full         # полная сводка

# Точечное редактирование (25 операций):
bash .claude/skills/skd/scripts/call.sh edit Template.xml -Op add-field -DataSet НаборДанных1 -Field "НовоеПоле: decimal(15,2)"

# Валидация (~30 проверок):
bash .claude/skills/skd/scripts/call.sh validate Template.xml
```

JSON DSL поддерживает shorthand: `"Количество: decimal(15,2) @dimension #noFilter"`, русские синонимы типов (`число`, `строка`, `дата`), `@autoDates` для автогенерации ДатаНачала/ДатаОкончания.

Подробнее: `.claude/skills/skd/SKILL.md`.

---

## Ограничения

- Формы конфигуратора через Agent API не создаются/редактируются (используйте UI). Формы enterprise — через skill /1c-forms
- Для InformationRegister и AccumulationRegister при `createObject` создаются дефолтные Измерение+Ресурс (шаблонный fallback)
- Тип реквизита при `addAttribute` задаётся дефолтный (строка 50); для изменения используйте `setProperties` с `Type: "cfg:DocumentRef.Больше"` или `Type: "xs:boolean"` и т.д.
