# Формат файла .v8i — Спецификация

> Формат списка информационных баз 1С:Предприятие

## 1. Общее описание

Файл `.v8i` — INI-подобный текстовый файл, содержащий список информационных баз.  
Используется для:
- Экспорта/импорта списка баз между компьютерами
- Публикации списка баз на веб-сервере
- Резервного копирования настроек подключения

---

## 2. Кодировка

| Источник | Кодировка |
|----------|-----------|
| Windows GUI | UTF-16 LE с BOM |
| Ручное создание | UTF-8 (с BOM или без) |
| Веб-публикация | UTF-8 |

**Рекомендация для парсера:** определять кодировку по BOM, fallback на UTF-8.

```typescript
function detectEncoding(buffer: Buffer): BufferEncoding {
  // UTF-16 LE BOM: FF FE
  if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
    return 'utf16le';
  }
  // UTF-8 BOM: EF BB BF
  if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return 'utf8';
  }
  // Default to UTF-8
  return 'utf8';
}
```

---

## 3. Структура файла

### 3.1 Общий формат

```ini
[Имя базы 1]
Ключ1=Значение1
Ключ2=Значение2

[Имя базы 2]
Ключ1=Значение1
```

### 3.2 Обязательные поля

| Поле | Описание | Пример |
|------|----------|--------|
| `[Секция]` | Отображаемое имя базы | `[Демо УТ]` |
| `Connect` | Строка подключения | `File="C:\Bases\Demo";` |

### 3.3 Опциональные поля

| Поле | Описание | Пример |
|------|----------|--------|
| `ID` | UUID базы | `a1b2c3d4-e5f6-...` |
| `OrderInList` | Порядок в списке | `1` |
| `OrderInTree` | Порядок в дереве | `1` |
| `Folder` | Папка в дереве | `/Разработка` |
| `App` | Приложение по умолчанию | `Auto`, `ThinClient`, `WebClient` |
| `WA` | Web-приложение | `1` |
| `Version` | Версия платформы | `8.3.27` |
| `ClientConnectionSpeed` | Скорость соединения | `Normal`, `Low` |
| `DefaultApp` | Приложение | `Auto` |

---

## 4. Строка подключения (Connect)

### 4.1 Файловая база

```ini
Connect=File="C:\Bases\Demo_UT";
```

С пользователем:
```ini
Connect=File="C:\Bases\Demo_UT";Usr="Администратор";
```

### 4.2 Серверная база

```ini
Connect=Srvr="server1c";Ref="Demo_UT";
```

С пользователем и паролем:
```ini
Connect=Srvr="server1c";Ref="Demo_UT";Usr="Admin";Pwd="secret";
```

### 4.3 Веб-клиент

```ini
Connect=ws="http://server/demo";
```

### 4.4 Парсинг строки подключения

```typescript
interface ConnectionParams {
  type: 'file' | 'server' | 'web';
  file?: string;
  server?: string;
  ref?: string;
  user?: string;
  password?: string;
  webService?: string;
}

function parseConnectString(connect: string): ConnectionParams {
  const params: Record<string, string> = {};
  
  // Regex для пар ключ="значение" или ключ=значение
  const regex = /(\w+)=(?:"([^"]*)"|([^;]*))/g;
  let match;
  
  while ((match = regex.exec(connect)) !== null) {
    const key = match[1].toLowerCase();
    const value = match[2] ?? match[3];
    params[key] = value;
  }
  
  if (params.file) {
    return { type: 'file', file: params.file, user: params.usr };
  }
  if (params.srvr) {
    return {
      type: 'server',
      server: params.srvr,
      ref: params.ref,
      user: params.usr,
      password: params.pwd
    };
  }
  if (params.ws) {
    return { type: 'web', webService: params.ws };
  }
  
  throw new Error('Unknown connection type');
}
```

---

## 5. Примеры файлов

### 5.1 Минимальный файл

