# WOW — Infobase Manager Feature

> **W**orkspace **O**rchestration for **W**orkbases (1С Infobases)

## Обзор

Фича «Infobase Manager» добавляет в расширение CDT 41 возможность управления информационными базами 1С прямо из VS Code через утилиту автономного сервера **ibcmd**.

## Документы

| Документ | Описание |
|----------|----------|
| [infobase-manager-design.md](./infobase-manager-design.md) | Основной дизайн-документ: цели, модель данных, архитектура, фазы |
| [infobase-manager-use-cases.md](./infobase-manager-use-cases.md) | Детальные Use-Cases и User Journeys |
| [infobase-manager-wireframes.md](./infobase-manager-wireframes.md) | UI/UX wireframes: панель, диалоги, уведомления |
| [ibcmd-api-reference.md](./ibcmd-api-reference.md) | Справочник команд ibcmd для реализации |
| [ibcmd-cdt41-principles.md](./ibcmd-cdt41-principles.md) | **Норматив CDT 41:** offline `--data`, `--db-path`, порядок argv, export/import, кодировка (YouTrack: 1cviewer-12) |
| [v8i-format-spec.md](./v8i-format-spec.md) | Спецификация формата .v8i с парсером |
| [infobase-server-dbms-rights.md](./infobase-server-dbms-rights.md) | Серверная ИБ: права в СУБД и ответственность администратора (WOW §3B) |

## Ключевые возможности

### MVP (Phase 1)
- ✅ Настройка пути к ibcmd
- ✅ View со списком баз
- ✅ Добавление существующей файловой базы
- ✅ Import/Export конфигурации
- ✅ Запуск Предприятия/Конфигуратора

### Phase 2
- ⬜ Создание новой базы
- ⬜ Серверные базы
- ⬜ Импорт .v8i
- ⬜ Статусы баз

### Phase 3
- ⬜ Группировка (папки)
- ⬜ Экспорт в .v8i
- ⬜ Сравнение конфигураций

## Быстрый старт для разработчика

### Структура модулей

```
src/
├── infobases/
│   ├── infobaseManager.ts        # Управление списком
│   ├── infobaseTreeProvider.ts   # TreeDataProvider
│   ├── infobaseCommands.ts       # Команды
│   ├── infobaseStorage.ts        # Персистентность
│   ├── v8iParser.ts              # Парсер .v8i
│   └── models/
│       ├── infobaseEntry.ts
│       └── connectionString.ts
├── services/
│   ├── ibcmdService.ts           # Обёртка ibcmd
│   └── platformLauncher.ts       # Запуск 1cv8.exe
```

### Команды

```typescript
// Регистрация в package.json
"contributes": {
  "commands": [
    { "command": "1c-metadata-tree.infobases.create", "title": "Создать базу" },
    { "command": "1c-metadata-tree.infobases.add", "title": "Добавить существующую" },
    { "command": "1c-metadata-tree.infobases.importV8i", "title": "Импорт из .v8i" },
    { "command": "1c-metadata-tree.infobase.configImport", "title": "Загрузить конфигурацию" },
    { "command": "1c-metadata-tree.infobase.configExport", "title": "Выгрузить конфигурацию" },
    { "command": "1c-metadata-tree.infobase.openEnterprise", "title": "Открыть в Предприятии" },
    { "command": "1c-metadata-tree.infobase.openDesigner", "title": "Открыть Конфигуратор" }
  ]
}
```

### Настройки

```typescript
// В package.json contributes.configuration
"1cMetadataTree.ibcmd.path": {
  "type": "string",
  "description": "Путь к ibcmd"
},
"1cMetadataTree.platform.path": {
  "type": "string", 
  "description": "Путь к 1cv8.exe"
},
"1cMetadataTree.ibcmd.timeout": {
  "type": "number",
  "default": 600000
}
```

## Зависимости

- **ibcmd** — утилита автономного сервера 1С (8.3.27+)
- **1cv8.exe** — клиент 1С:Предприятие (для запуска баз)

## Риски

| Риск | Митигация |
|------|-----------|
| ibcmd недоступен | Graceful degradation, инструкции |
| Блокировки баз | Проверка статуса, информативные сообщения |
| Долгий import | Progress с отменой, настраиваемый таймаут |

## Открытые вопросы

1. Хранение списка баз: workspace vs global?
2. Автоопределение ibcmd в стандартных путях?
3. Поддержка расширений 1С отдельно от основной конфигурации?

---

**Статус:** Draft  
**Дата:** 2026-03-27
