---
name: skd
description: Создание, анализ и редактирование СКД (DataCompositionSchema) — JSON DSL компиляция, валидация, точечное редактирование, анализ структуры
argument-hint: "compile|info|edit|validate + параметры"
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
---

# /skd — Работа с СКД (DataCompositionSchema)

Четыре операции над схемами компоновки данных 1С. Построен поверх cc-1c-skills.

## Использование

```bash
bash .claude/skills/skd/scripts/call.sh <command> [args...]
```

## Команды

### compile — создать СКД из JSON DSL

Генерирует Template.xml из компактного JSON-определения.

```bash
# Из файла:
bash .claude/skills/skd/scripts/call.sh compile -DefinitionFile schema.json -OutputPath Template.xml

# Из inline JSON:
bash .claude/skills/skd/scripts/call.sh compile -Value '{"dataSets":[{"query":"ВЫБРАТЬ 1","fields":["Поле1"]}]}' -OutputPath Template.xml
```

#### JSON DSL — краткий справочник

**Корневая структура:**
```json
{
  "dataSets": [...],           // обязательно
  "calculatedFields": [...],   // вычисляемые поля
  "totalFields": [...],        // итоги/ресурсы
  "parameters": [...],         // параметры схемы
  "settingsVariants": [...]    // варианты настроек
}
```

**Поля — shorthand:**
```
"Наименование"                                    — просто имя
"Количество: decimal(15,2)"                        — имя + тип
"Организация: CatalogRef.Организации @dimension"   — + роль
"Служебное: string #noFilter #noOrder"             — + ограничения
```

**Типы:** `string`, `string(N)`, `decimal(D,F)`, `boolean`, `date`, `dateTime`, `StandardPeriod`, `CatalogRef.X`, `DocumentRef.X`, `EnumRef.X`
**Синонимы:** `число`=decimal, `строка`=string, `булево`=boolean, `дата`=date, `СправочникСсылка.X`=CatalogRef.X
**Роли:** `@dimension`, `@account`, `@balance`, `@period`
**Ограничения:** `#noField`, `#noFilter`, `#noGroup`, `#noOrder`

**Итоги — shorthand:**
```json
"Количество: Сумма"                // → Сумма(Количество)
"Стоимость: Сумма(Кол * Цена)"     // произвольное выражение
```

**Параметры — shorthand:**
```json
"Период: StandardPeriod = LastMonth @autoDates"   // авто ДатаНачала/ДатаОкончания
"Организация: CatalogRef.Организации"
```

**Варианты настроек:**
```json
{
  "name": "Основной",
  "settings": {
    "selection": ["Организация", "Количество", "Сумма", "Auto"],
    "filter": ["Организация = _ @off @user"],
    "dataParameters": ["Период = LastMonth @user"],
    "structure": "Организация > details"
  }
}
```

#### Полный пример

```json
{
  "dataSets": [{
    "query": "ВЫБРАТЬ Продажи.Номенклатура, Продажи.Количество, Продажи.Сумма ИЗ РегистрНакопления.Продажи КАК Продажи",
    "fields": [
      "Номенклатура: CatalogRef.Номенклатура @dimension",
      "Количество: decimal(15,3)",
      "Сумма: decimal(15,2)"
    ]
  }],
  "totalFields": ["Количество: Сумма", "Сумма: Сумма"],
  "parameters": ["Период: StandardPeriod = LastMonth @autoDates"],
  "settingsVariants": [{
    "name": "Основной",
    "settings": {
      "selection": ["Номенклатура", "Количество", "Сумма", "Auto"],
      "filter": ["Организация = _ @off @user"],
      "dataParameters": ["Период = LastMonth @user"],
      "structure": "Номенклатура > details"
    }
  }]
}
```

---

### info — анализ существующей СКД

Компактная сводка структуры СКД. Заменяет чтение тысяч строк XML.

```bash
# Общий обзор:
bash .claude/skills/skd/scripts/call.sh info Template.xml

# Текст запроса набора данных:
bash .claude/skills/skd/scripts/call.sh info Template.xml -Mode query -Name НаборДанных1

# Все поля:
bash .claude/skills/skd/scripts/call.sh info Template.xml -Mode fields

# Параметры:
bash .claude/skills/skd/scripts/call.sh info Template.xml -Mode params

# Вариант настроек:
bash .claude/skills/skd/scripts/call.sh info Template.xml -Mode variant -Name Основной

# Полная сводка:
bash .claude/skills/skd/scripts/call.sh info Template.xml -Mode full
```

**Режимы:** `overview` (default), `query`, `fields`, `links`, `calculated`, `resources`, `params`, `variant`, `templates`, `trace`, `full`

---

### edit — точечное редактирование СКД

25 атомарных операций для модификации Template.xml без перегенерации.

```bash
# Добавить поле:
bash .claude/skills/skd/scripts/call.sh edit Template.xml -Op add-field -DataSet НаборДанных1 -Field "НовоеПоле: decimal(15,2)"

# Добавить параметр:
bash .claude/skills/skd/scripts/call.sh edit Template.xml -Op add-param -Name Организация -Type "CatalogRef.Организации"

# Добавить ресурс:
bash .claude/skills/skd/scripts/call.sh edit Template.xml -Op add-resource -DataPath Количество -Expression "Сумма(Количество)"

# Изменить запрос:
bash .claude/skills/skd/scripts/call.sh edit Template.xml -Op set-query -DataSet НаборДанных1 -Value "ВЫБРАТЬ ..."
```

---

### validate — проверка СКД

~30 проверок корректности XML.

```bash
bash .claude/skills/skd/scripts/call.sh validate Template.xml
```

---

## Интеграция с Agent API

Типичный workflow создания отчёта:

```bash
# 1. Создать объект Report в конфигурации
bash .claude/skills/cdt-agent/scripts/call.sh createObject '{"type":"Report","name":"ОстаткиТоваров"}'

# 2. Скомпилировать СКД из JSON DSL
bash .claude/skills/skd/scripts/call.sh compile -Value '{"dataSets":[...]}' \
  -OutputPath "FormatSamples/uh/Reports/ОстаткиТоваров/Templates/ОсновнаяСхемаКомпоновкиДанных/Ext/Template.xml"

# 3. Deploy в базу
bash .claude/skills/cdt-agent/scripts/call.sh deploy '{}'

# 4. Проверить в enterprise mode
bash .claude/skills/1c-forms/scripts/call.sh start "C:/path/to/ib"
bash .claude/skills/1c-forms/scripts/call.sh exec 'await navigateLink("Отчет.ОстаткиТоваров"); await clickElement("Сформировать"); await wait(5); const r = await readSpreadsheet(); console.log(JSON.stringify(r));'
```

## Важно

- JSON DSL поддерживает русские синонимы типов (число, строка, дата и т.д.)
- Ссылочные типы (CatalogRef.X) требуют базу с соответствующей конфигурацией при сборке EPF
- `@autoDates` автоматически генерирует ДатаНачала/ДатаОкончания из параметра Период
- Запросы можно вынести в .sql файлы: `"query": "@queries/sales.sql"`
