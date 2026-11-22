import * as assert from 'assert';
import { JSDOM, VirtualConsole } from 'jsdom';

import {
  renderConfigCompareWebviewHtml,
  toWebviewPayload,
} from '../../../src/compareMerge/configCompareProvider';
import type { ConfigCompareWebviewPayloadDto } from '../../../src/compareMerge/configCompareMessages';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import type { ConfigCompareWebviewPayload } from '../../../src/compareMerge/configurationCompareWorkspace';

suite('ConfigCompareWebview runtime', () => {
  test('runs the rendered HTML, gates actions during progress and ignores stale load generations', () => {
    const posted: Array<{ type: string }> = [];
    const { dom, errors } = createDom({
      generation: 0,
      status: 'loading',
      phase: 'detecting',
    }, posted);
    try {
      const document = dom.window.document;
      assert.strictEqual(posted[0]?.type, 'ready');
      assert.strictEqual(document.getElementById('previewButton')?.hasAttribute('disabled'), true);
      const progressBar = document.querySelector('#loadLine progress');
      assert.ok(progressBar, 'loading state should render a native progress bar');
      assert.strictEqual(progressBar?.hasAttribute('value'), false, 'unknown work should remain indeterminate');

      dispatch(dom, {
        type: 'loadState',
        generation: 2,
        status: 'loading',
        phase: 'comparing',
        completed: 1,
        total: 3,
        partial: true,
        payload: makeDto(true),
      });
      const determinateProgress = document.querySelector('#loadLine progress');
      assert.strictEqual(determinateProgress?.getAttribute('max'), '3');
      assert.strictEqual(determinateProgress?.getAttribute('value'), '1');
      const progressText = document.getElementById('loadLine')?.textContent ?? '';
      dispatch(dom, {
        type: 'loadState',
        generation: 1,
        status: 'error',
        error: 'устаревшее завершение',
      });
      assert.match(document.getElementById('loadLine')?.textContent ?? '', /1 из 3/u);
      assert.strictEqual(document.getElementById('loadLine')?.textContent, progressText);
      assert.strictEqual(document.getElementById('previewButton')?.hasAttribute('disabled'), true);

      dispatch(dom, {
        type: 'loadState',
        generation: 2,
        status: 'ready',
        payload: makeDto(),
      });
      assert.match(document.getElementById('loadLine')?.textContent ?? '', /Сравнение готово/u);
      assert.ok(errors.length === 0, errors.join('\n'));
    } finally {
      dom.window.close();
    }
  });

  test('shows preview and merge completion messages while the host is still busy', () => {
    const { dom, errors } = createDom({ generation: 0, status: 'ready' }, []);
    try {
      const dto = makeDto();
      dispatch(dom, stateMessage(dto, true));
      dispatch(dom, {
        type: 'previewReady',
        previewId: 'preview-1',
        summary: 'Изменён модуль объекта.',
        operationCount: 1,
        destructiveCount: 0,
        items: [{
          nodeId: 'bsl:routine:Catalog.Products.Object:run',
          label: 'Run',
          kind: 'bslRoutine',
          status: 'changed',
        }],
        diagnostics: [],
      });
      assert.match(dom.window.document.getElementById('preview')?.textContent ?? '', /Изменён модуль объекта/u);

      dispatch(dom, stateMessage(dto, true));
      dispatch(dom, {
        type: 'mergeSuccess',
        applied: [{ operationId: 'operation-1', kind: 'bslLogicalRoutineMerge' }],
        backupPaths: ['…/ObjectModule.bsl.bak'],
        payload: dto,
        locked: false,
        diagnostics: [],
      });
      assert.match(dom.window.document.getElementById('result')?.textContent ?? '', /Объединение выполнено/u);
      assert.match(dom.window.document.getElementById('result')?.textContent ?? '', /Применено операций: 1/u);

      dispatch(dom, stateMessage(dto, true));
      dispatch(dom, {
        type: 'mergeError',
        message: 'Сбой объединения',
        diagnostics: [],
        locked: true,
        backupPaths: ['…/recovery.bak'],
      });
      assert.match(dom.window.document.getElementById('notice')?.textContent ?? '', /Сбой объединения/u);
      assert.match(dom.window.document.getElementById('result')?.textContent ?? '', /recovery\.bak/u);
      assert.ok(errors.length === 0, errors.join('\n'));
    } finally {
      dom.window.close();
    }
  });

  test('reserves label width and shrinks secondary controls at narrow viewport sizes', () => {
    const html = renderConfigCompareWebviewHtml({
      webview: { cspSource: 'vscode-resource:' },
      payload: makeBulkPayload(),
      executableNodeIds: bulkExecutableNodeIds(),
      nonce: 'narrow-layout-test',
    });
    const narrowStyles = html.slice(html.indexOf('@media (max-width: 760px)'));
    assert.match(narrowStyles, /--name-column: minmax\(300px, 2fr\)/u);
    assert.match(narrowStyles, /\.name-cell \{ gap: 3px; padding-left: calc\(6px \+ var\(--depth, 0\) \* 11px\); \}/u);
    assert.match(narrowStyles, /\.row-status \{ flex: 0 1 60px; max-width: 60px; min-width: 0; \}/u);
    assert.match(narrowStyles, /\.delete-selection-action \{ max-width: 128px; overflow: hidden/u);
  });

  test('bulk selection excludes canonical deletion candidates', () => {
    const posted: Array<{ type: string; nodeIds?: string[] }> = [];
    const { dom, errors } = createDom(
      { generation: 0, status: 'ready' },
      posted,
      makeBulkPayload(),
      bulkExecutableNodeIds()
    );
    try {
      const document = dom.window.document;
      (document.getElementById('selectVisibleButton') as HTMLButtonElement).click();
      assert.deepStrictEqual(lastSelection(posted), [
        'metadata:changed',
        'bsl:changed',
        'file:replacement',
      ]);
      assert.ok(errors.length === 0, errors.join('\n'));
    } finally {
      dom.window.close();
    }
  });

  test('legacy DTO without deletionNodeIds infers deletions from the display tree', () => {
    const posted: Array<{ type: string; nodeIds?: string[] }> = [];
    const { dom, errors } = createDom(
      { generation: 0, status: 'ready' },
      posted,
      makeLegacyBulkPayload(),
      legacyExecutableNodeIds()
    );
    try {
      const dto = toWebviewPayload(makeLegacyBulkPayload(), legacyExecutableNodeIds(), 'Тест') as ConfigCompareWebviewPayloadDto & {
        deletionNodeIds?: string[];
        unresolvedConflictCount?: number;
      };
      delete dto.deletionNodeIds;
      delete dto.unresolvedConflictCount;
      dispatch(dom, stateMessage(dto, false, []));
      assert.match(dom.window.document.getElementById('unresolvedConflictBanner')?.textContent ?? '', /2/u);
      (dom.window.document.getElementById('selectVisibleButton') as HTMLButtonElement).click();
      assert.deepStrictEqual(lastSelection(posted), [
        'bsl:changed',
        'file:replacement',
      ]);
      assert.ok(errors.length === 0, errors.join('\n'));
    } finally {
      dom.window.close();
    }
  });

  test('explicit delete action toggles selected deletions without executing them and bulk selection preserves that intent', () => {
    const posted: Array<{ type: string; nodeIds?: string[] }> = [];
    const dto = makeBulkDto();
    const { dom, errors } = createDom(
      { generation: 0, status: 'ready' },
      posted,
      makeBulkPayload(),
      bulkExecutableNodeIds()
    );
    try {
      const document = dom.window.document;
      const mergeIds = ['metadata:changed', 'bsl:changed', 'file:replacement'];
      dispatch(dom, stateMessage(dto, false, mergeIds));
      const deleteRow = document.querySelector('[data-key="bsl:deleted"]');
      const deleteButton = deleteRow?.querySelector('button.delete-selection-action') as HTMLButtonElement | null;
      assert.ok(deleteButton, 'each visible delete candidate should have a separate selection action');
      assert.match(deleteButton?.textContent ?? '', /Выбрать удаление \(1\)/u);
      deleteRow?.dispatchEvent(new dom.window.Event('focus'));
      deleteButton?.focus();
      deleteButton?.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: ' ',
        bubbles: true,
        cancelable: true,
      }));
      assert.deepStrictEqual(lastSelection(posted), [], 'Space on the delete action must not trigger the tree row bulk toggle');
      deleteButton?.click();
      assert.deepStrictEqual(lastSelection(posted), [
        'metadata:changed',
        'bsl:changed',
        'file:replacement',
        'bsl:deleted',
      ]);
      const selectedDeleteButton = document.querySelector('[data-key="bsl:deleted"] button.delete-selection-action') as HTMLButtonElement | null;
      assert.match(selectedDeleteButton?.textContent ?? '', /Отменить удаление \(1\)/u);
      assert.strictEqual(posted.some((message) => message.type === 'createPreview'), false);
      assert.strictEqual(posted.some((message) => message.type === 'executeMerge'), false);

      (document.getElementById('selectVisibleButton') as HTMLButtonElement).click();
      assert.deepStrictEqual(lastSelection(posted).sort(), [
        'metadata:changed',
        'bsl:changed',
        'file:replacement',
        'bsl:deleted',
      ].sort(), 'bulk selection should preserve an already explicit delete intent');

      selectedDeleteButton?.click();
      assert.deepStrictEqual(lastSelection(posted), [
        'metadata:changed',
        'bsl:changed',
        'file:replacement',
      ]);
      (document.getElementById('clearSelectionButton') as HTMLButtonElement).click();
      assert.deepStrictEqual(lastSelection(posted), []);
      assert.ok(errors.length === 0, errors.join('\n'));
    } finally {
      dom.window.close();
    }
  });

  test('shows a blocking-conflict count and a generic accessible conflict label', () => {
    const dto = makeBulkDto();
    const { dom, errors } = createDom(
      { generation: 0, status: 'ready' },
      [],
      makeBulkPayload(),
      bulkExecutableNodeIds()
    );
    try {
      const document = dom.window.document;
      const banner = document.getElementById('unresolvedConflictBanner');
      assert.ok(banner, 'blocking conflict count should have a visible banner');
      assert.match(banner?.textContent ?? '', /2/u);
      assert.strictEqual(banner?.getAttribute('aria-live'), 'polite');
      assert.ok(
        document.querySelector('[data-key="bsl:conflict"] [aria-label="Конфликт"]'),
        'BSL logical conflicts should use the generic accessible label'
      );
      assert.ok(errors.length === 0, errors.join('\n'));
    } finally {
      dom.window.close();
    }
  });

  test('row and parent checkbox plus Space selection never introduce deletion IDs', () => {
    const posted: Array<{ type: string; nodeIds?: string[] }> = [];
    const dto = makeBulkDto();
    const { dom, errors } = createDom(
      { generation: 0, status: 'ready' },
      posted,
      makeBulkPayload(),
      bulkExecutableNodeIds()
    );
    try {
      const document = dom.window.document;
      const ownerRow = [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')]
        .find((row) => row.querySelector('.row-label')?.textContent === 'Products');
      assert.ok(ownerRow, 'coalesced metadata owner should be visible as a parent row');
      const checkbox = ownerRow?.querySelector('input.row-check') as HTMLInputElement | null;
      assert.ok(checkbox, 'parent rows with canonical candidates should be selectable');
      checkbox?.click();
      assert.deepStrictEqual(lastSelection(posted), ['metadata:changed']);

      dispatch(dom, stateMessage(dto, false, []));
      ownerRow?.dispatchEvent(new dom.window.Event('focus'));
      document.getElementById('viewport')?.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: ' ',
        bubbles: true,
        cancelable: true,
      }));
      assert.deepStrictEqual(lastSelection(posted), ['metadata:changed']);
      assert.ok(errors.length === 0, errors.join('\n'));
    } finally {
      dom.window.close();
    }
  });

  test('clamps the virtual window after filtering a large tree from a distant scroll position', () => {
    const payload = makeLargePayload(10_000);
    const { dom, errors } = createDom({ generation: 0, status: 'ready' }, [], payload, []);
    try {
      const viewport = dom.window.document.getElementById('viewport')!;
      Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 620 });
      const header = dom.window.document.querySelector('.grid-header')!;
      header.getBoundingClientRect = () => ({
        x: 0, y: 0, width: 1000, height: 32, top: 0, right: 1000, bottom: 32, left: 0,
        toJSON: () => ({}),
      });
      viewport.scrollTop = 200_000;
      viewport.dispatchEvent(new dom.window.Event('scroll'));
      assert.ok(dom.window.document.querySelectorAll('#rows [role="treeitem"]').length < 40);

      const search = dom.window.document.getElementById('searchInput') as HTMLInputElement;
      search.value = 'Товар9999';
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      assert.match(dom.window.document.getElementById('rows')?.textContent ?? '', /Товар9999/u);
      assert.ok(dom.window.document.querySelectorAll('#rows [role="treeitem"]').length < 40);
      assert.strictEqual(viewport.scrollTop, 0);
      assert.ok(errors.length === 0, errors.join('\n'));
    } finally {
      dom.window.close();
    }
  });
});

