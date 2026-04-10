# CDT 41 Agent API — Skill Reference

Расширение CDT 41 для VS Code предоставляет 28 команд для программного управления метаданными и отладкой конфигурации 1С:Предприятие. Команды вызываются через `vscode.commands.executeCommand`.

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

Запуск отладочной сессии (dbgs.exe + 1cv8c.exe).

```json
{
  "rootProject": "C:/reps/project/conf",
  "infobase": "File=C:/Users/User/Documents/InfoBase",
  "platformPath": "C:/Program Files/1cv8/8.3.27.1859/bin"
}
```

Возвращает: `{ sessionId: string }`.

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

### Сценарий B: отладка

```
1. debug.start({ rootProject: '...', infobase: 'File=...', platformPath: '...' })
2. debug.setBreakpoint({ file: '...ObjectModule.bsl', line: 5 })
3. debug.waitForStop({ sessionId: '...' })         → дождаться breakpoint
4. debug.getScopes({ sessionId: '...', frameId: 1 })
5. debug.getVariables({ sessionId: '...', varRef: 1 })  → прочитать переменные
6. debug.continue({ sessionId: '...', threadId: 1 })
7. debug.stop({ sessionId: '...' })
```

## Ограничения

- Формы через Agent API не создаются/редактируются (используйте UI)
- Для InformationRegister и AccumulationRegister при `createObject` создаются дефолтные Измерение+Ресурс (шаблонный fallback)
- Тип реквизита при `addAttribute` задаётся дефолтный (строка 50); для изменения используйте `setProperties` с `Type: "cfg:DocumentRef.Больше"` или `Type: "xs:boolean"` и т.д.
