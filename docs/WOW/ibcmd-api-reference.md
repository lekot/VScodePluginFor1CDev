# ibcmd API Reference

> Справочник команд ibcmd, используемых в Infobase Manager

## Общая информация

**ibcmd** — утилита командной строки автономного сервера 1С:Предприятие.  
Доступна начиная с версии платформы **8.3.27**.

Расположение по умолчанию:
- Windows: `C:\Program Files\1cv8\<version>\bin\ibcmd.exe`
- Linux: `/opt/1cv8/<version>/ibcmd`

---

## 1. Работа с информационными базами

### 1.1 Создание базы

```bash
ibcmd infobase create --db-path=<path> [options]
```

**Параметры:**

| Параметр | Описание | Обязательный |
|----------|----------|--------------|
| `--db-path` | Путь к папке для файловой базы | Да (файловая) |
| `--dbms` | Тип СУБД для серверной базы | Да (серверная) |
| `--db-server` | Сервер СУБД | Да (серверная) |
| `--db-name` | Имя базы данных | Да (серверная) |
| `--db-user` | Пользователь СУБД | Нет |
| `--db-pwd` | Пароль СУБД | Нет |
| `--locale` | Локаль базы (ru_RU, en_US) | Нет |
| `--date-offset` | Смещение дат | Нет |

**Пример (файловая):**

```bash
ibcmd infobase create --db-path="C:\Bases\NewBase"
```

**Пример (серверная PostgreSQL):**

```bash
ibcmd infobase create \
  --dbms=PostgreSQL \
  --db-server=localhost \
  --db-name=new_base \
  --db-user=postgres \
  --db-pwd=secret
```

---

### 1.2 Информация о базе

```bash
ibcmd infobase info --config=<yaml>
```

**Параметры:**

| Параметр | Описание | Обязательный |
|----------|----------|--------------|
| `--config` | Путь к YAML-конфигу подключения | Да |

**YAML-конфиг подключения:**

```yaml
# Файловая база
infobase:
  file: "C:\\Bases\\Demo_UT"
  user: "Администратор"
  password: "secret"

# Серверная база
infobase:
  server: "server1c"
  ref: "Demo_UT"
  user: "Администратор"
  password: "secret"
```

**Вывод:**

```
Infobase: C:\Bases\Demo_UT
Type: File
Version: 8.3.27.1234
Configuration: "Управление торговлей, редакция 11"
Sessions: 0
```

---

## 2. Работа с конфигурацией

### 2.1 Импорт конфигурации (загрузка в базу)

```bash
ibcmd infobase config import --config=<yaml> [options] <source-path>
```

**Параметры:**

| Параметр | Описание | Обязательный |
|----------|----------|--------------|
| `--config` | YAML-конфиг подключения | Да |
| `--user` | Пользователь ИБ (альтернатива YAML) | Нет |
| `--password` | Пароль (альтернатива YAML) | Нет |
| `--force` | Принудительный импорт | Нет |
| `--extension` | Имя расширения (для импорта расширения) | Нет |
| `<source-path>` | Путь к папке с выгрузкой | Да |

**Пример:**

```bash
ibcmd infobase config import \
  --config=connection.yaml \
  "C:\Projects\ERP_Config"
```

**С расширением:**

```bash
ibcmd infobase config import \
  --config=connection.yaml \
  --extension="МоёРасширение" \
  "C:\Projects\Extension_Config"
```

**Коды возврата:**

| Код | Описание |
|-----|----------|
| 0 | Успешно |
| 1 | Ошибка импорта |
| 2 | База заблокирована |
| 3 | Ошибка подключения |

---

### 2.2 Экспорт конфигурации (выгрузка из базы)

```bash
ibcmd infobase config export --config=<yaml> --out=<path> [options]
```

**Параметры:**

| Параметр | Описание | Обязательный |
|----------|----------|--------------|
| `--config` | YAML-конфиг подключения | Да |
| `--out` | Путь для выгрузки | Да |
| `--extension` | Имя расширения | Нет |
| `--format` | Формат выгрузки (xml, edt) | Нет |

**Пример:**

```bash
ibcmd infobase config export \
  --config=connection.yaml \
  --out="C:\Export\ERP_Config"
```

---

### 2.3 Проверка конфигурации

```bash
ibcmd infobase config check --config=<yaml> [options]
```

**Параметры:**

| Параметр | Описание | Обязательный |
|----------|----------|--------------|
| `--config` | YAML-конфиг подключения | Да |
| `--force` | Принудительная проверка | Нет |

**Пример:**

```bash
ibcmd infobase config check --config=connection.yaml
```

**Вывод при ошибках:**

```
Configuration check failed:
  - Error in CommonModule.ОбщийМодуль1: Syntax error at line 15
  - Warning in Document.Документ1: Deprecated method used
```

---

## 3. Управление сеансами

### 3.1 Список сеансов

```bash
ibcmd infobase session list --config=<yaml>
```

**Вывод:**

```
Sessions (2):
  1. User: Администратор, App: Designer, Started: 2026-03-27 10:00
  2. User: Иванов, App: 1CV8, Started: 2026-03-27 09:30
```

