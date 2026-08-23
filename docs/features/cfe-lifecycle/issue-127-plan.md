# План issue #127 — перехваты и формы CFE

План реализует выбранный вариант из `issue-127-design.md`. Контракты не переопределяются в ходе
реализации; изменение контракта требует возврата на design/spec review.

## Коммит 1 — structural BSL interceptors

Файлы: CFE BSL scanner/model/service под `src/extensionSupport/cfeProject`, application facade,
BSL fixtures и unit tests.

Изменения: UUID-разрешение adopted target в связанной CF, проверка module kind, структурное
извлечение метода, генерация четырёх видов перехватов, idempotency/conflict/hash semantics,
PropertyState gate, MutationPlan/CAS/rollback.

Контракты: `CfeInterceptorKind`, `CfeModuleKind`, `CfeCreateInterceptorRequest/Outcome`,
`CfeProjectService.createInterceptor`.

## Коммит 2 — CFE form domain

Файлы: ordered form parser/serializer, form identity/dependency resolver, ID allocator,
application service, XML fixtures `2.17`–`2.21` и unit tests.

Изменения: create own form, borrow adopted form с Part1/BaseForm, extend form аддитивными
операциями, сохранить callType и несколько Action, выделять ID от 1000000, применять format gates,
dependency closure, CAS/rollback.

Контракты: `CfeCreateOwnFormRequest`, `CfeBorrowFormRequest`, `CfeExtendFormRequest`,
`CfeFormOperation`, `CfeFormMutationOutcome`, методы `createOwnForm/borrowForm/extendForm`.

## Коммит 3 — editor guard и UI adapters

Файлы: `src/formEditor/*`, extension-support commands/registration, UI tests.

Изменения: распознавать adopted form context, блокировать generic Save/handler write, добавить
тонкие UI-вызовы application service, обновлять дерево после commit. Own forms не меняют поведение.

Контракты: общий `CFE_ADOPTED_OPERATION_REQUIRED`; UI не содержит XML/BSL mutation logic.

## Коммит 4 — Agent/MCP adapters и documentation

Файлы: Agent CFE operations/commands, MCP CFE catalog/schemas, package manifest, README,
Agent API/MCP docs и exact coverage tests.

Изменения: зарегистрировать четыре Agent-команды и четыре MCP tools, strict schemas/refinements,
annotations, DTO/error mapping, актуальные exact counts и описание поддержанной матрицы.

Контракты: MCP вызывает ровно одноимённую Agent-команду; runtime и catalog множества равны.

## Коммит 5 — quality gate и platform round-trip

Файлы: integration/platform fixtures и отчёт issue; production code меняется только по findings.

Изменения: полный core/smoke/compile/lint gate, real 1C 8.3.27 import/apply/export для interceptor,
own form и borrowed/extended form, package audit. После зелёного gate — коммит, PR, CI и merge
commit; issue закрывается только после проверки merge и platform artifacts.