function createDom(
  initialLoadState: { generation: number; status: 'loading' | 'ready'; phase?: 'detecting' },
  posted: Array<{ type: string }>,
  payload = makePayload(),
  executableNodeIds = ['bsl:routine:Catalog.Products.Object:run']
): { dom: JSDOM; errors: string[] } {
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error.message));
  const html = renderConfigCompareWebviewHtml({
    webview: { cspSource: 'vscode-resource:' },
    payload,
    executableNodeIds,
    nonce: 'runtime-test-nonce',
    initialLoadState,
  });
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
        postMessage: (message: { type: string }) => posted.push(message),
        getState: () => undefined,
        setState: () => undefined,
      });
      window.confirm = () => true;
    },
  });
  return { dom, errors };
}

function dispatch(dom: JSDOM, message: unknown): void {
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message }));
}

function stateMessage(
  payload: ConfigCompareWebviewPayloadDto,
  busy: boolean,
  selectedNodeIds: string[] = []
) {
  return {
    type: 'state',
    payload,
    selectedNodeIds,
    executableNodeIds: payload.executableNodeIds,
    canCreatePreview: true,
    busy,
    locked: false,
    diagnostics: [],
  };
}

function lastSelection(messages: Array<{ type: string; nodeIds?: string[] }>): string[] {
  const selections = messages.filter((message) => message.type === 'selectionChanged');
  return Array.from(selections[selections.length - 1]?.nodeIds ?? []);
}

