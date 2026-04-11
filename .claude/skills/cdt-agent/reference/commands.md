# CDT Agent API — Полный reference

30 команд через `bash .claude/skills/cdt-agent/scripts/call.sh <suffix> '<args>'`.

Все команды возвращают `AgentResult<T>`:
- Успех: `{"success": true, "data": {...}}` или `{"success": true}`
- Ошибка: `{"success": false, "error": "..."}`

## Содержание

- [CRUD метаданных (12 команд)](#crud-метаданных)
- [Привязки (2 команды)](#привязки)
- [Debug (14 команд)](#debug)
- [Deploy (1 команда)](#deploy)

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
bash .claude/skills/cdt-agent/scripts/call.sh createObject '{"type":"Catalog","name":"Контрагенты","synonym":"Контрагенты"}'
```

---

### `getYaml`

Возвращает YAML-представление объекта (компактнее XML, удобно для агентов).

**Params:** `{ path: string }` — например `"Catalog.Контрагенты"`
**Result:** `{ yaml: string }`

```bash
bash .claude/skills/cdt-agent/scripts/call.sh getYaml '{"path":"Catalog.Контрагенты"}'
```

---

### `listObjects`

Список объектов конфигурации, опционально фильтрованный по типу.

**Params:** `{ type?: string }` — если не задан, возвращает все объекты
**Result:** `{ objects: Array<{ type, name, filePath }> }`

```bash
# Все объекты
bash .claude/skills/cdt-agent/scripts/call.sh listObjects '{}'

# Только справочники
bash .claude/skills/cdt-agent/scripts/call.sh listObjects '{"type":"Catalog"}'
```

---

### `getProperties`

Возвращает свойства объекта (или вложенного элемента — реквизита, табличной части).

**Params:** `{ path: string }`
**Result:** `{ properties: Record<string, unknown> }`

```bash
bash .claude/skills/cdt-agent/scripts/call.sh getProperties '{"path":"Catalog.Контрагенты"}'
bash .claude/skills/cdt-agent/scripts/call.sh getProperties '{"path":"Catalog.Контрагенты.Attribute.ИНН"}'
```

---

### `addAttribute`

Добавляет реквизит к объекту.

**Params:** `{ path: string, name: string }`
**Result:** `{ filePath: string }`

```bash
bash .claude/skills/cdt-agent/scripts/call.sh addAttribute '{"path":"Catalog.Контрагенты","name":"ИНН"}'
```

---

### `addTabularSection`

Добавляет табличную часть к объекту.

**Params:** `{ path: string, name: string }`
**Result:** `{ filePath: string }`

```bash
bash .claude/skills/cdt-agent/scripts/call.sh addTabularSection '{"path":"Document.ЗаказПокупателя","name":"Товары"}'
```

---

### `addTabularSectionColumn`

Добавляет колонку (реквизит) в табличную часть.

**Params:** `{ path: string, name: string }` — путь вида `Document.X.TabularSection.Y`
**Result:** `{ filePath: string }`

```bash
bash .claude/skills/cdt-agent/scripts/call.sh addTabularSectionColumn '{"path":"Document.ЗаказПокупателя.TabularSection.Товары","name":"Количество"}'
```

---

### `deleteAttribute`

Удаляет реквизит.

**Params:** `{ path: string }` — например `"Catalog.X.Attribute.Y"`
**Result:** `void`

```bash
bash .claude/skills/cdt-agent/scripts/call.sh deleteAttribute '{"path":"Catalog.Контрагенты.Attribute.ИНН"}'
```

---

### `deleteTabularSection`

Удаляет табличную часть.

**Params:** `{ path: string }` — например `"Document.X.TabularSection.Y"`
**Result:** `void`

```bash
bash .claude/skills/cdt-agent/scripts/call.sh deleteTabularSection '{"path":"Document.ЗаказПокупателя.TabularSection.Товары"}'
```

---

### `deleteObject`

Удаляет объект конфигурации.

**Params:** `{ path: string }` — например `"Catalog.Тестовый"`
**Result:** `void`

```bash
bash .claude/skills/cdt-agent/scripts/call.sh deleteObject '{"path":"Catalog.Тестовый"}'
```

---

### `renameObject`

Переименовывает объект.

**Params:** `{ path: string, newName: string }`
**Result:** `void`

```bash
bash .claude/skills/cdt-agent/scripts/call.sh renameObject '{"path":"Catalog.Старое","newName":"Новое"}'
```

---

### `setProperties`

Устанавливает свойства объекта (merge с существующими).

**Params:** `{ path: string, properties: object }`
**Result:** `void`

```bash
bash .claude/skills/cdt-agent/scripts/call.sh setProperties '{"path":"Catalog.Контрагенты","properties":{"Synonym":"Партнёры"}}'
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
bash .claude/skills/cdt-agent/scripts/call.sh resolveBinding '{"configPath":"uh"}'
# → { "success": true, "data": { "infobase": { "type": "file", "filePath": "C:/Users/.../DemoERPUH", ... } } }
```

---

### `listBindings`

Все привязки с резолвленными инфобазами.

**Params:** нет (пустой объект `{}`)

**Result:** массив `[{ configRelativePath, workspaceFolder, infobaseCount, infobases: [...] }]`

**Пример:**
```bash
bash .claude/skills/cdt-agent/scripts/call.sh listBindings '{}'
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
bash .claude/skills/cdt-agent/scripts/call.sh debug.start '{
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
bash .claude/skills/cdt-agent/scripts/call.sh debug.stop '{"sessionId":"abc-123"}'
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
bash .claude/skills/cdt-agent/scripts/call.sh debug.setBreakpoint '{"file":"C:/conf/CommonModules/Module/Ext/Module.bsl","line":42}'

# С условием и хит-каунтом
bash .claude/skills/cdt-agent/scripts/call.sh debug.setBreakpoint '{
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
bash .claude/skills/cdt-agent/scripts/call.sh debug.clearBreakpoints '{}'

# Только в файле
bash .claude/skills/cdt-agent/scripts/call.sh debug.clearBreakpoints '{"file":"C:/conf/CommonModules/Module/Ext/Module.bsl"}'
```

---

### `debug.setExceptionFilter`

Включает/выключает остановку при исключениях, опционально с фильтром по подстроке.

**Params:** `{ sessionId: string, enabled: boolean, substring?: string }`
**Result:** `void`

```bash
# Включить с фильтром
bash .claude/skills/cdt-agent/scripts/call.sh debug.setExceptionFilter '{"sessionId":"abc","enabled":true,"substring":"Деление на ноль"}'

# Включить без фильтра — на всё
bash .claude/skills/cdt-agent/scripts/call.sh debug.setExceptionFilter '{"sessionId":"abc","enabled":true}'

# Выключить
bash .claude/skills/cdt-agent/scripts/call.sh debug.setExceptionFilter '{"sessionId":"abc","enabled":false}'
```

---

### `debug.waitForStop`

Ждёт остановку отладчика (BP/exception/step). Возвращает информацию о top frame сразу — не нужно вызывать getStackTrace отдельно для базового случая.

**Params:** `{ sessionId: string, timeoutMs?: number }` — таймаут default 30000
**Result:** `{ reason, threadId, frameId, file, line }`

`reason`: `'breakpoint'` | `'step'` | `'exception'` | `'pause'`

```bash
bash .claude/skills/cdt-agent/scripts/call.sh debug.waitForStop '{"sessionId":"abc","timeoutMs":30000}'
```

---

### `debug.getStackTrace`

Возвращает полный стек вызовов потока.

**Params:** `{ sessionId: string, threadId: number }`
**Result:** `{ frames: Array<{ id, name, file, line }> }`

```bash
bash .claude/skills/cdt-agent/scripts/call.sh debug.getStackTrace '{"sessionId":"abc","threadId":1}'
```

---

### `debug.getScopes`

Возвращает scope'ы (области видимости) для фрейма. У 1С обычно одна — "Локальные".

**Params:** `{ sessionId: string, frameId: number }`
**Result:** `{ scopes: Array<{ name, varRef }> }`

```bash
bash .claude/skills/cdt-agent/scripts/call.sh debug.getScopes '{"sessionId":"abc","frameId":1}'
```

---

### `debug.getVariables`

Возвращает переменные по varRef (из scopes или из дочернего объекта). Для drilldown — рекурсивно вызывать с varRef ребёнка.

**Params:** `{ sessionId: string, varRef: number }`
**Result:** `{ vars: Array<{ name, type, value, varRef }> }`

`varRef === 0` означает примитив (нет дочерних элементов).

```bash
# Корневой scope
bash .claude/skills/cdt-agent/scripts/call.sh debug.getVariables '{"sessionId":"abc","varRef":1}'

# Раскрыть массив (varRef из предыдущего ответа)
bash .claude/skills/cdt-agent/scripts/call.sh debug.getVariables '{"sessionId":"abc","varRef":42}'
```

---

### `debug.evaluate`

Вычисляет BSL-выражение в контексте фрейма.

**Params:** `{ sessionId: string, expression: string, frameId?: number }`
**Result:** `{ value, type, varRef }`

```bash
bash .claude/skills/cdt-agent/scripts/call.sh debug.evaluate '{"sessionId":"abc","expression":"Массив.Количество()","frameId":1}'
```

---

### `debug.continue`

Продолжает выполнение после остановки.

**Params:** `{ sessionId: string, threadId: number }`
**Result:** `void`

```bash
bash .claude/skills/cdt-agent/scripts/call.sh debug.continue '{"sessionId":"abc","threadId":1}'
```

---

### `debug.stepOver`

Шаг через строку (step over) — не заходит в вызовы.

**Params:** `{ sessionId: string, threadId: number }`
**Result:** `void`

```bash
bash .claude/skills/cdt-agent/scripts/call.sh debug.stepOver '{"sessionId":"abc","threadId":1}'
```

---

### `debug.stepIn`

Шаг внутрь вызова процедуры/функции.

**Params:** `{ sessionId: string, threadId: number }`
**Result:** `void`

```bash
bash .claude/skills/cdt-agent/scripts/call.sh debug.stepIn '{"sessionId":"abc","threadId":1}'
```

---

### `debug.stepOut`

Шаг наружу — выйти из текущей процедуры до её вызывающей.

**Params:** `{ sessionId: string, threadId: number }`
**Result:** `void`

```bash
bash .claude/skills/cdt-agent/scripts/call.sh debug.stepOut '{"sessionId":"abc","threadId":1}'
```

---

## Типичные сценарии

### Сценарий A: проверить что объект существует

```bash
bash .claude/skills/cdt-agent/scripts/call.sh listObjects '{"type":"Catalog"}'
# В data.objects ищем нужный
```

### Сценарий B: создать объект и проверить YAML

```bash
bash .claude/skills/cdt-agent/scripts/call.sh createObject '{"type":"Catalog","name":"Тестовый"}'
bash .claude/skills/cdt-agent/scripts/call.sh getYaml '{"path":"Catalog.Тестовый"}'
```

### Сценарий C: end-to-end debug session

```bash
# 1. Запустить
SESSION=$(bash .claude/skills/cdt-agent/scripts/call.sh debug.start '{...}' | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).data.sessionId)")

# 2. Поставить BP
bash .claude/skills/cdt-agent/scripts/call.sh debug.setBreakpoint '{"file":"...","line":10}'

# 3. Дождаться hit
STOP=$(bash .claude/skills/cdt-agent/scripts/call.sh debug.waitForStop "{\"sessionId\":\"$SESSION\"}")

# 4. Прочитать переменные top frame
SCOPES=$(bash .claude/skills/cdt-agent/scripts/call.sh debug.getScopes "{\"sessionId\":\"$SESSION\",\"frameId\":1}")

# 5. Продолжить
bash .claude/skills/cdt-agent/scripts/call.sh debug.continue "{\"sessionId\":\"$SESSION\",\"threadId\":1}"

# 6. Остановить
bash .claude/skills/cdt-agent/scripts/call.sh debug.stop "{\"sessionId\":\"$SESSION\"}"
```
