# CDT 41 (Community Development Tools for 1C) — полное описание для Marketplace

Используйте этот текст при публикации расширения в VS Code Marketplace (поле «Full Description»).

**Идентификатор расширения (не меняется при переименовании):** `1c-dev.1c-metadata-tree-vscode`

---

## CDT 41 (Community Development Tools for 1C)

VS Code расширение для визуализации дерева метаданных конфигураций 1С:Предприятие. Отображает иерархию объектов метаданных (справочники, документы, регистры и др.) в виде дерева в боковой панели Explorer.

### Возможности

- **Дерево метаданных** — полная иерархия конфигурации 1С в виде дерева с иконками для 40+ типов объектов
- **Поддержка форматов** — EDT и Designer (выгрузка в XML)
- **Навигация** — открытие XML-файлов элементов, панель свойств, поиск и фильтрация по дереву
- **Операции** — создание, копирование, переименование и удаление элементов метаданных с сохранением в XML
- **Производительность** — ленивая загрузка узлов и кэширование для больших конфигураций

### Установка

1. Скачайте файл `.vsix` со [страницы Releases](https://github.com/lekot/VScodePluginFor1CDev/releases) или из папки [releases](https://github.com/lekot/VScodePluginFor1CDev/tree/main/releases) репозитория.
2. В VS Code: `Ctrl+Shift+P` (Windows/Linux) или `Cmd+Shift+P` (macOS) → **Extensions: Install from VSIX…** → выберите скачанный файл.

Расширение также совместимо с Cursor и другими редакторами на базе VS Code — установка через Install from VSIX.

### Требования

- VS Code 1.80.0 или выше
- Рабочая папка с конфигурацией 1С в формате EDT или Designer (XML)

### Репозиторий и лицензия

- Репозиторий: [lekot/VScodePluginFor1CDev](https://github.com/lekot/VScodePluginFor1CDev)
- Лицензия: MIT
