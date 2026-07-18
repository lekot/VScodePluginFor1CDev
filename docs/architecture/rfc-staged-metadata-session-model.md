# RFC: Staged Metadata Session Model (RAM-safe)

## Status

- Proposed
- Owner: 1C Metadata Tree team
- Related ADR: [ConfigurationSession и безопасные мутации](adr-configuration-session-and-safe-mutations.md)

## Context

Сейчас UI-команды сразу пишут XML и запускают reload. Это даёт паузы и гонки watcher/reload. Полный in-memory clone дерева до Save неприемлем: уже существует lazy `TreeNode` graph с индексами, а несколько больших конфигураций могут удвоить RAM extension host.

## Decision and scope

Использовать внутри `ConfigurationSession`:

1. immutable structural `BaseSnapshot` текущего committed состояния;
2. компактный `PendingOps` как единственный source of truth несохранённых правок;
3. производный lazy `Overlay` только для запрошенных UI branches;
4. `Apply` через общие mutation queue, storage и recovery contracts ADR.

Первая версия staging — **только для интерактивных Tree/Properties UI**. Agent API, deploy и automation сохраняют immediate semantics, не читают UI overlay и получают `PENDING_UI_CHANGES`, пока пользователь не выполнит Apply/Discard. Это исключает две разные трактовки effective state в автоматизации.

Staging нельзя включать до появления `ConfigurationSession`, единого write gateway и watcher/hash drift fence. `PendingOps` и durability `MutationJournal` — разные сущности: первый хранит ещё не применённый пользовательский intent, второй восстанавливает уже начатую disk transaction.

## Goals

- показать UI-правку активной ветки без disk write и полного reload;
- не создавать второй полный graph;
- не терять pending state из-за watcher, eviction, close или failed reconcile;
- иметь измеримые per-session resource limits;
- сохранить immediate Agent/deploy behavior вне pending UI session.

## Non-goals

- полный redesign parsers;
- автоматический semantic merge внешних конфликтов;
- staging Agent/deploy операций в первой версии;
- точная атрибуция V8 heap в байтах одной подсистеме.

## Model and contracts

### BaseSnapshot

`BaseSnapshot` содержит `snapshotVersion`, committed metadata identities и immutable collections. Lazy load создаёт новый version-owned child payload/cache entry, но не мутирует уже выданную collection. Поздний result с другой `sessionGeneration/snapshotVersion` отбрасывается.

### PendingOps

Каждая операция хранит stable metadata object ID, kind (`create`, `rename`, `delete`, `editProps`), минимальный payload, captured base version/hashes и dependencies. Path/name не являются identity после rename. Операции нормализуются по таблице ADR §5.10; неизвестная комбинация, duplicate name, missing parent или неявный cascade дают typed conflict.

`PendingOps` сохраняются при overlay eviction. Принятая операция удаляется только после durable applied marker disk commit; при `committedWithReconcileError` она остаётся в committed overlay и не применяется повторно.

### Overlay and reads

`OverlayResolver` вычисляет effective view только для запрошенной ветки/Properties node. Cache полностью производен из `BaseSnapshot + PendingOps`, поэтому его можно восстановить. Активный Tree/Webview consumer держит pin; LRU удаляет только unpinned entries. Cross-object effects, которые нельзя честно показать локальным overlay, отмечаются как pending dependency и валидируются на Apply.

### Apply/Discard lifecycle

- первая PendingOp выставляет dirty indicator session/document scope;
- `Apply` повторно валидирует dependencies/base target hashes и передаёт plan в session mutation queue;
- `Discard` требует подтверждения и не пишет на диск;
- close window/workspace, detach, reload extension и смена config при dirty state предлагают Apply/Discard/Cancel;
- optional `staging.persistLog` нужен для crash recovery, но не заменяет close prompt;
- hard limit запрещает новую staging/materialization, но не удаляет уже принятые ops.

## Drift and conflicts