function makeBulkDto(): ConfigCompareWebviewPayloadDto {
  const dto = toWebviewPayload(makeBulkPayload(), bulkExecutableNodeIds(), 'Тест') as ConfigCompareWebviewPayloadDto & {
    deletionNodeIds?: string[];
    unresolvedConflictCount?: number;
  };
  dto.deletionNodeIds = ['metadata:deleted', 'bsl:deleted', 'file:deleted'];
  dto.unresolvedConflictCount = 2;
  return dto;
}

function bulkExecutableNodeIds(): string[] {
  return [
    'metadata:changed',
    'metadata:deleted',
    'bsl:changed',
    'bsl:deleted',
    'file:replacement',
    'file:deleted',
  ];
}

function legacyExecutableNodeIds(): string[] {
  return ['bsl:changed', 'bsl:deleted', 'file:replacement', 'file:deleted'];
}

function makeLegacyBulkPayload(): ConfigCompareWebviewPayload {
  const payload = makeBulkPayload();
  return {
    ...payload,
    root: {
      ...payload.root,
      children: payload.root.children.filter((node) => node.id !== 'metadata'),
    },
    stats: { total: 4, different: 4, mergeable: 4 },
  };
}

function makeBulkPayload(): ConfigCompareWebviewPayload {
  const qualifiedName = 'Catalog.Products';
  const ownerPresentation = {
    ownerKey: 'Catalog:name:Catalog.Products',
    ownerAliases: ['Catalog:name:Catalog.Products'],
    metadataType: 'Catalog',
    qualifiedName,
    identities: [
      { side: 'left' as const, qualifiedName, uuid: 'target-products' },
      { side: 'right' as const, qualifiedName, uuid: 'source-products' },
    ],
  };
  const metadata = [
    testNode('metadata:changed', 'Catalog.Products', 'metadataObject', 'changed', { mergeable: true, presentation: ownerPresentation }),
    testNode('metadata:deleted', 'Catalog.Products', 'metadataObject', 'leftOnly', { mergeable: true, destructive: true, presentation: ownerPresentation }),
  ];
  const bsl = [
    testNode('bsl:changed', 'Changed routine', 'bslRoutine', 'changed', { mergeable: true }),
    testNode('bsl:deleted', 'Deleted routine', 'bslRoutine', 'leftOnly', { mergeable: true }),
    testNode('bsl:conflict', 'Logical conflict', 'bslRoutine', 'changed', { conflict: { kind: 'logical', blocking: true, message: 'Manual merge required.' } }),
    testNode('bsl:conflict-second', 'Second conflict', 'bslRoutine', 'changed', { conflict: { kind: 'logical', blocking: true, message: 'Another manual merge required.' } }),
  ];
  const files = [
    testNode('file:replacement', 'Changed binary replacement', 'binaryFile', 'changed', { mergeable: true, destructive: true }),
    testNode('file:deleted', 'Deleted file', 'binaryFile', 'leftOnly', { mergeable: true, destructive: true }),
  ];
  return {
    root: testNode('configCompare', 'Compare', 'configCompare', 'changed', {
      children: [
        testNode('metadata', 'Metadata', 'metadataGroup', 'changed', { children: metadata }),
        testNode('bsl', 'BSL', 'bslGroup', 'changed', { children: bsl }),
        testNode('adapter', 'Files', 'adapterGroup', 'changed', { children: files }),
      ],
    }),
    stats: { total: 8, different: 8, mergeable: 6 },
    sourceRoots: { left: 'Цель', right: 'Источник' },
    locked: false,
    strategy: 'full',
  };
}