```ini
[Демо база]
Connect=File="C:\Bases\Demo";
```

### 5.2 Полный файл с несколькими базами

```ini
[Демо УТ]
Connect=File="C:\Bases\Demo_UT";
ID=a1b2c3d4-e5f6-7890-abcd-ef1234567890
OrderInList=1
Folder=/Разработка
App=Auto

[Тестовая ERP]
Connect=File="C:\Bases\Test_ERP";
ID=b2c3d4e5-f6a7-8901-bcde-f12345678901
OrderInList=2
Folder=/Разработка
App=ThinClient

[Продуктив ERP]
Connect=Srvr="server1c.company.local";Ref="Prod_ERP";
ID=c3d4e5f6-a7b8-9012-cdef-123456789012
OrderInList=3
Folder=/Продуктив
App=Auto
ClientConnectionSpeed=Normal

[Веб-демо]
Connect=ws="https://demo.company.com/demo";
ID=d4e5f6a7-b8c9-0123-defa-234567890123
OrderInList=4
WA=1
```

### 5.3 С папками (иерархия)

```ini
[Разработка/Демо УТ]
Connect=File="C:\Bases\Demo_UT";
Folder=/Разработка

[Разработка/Тест ERP]
Connect=File="C:\Bases\Test_ERP";
Folder=/Разработка

[Продуктив/ERP]
Connect=Srvr="server1c";Ref="Prod_ERP";
Folder=/Продуктив
```

---

## 6. Парсер для TypeScript

### 6.1 Интерфейсы

```typescript
interface V8iEntry {
  name: string;
  connect: string;
  connectionParams: ConnectionParams;
  id?: string;
  orderInList?: number;
  orderInTree?: number;
  folder?: string;
  app?: 'Auto' | 'ThinClient' | 'ThickClient' | 'WebClient';
  version?: string;
  clientConnectionSpeed?: 'Normal' | 'Low';
}

interface V8iParseResult {
  entries: V8iEntry[];
  errors: V8iParseError[];
}

interface V8iParseError {
  line: number;
  message: string;
}
```

### 6.2 Реализация парсера

```typescript
import * as fs from 'fs';

export function parseV8iFile(filePath: string): V8iParseResult {
  const buffer = fs.readFileSync(filePath);
  const encoding = detectEncoding(buffer);
  const content = buffer.toString(encoding);
  
  return parseV8iContent(content);
}

export function parseV8iContent(content: string): V8iParseResult {
  const entries: V8iEntry[] = [];
  const errors: V8iParseError[] = [];
  
  const lines = content.split(/\r?\n/);
  let currentEntry: Partial<V8iEntry> | null = null;
  let lineNumber = 0;
  
  for (const line of lines) {
    lineNumber++;
    const trimmed = line.trim();
    
    // Пустая строка или комментарий
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) {
      continue;
    }
    
    // Начало секции [Name]
    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      // Сохранить предыдущую запись
      if (currentEntry?.name && currentEntry?.connect) {
        try {
          currentEntry.connectionParams = parseConnectString(currentEntry.connect);
          entries.push(currentEntry as V8iEntry);
        } catch (e) {
          errors.push({ line: lineNumber, message: `Invalid Connect: ${e}` });
        }
      }
      
      currentEntry = { name: sectionMatch[1] };
      continue;
    }
    
    // Ключ=Значение
    const kvMatch = trimmed.match(/^(\w+)=(.*)$/);
    if (kvMatch && currentEntry) {
      const [, key, value] = kvMatch;
      
      switch (key.toLowerCase()) {
        case 'connect':
          currentEntry.connect = value;
          break;
        case 'id':
          currentEntry.id = value;
          break;
        case 'orderinlist':
          currentEntry.orderInList = parseInt(value, 10);
          break;
        case 'orderintree':
          currentEntry.orderInTree = parseInt(value, 10);
          break;
        case 'folder':
          currentEntry.folder = value;
          break;
        case 'app':
          currentEntry.app = value as V8iEntry['app'];
          break;
        case 'version':
          currentEntry.version = value;
          break;
        case 'clientconnectionspeed':
          currentEntry.clientConnectionSpeed = value as 'Normal' | 'Low';
          break;
      }
    }
  }
  
  // Последняя запись
  if (currentEntry?.name && currentEntry?.connect) {
    try {
      currentEntry.connectionParams = parseConnectString(currentEntry.connect);
      entries.push(currentEntry as V8iEntry);
    } catch (e) {
      errors.push({ line: lineNumber, message: `Invalid Connect: ${e}` });
    }
  }
  
  return { entries, errors };
}
```

