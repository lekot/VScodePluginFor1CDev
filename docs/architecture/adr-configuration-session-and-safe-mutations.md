# ADR: ConfigurationSession и безопасные мутации конфигурации

**Статус:** Принят; инфраструктурная часть реализована
**Дата:** 2026-07-18
**Область:** multi-root routing, reload, watcher/process lifecycle, запись Designer/EDT metadata
**Связанный RFC:** [Staged Metadata Session Model (RAM-safe)](rfc-staged-metadata-session-model.md)

**Состояние реализации:** На ветке `feat/architecture-review-hardening` реализованы identity/registry,
per-configuration routing и reload, безопасный mutation/storage gateway с durable recovery,
containment, а также lifecycle watcher'ов и процессов. Связанный staged RFC (`BaseSnapshot +
PendingOps + lazy Overlay`) остаётся будущим направлением и принятием этого ADR не объявляется
реализованным.

**Проверка:** `npm run verify` завершён с кодом 0; VS Code smoke — 10 passed и 1 pending
opt-in deploy; локальная matrix на полной временной копии `FormatSamples/empty_conf` — 15 passed,
0 failed, 0 skipped. Реальная ibcmd/import-проверка платформой не выполнялась, потому что её
opt-in окружение не было настроено.

---

## 1. Контекст и проблема

Расширение уже умеет находить несколько конфигураций, но изменяющие команды, reload, watcher'ы, процессы и файловые writer'ы не объединены одной границей владения. Часть API выбирает первую найденную конфигурацию, reload координируется по строковому пути, watcher'ы пересоздаются при глобальной загрузке дерева, а разные редакторы используют разные варианты backup/rollback.

Это создаёт один класс системных рисков:

- команда может изменить не ту конфигурацию в multi-root workspace;
- reload, watcher и мутация могут видеть разные поколения файлового состояния;
- параллельные записи одного XML или набора связанных XML могут потерять изменения;
- best-effort `.bak` не даёт восстанавливаемого контракта для многофайловой операции;
- отмена или dispose во время записи/внешнего процесса не имеют единой семантики;
- глобальный lifecycle не выражает, кто владеет watcher'ом, процессом и незавершённой операцией конкретной конфигурации.

Нужна единая runtime-граница на конфигурацию, не требующая одномоментного переписывания всех providers, parsers и команд.

### 1.1. Связь со staged RFC

Этот ADR **не заменяет и не конкурирует** с `rfc-staged-metadata-session-model.md`.

- RFC определяет модель редактирования: `BaseSnapshot + PendingOps + lazy Overlay` и применение staged-операций через `Save/Apply`.
- Этот ADR определяет lifecycle и consistency boundary, внутри которой живёт эта модель: identity конфигурации, владение ресурсами, сериализация reload/мутаций и безопасный commit на диск.
- `BaseSnapshot` RFC становится snapshot'ом `ConfigurationSession`; `PendingOps` и lazy `Overlay` остаются без полного клона дерева.
- `PendingOps` — доменный журнал ещё не применённых пользовательских изменений. Описанный ниже `MutationJournal` — отдельный durability-журнал уже начатой транзакции записи. Их нельзя объединять или трактовать как взаимозаменяемые.
- Поэтапное внедрение `ConfigurationSession` является инфраструктурной предпосылкой для итераций RFC, но staged-редактирование не включается автоматически этим ADR.

## 2. Цели и нецели

### Цели

1. Любая читающая или изменяющая операция адресует конкретную конфигурацию стабильным identity.
2. В одной конфигурации одновременно выполняется не более одной мутации и одного согласованного reload pipeline.
3. Разные конфигурации не блокируют друг друга.
4. Запись проверяет границу root, ожидаемую версию и предоставляет детерминированный rollback/recovery.
5. Watcher'ы и дочерние процессы имеют явного владельца и завершаются вместе с сессией.
6. Миграция сохраняет текущие UI и Agent сценарии для workspace с одной конфигурацией.
7. Решение совместимо с RAM-safe staged-моделью и не создаёт второй полный граф дерева.

### Нецели

- Полный перевод всех write surfaces в одной поставке.
- Распределённая транзакция между разными конфигурациями или информационными базами.
- Автоматический semantic merge внешних изменений.
- Обещание физической атомарности набора файлов: файловые системы дают атомарную замену отдельного файла, а для набора файлов гарантируется recoverability через журнал и rollback.
- Полная поддержка virtual workspaces. До URI-native реализации изменяющие сессии допустимы только для `file` URI; manifest должен честно фиксировать это ограничение.

## 3. Рассмотренные варианты

### Вариант A — укрепить существующие сервисы

Добавить `configurationId` в команды, исправить выбор первой конфигурации, расширить текущий `ReloadCoordinatorService` и переиспользовать общий atomic writer, сохранив глобальные `ExtensionState`, массив watcher'ов и независимые writer'ы.

**Плюсы:** минимальный diff, быстрый выпуск отдельных исправлений, мало адаптеров.
**Минусы:** владение остаётся распределённым; identity, reload и write-lock легко снова обойти; staged RFC придётся интегрировать с несколькими глобальными сервисами; dispose/recovery по-прежнему не локализованы.
**Вердикт:** годится как набор срочных патчей, но не как целевая архитектура.

### Вариант B — big-bang workspace actor и event sourcing

Заменить providers/команды единым workspace actor, сделать все изменения persistent events, а дерево полностью проецировать из event log. Watcher'ы, процессы, reload и storage сразу перевести на actor messages.

**Плюсы:** строгая последовательность событий, сильная replay/recovery модель, единый путь для staged и immediate mutations.
**Минусы:** слишком большой migration blast radius; высокий риск несовместимости редакторов и Agent API; event schema становится долгосрочным публичным обязательством; противоречит поэтапному rollout RFC и откладывает исправление текущих рисков.
**Вердикт:** архитектурно чисто, но неприемлемо для текущего продукта.

### Вариант C — прагматичная миграция к ConfigurationSession

Ввести `WorkspaceRegistry`, который создаёт одну `ConfigurationSession` на физическую конфигурацию. `ConfigurationSession` является facade/composition boundary: она объединяет отдельные snapshot, watcher, reload, mutation, storage и process-компоненты, но не реализует их в одном god object. Текущие commands/providers переходят через совместимые фасады по одному write surface.

**Плюсы:** устраняет неоднозначную маршрутизацию и гонки в явной границе; допускает параллельность разных конфигураций; переиспользует текущие parser/tree и staged RFC; поддерживает постепенный rollout и rollback миграции.
**Минусы:** во время миграции существуют legacy adapters; необходимо запретить двойной write path; session/registry добавляют состояния и требуют дисциплины identity во всех контрактах.
**Вердикт:** выбран.

## 4. Решение

Принять `ConfigurationSession` как единственную целевую границу чтения, reload и мутации одной конфигурации. `WorkspaceRegistry` является единственным владельцем сессий и единственным местом преобразования workspace/resource context в `ConfigurationId`.

Сессия — фасад над независимо тестируемыми портами `SnapshotStore`, `ReloadGate`, `MutationQueue`, `ConfigurationStorage`, `MetadataWatcher` и `ProcessScope`. Фасад задаёт их общий lifecycle и consistency boundary, но не переносит реализацию этих ответственностей в один класс.

### 4.1. Компонентная модель

```text
VS Code UI / Agent API / deploy commands
                  |
        explicit ConfigurationId
                  v
          WorkspaceRegistry
          /       |        \
   Session A   Session B   Session C
      |            |           |
 snapshot      reload gate   mutation queue
 watcher       atomic store  journal/processes
      \____________|___________/
                   |
          Designer/EDT files
