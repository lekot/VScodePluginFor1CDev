# Backlog для разработчика (синхрон с gap и GitHub)

Источник приоритетов: [research/cdt-vs-edt-functional-gap.md](research/cdt-vs-edt-functional-gap.md) (§11.3, §12–§13). При расхождении с трекером **главенствует GitHub issues**.

## Топ-3 разрыва по свежему снимку EDT-killer (аналитика)

Исполнение по компании ведётся в [AIF-19](/AIF/issues/AIF-19) **по этому разделу и** [plans/fe-next-top3-sprint-spec.md](plans/fe-next-top3-sprint-spec.md), а не по «верхним строкам» таблицы «Высокий приоритет» ниже без учёта вынесения [#27](https://github.com/lekot/VScodePluginFor1CDev/issues/27) из спринт-пакета ([AIF-40](/AIF/issues/AIF-40)).

Актуализация чеклиста: [analytics/edt-killer-target.md](analytics/edt-killer-target.md) §4 (после интеграции диагностик / PR #34). Для закрытия уровней **A и B** по продуктовым критериям сейчас наиболее критичны:

**Спринт-спека для FE (топ-3):** [plans/fe-next-top3-sprint-spec.md](plans/fe-next-top3-sprint-spec.md) — краткие спеки, критерии приёмки в духе EDT-killer, зависимости и риски по пунктам ниже.

1. **Роли и RLS** — матрица паритета с EDT и сохранение ограничений без потерь: [#28](https://github.com/lekot/VScodePluginFor1CDev/issues/28), [#18](https://github.com/lekot/VScodePluginFor1CDev/issues/18) (критерий A.5).
2. **Проверка конфигурации / задачи VS Code** — доведение контура [#30](https://github.com/lekot/VScodePluginFor1CDev/issues/30) до критерия **D.1** ([edt-killer-target.md](analytics/edt-killer-target.md)): задачи + документированный отчёт; UI расширения — следующий шаг. *Редактор форм [#27](https://github.com/lekot/VScodePluginFor1CDev/issues/27) по решению владельца вынесен из текущего спринт-скопа аналитики — см. комментарий в [AIF-40](/AIF/issues/AIF-40#comment-0a29a5b9-e5dc-41bf-bcfc-a2c6652510da) и [fe-next-top3-sprint-spec.md](plans/fe-next-top3-sprint-spec.md).*
3. **Состав подсистем и макеты / печать** — критерии **B.3 → B.2** по приоритету исполнения ([AIF-40](/AIF/issues/AIF-40#comment-aa2fc814-607e-41a7-a3e3-e77b1e712bde)): **сначала B.3** (редактирование состава подсистем из CDT с валидацией ссылок); **B.2** — реализация в CDT или явный задокументированный offload без «тихих» дыр. Детали — [fe-next-top3-sprint-spec.md](plans/fe-next-top3-sprint-spec.md) §3.

## Высокий приоритет (матрица «боль × дёшево»)

| Тема | Issue | Действие |
|------|-------|----------|
| Сохранение RLS без потерь / webview | [#18](https://github.com/lekot/VScodePluginFor1CDev/issues/18) | Закрыть сценарии из §5 gap; добавить регрессионные тесты на round-trip XML. |
| Проверка конфигурации из VS Code / задачи | [#30](https://github.com/lekot/VScodePluginFor1CDev/issues/30) | **Частично:** VS Code Run Task + `ibcmd` + [DEVELOPING.md](../DEVELOPING.md) — PR [feat/issue-30-ibcmd-tasks](https://github.com/lekot/VScodePluginFor1CDev/compare/main...feat/issue-30-ibcmd-tasks?expand=1); отчёт в UI расширения — следующий шаг. |
| Merge / обновления конфигурации | [#12](https://github.com/lekot/VScodePluginFor1CDev/issues/12) | Уточнить scope с PM; высокая боль при апдейтах. |
| Стабилизация редактора форм | [#27](https://github.com/lekot/VScodePluginFor1CDev/issues/27) | Критерии уровня B в [edt-killer-target.md](analytics/edt-killer-target.md). |
| BSL / общий модуль в дереве | [#21](https://github.com/lekot/VScodePluginFor1CDev/issues/21) | См. [plans/issue-bsl-common-module-tree-plan.md](plans/issue-bsl-common-module-tree-plan.md). |
| Отчёты, СКД, запросы | [#26](https://github.com/lekot/VScodePluginFor1CDev/issues/26) | Уровень C; дробить на подзадачи. |
| ИБ / отладка | [#29](https://github.com/lekot/VScodePluginFor1CDev/issues/29) | Документированный контур + критерии уровня D. |

## Средний приоритет

| Тема | Issue | Действие |
|------|-------|----------|
| Расширения конфигураций | [#4](https://github.com/lekot/VScodePluginFor1CDev/issues/4) | Покрытие сценариев §8 gap. |
| Плейсхолдер пустой ТЧ | [#19](https://github.com/lekot/VScodePluginFor1CDev/issues/19) | Согласовать с `treeNormalization` / парсером. |
| Паритет прав с EDT | [#28](https://github.com/lekot/VScodePluginFor1CDev/issues/28) | Матрица объектов/прав; схемная валидация RLS (gap §12). |
| Мастера FilterCriterion / ChartOfAccounts | [#22](https://github.com/lekot/VScodePluginFor1CDev/issues/22), [#23](https://github.com/lekot/VScodePluginFor1CDev/issues/23) | Зависимость от шаблонов и ibcmd (см. `IBMATRIX_SKIP_TYPE_FOLDER_IDS` в `matrixTargetPredicate.ts`). |
| Дерево отдельно от XML | [#7](https://github.com/lekot/VScodePluginFor1CDev/issues/7) | Архитектурный рефакторинг. |

## Ниже по очереди / стратегия

| Тема | Issue | Примечание |
|------|-------|------------|
| Платформенная семантика BSL + сквозной рефакторинг | [#25](https://github.com/lekot/VScodePluginFor1CDev/issues/25) | Не дублировать LSP; чёткая граница с CDT. |
| Хвост §8 | [#31](https://github.com/lekot/VScodePluginFor1CDev/issues/31) | Доп. типы метаданных. |

## Инженерный «wow»-backlog (gap §12)

- Схемы контрактов (Zod/аналог) для XML и версий xmlns.
- Загрузка крупного состояния webview через `postMessage` вместо встраивания JSON в HTML.

## Новые тикеты (предложение)

- Отдельный issue на **сжатие ветки CommonModules** (gap §13), если не покрывается полностью #21/#25.
