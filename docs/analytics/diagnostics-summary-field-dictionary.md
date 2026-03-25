# Словарь полей: «CDT 41: Copy diagnostics summary»

Текстовая сводка для багрепортов и поддержки. Формируется командой палитры **CDT 41: Copy diagnostics summary** (`1c-metadata-tree.copyDiagnosticsSummary`). Реализация: `src/utils/diagnosticsSummary.ts`, вызов из `src/extension.ts`.

Строки идут **сверху вниз** в фиксированном порядке (см. снимок в `test/suite/diagnosticsSummary.test.ts`).

## Заголовок и версии

| Строка | Источник | Когда есть |
|--------|----------|------------|
| `{productLabel} diagnostics` | Константа `CDT 41` | Всегда |
| `Extension version: …` | `package.json` расширения | Всегда |
| `VS Code version: …` | `vscode.version` | Всегда |

## Хост и окружение редактора

| Строка | Источник | Когда есть |
|--------|----------|------------|
| `Host app: …` | `vscode.env.appName` (например Visual Studio Code, Cursor) | Если значение непустое |
| `Host platform: …` | `process.platform` (`win32`, `darwin`, `linux`, …) | Если значение непустое |
| `VS Code UI locale: …` | `vscode.env.language` (код языка UI, например `ru`, `en`) | Если значение непустое |
| `Remote: …` | `vscode.env.remoteName` (например `wsl`, `ssh-remote`, идентификатор dev container) | Только во **remote**-окне; при локальной работе строки нет |
| `Extension run mode: …` | `ExtensionContext.extensionMode` → `production` \| `development` \| `test` | Если значение непустое (в штатном запуске из marketplace обычно `production`) |

## Workspace и корни конфигурации

| Блок | Содержание |
|------|------------|
| `Workspace folders: N` | Число корневых папок workspace |
| `  - {name}: {path}` | По одной строке на папку: отображаемое имя и **полный путь** на диске (`WorkspaceFolder.uri.fsPath`) |
| `Configuration roots: …` | Либо список найденных корней конфигурации, либо сообщение об отсутствии |

**Поиск корней:** `FormatDetector.findAllConfigurationRoots` по путям папок workspace; **максимальная глубина обхода — 5** уровней от каждой папки (это отражено в тексте, если корней не найдено).

Для каждого найденного корня:

- строка `  - {configPath}` — абсолютный путь к корню конфигурации;
- строка `    format: {Designer|EDT|…} (workspace folder: {workspaceFolderPath})` — результат `FormatDetector.detect` и папка workspace, к которой привязан корень.

## Метка времени

| Строка | Значение |
|--------|----------|
| `Generated (UTC): …` | ISO-8601 в UTC (`new Date().toISOString()`), время формирования сводки |

## Конфиденциальность и публикация

- **Пути** (workspace, корни конфигурации) могут содержать имена пользователей, клиентов или внутренние каталоги. Перед публикацией в открытый тикет их можно заменить на нейтральные placeholder'ы, сохранив структуру (например «2 папки, обе Designer»).
- **Remote** и **Host app** помогают воспроизвести баги в WSL/SSH/контейнере и в форках VS Code — это не секреты, но иногда раскрывает инфраструктуру; при необходимости строку можно обобщить вручную после вставки из буфера.

## Согласованность с пользовательской документацией

- Краткое описание команды: [README.md](../../README.md) (таблица команд).
- Шаблон GitHub: [.github/ISSUE_TEMPLATE/bug_report.md](../../.github/ISSUE_TEMPLATE/bug_report.md).

При изменении набора полей или порядка строк обновите этот файл и тест `diagnosticsSummary.test.ts` (снимок «full bundle»).
