# Исследование: среда для матрицы и `ibcmd`

Дополняет [design/e2e-container-matrix-ibcmd.md](../design/e2e-container-matrix-ibcmd.md) §6.

## Эталонные пути (Windows)

Типичная установка платформы 1С:

```text
C:\Program Files\1cv8\<версия>\bin\ibcmd.exe
```

Задаётся в `IBCMD_PATH`.

## YAML описания ИБ

Формат ожидается тот же, что создаёт **`ibcmd server config init`** (режим server → config init в документации администратора 8.3.x).

Для **файловой** ИБ в параметре пути к базе указывают каталог, совпадающий с подключением в конфигураторе, например:

```bat
ibcmd.exe server config init --database-path="C:\Users\You\Documents\MyFileIB" --name=CDT_matrix --out="%USERPROFILE%\1cviewer-ibcmd-infobase.yml"
```

Далее `IBCMD_INFOBASE_CONFIG` → этот `.yml`.

## Локальные обёртки в репозитории

- `ibcmd.setup.example.bat` — шаблон; копия в `ibcmd-local.bat` (в `.gitignore`) для своих путей.
- `instrument-full-local.bat` — UTF-8 консоль + переменные для полного прогона.

## Когда имеет смысл включать ibcmd

- Перед релизом или после изменений в `XMLWriter`, `elementOperations`, шаблонах Designer.
- При добавлении новых типов в `isMatrixTarget`: проверить, не нужно ли расширить `IBMATRIX_SKIP_TYPE_FOLDER_IDS`.

## Нефункциональные риски

- Импорт **пишет в реальную ИБ** — использовать только тестовую базу.
- Длительность импорта на больших конфигурациях; при необходимости увеличить `IBCMD_TIMEOUT_MS`.
