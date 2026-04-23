# CDT 41 Agent API — Skill Reference

Расширение CDT 41 для VS Code предоставляет **53** команды для программного управления метаданными, привязками, отладкой и формами конфигурации 1С:Предприятие. Команды вызываются через `vscode.commands.executeCommand` или через HTTP bridge.

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
  "createdAt": "2026-04-13T08:56:08.711Z",
  "extensionVersion": "0.46.8",
  "docs": "https://github.com/lekot/VScodePluginFor1CDev/blob/main/docs/features/agent-api/agent-skill.md",
  "quickstart": "POST http://127.0.0.1:<port>/command ...",
  "helperScriptPath": "C:/Users/.../.vscode/extensions/nikolay-shirokov.1c-metadata-tree-vscode-0.46.8/resources/agent-bridge/call.sh",
  "discoverScriptPath": "C:/Users/.../.vscode/extensions/nikolay-shirokov.1c-metadata-tree-vscode-0.46.8/resources/agent-bridge/discover.sh"
}
```

Поля `helperScriptPath` / `discoverScriptPath` указывают на bash-скрипты, поставляемые вместе с расширением (см. ниже «Вызов через helper-скрипт»).

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
/^1c-metadata-tree\.agent(\.debug|\.forms|\.skd)?\.[a-zA-Z]+$/
```

### Вызов через helper-скрипт

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

Этот путь предпочтительнее, чем ручной `curl`: скрипт сам подставляет токен, правильно пропускает кириллицу через UTF-8 и шейпит тело запроса.

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

Возвращает: `{ summary: { success, error, skipped }, results: [{ infobase, status, message }] }`.

#### `1c-metadata-tree.agent.deployChangedFiles`

Раскатка файлов, изменённых в git working tree. Автоматически определяет изменённые файлы конфигурации.

```json
{
  "configPath": "C:/reps/project/conf"
}
```

- `configPath` — путь к каталогу конфигурации (необязательно)

Возвращает тот же формат.

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

---

## Ограничения

- Формы конфигуратора через Agent API не создаются/редактируются (используйте UI). Формы enterprise — через agent.forms.*
- Для InformationRegister и AccumulationRegister при `createObject` создаются дефолтные Измерение+Ресурс (шаблонный fallback)
- Тип реквизита при `addAttribute` задаётся дефолтный (строка 50); для изменения используйте `setProperties` с `Type: "cfg:DocumentRef.Больше"` или `Type: "xs:boolean"` и т.д.
