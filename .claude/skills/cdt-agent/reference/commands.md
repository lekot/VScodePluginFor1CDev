# CDT Agent API — Полный reference

53 команды через `bash "$HELPER" <suffix> '<args>'`.

Все команды возвращают `AgentResult<T>`:
- Успех: `{"success": true, "data": {...}}` или `{"success": true}`
- Ошибка: `{"success": false, "error": "..."}`

```bash
# В начале сессии один раз:
HELPER=$(node -p "JSON.parse(require('fs').readFileSync('./.vscode/cdt-agent-bridge.json','utf8')).helperScriptPath")
# Далее все примеры используют "$HELPER".
```

## Содержание

- [CRUD метаданных (12 команд)](#crud-метаданных)
- [Привязки (2 команды)](#привязки)
- [Debug (15 команд)](#debug)
- [Deploy (5 команд)](#deploy)
- [Forms (5 команд)](#forms)
- [SKD (4 команды)](#skd)

---

## CRUD метаданных

### `createObject`

Создаёт новый объект конфигурации (Catalog, Document, CommonModule, Subsystem, Enum и др.).

**Params:**
```ts
{
  type: string;          // 'Catalog' | 'Document' | 'CommonModule' | 'Subsystem' | 'Enum' | ...
  name: string;          // Имя объекта
  synonym?: string;      // Синоним (отображаемое имя)
  properties?: object;   // Дополнительные свойства (HierarchyType, ObjectModule и др.)
}
```

**Result:** `{ filePath: string }`

**Пример:**
```bash
bash "$HELPER" createObject '{"type":"Catalog","name":"Контрагенты","synonym":"Контрагенты"}'
```

---

### `getYaml`

Возвращает YAML-представление объекта (компактнее XML, удобно для агентов).

**Params:** `{ path: string }` — например `"Catalog.Контрагенты"`
**Result:** `{ yaml: string }`

```bash
bash "$HELPER" getYaml '{"path":"Catalog.Контрагенты"}'
```

---

### `listObjects`

Список объектов конфигурации, опционально фильтрованный по типу.

**Params:** `{ type?: string }` — если не задан, возвращает все объекты
**Result:** `{ objects: Array<{ type, name, filePath }> }`

```bash
# Все объекты
bash "$HELPER" listObjects '{}'

# Только справочники
bash "$HELPER" listObjects '{"type":"Catalog"}'
```

---

### `getProperties`

Возвращает свойства объекта (или вложенного элемента — реквизита, табличной части).

**Params:** `{ path: string }`
**Result:** `{ properties: Record<string, unknown> }`

```bash
bash "$HELPER" getProperties '{"path":"Catalog.Контрагенты"}'
bash "$HELPER" getProperties '{"path":"Catalog.Контрагенты.Attribute.ИНН"}'
```

---

### `addAttribute`

Добавляет реквизит к объекту.

**Params:** `{ path: string, name: string }`
**Result:** `{ filePath: string }`

```bash
bash "$HELPER" addAttribute '{"path":"Catalog.Контрагенты","name":"ИНН"}'
```

---

### `addTabularSection`

Добавляет табличную часть к объекту.

**Params:** `{ path: string, name: string }`
**Result:** `{ filePath: string }`

```bash
bash "$HELPER" addTabularSection '{"path":"Document.ЗаказПокупателя","name":"Товары"}'
```

---

### `addTabularSectionColumn`

Добавляет колонку (реквизит) в табличную часть.

**Params:** `{ path: string, name: string }` — путь вида `Document.X.TabularSection.Y`
**Result:** `{ filePath: string }`

```bash
bash "$HELPER" addTabularSectionColumn '{"path":"Document.ЗаказПокупателя.TabularSection.Товары","name":"Количество"}'
```

---

### `deleteAttribute`

Удаляет реквизит.

**Params:** `{ path: string }` — например `"Catalog.X.Attribute.Y"`
**Result:** `void`

```bash
bash "$HELPER" deleteAttribute '{"path":"Catalog.Контрагенты.Attribute.ИНН"}'
```

---

### `deleteTabularSection`

Удаляет табличную часть.

**Params:** `{ path: string }` — например `"Document.X.TabularSection.Y"`
**Result:** `void`

```bash
bash "$HELPER" deleteTabularSection '{"path":"Document.ЗаказПокупателя.TabularSection.Товары"}'
```

---

### `deleteObject`

Удаляет объект конфигурации.

**Params:** `{ path: string }` — например `"Catalog.Тестовый"`
**Result:** `void`

```bash
bash "$HELPER" deleteObject '{"path":"Catalog.Тестовый"}'
```

---

### `renameObject`

Переименовывает объект.

**Params:** `{ path: string, newName: string }`
**Result:** `void`

```bash
bash "$HELPER" renameObject '{"path":"Catalog.Старое","newName":"Новое"}'
```

---

### `setProperties`

Устанавливает свойства объекта (merge с существующими).

**Params:** `{ path: string, properties: object }`
**Result:** `void`

```bash
bash "$HELPER" setProperties '{"path":"Catalog.Контрагенты","properties":{"Synonym":"Партнёры"}}'
```

---

## Привязки

### `resolveBinding`

Резолвит привязку фикстуры → инфобазу. Принимает полный путь, относительный, или просто имя фикстуры ("uh", "empty_conf").

**Params:**
```ts
{
  configPath?: string;  // "uh" | "empty_conf" | "FormatSamples/uh" | полный путь
}
```

**Result:** `{ configPath, configRelativePath, workspaceFolder, infobase: { id, name, type, filePath?, server?, database?, webUrl? } }`

**Пример:**
```bash
bash "$HELPER" resolveBinding '{"configPath":"uh"}'
# → { "success": true, "data": { "infobase": { "type": "file", "filePath": "C:/Users/.../DemoERPUH", ... } } }
```

---

### `listBindings`

Все привязки с резолвленными инфобазами.

**Params:** нет (пустой объект `{}`)

**Result:** массив `[{ configRelativePath, workspaceFolder, infobaseCount, infobases: [...] }]`

**Пример:**
```bash
bash "$HELPER" listBindings '{}'
```

---

## Debug

### `debug.start`

Запускает отладочную сессию 1С (запускает dbgs.exe + 1cv8c.exe).

**Params:**
```ts
{
  rootProject: string;       // Абсолютный путь к корню конфигурации
  infobase: string;          // 'File=C:/path' или 'Srvr=server;Ref=name'
  platformPath: string;      // Каталог с 1cv8c.exe и dbgs.exe
  extensions?: string[];     // Опциональные расширения конфигурации
  debugServerHost?: string;  // По умолчанию 'localhost'
  debugServerPort?: number;  // По умолчанию 1550
}
```

**Result:** `{ sessionId: string }` — сохрани, нужно для всех debug операций

```bash
bash "$HELPER" debug.start '{
  "rootProject":"C:/reps/test/conf",
  "infobase":"File=C:/test/ib",
  "platformPath":"C:/Program Files/1cv8/8.3.24/bin"
}'
```

---

### `debug.stop`

Останавливает отладочную сессию.

**Params:** `{ sessionId: string }`
**Result:** `void`

```bash
bash "$HELPER" debug.stop '{"sessionId":"abc-123"}'
```

---

### `debug.setBreakpoint`

Ставит точку останова в файле на строке. Возвращает после получения verified-статуса (или таймаута 2с).

**Params:**
```ts
{
  file: string;            // Абсолютный путь к BSL файлу
  line: number;            // 1-based номер строки
  condition?: string;      // BSL-выражение (срабатывает если true)
  hitCondition?: string;   // '5', '>= 3', '> 3', '% 7' — см. parseHitCondition
  logMessage?: string;     // Лог вместо остановки (logpoint)
}
```

**Result:** `{ verified: boolean, id: string }`

```bash
bash "$HELPER" debug.setBreakpoint '{"file":"C:/conf/CommonModules/Module/Ext/Module.bsl","line":42}'

# С условием и хит-каунтом
bash "$HELPER" debug.setBreakpoint '{
  "file":"C:/conf/CommonModules/Module/Ext/Module.bsl",
  "line":42,
  "condition":"i > 5",
  "hitCondition":">= 3"
}'
```

---

### `debug.clearBreakpoints`

Удаляет точки останова в файле, или все BP если file не задан.

**Params:** `{ file?: string }`
**Result:** `void`

```bash
# Все BP
bash "$HELPER" debug.clearBreakpoints '{}'

# Только в файле
bash "$HELPER" debug.clearBreakpoints '{"file":"C:/conf/CommonModules/Module/Ext/Module.bsl"}'
```

---

### `debug.setExceptionFilter`

Включает/выключает остановку при исключениях, опционально с фильтром по подстроке.

**Params:** `{ sessionId: string, enabled: boolean, substring?: string }`
**Result:** `void`

```bash
# Включить с фильтром
bash "$HELPER" debug.setExceptionFilter '{"sessionId":"abc","enabled":true,"substring":"Деление на ноль"}'

# Включить без фильтра — на всё
bash "$HELPER" debug.setExceptionFilter '{"sessionId":"abc","enabled":true}'

# Выключить
bash "$HELPER" debug.setExceptionFilter '{"sessionId":"abc","enabled":false}'
```

---

### `debug.waitForStop`

Ждёт остановку отладчика (BP/exception/step). Возвращает информацию о top frame сразу — не нужно вызывать getStackTrace отдельно для базового случая.

**Params:** `{ sessionId: string, timeoutMs?: number }` — таймаут default 30000
**Result:** `{ reason, threadId, frameId, file, line }`

`reason`: `'breakpoint'` | `'step'` | `'exception'` | `'pause'`

```bash
bash "$HELPER" debug.waitForStop '{"sessionId":"abc","timeoutMs":30000}'
```

---

### `debug.getStackTrace`

Возвращает полный стек вызовов потока.

**Params:** `{ sessionId: string, threadId: number }`
**Result:** `{ frames: Array<{ id, name, file, line }> }`

```bash
bash "$HELPER" debug.getStackTrace '{"sessionId":"abc","threadId":1}'
```

---

### `debug.getScopes`

Возвращает scope'ы (области видимости) для фрейма. У 1С обычно одна — "Локальные".

**Params:** `{ sessionId: string, frameId: number }`
**Result:** `{ scopes: Array<{ name, varRef }> }`

```bash
bash "$HELPER" debug.getScopes '{"sessionId":"abc","frameId":1}'
```

---

### `debug.getVariables`

Возвращает переменные по varRef (из scopes или из дочернего объекта). Для drilldown — рекурсивно вызывать с varRef ребёнка.

**Params:** `{ sessionId: string, varRef: number }`
**Result:** `{ vars: Array<{ name, type, value, varRef }> }`

`varRef === 0` означает примитив (нет дочерних элементов).

```bash
# Корневой scope
bash "$HELPER" debug.getVariables '{"sessionId":"abc","varRef":1}'

# Раскрыть массив (varRef из предыдущего ответа)
bash "$HELPER" debug.getVariables '{"sessionId":"abc","varRef":42}'
```

---

### `debug.evaluate`

Вычисляет BSL-выражение в контексте фрейма.

**Params:** `{ sessionId: string, expression: string, frameId?: number }`
**Result:** `{ value, type, varRef }`

```bash
bash "$HELPER" debug.evaluate '{"sessionId":"abc","expression":"Массив.Количество()","frameId":1}'
```

---

### `debug.continue`

Продолжает выполнение после остановки.

**Params:** `{ sessionId: string, threadId: number }`
**Result:** `void`

```bash
bash "$HELPER" debug.continue '{"sessionId":"abc","threadId":1}'
```

---

### `debug.stepOver`

Шаг через строку (step over) — не заходит в вызовы.

**Params:** `{ sessionId: string, threadId: number }`
**Result:** `void`

```bash
bash "$HELPER" debug.stepOver '{"sessionId":"abc","threadId":1}'
```

---

### `debug.stepIn`

Шаг внутрь вызова процедуры/функции.

**Params:** `{ sessionId: string, threadId: number }`
**Result:** `void`

```bash
bash "$HELPER" debug.stepIn '{"sessionId":"abc","threadId":1}'
```

---

### `debug.stepOut`

Шаг наружу — выйти из текущей процедуры до её вызывающей.

**Params:** `{ sessionId: string, threadId: number }`
**Result:** `void`

```bash
bash "$HELPER" debug.stepOut '{"sessionId":"abc","threadId":1}'
```

---

## Forms

Команды управления веб-клиентом 1С через Playwright/Chromium. Whitelist: `forms.*`.

### `forms.start`

Запускает сессию веб-клиента 1С. Подключается к готовому ibsrv (`url`) или сам спавнит ibsrv из файловой базы (`dbPath`). Ровно один из двух параметров обязателен.

**Params:**
```ts
{
  url?: string;            // URL готового ibsrv. Взаимоисключающий с dbPath
  dbPath?: string;         // Путь к файловой базе — ibsrv запустится автоматически. Взаимоисключающий с url
  platformPath?: string;   // Каталог bin платформы 1С (для spawn ibsrv). Если не задан — берётся из настроек
  readyTimeoutMs?: number; // Таймаут готовности ibsrv+chromium в мс (по умолчанию 60000)
}
```

**Result:** `{ url: string, ibsrvSpawned: boolean, uiAccessHint?: string }`

```bash
# Подключиться к уже запущенному веб-серверу
bash "$HELPER" forms.start '{"url":"http://localhost:8080/base"}'

# Запустить из файловой базы
bash "$HELPER" forms.start '{"dbPath":"C:/bases/mybase","platformPath":"C:/Program Files/1cv8/8.3.24/bin"}'
```

---

### `forms.exec`

Выполняет JS-скрипт в контексте браузера. Скрипт передаётся в run.mjs exec — stdout возвращается в output.

**Params:**
```ts
{
  script: string;      // JS-скрипт для выполнения в браузере (обязателен)
  timeoutMs?: number;  // Таймаут в мс (по умолчанию 30000)
}
```

**Result:** `{ output: string, stderr?: string, exitCode: number }`

Sandbox экспортирует функции из `resources/web-test/browser.mjs` (`getPageState`, `getSections`, `navigateSection`, `clickElement`, `fillField`, `closeForm`, `screenshot`, `getPage` и др.) и глобальные `console`, `writeFileSync`, `readFileSync`. Чтобы получить значение наружу — пиши в `console.log(...)`: строки из stdout попадают в `output`.

```bash
# Статус открытой страницы (section, tab, formTitle)
bash "$HELPER" forms.exec '{"script":"const st = await getPageState(); console.log(JSON.stringify(st));"}'

# Навигация и чтение формы через Playwright page напрямую (getPage возвращает playwright.Page)
bash "$HELPER" forms.exec '{"script":"const p = getPage(); const t = await p.title(); console.log(t);","timeoutMs":10000}'
```

---

### `forms.stop`

Останавливает сессию веб-клиента. Если ibsrv был запущен через `forms.start`, гасит его тоже.

**Params:** `{}` (нет параметров)
**Result:** `{}`

```bash
bash "$HELPER" forms.stop '{}'
```

---

### `forms.shot`

Делает скриншот текущего состояния браузера.

**Params:**
```ts
{
  file?: string;  // Путь к PNG. Если не задан — сохраняется во temp-файл
}
```

**Result:** `{ file: string }` — абсолютный путь сохранённого PNG

```bash
bash "$HELPER" forms.shot '{}'
bash "$HELPER" forms.shot '{"file":"C:/tmp/screen.png"}'
```

---

### `forms.status`

Проверяет состояние текущей сессии веб-клиента.

**Params:** `{}` (нет параметров)
**Result:** `{ browserAlive: boolean, url?: string, ibsrvAlive: boolean, ibsrvPid?: number }`

```bash
bash "$HELPER" forms.status '{}'
```

---

## SKD

Команды работы со схемами компоновки данных (DataCompositionSchema). Whitelist: `skd.*`.

### `skd.compile`

Компилирует СКД из JSON DSL в XML (Template.xml). Один из `definitionFile` / `value` обязателен; нельзя использовать оба.

**Params:**
```ts
{
  definitionFile?: string;  // Путь к JSON-файлу описания СКД. Взаимоисключающий с value
  value?: string;           // Inline JSON-строка описания СКД. Взаимоисключающий с definitionFile
  outputPath: string;       // Путь к выходному XML-файлу (обязателен)
}
```

**Result:** `{ output: string, stats?: { dataSets, fields, calculated, totals, parameters, variants, sizeBytes }, rawOutput: string }`

```bash
bash "$HELPER" skd.compile '{"definitionFile":"C:/tmp/skd.json","outputPath":"C:/conf/Reports/Отчёт/Ext/Template.xml"}'
bash "$HELPER" skd.compile '{"value":"{\"dataSets\":[]}","outputPath":"C:/tmp/out.xml"}'
```

---

### `skd.info`

Возвращает информацию о структуре СКД в текстовом виде. Поддерживает пагинацию и несколько режимов вывода.

**Params:**
```ts
{
  templatePath: string;    // Путь к Template.xml, папке СКД или дескриптору (обязателен)
  mode?: 'overview' | 'query' | 'fields' | 'links' | 'calculated' | 'resources'
       | 'params' | 'variant' | 'trace' | 'templates' | 'full';  // По умолчанию overview
  name?: string;           // Имя набора данных / варианта для детального вывода
  batch?: number;          // Загрузка пакетами, 0 = без пакетов
  limit?: number;          // Максимум строк на страницу (по умолчанию 150)
  offset?: number;         // Смещение для пагинации
  outFile?: string;        // Путь к выходному файлу
}
```

**Result:** `{ info: string, truncated?: boolean }`

```bash
bash "$HELPER" skd.info '{"templatePath":"C:/conf/Reports/Отчёт/Ext/Template.xml"}'
bash "$HELPER" skd.info '{"templatePath":"C:/conf/Reports/Отчёт/Ext/Template.xml","mode":"fields"}'
bash "$HELPER" skd.info '{"templatePath":"C:/conf/Reports/Отчёт/Ext/Template.xml","mode":"params","limit":50,"offset":0}'
```

---

### `skd.edit`

Атомарная операция редактирования СКД (add/modify/remove полей, параметров, отборов и т.д.).

**Params:**
```ts
{
  templatePath: string;       // Путь к Template.xml или папке СКД (обязателен)
  operation: SkdEditOperation; // Тип операции (обязателен) — см. список ниже
  value: string;              // JSON-значение операции (обязателен)
  dataSet?: string;           // Имя набора данных для привязки операции
  variant?: string;           // Имя варианта настроек
  noSelection?: boolean;      // Не добавлять автоматически в отбор
}
```

Допустимые значения `operation`: `add-field`, `add-total`, `add-calculated-field`, `add-parameter`, `add-filter`, `add-dataParameter`, `add-order`, `add-selection`, `add-dataSetLink`, `add-dataSet`, `add-variant`, `add-conditionalAppearance`, `set-query`, `set-outputParameter`, `set-structure`, `modify-field`, `modify-filter`, `modify-dataParameter`, `clear-selection`, `clear-order`, `clear-filter`, `remove-field`, `remove-total`, `remove-calculated-field`, `remove-parameter`, `remove-filter`.

**Result:** `{ output: string, rawOutput: string }`

```bash
bash "$HELPER" skd.edit '{"templatePath":"C:/conf/Reports/Отчёт/Ext/Template.xml","operation":"add-field","value":"{\"Field\":\"Контрагент\"}"}'
```

---

### `skd.validate`

Валидирует Template.xml и возвращает счётчики ошибок/предупреждений.

**Params:**
```ts
{
  templatePath: string;  // Путь к Template.xml, папке СКД или дескриптору (обязателен)
  detailed?: boolean;    // Детальный вывод, включая [OK]-строки
  maxErrors?: number;    // Максимум ошибок до остановки (по умолчанию 20)
  outFile?: string;      // Путь к выходному файлу отчёта
}
```

**Result:** `{ valid: boolean, errorCount: number, warningCount: number, rawOutput: string }`

```bash
bash "$HELPER" skd.validate '{"templatePath":"C:/conf/Reports/Отчёт/Ext/Template.xml"}'
bash "$HELPER" skd.validate '{"templatePath":"C:/conf/Reports/Отчёт/Ext/Template.xml","detailed":true}'
```

---

## Типичные сценарии

### Сценарий A: проверить что объект существует

```bash
bash "$HELPER" listObjects '{"type":"Catalog"}'
# В data.objects ищем нужный
```

### Сценарий B: создать объект и проверить YAML

```bash
bash "$HELPER" createObject '{"type":"Catalog","name":"Тестовый"}'
bash "$HELPER" getYaml '{"path":"Catalog.Тестовый"}'
```

### Сценарий C: end-to-end debug session

```bash
# 1. Запустить
SESSION=$(bash "$HELPER" debug.start '{...}' | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).data.sessionId)")

# 2. Поставить BP
bash "$HELPER" debug.setBreakpoint '{"file":"...","line":10}'

# 3. Дождаться hit
STOP=$(bash "$HELPER" debug.waitForStop "{\"sessionId\":\"$SESSION\"}")

# 4. Прочитать переменные top frame
SCOPES=$(bash "$HELPER" debug.getScopes "{\"sessionId\":\"$SESSION\",\"frameId\":1}")

# 5. Продолжить
bash "$HELPER" debug.continue "{\"sessionId\":\"$SESSION\",\"threadId\":1}"

# 6. Остановить
bash "$HELPER" debug.stop "{\"sessionId\":\"$SESSION\"}"
```

### Сценарий D: end-to-end debug + forms (веб-клиент через ibsrv debug-сессии)

```bash
# 1. Запустить отладочную сессию с веб-сервером
SESSION=$(bash "$HELPER" debug.start '{
  "rootProject":"C:/reps/myconf",
  "infobase":"File=C:/bases/mybase",
  "platformPath":"C:/Program Files/1cv8/8.3.24/bin"
}' | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).data.sessionId)")

# 2. Узнать URL ibsrv из debug-сессии (через resolveBinding или из debug.start result)
IBSRV_URL="http://localhost:8080/mybase"

# 3. Подключить веб-клиент к тому же ibsrv
bash "$HELPER" forms.start "{\"url\":\"$IBSRV_URL\"}"

# 4. Выполнить скрипт в браузере (например, получить заголовок формы)
bash "$HELPER" forms.exec '{"script":"return document.querySelector(\".v8-form-title\")?.textContent ?? \"\"","timeoutMs":10000}'

# 5. Сделать скриншот для диагностики
bash "$HELPER" forms.shot '{"file":"C:/tmp/form-state.png"}'

# 6. Остановить веб-клиент
bash "$HELPER" forms.stop '{}'

# 7. Остановить отладочную сессию
bash "$HELPER" debug.stop "{\"sessionId\":\"$SESSION\"}"
```