Drift fence работает с первой staged итерации. Watcher не делает unconditional reload при `PendingOps`:

- событие вне target/dependency set после hash revalidation может обновить base;
- пересечение с captured hashes переводит session в explicit conflict и сохраняет base/pending overlay;
- immediate Agent/deploy/legacy write при pending state блокируется `PENDING_UI_CHANGES`;
- Apply со stale target hash завершается до disk effect;
- конфликт требует Apply after resolution, Discard либо explicit export/manual action; silent overwrite запрещён.

## Resource guardrails

Limits считаются per session, а не по недоступной точной атрибуции V8 heap:

| Limit | Default | Измерение/действие |
|---|---:|---|
| `staging.maxRoots` | 2 | Число sessions с PendingOps; новая session staging отклоняется. |
| `staging.maxPendingOps` | 1000 | Число нормализованных ops. |
| `staging.maxPendingPayloadBytes` | 8 MiB | UTF-8 размер canonical serialized payload/dependencies. |
| `staging.maxMaterializedNodes` | 50000 | Число overlay cache nodes; LRU unpinned до лимита. |

Heap/RSS и estimated cache bytes используются только как telemetry/soft warning, а не как доказательство hard limit. При достижении hard limit UI сохраняет dirty state и предлагает Apply/Discard; уже принятые ops и pinned active view не удаляются.

## Rollout

### Iteration 0 — mandatory safety prerequisites

- `ConfigurationSession`, per-config queue и tiered storage работают для выбранного surface;
- watcher/hash drift fence активен;
- UI dirty/Apply/Discard/close lifecycle реализован;
- legacy/immediate writes блокируются при PendingOps.

### Iteration 1 — instrumentation and Properties

- метрики limits/pending/cache и fault-free lifecycle tests;
- только Properties создаёт staged patch;
- остальные изменяющие UI-команды требуют Apply/Discard перед legacy write.

### Iteration 2 — create/rename/delete

- element commands создают нормализованные PendingOps по stable object ID;
- overlay материализуется только для затронутых/открытых branches;
- Apply использует общий session transaction plan и applied marker.

### Iteration 3 — hardening

- conflict-resolution UX, pin/LRU и limit matrix;
- stress tests multi-root, long session и late lazy callbacks;
- cross-object dependency validation.

### Iteration 4 (optional) — persisted pending log

- versioned pending schema, validation/migration и crash recovery;
- unknown schema открывается read-only/export flow, без автоматической записи.

## Risks

- Overlay усложняет read path: держать его pure/derived и тестировать operation algebra.
- Смешение staging/immediate semantics: staging ограничен UI, а immediate writes блокируются при dirty state.
- Memory drift: применять счётные limits, pin/LRU и telemetry.
- External drift: fence обязателен до Iteration 1, а не откладывается на hardening.

## Acceptance criteria

- Нет второго полного tree graph; cache можно полностью пересоздать из BaseSnapshot + PendingOps.
- На fixture 10 000 visible nodes/100 PendingOps добавление op и refresh активной ветки имеет p95 не более 100 ms без disk write/full parse; benchmark environment фиксируется в test report.
- Defaults из resource table проверены boundary tests; превышение каждого limit отклоняет новую работу, не теряя PendingOps/pinned view.
- Таблица composition ADR покрыта unit tests, включая create→delete, repeated rename, rename→edit/delete и parent cascade conflict.
- External event до/во время Apply, immediate Agent/deploy call и stale target hash дают deterministic conflict/block без silent overwrite.
- Commit + reconcile failure не повторяет disk plan и сохраняет корректный effective view до retry reconcile.
- Apply/Discard/Cancel проверены при close, detach, extension reload и config switch; без выбора dirty state не объявляется сохранённым.
- Late lazy result старой generation не меняет current view; eviction не удаляет PendingOps.
- Single-config Agent/deploy сценарии без pending UI state сохраняют прежний immediate result.
