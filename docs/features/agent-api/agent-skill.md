# CDT 41 Agent API — Skill Reference

Расширение CDT 41 для VS Code предоставляет набор команд для программного управления метаданными конфигурации 1С:Предприятие. Команды вызываются через `vscode.commands.executeCommand`.

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

## Типичный сценарий агента

```
1. listObjects({ type: 'Catalog' })              → узнать что есть
2. createObject({ type: 'Catalog', name: 'Товары' })  → создать справочник
3. addAttribute({ path: 'Catalog.Товары', name: 'Артикул' })
4. addAttribute({ path: 'Catalog.Товары', name: 'Цена' })
5. addTabularSection({ path: 'Catalog.Товары', name: 'Штрихкоды' })
6. addTabularSectionColumn({ path: 'Catalog.Товары.TabularSection.Штрихкоды', name: 'Код' })
7. getYaml({ path: 'Catalog.Товары' })           → проверить результат
```

## Ограничения

- Формы через Agent API не создаются/редактируются (используйте UI)
- `setProperties` работает только для корневых объектов (не для реквизитов)
- Для InformationRegister и AccumulationRegister при `createObject` создаются дефолтные Измерение+Ресурс (шаблонный fallback)
- Тип реквизита при `addAttribute` задаётся дефолтный; для изменения типа используйте UI (TypeEditor)