### 3.2 Завершение сеансов

```bash
ibcmd infobase session terminate --config=<yaml> [--all | --session=<id>]
```

**Параметры:**

| Параметр | Описание |
|----------|----------|
| `--all` | Завершить все сеансы |
| `--session` | ID конкретного сеанса |

---

## 4. Инициализация конфига

### 4.1 Создание YAML-конфига

```bash
ibcmd server config init --out=<path> [options]
```

**Параметры:**

| Параметр | Описание |
|----------|----------|
| `--out` | Путь для сохранения YAML |
| `--db-path` | Путь к файловой базе |
| `--server` | Сервер 1С |
| `--ref` | Имя базы на сервере |

**Пример:**

```bash
ibcmd server config init \
  --out=connection.yaml \
  --db-path="C:\Bases\Demo_UT"
```

**Результат (connection.yaml):**

```yaml
infobase:
  file: "C:\\Bases\\Demo_UT"
```

---

## 5. Формат YAML-конфига

### 5.1 Файловая база

```yaml
infobase:
  file: "C:\\Bases\\Demo_UT"
  user: "Администратор"
  password: "secret"
```

### 5.2 Серверная база

```yaml
infobase:
  server: "server1c"
  ref: "Demo_UT"
  user: "Администратор"
  password: "secret"
```

### 5.3 С дополнительными параметрами

```yaml
infobase:
  server: "server1c"
  ref: "Demo_UT"
  user: "Администратор"
  password: "secret"

options:
  locale: "ru_RU"
  session-terminate-timeout: 60
```

---

## 6. Переменные окружения

| Переменная | Описание | Приоритет |
|------------|----------|-----------|
| `IBCMD_PATH` | Путь к ibcmd | Высший |
| `IBCMD_INFOBASE_CONFIG` | Путь к YAML по умолчанию | Средний |
| `IBCMD_USER` | Пользователь по умолчанию | Низкий |
| `IBCMD_PASSWORD` | Пароль по умолчанию | Низкий |
| `IBCMD_TIMEOUT_MS` | Таймаут в мс | Низкий |

---

## 7. Использование в Infobase Manager

### 7.1 Генерация временного YAML

Для каждой операции расширение генерирует временный YAML-файл:

```typescript
async function createTempConfig(entry: InfobaseEntry): Promise<string> {
  const config = entry.type === 'file'
    ? { infobase: { file: entry.filePath } }
    : { infobase: { server: entry.server, ref: entry.database } };
  
  if (entry.user) {
    config.infobase.user = entry.user;
    const password = await secrets.get(`infobase-${entry.id}`);
    if (password) config.infobase.password = password;
  }
  
  const tempPath = path.join(os.tmpdir(), `ibcmd-${entry.id}.yaml`);
  await fs.writeFile(tempPath, yaml.stringify(config));
  return tempPath;
}
```

### 7.2 Вызов ibcmd

```typescript
async function runIbcmd(args: string[], timeout?: number): Promise<IbcmdResult> {
  const ibcmdPath = getIbcmdPath();
  
  return new Promise((resolve, reject) => {
    const proc = execFile(ibcmdPath, args, {
      timeout: timeout ?? 600000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      resolve({
        exitCode: error?.code ?? 0,
        stdout,
        stderr
      });
    });
  });
}
```

### 7.3 Маппинг операций

| Операция UI | Команда ibcmd |
|-------------|---------------|
| Создать базу | `infobase create` |
| Проверить доступность | `infobase info` |
| Загрузить конфигурацию | `infobase config import` |
| Выгрузить конфигурацию | `infobase config export` |
| Проверить конфигурацию | `infobase config check` |
| Получить сеансы | `infobase session list` |

---

## 8. Обработка ошибок

### 8.1 Типичные ошибки

| Код | Сообщение | Причина | Решение |
|-----|-----------|---------|---------|
| 1 | "Configuration error" | Ошибка в конфигурации | Показать детали, предложить проверку |
| 2 | "Infobase is locked" | База заблокирована | Показать сеансы, предложить завершить |
| 3 | "Connection failed" | Нет подключения | Проверить путь/сервер, credentials |
| 127 | "Command not found" | ibcmd не найден | Предложить указать путь |

### 8.2 Таймауты

```typescript
const TIMEOUTS = {
  info: 30_000,      // 30 сек
  check: 300_000,    // 5 мин
  import: 600_000,   // 10 мин (настраиваемо)
  export: 600_000,   // 10 мин (настраиваемо)
  create: 60_000     // 1 мин
};
```

---

## 9. Совместимость версий

| Версия платформы | ibcmd | Примечания |
|------------------|-------|------------|
| 8.3.27+ | ✅ Полная | Все команды |
| 8.3.25-8.3.26 | ⚠️ Частичная | Нет некоторых опций |
| < 8.3.25 | ❌ Нет | ibcmd недоступен |

---

## 10. Ссылки

- [Документация 1С: Автономный сервер](https://its.1c.ru/db/v8327doc#bookmark:adm:TI000001234)
- [ibcmd CLI Reference](https://its.1c.ru/db/v8327doc#bookmark:adm:TI000001235)