### 6.3 Генератор .v8i

```typescript
export function generateV8iContent(entries: V8iEntry[]): string {
  const lines: string[] = [];
  
  for (const entry of entries) {
    lines.push(`[${entry.name}]`);
    lines.push(`Connect=${entry.connect}`);
    
    if (entry.id) lines.push(`ID=${entry.id}`);
    if (entry.orderInList !== undefined) lines.push(`OrderInList=${entry.orderInList}`);
    if (entry.folder) lines.push(`Folder=${entry.folder}`);
    if (entry.app) lines.push(`App=${entry.app}`);
    if (entry.version) lines.push(`Version=${entry.version}`);
    
    lines.push(''); // Пустая строка между записями
  }
  
  return lines.join('\r\n');
}
```

---

## 7. Конвертация в InfobaseEntry

```typescript
function v8iEntryToInfobaseEntry(v8i: V8iEntry): InfobaseEntry {
  const params = v8i.connectionParams;
  
  return {
    id: v8i.id ?? crypto.randomUUID(),
    name: v8i.name,
    type: params.type === 'file' ? 'file' : 'server',
    filePath: params.file,
    server: params.server,
    database: params.ref,
    user: params.user,
    createdAt: new Date().toISOString(),
    status: 'unknown'
  };
}
```

---

## 8. Валидация

### 8.1 Проверки при импорте

```typescript
function validateV8iEntry(entry: V8iEntry): string[] {
  const errors: string[] = [];
  
  if (!entry.name) {
    errors.push('Отсутствует имя базы');
  }
  
  if (!entry.connect) {
    errors.push('Отсутствует строка подключения');
  }
  
  const params = entry.connectionParams;
  
  if (params.type === 'file' && params.file) {
    // Проверить существование пути (опционально)
    if (!fs.existsSync(params.file)) {
      errors.push(`Путь не существует: ${params.file}`);
    }
  }
  
  if (params.type === 'server' && !params.ref) {
    errors.push('Не указано имя базы на сервере');
  }
  
  return errors;
}
```

---

## 9. Источники .v8i

### 9.1 Локальный файл

Стандартное расположение списка баз пользователя:
- Windows: `%APPDATA%\1C\1CEStart\ibases.v8i`
- Linux: `~/.1C/1cestart/ibases.v8i`

### 9.2 Веб-публикация

Список баз может быть опубликован на веб-сервере:

```
https://intranet.company.com/1c/bases.v8i
```

Загрузка:

```typescript
async function fetchV8iFromUrl(url: string): Promise<V8iParseResult> {
  const response = await fetch(url);
  const content = await response.text();
  return parseV8iContent(content);
}
```

---

## 10. Ограничения и особенности

1. **Пароли в открытом виде** — в .v8i пароли хранятся без шифрования. При импорте рекомендуется:
   - Предупреждать пользователя
   - Сохранять пароли в SecretStorage
   - Не экспортировать пароли обратно в .v8i

2. **Пути Windows** — в значении `File=` путь может содержать обратные слеши, которые не экранируются.

3. **Кириллица в именах** — имена баз и папок могут содержать кириллицу, важно правильно определить кодировку.

4. **Дубликаты** — файл может содержать базы с одинаковыми именами (разные секции). При импорте нужно обрабатывать.
