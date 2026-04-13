---
name: 1c-forms
description: Работа с формами 1С в режиме предприятия через веб-клиент — навигация, чтение, заполнение, табличные части, отчёты
argument-hint: "действие и параметры"
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
---

# /1c-forms — Agent API for 1C enterprise forms

Слой агентского API для работы с формами 1С в режиме предприятия. Использует Playwright + веб-клиент 1С. Построен поверх web-test движка (cc-1c-skills).

## Использование

```bash
bash .claude/skills/1c-forms/scripts/call.sh <command> [args...]
```

## Команды

### Запуск и подключение

```bash
# Передай путь к ИБ — ibsrv поднимется автоматически:
bash .claude/skills/1c-forms/scripts/call.sh start "C:/Users/Максим/Documents/InfoBase11"
# → автопоиск ibsrv.exe → запуск на свободном порту → Playwright → web client
# → { "ok": true, "port": 54321, "sections": [...] }

# Если ibsrv/Apache уже запущен — передай URL:
bash .claude/skills/1c-forms/scripts/call.sh start http://localhost:8314/

# Выполнить скрипт в запущенной сессии
bash .claude/skills/1c-forms/scripts/call.sh exec '<javascript>'

# One-shot: поднять ibsrv + выполнить скрипт + всё остановить
bash .claude/skills/1c-forms/scripts/call.sh run "C:/path/to/ib" '<script>'

# Скриншот
bash .claude/skills/1c-forms/scripts/call.sh shot [file.png]

# Статус
bash .claude/skills/1c-forms/scripts/call.sh status

# Остановить всё (браузер + ibsrv)
bash .claude/skills/1c-forms/scripts/call.sh stop
```

### Target resolution

| Аргумент | Что происходит |
|----------|---------------|
| `http://localhost:8314/` | Используется как есть — ibsrv/Apache уже запущен |
| `C:/Users/.../InfoBase11` | Автозапуск ibsrv на свободном порту, подключение через Playwright |

ibsrv переиспользуется между вызовами (session file). `stop` убивает и браузер, и ibsrv.

## Выполнение скриптов

Все функции browser.mjs доступны как глобальные. `console.log()` попадает в JSON-ответ.

```bash
# Inline скрипт (предпочтительно для коротких операций):
bash .claude/skills/1c-forms/scripts/call.sh exec 'const f = await getFormState(); console.log(JSON.stringify(f, null, 2));'

# Многострочный скрипт через heredoc:
cat <<'SCRIPT' | bash .claude/skills/1c-forms/scripts/call.sh exec -
await navigateSection('Продажи');
await openCommand('Заказы клиентов');
const form = await getFormState();
console.log(JSON.stringify(form, null, 2));
SCRIPT
```

## API reference

### Навигация

| Функция | Возвращает | Описание |
|---------|-----------|----------|
| `navigateSection(name)` | `{ navigated, sections, commands }` | Перейти в раздел (fuzzy match) |
| `openCommand(name)` | form state | Открыть команду из панели функций |
| `navigateLink(url)` | form state | Открыть объект по пути метаданных (e1cib) |
| `openFile(path)` | form state | Открыть EPF/ERF (с обработкой диалога безопасности) |
| `switchTab(name)` | form state | Переключиться на открытую вкладку |

Примеры путей для `navigateLink`: `'Документ.ЗаказКлиента'`, `'Справочник.Контрагенты'`, `'РегистрНакопления.Товары'`

### Чтение состояния формы

| Функция | Возвращает | Описание |
|---------|-----------|----------|
| `getFormState()` | `{ form, fields, buttons, tables, ... }` | Полное состояние текущей формы |
| `readTable({ maxRows?, offset?, table? })` | `{ columns, rows, total }` | Данные таблицы с пагинацией |
| `readSpreadsheet()` | `{ title, headers, data, totals }` | Данные отчёта (СКД) |
| `getSections()` | `{ activeSection, sections, commands }` | Панель разделов |

**getFormState() поля:**
- `form` — номер активной формы (null = рабочий стол)
- `fields` — массив: `{ name, value, label?, actions?, required? }`
- `buttons` — кнопки формы
- `tables` — все таблицы: `{ name, columns, rowCount, label? }`
- `navigation` — панель навигации формы
- `filters` — активные фильтры
- `reportSettings` — настройки отчёта (СКД)
- `errorModal` — модальная ошибка 1С (если есть)
- `confirmation` — диалог Да/Нет (если есть)

### Действия

