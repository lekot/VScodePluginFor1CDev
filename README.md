[Релизы](https://github.com/lekot/VScodePluginFor1CDev/releases)

Вся фича написана роботами. Багрепорты принимаю с благодарностью

# CDT 41 (Community Development Tools for 1C)

VS Code расширение для визуализации и редактирования дерева метаданных конфигураций 1С:Предприятие.

## Возможности

- 📁 Отображение иерархии метаданных конфигурации 1С
- 🎨 Иконки для всех типов метаданных (40+ типов) (я не считал)
- 🔍 Быстрая навигация по элементам конфигурации
- 📝 Отображение синонимов и свойств элементов
- 🔄 Автоматическая загрузка при открытии workspace
- ⚡ Ленивая загрузка для производительности
- 🎯 Поддержка EDT (я не проверял) и Designer (+) форматов

А также: Отладка из VSCode, визуальное редактирование типов реквизитов,  отображение таблицы состава ролей, фильтр по подсистемам, визуальный редактор форм (прототип, идёт работа)

### Agent API (для AI-агентов)

CDT 41 предоставляет 12 VS Code commands для программного управления метаданными 1С. AI-агент (Claude Code, Copilot, MCP-клиент) может создавать объекты, добавлять реквизиты, читать/писать свойства — без ручного взаимодействия с UI. Объекты адресуются через dot-path: `Catalog.Товары`, `Document.ПриходТовара.Attribute.Склад`. Подробнее: [docs/features/agent-api/agent-skill.md](docs/features/agent-api/agent-skill.md)

Чего нет: конструктора запроса (есть внешние в режиме предприятия), СКД-редактора, редактирование состава подсистем (когда-то будет), состава планов обмена и много чего еще нет. Включайся в разработку - будет
<img width="1407" height="929" alt="image" src="https://github.com/user-attachments/assets/b654c166-4e98-4429-a309-80ebe4f9ab16" />
<img width="1092" height="450" alt="image" src="https://github.com/user-attachments/assets/755d5a95-4088-4567-89ba-8d6ffe38d670" />
<img width="1159" height="885" alt="image" src="https://github.com/user-attachments/assets/7f608dee-7a6d-46a9-aac8-f86e52e55433" />
<img width="1490" height="757" alt="image" src="https://github.com/user-attachments/assets/ebca534a-d37c-4c88-8b1b-826525a743c4" />
<img width="1462" height="671" alt="image" src="https://github.com/user-attachments/assets/e2f9194f-9593-4f86-a364-829c2c922410" />




## Установка

### Из VSIX (рекомендуется)

1. Скачайте файл `.vsix` из папки [releases](releases/) в репозитории (или со страницы Releases на GitHub).
2. В VS Code: `Ctrl+Shift+P` → **Install from VSIX…** → укажите скачанный файл.
3. Перезагрузите окно при необходимости.

### Установка в Cursor и других редакторах на базе VS Code

Аналогично

### Из исходников (для разработки)

1. Клонируйте репозиторий и перейдите в каталог проекта.
2. Установите зависимости: `npm install`
3. Соберите проект: `npm run compile` (или `.\build-all.bat` для сборки VSIX).
4. Запуск: нажмите `F5` в VS Code для отладки.

## Использование

### Открытие панели метаданных

1. Откройте папку с конфигурацией 1С в VS Code
2. Панель **CDT 41** появится автоматически в Explorer
3. Или: **Ctrl+Alt+1** (Windows/Linux) / **Cmd+Alt+1** (macOS), либо Command Palette (**Ctrl+Shift+P**) → «CDT 41: Open Metadata Tree»

### Команды (CDT 41)

Практический чеклист «день без EDT»: [docs/analytics/user-workflow-without-edt.md](docs/analytics/user-workflow-without-edt.md).

| Команда | Описание |
|--------|----------|
| CDT 41: Open Metadata Tree | Открыть панель дерева метаданных |
| Refresh | Обновить дерево |
| Show Properties | Открыть панель свойств выбранного элемента |
| Open XML File | Открыть XML файл элемента |
| Create Element | Создать элемент |
| Duplicate Element | Дублировать элемент |
| Delete Element | Удалить элемент |
| Rename Element | Переименовать элемент |
| Copy Path / Name | Копировать путь или имя в буфер |
| Search in tree | Фокус в поле поиска по дереву |
| Clear search and filters | Сбросить поиск и фильтры |
| Filter by metadata type | Фильтр по типу метаданных |
| Filter by Subsystem | Фильтр по подсистеме (правый клик на подсистеме) |
| Clear Subsystem Filter | Сбросить фильтр по подсистеме |
| Next search result | Следующий результат поиска |
| Previous search result | Предыдущий результат поиска |
| Clear tree cache | Очистить кэш дерева |
| CDT 41: Export logs | Экспорт логов расширения |
| CDT 41: Copy diagnostics summary | Сводка для багрепортов: версии, хост-приложение, ОС, язык UI, remote (если есть), режим расширения (production / development / test), папки workspace и найденные корни конфигурации (поиск до глубины 5), метка UTC. [Словарь полей](docs/analytics/diagnostics-summary-field-dictionary.md) |

### Горячие клавиши (в панели CDT 41)

- **Ctrl+Alt+1** / **Cmd+Alt+1** — открыть панель метаданных  
- **Ctrl+Shift+M** / **Cmd+Shift+M** — открыть/закрыть панель  
- **Ctrl+F** / **Cmd+F** — поиск в дереве  
- **Delete** — удалить выбранный элемент  
- **F2** — переименовать элемент  
- **Ctrl+D** / **Cmd+D** — дублировать элемент  
- **Ctrl+C** / **Cmd+C** — копировать имя/путь  

### Навигация

- **Развернуть/свернуть узел**: Клик на стрелку рядом с элементом
- **Открыть файл**: Клик на элемент с файлом
- **Обновить дерево**: Кнопка "Refresh" в панели или команда `1C: Refresh`

### Поиск и фильтрация

- **Поиск по имени**: кнопка поиска в панели или Ctrl+F; ввод подстроки фильтрует дерево, показываются совпадающие узлы и их предки.
- **По синониму и комментарию**: опция в поиске (при включении поиск идёт также по синониму и комментарию).
- **Регулярные выражения**: опция «использовать regex» в поиске.
- **Фильтр по типу**: команда «Filter by metadata type» — выбор типов метаданных (Справочники, Документы и т.д.).
- **Фильтр по подсистеме**: правый клик на узле подсистемы → «Filter by Subsystem» — показывает только объекты, принадлежащие данной подсистеме. Фильтр можно сбросить через контекстное меню или команду «Clear Subsystem Filter».
- **Навигация по результатам**: Next search result / Previous search result для перехода по совпадениям.

### Поведение фильтрации по подсистеме

Фильтрация по подсистеме работает следующим образом:

1. **Применение фильтра**: Правый клик на узле подсистемы в дереве → «Filter by Subsystem»
2. **Видимость узлов**: Показываются только узлы, принадлежащие выбранной подсистеме (включая саму подсистему и все её дочерние элементы)
3. **Иерархия**: Все предки отфильтрованных узлов остаются видимыми для сохранения структуры дерева
4. **Совместимость с другими фильтрами**: Фильтр по подсистеме комбинируется с фильтром по типу и поиском
5. **Сброс фильтра**:
   - Через контекстное меню (правый клик → «Clear Subsystem Filter»)
   - Через команду «Clear search and filters» (сбрасывает все фильтры)
6. **Индикация**: Активный фильтр отображается в заголовке дерева в формате «Подсистема: {имя}»

**Примеры использования**:
- Просмотр только объектов подсистемы «Продажи»: правый клик на «Продажи» → «Filter by Subsystem»
- Комбинированный фильтр: сначала примените фильтр по подсистеме, затем выберите типы метаданных (например, только Справочники)
- Поиск внутри подсистемы: примените фильтр по подсистеме, затем используйте поиск (Ctrl+F)

### Поддерживаемые типы метаданных

#### Основные объекты
- Справочники (Catalogs)
- Документы (Documents)
- Перечисления (Enums)
- Отчеты (Reports) (?)
- Обработки (DataProcessors)
- Регистры (Information/Accumulation/Accounting/Calculation)
- Бизнес-процессы (BusinessProcesses)
- Задачи (Tasks)

#### Другие объекты
- Константы (Constants)
- Общие модули (CommonModules)
- Роли (Roles)
- Подсистемы (Subsystems)
- Web-сервисы (WebServices)
- HTTP-сервисы (HTTPServices)
- И многое другое...

## Требования

- VS Code версии 1.80.0 или выше
- Node.js 16.x или выше (для разработки)
- Конфигурация 1С в формате EDT или Designer

## Структура проекта

```
VScodePluginFor1CDev/
├── src/
│   ├── extension.ts                 # Точка входа, команды, связка провайдеров
│   ├── models/                      # TreeNode, типы узлов
│   ├── parsers/                     # metadataParser, designerParser, edtParser, formatDetector, xmlParser, …
│   ├── providers/                   # treeDataProvider, propertiesProvider, typeEditorProvider
│   ├── services/                    # elementOperations, metadataWatcherService, reloadCoordinator, шаблоны Designer, …
│   ├── utils/                       # XMLWriter, logger, diskCache, validators, referenceFinder, …
│   ├── constants/                   # UI-сообщения, подписи свойств, секции
│   ├── types/                       # Контракты перезагрузки и прочие типы
│   ├── serializers/                 # Сериализация типов для UI
│   ├── formEditor/                  # Кастомный редактор Ext/Form.xml (webview)
│   └── rolesEditor/                 # Редактор прав роли (Role.xml, webview)
├── test/
│   ├── fixtures/                    # Фикстуры (designer-config и др.)
│   ├── suite/                       # Модульные, интеграционные, smoke
│   └── matrix/                      # Матрица контейнеров + опциональный ibcmd
├── docs/
│   ├── documentation-map.md         # Указатель: research → analytics → plans → код
│   ├── architecture.md              # Карта src/ и потоков данных
│   ├── developer-backlog.md         # Очередь задач (синхрон с gap и GitHub)
│   ├── design/                      # Дизайн E2E / ibcmd
│   ├── plans/                       # Планы фич и матрицы
│   ├── research/                    # Gap с EDT, спеки объектов XML
│   └── analytics/                   # EDT-killer, user workflow, инвентаризация
├── DEVELOPING.md
└── package.json
```

Подробная архитектура: [docs/architecture.md](docs/architecture.md). Полный указатель документов: [docs/documentation-map.md](docs/documentation-map.md).

## Разработка

### Границы продукта (CDT и BSL/LSP)

Расширение **CDT 41** отвечает за **дерево метаданных**, разрешение **путей к файлам** (в т.ч. вложенный `Ext` и `.bsl` общих модулей в выгрузке Designer) и **ограниченный набор команд** в контексте дерева (например открытие XML или файла модуля). **Полноценный анализ языка BSL** — подсветка, навигация по символам, диагностика на уровне процедур и т.п. — это зона **внешнего BSL/LSP** и других расширений VS Code; CDT намеренно не дублирует LSP. Пользователи могут сочетать CDT с LSP: CDT показывает структуру конфигурации и файлы, LSP — семантику кода в открытых `.bsl`. Граница соответствует handoff #25 (план: `docs/plans/issue-bsl-common-module-tree-plan.md`, фаза 9).

### Компиляция

```bash
npm run compile
```

### Режим watch

```bash
npm run watch
```

### Запуск тестов

Полный прогон (компиляция, линт, все тесты):

```bash
npm test
```

Быстрый прогон парсеров и части тестов (Windows):

```bash
.\test-suite.bat
```

**Полный смокер инструмента** (рекомендуемый gate перед релизом или после крупных изменений): **`.\scripts\instrument-smoke.bat`**

Локально без ручного `set`: **`.\instrument-full-local.bat`** — в начале `chcp 65001` (UTF-8 в консоли), задаёт `IBCMD_*` и путь к YAML, полный обход матрицы, при сбое **ibcmd** прогон не обрывается (`INSTRUMENT_IBCMD_NONFATAL=1`), затем VS Code smoke. Перед первым запуском сгенерируйте YAML (`ibcmd server config init`, см. ниже).

Порядок шагов:

1. Сборка расширения и тестов, копирование фикстур в `out/test/fixtures`.
2. **Core** (`runCore`): все сьюты из `coreSuites.ts`, кроме `containerMatrix.e2e.test.js` (чтобы не гонять матрицу дважды).
3. **Матрица контейнеров** на свежей копии `FormatSamples/empty_conf` (или на каталоге из `MATRIX_WORK_DIR`) и шаг **ibcmd** при заданных `IBCMD_PATH` + `IBCMD_INFOBASE_CONFIG` — см. `docs/design/e2e-container-matrix-ibcmd.md` §6.5. JSON-отчёт по умолчанию: `suite-reports/instrument-matrix.json`. **Полный обход целей** включается автоматически, если не заданы `MATRIX_SLICE_LIMIT` и `MATRIX_FULL` (для быстрого среза: `set MATRIX_SLICE_LIMIT=5` или `set MATRIX_FULL=0`).
4. **VS Code smoke** (`runSmoke.js`): дерево, формы, команды без модального ввода. Отчёт: `suite-reports/instrument-vscode-smoke.json`. Пропуск: `set SKIP_VSCODE_SMOKE=1`.

Пример с вашей платформой и YAML ИБ:

```bat
set IBCMD_PATH=C:\Program Files\1cv8\8.3.27.1859\bin\ibcmd.exe
set IBCMD_INFOBASE_CONFIG=C:\Users\You\ibcmd-infobase.yml
.\scripts\instrument-smoke.bat
```

**Файловая база: как получить YAML для `IBCMD_INFOBASE_CONFIG`.** Утилита ожидает файл в формате, который обычно создают командой **`ibcmd server config init`** (см. Administrator Guide 8.3.x, приложение про **ibcmd**, режим **server** → **config init**). Для **файловой** ИБ укажите каталог базы (`--database-path`), совпадающий с путём подключения в конфигураторе (например `File="C:\Users\...\InfoBase11"`). Пример генерации (выполнить один раз, подставив версию платформы и путь к ИБ):

```bat
"C:\Program Files\1cv8\8.3.27.1859\bin\ibcmd.exe" server config init --database-path="C:\Users\You\Documents\MyFileIB" --name=CDT_matrix --out="%USERPROFILE%\1cviewer-ibcmd-infobase.yml"
```

Дальше задайте `IBCMD_INFOBASE_CONFIG` на этот `.yml` и запустите `.\scripts\instrument-smoke.bat`. Готовый шаблон с комментариями: **`ibcmd.setup.example.bat`** (скопируйте в **`ibcmd-local.bat`** — файл в `.gitignore`, чтобы не коммитить свои пути).

После прогона с рабочим ibcmd в `suite-reports/instrument-matrix.json` блок **`ibcmd`** будет с `"status": "executed"` и фрагментом лога; при ошибке импорта смокер завершится с ненулевым кодом. Откройте ту же ИБ в конфигураторе и выполните типовую проверку конфигурации при необходимости.

Для сценария через задачи VS Code (`CDT: ibcmd — check/import`) отчёты пишутся в `.ibcmd-reports/` в workspace (`check-last.log`, `import-last.log`). Их можно открыть из палитры:

- `CDT 41: Open last ibcmd check report`
- `CDT 41: Open last ibcmd import report`

Своя копия конфигурации в составе `scripts\instrument-smoke.bat` (вместо temp-копии `empty_conf`): перед запуском задайте **`INSTRUMENT_MATRIX_WORK_DIR`** (абсолютный путь к корню с `Configuration.xml`).

Только матрица на **своей** копии выгрузки (без полного instrument-smoke): `.\matrix-local.bat`.

---

**Узкий smoke только в VS Code** (без core и без матрицы/ibcmd — исторический быстрый прогон UI):

```bash
npm run test:smoke
```

`.\smoke-tests.bat` делает то же по сборке: сначала `tsc -p .` (расширение), затем `tsconfig.test.json`, затем `runSmoke.js`. Для JSON-отчёта, как в CI: задайте **`SUITE_REPORT_PATH_SMOKE`** (например `suite-reports\smoke-report.json`) и при необходимости **`MANDATORY_SUITES_SMOKE=suite/smoke/smoke.test.js`**.

Свой каталог выгрузки Designer (корень с `Configuration.xml`): задайте **`SMOKE_WORKSPACE`** (абсолютный или относительный путь), иначе используется `test/fixtures/designer-config`.

**Локальная контейнерная матрица** (Node, без VS Code; **пишет в каталог** — работайте с **копией** выгрузки):

```bat
set MATRIX_WORK_DIR=C:\копия\моей\конфигурации
set IBCMD_PATH=C:\Program Files\1cv8\8.3.27.1859\bin\ibcmd.exe
set IBCMD_INFOBASE_CONFIG=C:\путь\к\yaml-описанию-ИБ.yml
set MATRIX_FULL=1
.\matrix-local.bat
```

Контракт переменных и команда `ibcmd`: **`docs/design/e2e-container-matrix-ibcmd.md`** (§6.5); эталонные пути среды заказчика — **`docs/research/e2e-container-matrix-ibcmd.md`**.

Опция **`-await-user-close`** — после прогона окно VS Code остаётся открытым до ручного закрытия (удобно, чтобы поставить breakpoint/исключение и накликать ошибок):
```bash
npm run test:smoke -- -await-user-close
# или
.\smoke-tests.bat -await-user-close
```

Запуск открывает workspace `test/fixtures/designer-config`, активирует расширение, рекурсивно обходит дерево, открывает все формы (Form.xml) и выполняет команды без модального ввода. При **любом падении** создаётся папка `smoke-artifacts/<timestamp>/` в корне workspace с файлами `failures.json` и `summary.md`. При успешном прогоне папка артефактов не создаётся.

**Ограничения smoke:** из теста недоступно содержимое webview (редактор форм, панель свойств, редактор типа) — проверяется только факт выполнения команды без исключения. Команды с интерактивным вводом (создать элемент, переименовать, экспорт логов, создать форму и т.д.) в smoke не вызываются. Кнопки внутри webview не «нажимаются».

Подробнее: [DEVELOPING.md](DEVELOPING.md).

### Линтинг

```bash
npm run lint
```

Быстрая проверка перед PR (строгий линт, линт async для тестовых entrypoints, core-набор без VS Code):

```bash
npm run verify
```

### Форматирование

```bash
npm run format
```

## Архитектура

Расширение использует следующую архитектуру:

1. **Extension** — точка входа, регистрация команд и провайдеров
2. **MetadataParser** — парсинг XML (Designer / EDT), фасад над `DesignerParser` и `EdtParser`
3. **TreeDataProvider** — VS Code TreeDataProvider API и фильтры
4. **TreeNode** — модель узла дерева
5. **FormEditorProvider / RolesRightsEditorProvider** — кастомные редакторы XML в webview
6. **MetadataWatcherService + ReloadCoordinatorService** — реакция на внешние правки файлов

### Поток данных

```
Workspace → FormatDetector → MetadataParser → TreeNode → TreeDataProvider → VS Code Tree View
```

Детальная карта каталогов `src/`, сервисов и тестов: [docs/architecture.md](docs/architecture.md).

### Документация для разработчиков

- [docs/documentation-map.md](docs/documentation-map.md) — порядок чтения (исследование → критерии → планы → код)
- [docs/developer-backlog.md](docs/developer-backlog.md) — приоритетный backlog с ссылками на GitHub issues
- [docs/manifest.md](docs/manifest.md) — контракт изменений на диске
- [docs/plans/issue-bsl-common-module-tree-plan.md](docs/plans/issue-bsl-common-module-tree-plan.md) — план по дереву общих модулей / BSL (#21, #25)
- [DEVELOPING.md](DEVELOPING.md) — сборка и тесты

## Производительность

- **Ленивая загрузка**: Дочерние элементы загружаются только при развёртывании узла
- **Кэширование**: Используется Map для быстрого поиска узлов по ID
- **Асинхронность**: Все операции ввода-вывода выполняются асинхронно

## Известные ограничения

1. Тесты запускаются через `npm test` (Mocha), `.\test-suite.bat` (консольные тесты) или `npm run test:smoke` (smoke в среде VS Code).
2. Поддерживаются только конфигурации в формате EDT и Designer.
3. Для очень больших конфигураций (100K+ элементов) может потребоваться дополнительная оптимизация.
4. Smoke-тесты не проверяют содержимое webview и не вызывают команды с модальными диалогами (см. раздел «Запуск тестов»).

## Вклад в проект

Приветствуются pull requests! Для крупных изменений сначала откройте issue для обсуждения.

## Лицензия

[MIT](LICENSE) - делайте с этим кодом все, что захотите, Open Source, but AS IS. 
Донаты приветствуются в виде опен-роутер/антропик токенов


## Поддержка

Если у вас возникли проблемы или вопросы:
1. Проверьте [Issues](https://github.com/lekot/VScodePluginFor1CDev/issues)
2. Создайте новый Issue с описанием проблемы
3. Приложите логи из Output канала **CDT 41**
