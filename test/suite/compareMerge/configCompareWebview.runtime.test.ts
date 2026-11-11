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

function stateMessage(payload: ConfigCompareWebviewPayloadDto, busy: boolean) {
  return {
    type: 'state',
    payload,
    selectedNodeIds: [],
    executableNodeIds: payload.executableNodeIds,
    canCreatePreview: true,
    busy,
    locked: false,
    diagnostics: [],
  };
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