```

`ExtensionState` в целевой модели хранит registry и глобальные UI providers, но не владеет отдельными watcher'ами и reload slots. Registry владеет сессиями; сессия владеет только ресурсами configuration scope. Ресурсы других scopes описаны в §5.8 и не должны искусственно привязываться к первой конфигурации.

## 5. Контракты

### 5.1. Identity конфигурации

`ConfigurationIdentity` содержит:

| Поле | Контракт |
|---|---|
| `configurationId` | Непрозрачный ID, стабильный в пределах существования physical root и сохранённого versioned mapping. Не является display name или индексом в массиве. |
| `rootUri` | Канонический URI корня конфигурации. Для `file` URI учитывает `realpath`, нормализацию разделителей и чувствительность файловой системы к регистру. |
| `workspaceFolderUris` | Непустое множество workspace folders, через которые доступен root. Primary folder нужен только для UI и может изменяться без смены ID. |
| `format` | Фактически обнаруженный `Designer` или `EDT`; формат не включается в ID, чтобы повторная детекция не меняла identity. |
| `descriptorUri` | Канонический `Configuration.xml` либо `src/Configuration/Configuration.mdo`; не фабрикуется путь к отсутствующему файлу. |
| `capabilities` | Read/write/process capabilities, вычисленные из URI scheme, workspace trust, формата и доступных инструментов. |

Правила identity:

1. Один и тот же физический root, обнаруженный через symlink или перекрывающиеся workspace folders, создаёт одну сессию и список aliases, а не дубликаты.
2. Display label вычисляется отдельно и может меняться без смены ID.
3. `ConfigurationId` хранится в versioned internal mapping `identity fingerprint -> random ID`. Fingerprint включает canonical physical root и стабильный UUID конфигурации из descriptor (не content hash); mapping переживает restart. Если UUID недоступен, используется persisted root mapping с degraded identity health. Rename/move root создаёт новый ID, пока миграция identity не доказана явным file identity; замена descriptor другой конфигурацией по тому же пути также создаёт новый ID. Старые ID никогда молча не переназначаются.
4. Resource routing выбирает наиболее глубокий canonical root, содержащий URI. Для существующих paths используется `realpath`; для create — `realpath` ближайшего существующего parent, `lstat` каждого последующего сегмента и повторная проверка перед disk effect. Absolute path, `..`, symlink/junction escape отклоняются. Гарантия защищает от случайных и наблюдаемых внешних изменений; против враждебной замены filesystem namespace между системными вызовами абсолютная защита не заявляется.
5. Case semantics определяются фактическими свойствами volume/directory. Нельзя безусловно lower-case все Windows paths: case-sensitive directory сохраняет регистр в identity.
6. Неявный выбор разрешён только если registry содержит ровно одну совместимую конфигурацию. При нуле возвращается `CONFIGURATION_NOT_FOUND`, при нескольких — `CONFIGURATION_SELECTION_REQUIRED`. Выбор `configs[0]` запрещён.
7. Agent API получает операцию перечисления конфигураций и принимает `configurationId` во всех config-scoped командах. Legacy-вызов без ID допустим только по правилу единственной конфигурации.

### 5.2. WorkspaceRegistry

Registry предоставляет следующие логические операции:

- `refresh(authoritativeDiscovery, cancellation) -> RegistryDiff`: канонизирует полный discovery snapshot, создаёт новые сессии, обновляет aliases/capabilities и переводит исчезнувшие сессии в detach flow;
- `list() -> ConfigurationDescriptor[]`: возвращает identity, label, format, capabilities и health без раскрытия mutable session state;
- `require(configurationId) -> ConfigurationSession`: exact lookup либо typed error;
- `resolveResource(uri) -> ConfigurationSession`: canonical containment и наиболее специфичный root;
- `resolveLegacyDefault(requiredCapability) -> ConfigurationSession`: только zero/one policy из раздела identity;
- `dispose()`: запрещает новые lookup/операции, dispose'ит все сессии и дожидается bounded cleanup.

`refresh` сам является single-flight на workspace level. Новый полный discovery snapshot, пришедший во время refresh, заменяет pending snapshot; одновременно два diff не применяются. Partial, cancelled или завершившийся ошибкой discovery не считается доказательством исчезновения root и не dispose'ит сессии. Session с тем же identity fingerprint переиспользуется, поэтому refresh не пересоздаёт watcher и процессы без причины. Смена descriptor/format требует нового fingerprint либо явного controlled transition без active mutation/PendingOps.

Исчезнувшая из authoritative snapshot сессия сначала переходит в `detached`. Новые операции запрещены, но active critical section, recovery и пользовательское решение по `PendingOps` завершаются по обычным правилам. Без pending/recovery ресурсов detach сразу переходит в dispose; иначе UI предлагает Apply, Discard или экспорт pending log и хранит tombstone до bounded retention. Удаление одной overlapping workspace folder только обновляет `workspaceFolderUris`, пока остаётся другой alias.

### 5.3. ConfigurationSession

Сессия имеет монотонные `sessionGeneration` и `snapshotVersion`, health (`initializing`, `ready`, `degraded`, `detached`, `disposing`, `disposed`) и следующие логические границы:

- `read`: возвращает immutable structural view конкретной `snapshotVersion`; lazy caches принадлежат версии и материализуют новые immutable child payloads, не изменяя уже выданные collections;
- `reload`: проходит через per-session single-flight gate;
- `mutate`: ставит операцию в per-session FIFO queue;
- `runProcess`: регистрирует дочерний процесс и его cancellation/cleanup policy;
- `stage/apply`: в будущих итерациях RFC управляет `PendingOps` и overlay внутри той же сессии;
- `dispose`: закрывает вход, отменяет очередь, завершает owned resources и переводит сессию в terminal state.

Публичные результаты всегда содержат `configurationId`, `operationId` и итоговую `snapshotVersion`. Это позволяет UI, Agent и логам не спутать ответы разных конфигураций или старых поколений.

### 5.4. Single-flight reload

1. В одной сессии выполняется не более одного reload pipeline.
2. В начале pass gate фиксирует `capturedEpoch` — монотонный максимум session event sequence. Вызов совместим с in-flight pass, если его `requestedEpoch <= capturedEpoch` и он не требует более сильного режима parse; он получает тот же completion.
3. Событие с большим epoch или более сильным режимом заменяет единственный pending request. После каждого pass допускается максимум один queued follow-up, который при старте захватывает новый epoch. События во время follow-up могут аналогично создать следующий queued pass; ограничение относится к одному текущему pass, а не ко всей бесконечной серии событий.
4. Reload не публикует частично построенное дерево. Новый structural snapshot, load contexts и lazy cache generation становятся видимыми одной заменой после успешного parse. Поздняя lazy materialization публикуется только в cache той же `sessionGeneration/snapshotVersion`; выданные ранее immutable collections не мутируют.
5. Ошибка сохраняет последний согласованный snapshot и переводит health в `degraded`; следующий explicit retry разрешён.
6. Reload, запрошенный во время мутации, ждёт commit/rollback queue barrier. Watcher-события от внутренних записей коалесцируются по transaction metadata, а не только по TTL.
7. Reload разных сессий не имеет общей consistency/ordering зависимости. Общий resource scheduler может временно задержать старт из-за настраиваемого CPU/I/O лимита, включая лимит 1, но одна сессия не удерживает semantic lock другой.

Отмена ожидания одним caller не отменяет общий reload для остальных. Внутренний reload отменяется только dispose сессии или отменой ещё не начатой queued работы; публикация snapshot после dispose запрещена generation guard'ом.

### 5.5. Per-config mutation queue

Request мутации имеет `operationId`, `configurationId`, `kind`, optional `clientSnapshotVersion`, cancellation token и декларацию требуемых capabilities. Точный transaction plan, target URI и expected hashes строятся внутри очереди, а не доверяются caller.

Queue contract:

1. FIFO и не более одной активной мутации на сессию; разные сессии не имеют общей consistency/ordering зависимости.
2. `dequeue` захватывает текущую `baseSnapshotVersion`. Поэтому несколько запросов, поставленных из одного UI snapshot, не становятся автоматически stale после commit предыдущего запроса. Если caller явно потребовал strict optimistic check через `clientSnapshotVersion`, несовпадение возвращает conflict до prepare.
3. До prepare проверяются session health, trust/capabilities, canonical root boundary и identity цели. План получает expected hashes из состояния на dequeue; непосредственно перед первым disk effect hashes и containment revalidate'ятся. Изменение target после dequeue завершается конфликтом. Изменение несвязанного файла не отклоняет операцию только из-за глобальной версии snapshot.
4. Active mutation получает эксклюзивный write lease. Reload публикация и другая internal mutation не пересекают lease. Смена trust/capability до critical section отменяет операцию; после первого disk effect critical section доводится до terminal outcome по правилам §5.9.
5. Read-only процессы могут выполняться параллельно только с зафиксированной snapshot version. Управляемый расширением write plan идёт через `ConfigurationStorage`; произвольно изменяющий внешний процесс использует отдельный `externalMutation` contract §5.8 и не получает ложной rollback-гарантии storage.
6. После commit очередь инициирует один reconcile reload. Его watcher-дубликаты объединяются с тем же `operationId`.
7. Legacy surface после миграции обязан вызывать session queue; прямой writer параллельно с session path запрещён.
8. Если UI `PendingOps` существуют, immediate Agent/deploy mutation этой сессии возвращает `PENDING_UI_CHANGES`, пока пользователь не выполнит Apply/Discard. Это сохраняет immediate semantics Agent API и исключает неявный rebase staged UI state.

### 5.6. Atomic storage и граница файловой системы

`ConfigurationStorage` является единственным целевым disk commit gateway для управляемых расширением записей. Он принимает построенный внутри session transaction plan. Outcomes разделены по уровням:

- `StorageOutcome = committed | rolledBack | conflict | recoveryRequired` описывает только disk transaction;
- `MutationOutcome = committed | cancelled | conflict | failed | recoveryRequired` добавляет queue/preflight/cancellation;
- `ReconcileOutcome = reconciled | committedWithReconcileError` описывает публикацию нового snapshot после уже terminal disk commit.

`committedWithReconcileError` никогда не превращается в rollback диска: применённые `PendingOps` помечаются durable `applied(operationId)`, исключаются из повторного Save и до успешного reconcile отображаются через committed overlay поверх последнего snapshot.

Storage использует два tier:

1. **Tier 1 — single-file replace.** Temp находится в каталоге target, записывается и синхронизируется, затем атомарно заменяет target. Durability-журнал не обязателен: после process crash наблюдается старый или новый файл, а orphan temp безопасно очищается по уникальному operation ID. Single-file delete выполняется через rename в уникальный tombstone и считается Tier 2, если удаление tombstone нужно координировать с другими targets.
2. **Tier 2 — multi-file/directory/destructive plan.** До первого disk effect обязателен `MutationJournal`, backups/tombstones и idempotent recovery §5.7. Rename/delete каталога выполняются только через обратимый move в staging area той же файловой системы; необратимое удаление происходит после terminal commit и успешного reconcile.

Гарантии для каждого файла:

- canonical target находится внутри canonical `rootUri` и имеет допустимую роль в операции;
- перед записью совпадает expected old hash;
- temp-файл создаётся эксклюзивно в каталоге target, записывается и синхронизируется; parent directory синхронизируется там, где платформа предоставляет такую гарантию;
- замена выполняется rename в пределах той же файловой системы;
- post-write content/hash проверяется;
- backup/tombstone Tier 2 не удаляется до durable terminal record и успешного reconcile.

Для нескольких файлов storage не заявляет недоступную файловой системе all-or-nothing атомарность. Вместо этого он применяет детерминированный порядок, записывает прогресс в `MutationJournal` и при сбое откатывает уже заменённые targets в обратном порядке. Создание, удаление и rename каталогов также обязаны иметь обратимый journal step. Если filesystem не позволяет подготовить обратимый plan, операция отклоняется до первого disk effect.

Workspace-relative пути сначала разрешаются как URI и проходят containment по правилам §5.1: `realpath` существующей цели либо ближайшего существующего parent, segment `lstat` и повторная проверка перед effect. Проверки только `basename` недостаточно. В первой версии write capability доступна только для `file` scheme.

Durability guarantee покрывает controlled extension/process crash на поддерживаемой локальной filesystem. Power-loss durability заявляется только там, где runtime/OS подтверждает sync файла и directory entry; в остальных случаях recovery является best effort и это отражается capability/health. Враждебная concurrent подмена filesystem namespace вне threat model, но наблюдаемый hash/containment drift всегда блокирует автоматический overwrite.

### 5.7. Rollback и MutationJournal

Durability-журнал Tier 2 хранится в extension global storage под schema-versioned namespace и `ConfigurationId`, а не внутри пользовательской конфигурации. Каждая версия записи создаётся через temp + atomic replace и синхронизируется в пределах поддерживаемой OS guarantee.

Минимальная journal record содержит transaction/operation ID, configuration identity fingerprint, state, ordered steps, target URI, expected old/new hashes, backup URI, temp URI, completed step index и timestamps.

Для create/delete отсутствие target кодируется отдельным sentinel `ABSENT`, поэтому truth table одинаково применима к файлам и tombstones.

Состояния: `prepared -> committing -> committed`; ветви ошибки — `rollingBack -> rolledBack` либо `recoveryRequired`.

Правила:

- `prepared` фиксируется до первой замены target;
- после каждого disk effect прогресс durable обновляется; crash между effect и обновлением распознаётся по old/new hashes и наличию backup/temp;
- backup удаляется только после terminal commit и успешного reconcile; terminal journal compact'ится в bounded audit record, а не исчезает до подтверждения cleanup;
- при activation registry до запуска watcher'ов сканирует non-cleaned и незавершённые записи и выполняет idempotent recovery/reconcile;
- несовпадение identity или hashes не затирается автоматически: сессия становится `degraded`, write блокируется, пользователю показывается recovery action;
- лог не хранит secrets и имеет retention/size limits;
- journal recovery не подменяет `PendingOps` RFC и не восстанавливает несохранённые staged edits без отдельно включённого `staging.persistLog`.

Recovery truth table:

| Journal/файлы | Решение |
|---|---|
| `prepared`, все targets имеют old hash | Ни один effect не произошёл: удалить temp, отметить `rolledBack`. |
| `committing`, часть targets имеет new hash, остальные old hash, backups совпадают с old hash | Повторить rollback в обратном порядке; каждый шаг idempotent. |
| `committing`, все targets имеют new hash | Довести запись до `committed`, затем запустить reconcile; повторно не применять mutation plan. |
| Journal step index отстаёт, но target уже имеет ожидаемый new hash | Считать step выполненным и продолжить выбранный commit/rollback path. |
| Target не совпадает ни с expected old, ни с expected new hash; backup отсутствует/повреждён | `recoveryRequired`, автоматическая запись заблокирована, доступны inspect/export/manual recovery actions. |
| `committed`, reconcile не подтверждён | Сохранить backups и applied-op marker, повторить только reconcile; disk plan повторно не выполнять. |
| `rolledBack`, все targets имеют old hash | Удалить temp/backups, compact journal в terminal audit record. |

Recovery policy выбирает finish-commit только если все targets уже имеют ожидаемый new hash; смешанное old/new состояние по умолчанию откатывается. Retention terminal audit records и максимальный суммарный размер задаются внутренними константами и проверяются тестами.

### 5.8. Владение watcher'ами и процессами

- У каждой ready session ровно один metadata watcher; registry/session dispose является единственным владельцем его остановки.
- Watcher выдаёт нормализованный batch с URI, event kind, observed hashes/epoch. Он не вызывает глобальный reload напрямую, а передаёт событие session reload gate.
- Во время transaction session регистрирует ожидаемые внутренние изменения. Совпавшие watcher events подтверждают commit и коалесцируются; неожиданные события помечают external drift.
- Если при `PendingOps` RFC обнаружен external drift, безусловный reload запрещён: сессия переходит в conflict flow, сохраняя base/overlay до решения пользователя.
- Resource scopes образуют явную иерархию: `extension -> workspace -> configuration -> infobase -> operation`. Agent bridge/browser относятся к extension/workspace scope, общая информационная база — к infobase scope, watcher конфигурации — к configuration scope, конкретный `ibcmd`/Designer child — к operation scope. Владелец ресурса — ближайший scope, жизненный цикл которого действительно совпадает с ресурсом; запрещено привязывать global/workspace resource к первой конфигурации.
- Каждый дочерний процесс регистрируется в своём scope с operation ID, purpose, start epoch и termination policy. Configuration session агрегирует только config-scoped и дочерние operation handles, но не владеет соседними workspace/infobase scopes.
- Процесс, способный произвольно менять конфигурацию, выполняется как `externalMutation`: получает configuration write lease, фиксирует baseline manifest/hash set и durable факт запуска, но не объявляет ложный точный target plan и не получает автоматической rollback-гарантии `ConfigurationStorage`. После завершения или crash выполняется full drift scan. Нулевой drift даёт terminal no-op; ожидаемый валидный drift — reconcile; неизвестный/частичный drift — `externalDrift`/degraded с ручным inspect/recovery. Exit code сам по себе не доказывает отсутствие изменений.
- Dispose прекращает приём операций, отменяет queued work, посылает cooperative cancellation активным процессам, затем bounded terminate/kill согласно platform policy и дожидается cleanup. Процесс не может публиковать результат в новую generation сессии.

### 5.9. Ошибки и отмена

Все границы возвращают typed error с `code`, `phase`, `configurationId`, `operationId`, safe user message, `retryable` и исходной причиной для логов. Минимальные классы: selection/not-found, unsupported capability, pending UI changes, stale snapshot/hash, external drift, cancelled, parse/reload failure, process failure, write failure, rollback failure и recovery required.

Семантика отмены:

| Момент | Результат |
|---|---|
| Операция в очереди | Удаляется без disk effects, `cancelled`. |
| Preflight/prepare до первой замены | Temp/backup очищаются, созданный Tier 2 journal закрывается как rolled back, `cancelled`. |
| Commit уже заменил хотя бы один target | Caller cancellation запоминается, но critical section доводится до commit либо rollback; промежуточный результат не возвращается как успех. |
| Reconcile reload | Commit остаётся committed; failure даёт `committedWithReconcileError`/degraded health и explicit retry, а не ложный rollback диска. |
| Session dispose | Новые операции отклоняются; queued отменяются; active critical section получает bounded graceful completion, затем recovery journal сохраняется. |

UI показывает одну actionable ошибку. Agent API получает тот же machine-readable code. Логи содержат correlation IDs, но не secrets и не полный чувствительный payload.

### 5.10. Граница staged-редактирования

Первая версия staged RFC применяется только к интерактивным UI surfaces дерева/Properties, где extension может показать dirty state и запросить решение пользователя. Agent API, deploy и automation сохраняют immediate commit semantics через mutation queue. Они не читают неподтверждённый UI overlay и при его наличии получают `PENDING_UI_CHANGES`, а не молча применяют изменения поверх него.

UI reads используют единый effective view `BaseSnapshot + PendingOps + lazy Overlay`. `PendingOps` содержат stable metadata object ID, captured base hashes/version и нормализованную операцию. Overlay является только производным cache: eviction никогда не удаляет пользовательские изменения.

Минимальная алгебра нормализации:

| Последовательность одного object ID | Нормализованный результат |
|---|---|
| `create -> edit/rename` | Один `create` с итоговым именем/props. |
| `create -> delete` | No-op, если на созданный объект нет других pending dependencies. |
| `rename -> rename` | Один rename от base identity к последнему имени. |
| `rename -> editProps` | Rename + patch, адресованные stable object ID, а не старому пути. |
| `rename/edit -> delete` | Один delete; несовместимые dependent ops дают conflict. |
| Delete parent при pending descendants | Явное cascade подтверждение либо conflict; молчаливое удаление ops запрещено. |

Duplicate names, missing parent, cross-object dependencies и reference updates валидируются при добавлении op и повторно при Apply. Неизвестная комбинация не угадывается, а возвращает typed conflict.

До включения первого staged surface уже должны работать session mutation queue и drift fence. Любое внешнее watcher-событие сравнивается с captured base hashes: незатронутое изменение может обновить base после revalidation, пересечение с PendingOps переводит сессию в explicit conflict. Безусловный reload поверх pending state запрещён.

Lifecycle UI:

- первая PendingOp выставляет dirty indicator session/document scope;
- `Apply` выполняет mutation plan через queue/storage и удаляет ops только после durable applied marker;
- `Discard` требует подтверждения и удаляет ops/overlay без disk effects;
- close window/workspace, detach, reload extension и смена configuration при pending state показывают Apply/Discard/Cancel; без решения dispose не объявляет изменения сохранёнными;
- optional `staging.persistLog` восстанавливает pending state после crash, но не отменяет обычный close prompt;
- при hard resource limit уже принятые PendingOps сохраняются, а новая staging/materialization отклоняется с actionable сообщением.

## 6. Compatibility и миграция

Миграция выполняется без big bang:

1. **Identity/registry.** Ввести discovery descriptors и registry, оставить текущее дерево через read-only facade. Добавить Agent `listConfigurations`; `configurationId` сделать предпочтительным, а отсутствие ID разрешать только для единственной конфигурации.
2. **Reload ownership.** Перенести reload slots и watcher'ы в session. Текущий coordinator и lifecycle временно становятся adapters, делегирующими по ID. Глобальный reload всех roots остаётся только явной workspace-командой.
3. **Safe mutation gateway и drift fence.** Ввести queue, tiered storage, journal и watcher/hash conflict detection. Сначала перевести Agent CRUD/type и общие XML writers, затем properties/editors, binding/deploy и process-backed операции. Один surface не может одновременно использовать legacy и session write paths. Ни один staged surface не включается до завершения этого шага.
4. **UI-only staged RFC integration.** Разместить `BaseSnapshot`, `PendingOps` и lazy `Overlay` внутри session; `Save/Apply` использует тот же mutation queue/storage/journal. Agent/deploy сохраняют immediate semantics и блокируются при pending UI state. Сохраняются измеримые resource limits RFC.
5. **Удаление compatibility debt.** Удалить first-root getters, path-only coordinator keys, глобальный массив watcher'ов и прямые writer calls после миграции всех consumers.

Формат Designer/EDT XML и пользовательские workspace files этим ADR не меняются. `ConfigurationId` хранится только во versioned internal mapping по правилам §5.1 и не записывается в пользовательскую конфигурацию. Journal schema versioned и мигрируется независимо.

На каждом шаге допустим feature flag для возврата конкретного ещё не мигрированного surface, но не для отключения boundary/hash checks. Rollback версии не должен оставлять journal, который старая версия ошибочно примет: неизвестная schema переводится в recovery-required без автоматической записи.

## 7. Инварианты

1. Нет изменяющей операции без exact `ConfigurationId` либо доказанного single-config fallback.
2. Нет более одного watcher, reload execution или mutation execution на session.
3. Нет прямой записи вне session gateway для мигрированного surface.
4. Не публикуется partial snapshot или результат старой session generation.
5. Ни один managed target не записывается до boundary/hash preflight; Tier 2 target дополнительно требует durable `prepared` journal. `externalMutation` имеет отдельный baseline/drift contract и не выдаёт storage rollback guarantee.
6. Любая начатая Tier 2 мутация имеет terminal commit, terminal rollback или явно наблюдаемое `recoveryRequired`.
7. Разные конфигурации не сериализуются общей очередью.
8. `PendingOps` RFC не требует второго полного дерева и не смешивается с durability-журналом.
9. Staged state существует только в UI session scope; immediate Agent/deploy operation не выполняется при `PendingOps`.
10. Overlay и lazy caches производны: eviction/dispose cache не удаляет `PendingOps` или durability state.

## 8. Acceptance criteria

- В workspace с двумя конфигурациями Agent/UI create, rename, delete, type edit и deploy требуют/выводят правильный ID; отсутствие ID не меняет `configs[0]` и даёт selection error.
- Alias/symlink и overlapping workspace folders не создают две сессии одного physical root; фактическая case sensitivity volume/directory проверена. Move/replace descriptor не переназначает старый ID молча.
- Burst manual/watcher/git reload одной конфигурации даёт один in-flight pass и один queued pass на текущий pass для более нового epoch; resource scheduler не создаёт общей ordering зависимости configs.
- Параллельные мутации одного config исполняются FIFO; версия захватывается при dequeue, а target hashes revalidate'ятся перед effect. Несвязанные queued операции не конфликтуют только из-за commit предыдущей.
- Stale target hash и out-of-root absolute/`..`/symlink targets отклоняются до disk effects в заявленной threat model; create path проверяется через canonical parent и segment `lstat`.
- Fault injection в каждой точке Tier 1/Tier 2 process-crash model приводит к исходному/новому состоянию либо к состоянию из recovery truth table; restart не повторяет committed plan.
- Cancellation проверена до prepare, во время commit, во время process execution и при dispose; ни один сценарий не оставляет silent partial success.
- Internal watcher events не создают duplicate reload; внешний event во время mutation/PendingOps даёт drift/conflict, а не silent overwrite. Этот fence существует до включения первого staged surface.
- Session dispose освобождает watcher, timers, caches и дочерние процессы; поздний callback не меняет новую generation.
- Legacy single-config UI и Agent сценарии сохраняют совместимость на миграционных этапах; Agent остаётся immediate, получает `PENDING_UI_CHANGES` при UI overlay, migrated surface не имеет двойного write path.
- Designer XML после commit проходит структурный round-trip и доступную ibcmd/Designer validation; EDT использует реальный `.mdo` descriptor и собственные format contracts.
- Resource criteria связанного staged RFC соблюдены измеримыми per-session limits pending ops/payload/materialized nodes/roots; нет второго полного дерева, eviction не удаляет PendingOps.
- Manifest/capabilities соответствуют фактическим URI/trust ограничениям; unsupported virtual workspace не получает write/process commands.

## 9. Последствия

### Положительные

- Multi-root становится частью контракта, а не особенностью UI-дерева.
- Reload, watcher, storage и процессы используют одну consistency boundary.
- Ошибки записи становятся восстанавливаемыми и наблюдаемыми.
- Staged RFC получает подходящий lifecycle без удвоения дерева.

### Отрицательные

- Появляются registry/session adapters и временный migration debt.
- Требуются fault-injection и lifecycle tests, которых больше, чем у локальных writer-функций.
- Многофайловый commit остаётся recoverable, но не физически атомарным; UI и API должны честно отражать `recoveryRequired`.
- Canonicalization/realpath добавляют асинхронный preflight и platform-specific тестовую матрицу.

## 10. Отклонённые упрощения

- **Нормализованный строковый path как ID:** не решает symlink, URI scheme, регистр файловой системы и overlapping roots.
- **Одна глобальная mutation queue:** безопасно, но необоснованно блокирует независимые конфигурации.
- **Только debounce watcher'а:** не связывает событие с transaction и не предотвращает stale publish.
- **Best-effort `.bak` без журнала:** не восстанавливает многофайловую операцию после crash/restart.
- **Полный clone дерева для rollback:** противоречит RAM-safe решению staged RFC и не откатывает файловую систему.