| Функция | Описание |
|---------|----------|
| `clickElement(text, opts?)` | Клик по кнопке/ссылке/строке (fuzzy). `{ dblclick: true }` — двойной клик, `{ expand: true }` — свернуть/развернуть дерево, `{ table: 'Имя' }` — кнопка у конкретной таблицы |
| `fillFields({ name: value })` | Заполнить поля формы. Авто-определение типа: текст (paste), справочник (typeahead), чекбокс (toggle), радио (click) |
| `selectValue(field, search, opts?)` | Выбрать значение из справочника. `{ type: '...' }` — для составных типов |
| `fillTableRow(fields, opts)` | Заполнить строку ТЧ. `{ add: true }` — добавить строку, `{ row: N }` — редактировать, `{ table: 'Имя' }` — конкретная таблица |
| `deleteTableRow(row, opts?)` | Удалить строку ТЧ по индексу |
| `closeForm({ save? })` | Закрыть форму. `{ save: false }` — без сохранения, `{ save: true }` — с сохранением |
| `filterList(text, opts?)` | Фильтр списка. `{ field: 'Имя' }` — по конкретному полю |
| `unfilterList(opts?)` | Снять фильтры |

### Утилиты

| Функция | Описание |
|---------|----------|
| `screenshot()` | PNG скриншот |
| `wait(seconds)` | Ожидание с возвратом form state |

## Типичные сценарии

### Создать и провести документ

```bash
cat <<'SCRIPT' | bash .claude/skills/1c-forms/scripts/call.sh exec -
await navigateSection('Продажи');
await openCommand('Заказы клиентов');
await clickElement('Создать');
await fillFields({ 'Организация': 'Конфетпром', 'Контрагент': 'Альфа' });
await fillTableRow({ 'Номенклатура': 'Бумага', 'Количество': '10' }, { tab: 'Товары', add: true });
await clickElement('Провести и закрыть');
SCRIPT
```

### Прочитать список справочника

```bash
cat <<'SCRIPT' | bash .claude/skills/1c-forms/scripts/call.sh exec -
await navigateLink('Справочник.Контрагенты');
const t = await readTable({ maxRows: 50 });
console.log(JSON.stringify(t, null, 2));
SCRIPT
```

### Сформировать отчёт

```bash
cat <<'SCRIPT' | bash .claude/skills/1c-forms/scripts/call.sh exec -
await navigateLink('Отчет.ОстаткиТоваров');
await fillFields({ 'Склад': 'Основной склад' });
await clickElement('Сформировать');
await wait(5);
const report = await readSpreadsheet();
console.log(JSON.stringify(report, null, 2));
SCRIPT
```

## Формат ответа

```json
{ "ok": true, "output": "...console.log output...", "elapsed": 3.2 }
```

При ошибке (авто-скриншот):
```json
{ "ok": false, "error": "Element not found", "screenshot": "error-shot.png", "elapsed": 1.5 }
```

## Интеграция с /cdt-agent

Два API дополняют друг друга:
- `/cdt-agent` — работа с метаданными конфигурации (XML на диске, конфигуратор)
- `/1c-forms` — работа с данными и формами (веб-клиент, режим предприятия)

### Резолвинг базы по фикстуре

Если нужно узнать путь к базе по имени фикстуры — используй `resolveBinding` через bridge:

```bash
# По имени фикстуры:
bash .claude/skills/cdt-agent/scripts/call.sh resolveBinding '{"configPath":"uh"}'
# → { "success": true, "data": { "infobase": { "type": "file", "filePath": "C:/Users/.../DemoERPUH" } } }

# Список всех привязок:
bash .claude/skills/cdt-agent/scripts/call.sh listBindings '{}'
# → массив привязок с резолвленными инфобазами
```

### Полный цикл: фикстура → база → ibsrv → форма

```bash
# 1. Узнать путь к базе по фикстуре
RESULT=$(bash .claude/skills/cdt-agent/scripts/call.sh resolveBinding '{"configPath":"uh"}')
# Извлечь filePath из JSON

# 2. Запустить ibsrv + Playwright (автоматически)
bash .claude/skills/1c-forms/scripts/call.sh start "$FILE_PATH"

# 3. Работать с формами
bash .claude/skills/1c-forms/scripts/call.sh exec 'await navigateSection("Продажи");'
```

### Простой цикл

1. `/cdt-agent createObject` — создать новый справочник в конфигурации
2. `/cdt-agent deploy` — загрузить в базу
3. `/1c-forms exec` — открыть форму, создать элемент, проверить

## Важно

- **Headed mode** — 1С требует видимый браузер, headless не работает
- **Запуск 30-60с** — первое подключение к 1С долгое (встроено в `start`)
- **Fuzzy match** — все поиски по имени: exact > startsWith > includes
- **Кириллица** — ввод через clipboard paste (Ctrl+V), корректно срабатывают события 1С
- **Неразрывные пробелы** — 1С использует `\u00a0`, нормализация встроена
- **Макс 2 попытки** — если операция не сработала дважды одним способом, пробуй другой или сообщай пользователю
