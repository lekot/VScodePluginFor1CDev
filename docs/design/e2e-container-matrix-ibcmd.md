# Матрица контейнеров и опциональный шаг `ibcmd` (дизайн)

## 1. Цель

Автоматически прогонять **создание и удаление** узлов метаданных на **копии** выгрузки Designer, затем опционально импортировать дерево в тестовую ИБ через **`ibcmd infobase config import`**, чтобы ловить регрессии XML до ручной проверки в конфигураторе.

## 2. Компоненты в репозитории

- Логика отбора целей DFS: `test/matrix/matrixTargetPredicate.ts` (`isMatrixTarget`, `isNestedMatrixTargetUnderMatrixObject`).
- Запуск `ibcmd`: `test/matrix/ibcmdAdapter.ts` (`runIbcmdOnWorkDir`, `runIbcmdConfigCheck`).
- Оркестрация: `test/runMatrixLocal.ts`, полный instrument: `instrument-smoke.bat` / `instrument-full-local.bat` (см. [README.md](../../README.md)).

## 3. Переменные матрицы (кратко)

| Переменная | Назначение |
|------------|------------|
| `MATRIX_WORK_DIR` | Корень копии конфигурации с `Configuration.xml` (иначе используется встроенная копия empty_conf). |
| `MATRIX_FULL` / `MATRIX_SLICE_LIMIT` | Полный обход vs усечённый срез целей. |
| `INSTRUMENT_MATRIX_WORK_DIR` | Для `instrument-smoke`: своя копия вместо temp. |
| `IBMATRIX_SKIP_CONFIG_CHECK=1` | После **успешного** `config import` не вызывать `ibcmd infobase config check` (см. §6.6). |

Подробности сценариев create/delete — [plans/e2e-container-matrix-ibcmd.md](../plans/e2e-container-matrix-ibcmd.md).

## 4. Исключения целей (ibcmd-хрупкие типы)

Папки типов из `IBMATRIX_SKIP_TYPE_FOLDER_IDS` в `matrixTargetPredicate.ts` пропускаются: минимальный шаблон без перекрёстных ссылок даёт ошибки импорта (например `ChartsOfAccounts`, часть регистров, веб-сервисы). Список поддерживается в коде; при добавлении новых типов в матрицу сверяться с логом `ibcmd`.

## 5. Отчёты

- JSON по умолчанию: `suite-reports/instrument-matrix.json` (блоки `ibcmd` и `ibcmdCheck`: `executed` | `skipped` | `failed`).

## 6. Контракт `ibcmd`

### 6.1 Команда

```text
ibcmd infobase config import --config=<YAML> [--user=...] [--password=...] <absoluteWorkDir>
```

`absoluteWorkDir` — корень выгрузки Designer (файл `Configuration.xml` внутри).

### 6.2 Версия платформы

Ориентир: 1C 8.3.27+ (утилита `ibcmd` в составе дистрибутива; см. документацию администратора по **ibcmd**).

### 6.3 Поведение при отсутствии инструмента

Если `IBCMD_PATH` не задан — шаг **skipped**, прогон матрицы по файлам продолжается.  
Если задан `IBCMD_PATH`, но не задан `IBCMD_INFOBASE_CONFIG` — **skipped** с пояснением в логе (нет «тихого» успеха).

### 6.4 Таймаут

`IBCMD_TIMEOUT_MS` — опционально, по умолчанию 600000 мс (см. `ibcmdAdapter.ts`).

### 6.5 Переменные среды (эталон)

| Переменная | Обязательность | Описание |
|------------|----------------|----------|
| `IBCMD_PATH` | Для шага импорта | Полный путь к `ibcmd` (Windows: `...\bin\ibcmd.exe`). |
| `IBCMD_INFOBASE_CONFIG` | Если задан путь к ibcmd | Абсолютный путь к YAML описанию ИБ (часто `ibcmd server config init ... --out=...`). |
| `IBCMD_USER` | Нет | Учётная запись ИБ, если требуется. |
| `IBCMD_PASSWORD` | Нет | Пароль. |
| `IBCMD_TIMEOUT_MS` | Нет | Таймаут подпроцесса. |
| `IBCMD_CONFIG_CHECK_FORCE` | Нет | Если `1`, к `config check` добавляется `--force` (см. §6.6; реализовано в `ibcmdConfigCheckGate` и `runIbcmdConfigCheck`). |

Генерация YAML для файловой базы — в [README.md](../../README.md) (раздел instrument-smoke) и [research/e2e-container-matrix-ibcmd.md](../research/e2e-container-matrix-ibcmd.md).

### 6.6 Проверка конфигурации в ИБ (`config check`)

После импорта XML (или для уже загруженной конфигурации в тестовой ИБ) платформа поддерживает **проверку конфигурации** через `ibcmd` — аналог типовой проверки в конфигураторе на уровне CLI.

```text
ibcmd infobase config check --config=<YAML> [--user=...] [--password=...] [--extension=...] [--force]
```

Параметры `--config` / учётная запись совпадают с общими для режима **infobase** (см. руководство администратора 8.3.x, приложение **ibcmd**, раздел *infobase mode* → *config* → **check**). Флаг `--force` подтверждает операцию при предупреждениях; в CDT и матрице его можно включить переменной `IBCMD_CONFIG_CHECK_FORCE=1` (§6.5).

Готовые задачи VS Code в репозитории: `.vscode/tasks.json` → **CDT: ibcmd — check infobase configuration** (и импорт — **CDT: ibcmd — import configuration from XML**). Переменные среды те же, что в §6.5; для импорта дополнительно задайте `MATRIX_WORK_DIR` — корень выгрузки Designer.

Для UX после запуска задач: последние отчёты лежат в `.ibcmd-reports/check-last.log` и `.ibcmd-reports/import-last.log`; их можно открыть командами палитры **CDT 41: Open last ibcmd check report** и **CDT 41: Open last ibcmd import report**.

См. также: [DEVELOPING.md](../../DEVELOPING.md) (раздел про проверку конфигурации).