function testNode(
  id: string,
  label: string,
  kind: string,
  status: CompareTreeNode['status'],
  extra: Partial<CompareTreeNode> = {}
): CompareTreeNode {
  return { id, label, kind, status, children: [], ...extra };
}

function makeDto(locked = false): ConfigCompareWebviewPayloadDto {
  return toWebviewPayload(makePayload(locked), ['bsl:routine:Catalog.Products.Object:run'], 'Тест');
}

function makePayload(locked = false): ConfigCompareWebviewPayload {
  const routine: CompareTreeNode = {
    id: 'bsl:routine:Catalog.Products.Object:run',
    label: 'Run',
    kind: 'bslRoutine',
    status: 'changed',
    mergeable: true,
    mergeState: { state: 'ready' },
    leftValue: 'Приёмник',
    rightValue: 'Источник',
    children: [],
  };
  const root: CompareTreeNode = {
    id: 'configCompare',
    label: 'Сравнение конфигураций',
    kind: 'configCompare',
    status: 'changed',
    children: [{
      id: 'bsl',
      label: 'BSL',
      kind: 'bslGroup',
      status: 'changed',
      children: [routine],
    }],
  };
  return {
    root,
    stats: { total: 1, different: 1, mergeable: 1 },
    sourceRoots: { left: 'C:\\repo\\Приёмник', right: 'C:\\repo\\Источник' },
    locked,
    strategy: 'right',
  };
}

function makeLargePayload(count: number): ConfigCompareWebviewPayload {
  const entries: CompareTreeNode[] = Array.from({ length: count }, (_unused, index) => {
    const qualifiedName = `Catalog.Товар${index}`;
    return {
      id: `metadata:match:${index}`,
      label: qualifiedName,
      kind: 'metadataMatch',
      status: 'changed',
      mergeable: false,
      presentation: {
        ownerKey: `Catalog:name:${qualifiedName}`,
        ownerAliases: [`Catalog:name:${qualifiedName}`],
        metadataType: 'Catalog',
        qualifiedName,
        identities: [{ side: 'left', qualifiedName, uuid: `uuid-${index}` }],
      },
      children: [],
    };
  });
  return {
    root: {
      id: 'configCompare',
      label: 'Сравнение конфигураций',
      kind: 'configCompare',
      status: 'changed',
      children: [{
        id: 'metadata',
        label: 'Metadata',
        kind: 'metadataGroup',
        status: 'changed',
        children: entries,
      }],
    },
    stats: { total: count, different: count, mergeable: 0 },
    sourceRoots: { left: 'Цель', right: 'Источник' },
    locked: false,
    strategy: 'right',
  };
}
