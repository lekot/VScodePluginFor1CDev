# Vendored files from cc-1c-skills

## Upstream

- **Repo:** `C:\reps\cc-1c-skills` (https://github.com/Nikolay-Shirokov/cc-1c-skills)
- **Commit:** 1fa205b961f4ed3659f58f4b55d2d9b1d5e4810e
- **Date:** 2026-10-10

## Files

### resources/skd/

| File | Source |
|------|--------|
| `skd-compile.ps1` | `.claude/skills/skd-compile/scripts/skd-compile.ps1` |
| `skd-info.ps1` | `.claude/skills/skd-info/scripts/skd-info.ps1` |
| `skd-edit.ps1` | `.claude/skills/skd-edit/scripts/skd-edit.ps1` |
| `skd-validate.ps1` | `.claude/skills/skd-validate/scripts/skd-validate.ps1` |

## Обновление

Для синхронизации с upstream запусти:

```bat
scripts\sync-cc-1c-skills.bat
```

Скрипт обновит файлы и заменит коммит-хэш и дату в этом файле.

## Локальные изменения

В skd-edit.ps1 и skd-compile.ps1 локально поддерживается проверка editingAllowedCheck относительно целевой конфигурации: параметры проекта ищутся от каталога конфигурации, а относительный configSrc разрешается от каталога .v8-project.json. На Windows полностью квалифицированные абсолютные пути (drive-rooted и UNC) остаются допустимы; drive-relative (C:folder, включая C:) и rooted-but-drive-relative (\folder) значения отклоняются с deny, чтобы результат не зависел от текущего каталога процесса. Для нескольких совпадений применяется самый специфичный каталог базы; граница каталога исключает совпадение по одному лишь строковому префиксу. Runtime-матрица регрессии находится в test/suite/skdSupportPolicy.test.ts.

Также в skd-edit.ps1 (основное сохранение и add-drilldown) и skd-compile.ps1 запись файлов выполняется атомарно через функцию Save-FileAtomically: данные сначала полностью записываются в уникальный sibling temp-файл в том же каталоге, после чего выполняется атомарная замена через [System.IO.File]::Replace (с удалением временного бэкапа) или Move (если целевой файл ещё не существовал), гарантируя защиту от повреждения/усечения файла при сбоях или отмене (issue #240). Тесты регрессии находятся в test/suite/skdAtomicSave.test.ts.

Скрипт синхронизации копирует vendored PowerShell-файлы целиком и может затереть этот локальный patch. После синхронизации восстанови локальную проверку политики и атомарную запись, затем запусти тесты из test/suite/skdSupportPolicy.test.ts и test/suite/skdAtomicSave.test.ts; отдельный patch-subsystem не используется.

