# План реализации CFE lifecycle

План является приложением к `design.md`; контракты и инварианты определяются дизайном.

## Коммит 1 — CFE project context и scaffold

Файлы: `src/services/configurationSession/*`, новый `src/extensionSupport/cfeProject/*`,
`src/parsers/formatDetector.ts`, `src/bindings/bindingPathUtils.ts`, registration/UI commands,
Agent CFE operations/commands и MCP catalog, unit/contract fixtures.

Изменения: добавить versioned manifest и registry, точное сопоставление двух sessions, безопасное
создание/rollback минимального CFE, discovery refresh, распознавание `ConfigurationExtensions`,
точный выбор CFE binding/deploy, list/get/validate/create команды и MCP parity.

Контракты: `CfeProjectManifestV1`, `CfeProjectContext`, `CfeCreateProjectRequest/Outcome`,
`CfeApplicationService.listProjects/getContext/validate/createProject`.

## Коммит 2 — ownership-aware CRUD и borrow

Файлы: новый CFE domain/ownership слой, `src/services/elementOperations.ts`, Agent metadata
operations/DTO, tree/properties providers, CFE Agent/MCP catalog, XML fixtures и tests.

Изменения: классифицировать own/adopted по XML, защитить generic mutation paths, применять prefix
к own create, разрешать adopted source только по UUID связанной CF, атомарно заимствовать объект с
GeneratedTypes/зависимостями, публиковать ownership/source UUID в read API.

Контракты: `CfeObjectIdentity`, `CfeOwnershipGuard`, `CfeBorrowObjectRequest/Outcome`,
`CfeApplicationService.borrowObject` и расширенные read DTO.

## Коммит 3 — перехваты

Файлы: CFE BSL domain/parser, application service, extensionSupport UI adapters, Agent/MCP catalog,
module fixtures/tests.

Изменения: заменить name/regex-only write semantics структурным разрешением метода и директив,
добавить before/after/instead/changeAndValidate, идемпотентность, conflict detection и проверку
версии исходного метода.

Контракты: `CfeInterceptorKind`, `CfeCreateInterceptorRequest/Outcome`,
`CfeApplicationService.createInterceptor`.

## Коммит 4 — собственные и заимствованные формы

Файлы: CFE form domain/serializer/ID allocator, `src/formEditor/*`, application service,
Agent/MCP catalog, form fixtures/tests 2.17–2.21.

Изменения: создать own form, канонически borrow base form с зависимостями, ограничить generic edit
adopted form, добавить extendForm для элементов/атрибутов/команд/handlers, соблюдать BaseForm,
Part1, ID ranges, callType и versioned PropertyState.

Контракты: `CfeBorrowFormRequest`, `CfeExtendFormRequest`, `CfeFormMutationOutcome`,
`CfeApplicationService.createOwnForm/borrowForm/extendForm`.

## Коммит 5 — матрица, документация и release gate

Файлы: `test/suite/*`, platform/matrix scripts и fixtures, README/Agent API docs/changelog/package
metadata только по фактически выпущенным возможностям.

Изменения: negative/security/rollback/CAS tests, Agent↔MCP exact coverage, XML matrix 2.17–2.21,
реальный round-trip 8.3.27, package audit, compile/test/smoke/build-all, release notes.

Контракты: все публичные команды документированы; release gate не допускает непокрытую Agent
команду, устаревший MCP count или непроверенный VSIX.
