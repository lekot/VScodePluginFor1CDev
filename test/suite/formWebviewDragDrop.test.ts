import * as assert from 'assert';
import type { FormChildItem, FormModel } from '../../src/formEditor/formModel';
import {
  createFormDataTransfer,
  createFormDragEvent,
  createFormWebviewRuntimeFixture,
  type FormWebviewRuntimeFixture,
} from '../helpers/formWebviewRuntime';

type Surface = 'tree' | 'preview';
type CommandBarIdMode = 'name-fallback' | 'numeric-id' | 'ordinary-id';

const surfaces: Surface[] = ['tree', 'preview'];
const requisiteType = 'application/x-1c-form-requisite';
const formRootId = '__form_root__';

function makeItem(tag: string, id: string, childItems: FormChildItem[] = []): FormChildItem {
  return { tag, id, name: id, properties: {}, childItems };
}

function makeNamedItem(tag: string, name: string, id: string | undefined, childItems: FormChildItem[] = []): FormChildItem {
  return { tag, id, name, properties: {}, childItems };
}

function makeFormModel(childItemsRoot: FormChildItem[]): FormModel {
  return {
    childItemsRoot,
    attributes: [{ id: 'attribute-customer', name: 'Customer', properties: { Type: 'String' } }],
    commands: [],
    formEvents: [],
  };
}

function createNestedModel(): FormModel {
  return makeFormModel([
    makeItem('UsualGroup', 'source-outer', [
      makeItem('UsualGroup', 'source-middle', [
        makeItem('UsualGroup', 'source-inner', [makeItem('Button', 'nested-leaf')]),
      ]),
    ]),
    makeItem('UsualGroup', 'destination-group', [
      makeItem('Button', 'destination-child-one'),
      makeItem('Button', 'destination-child-two'),
    ]),
  ]);
}

function createDropModel(): FormModel {
  return makeFormModel([
    makeItem('Button', 'source-leaf'),
    makeItem('UsualGroup', 'outer', [
      makeItem('UsualGroup', 'middle', [
        makeItem('UsualGroup', 'deep', [makeItem('Button', 'deep-child')]),
      ]),
      makeItem('Button', 'leaf-target'),
    ]),
    makeItem('UsualGroup', 'left-group', [makeItem('Button', 'left-child')]),
    makeItem('UsualGroup', 'right-group', [makeItem('Button', 'right-child')]),
  ]);
}

function createAutoCommandBarModel(mode: CommandBarIdMode): { model: FormModel; ids: { main: string; nested: string; deep: string; sibling: string } } {
  const ids = mode === 'name-fallback'
    ? { main: 'MainCommands', nested: 'NestedCommands', deep: 'DeepCommands', sibling: 'OtherCommands' }
    : mode === 'numeric-id'
      ? { main: '41', nested: '42', deep: '43', sibling: '44' }
      : { main: 'main-actions', nested: 'nested-actions', deep: 'deep-actions', sibling: 'other-actions' };
  const names = { main: 'MainCommands', nested: 'NestedCommands', deep: 'DeepCommands', sibling: 'OtherCommands' };
  const id = (key: keyof typeof ids): string | undefined => mode === 'name-fallback' ? undefined : ids[key];
  const main = makeNamedItem('AutoCommandBar', names.main, id('main'), [
    makeNamedItem('CommandBar', names.nested, id('nested'), [
      makeNamedItem('CommandBar', names.deep, id('deep'), [makeItem('Button', 'deep-action')]),
    ]),
    makeNamedItem('CommandBar', names.sibling, id('sibling'), [makeItem('Button', 'sibling-action')]),
  ]);

  return {
    model: {
      childItemsRoot: [makeItem('UsualGroup', 'body-group', [makeItem('Button', 'body-action')])],
      attributes: [],
      commands: [],
      formEvents: [],
      autoCommandBarId: main.id,
      autoCommandBarName: main.name,
      autoCommandBar: main,
    },
    ids,
  };
}

function withRuntime(testBody: (fixture: FormWebviewRuntimeFixture) => void): void {
  const fixture = createFormWebviewRuntimeFixture();
  try {
    testBody(fixture);
  } finally {
    fixture.close();
  }
}

function sendFormData(fixture: FormWebviewRuntimeFixture, model: FormModel): void {
  fixture.send({ type: 'formData', formModel: model });
}

function itemElement(fixture: FormWebviewRuntimeFixture, surface: Surface, id: string): HTMLElement {
  const selector = surface === 'tree'
    ? `#tree-root .tree-node[data-id="${id}"]`
    : `#preview-form .preview-item[data-id="${id}"]`;
  const element = fixture.dom.window.document.querySelector<HTMLElement>(selector);
  assert.ok(element, `Expected ${surface} item ${id}`);
  return element;
}

function dragStart(
  fixture: FormWebviewRuntimeFixture,
  surface: Surface,
  sourceId: string,
): ReturnType<typeof createFormDataTransfer> {
  const transfer = createFormDataTransfer();
  const source = itemElement(fixture, surface, sourceId);
  source.dispatchEvent(createFormDragEvent(fixture.dom, 'dragstart', transfer));
  return transfer;
}

function dropOnItem(
  fixture: FormWebviewRuntimeFixture,
  surface: Surface,
  targetId: string,
  transfer: ReturnType<typeof createFormDataTransfer>,
  clientY = 0,
): Event {
  const event = createFormDragEvent(fixture.dom, 'drop', transfer, 0, clientY);
  itemElement(fixture, surface, targetId).dispatchEvent(event);
  return event;
}

function dragOverOnItem(
  fixture: FormWebviewRuntimeFixture,
  surface: Surface,
  targetId: string,
  transfer: ReturnType<typeof createFormDataTransfer>,
): Event {
  const event = createFormDragEvent(fixture.dom, 'dragover', transfer);
  itemElement(fixture, surface, targetId).dispatchEvent(event);
  return event;
}

function dragLeaveOnItem(fixture: FormWebviewRuntimeFixture, surface: Surface, targetId: string): Event {
  const event = new fixture.dom.window.Event('dragleave', { bubbles: true, cancelable: true });
  itemElement(fixture, surface, targetId).dispatchEvent(event);
  return event;
}

function highlightState(fixture: FormWebviewRuntimeFixture, surface: Surface, targetId: string): {
  target: boolean;
  ancestors: boolean;
} {
  const target = itemElement(fixture, surface, targetId);
  const ownerClass = surface === 'tree' ? 'tree-node' : 'preview-item';
  let ancestor = target.parentElement;
  let ancestorHighlighted = false;
  while (ancestor) {
    if (ancestor.classList.contains(ownerClass) && ancestor.classList.contains('drop-target')) {
      ancestorHighlighted = true;
      break;
    }
    ancestor = ancestor.parentElement;
  }
  return { target: target.classList.contains('drop-target'), ancestors: ancestorHighlighted };
}

function requisiteTransfer(fixture: FormWebviewRuntimeFixture): ReturnType<typeof createFormDataTransfer> {
  const attribute = fixture.dom.window.document.querySelector<HTMLElement>(
    '#attributes-tbody tr[data-id="attribute-customer"]',
  );
  assert.ok(attribute, 'Expected the Customer requisite drag source');
  const transfer = createFormDataTransfer();
  attribute.dispatchEvent(createFormDragEvent(fixture.dom, 'dragstart', transfer));
  assert.strictEqual(transfer.getData(requisiteType), 'Customer');
  return transfer;
}

function messagesOf(fixture: FormWebviewRuntimeFixture, type: string): unknown[] {
  return fixture.messages.filter((message) => message.type === type);
}

function setPreviewChildGeometry(target: HTMLElement, tops: number[]): void {
  const children = target.querySelector<HTMLElement>('.preview-children');
  assert.ok(children, 'Expected a preview container with rendered children');
  assert.strictEqual(children.children.length, tops.length, 'Every preview child has an explicit geometry');
  Array.from(children.children).forEach((child, index) => {
    const top = tops[index];
    Object.defineProperty(child, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: top,
        top,
        right: 200,
        bottom: top + 20,
        left: 0,
        width: 200,
        height: 20,
        toJSON: () => ({}),
      }),
    });
  });
}

suite('Form webview drag and drop runtime', () => {
  test('bubbling dragstart preserves a nested leaf source in tree and preview drops', () => {
    const results: Record<Surface, unknown[]> = { tree: [], preview: [] };
    for (const surface of surfaces) {
      withRuntime((fixture) => {
        sendFormData(fixture, createNestedModel());
        const transfer = dragStart(fixture, surface, 'nested-leaf');
        const sourceAfterDragStart = transfer.getData('text/plain');
        if (surface === 'preview') {
          setPreviewChildGeometry(itemElement(fixture, surface, 'destination-group'), [0, 20]);
        }
        dropOnItem(fixture, surface, 'destination-group', transfer, 15);
        results[surface] = [sourceAfterDragStart, ...messagesOf(fixture, 'dragDrop')];
      });
    }

    assert.deepStrictEqual(results, {
      tree: [
        'nested-leaf',
        { type: 'dragDrop', sourceId: 'nested-leaf', targetId: 'destination-group', index: 0 },
      ],
      preview: [
        'nested-leaf',
        { type: 'dragDrop', sourceId: 'nested-leaf', targetId: 'destination-group', index: 1, source: 'preview' },
      ],
    });
  });

  test('a valid tree container drop sends one payload and does not become a Form root move', () => {
    withRuntime((fixture) => {
      sendFormData(fixture, createDropModel());
      const transfer = createFormDataTransfer();
      transfer.setData('text/plain', 'source-leaf');

      dropOnItem(fixture, 'tree', 'left-group', transfer);

      assert.deepStrictEqual(messagesOf(fixture, 'dragDrop'), [
        { type: 'dragDrop', sourceId: 'source-leaf', targetId: 'left-group', index: 0 },
      ]);
    });
  });

  test('self, direct descendant and deep descendant targets are rejected on both surfaces', () => {
    const results: Record<Surface, unknown[][]> = { tree: [], preview: [] };
    for (const surface of surfaces) {
      withRuntime((fixture) => {
        sendFormData(fixture, createDropModel());
        for (const targetId of ['outer', 'middle', 'deep']) {
          const transfer = createFormDataTransfer();
          transfer.setData('text/plain', 'outer');
          dropOnItem(fixture, surface, targetId, transfer);
          results[surface].push(messagesOf(fixture, 'dragDrop').slice());
        }
      });
    }

    assert.deepStrictEqual(results, {
      tree: [[], [], []],
      preview: [[], [], []],
    });
  });

  test('moving into an ancestor or a sibling container remains allowed on both surfaces', () => {
    const results: Record<Surface, unknown[][]> = { tree: [], preview: [] };
    for (const surface of surfaces) {
      withRuntime((fixture) => {
        sendFormData(fixture, createDropModel());

        const ancestorTransfer = createFormDataTransfer();
        ancestorTransfer.setData('text/plain', 'deep');
        dropOnItem(fixture, surface, 'outer', ancestorTransfer);
        results[surface].push(messagesOf(fixture, 'dragDrop').slice());

        const siblingTransfer = createFormDataTransfer();
        siblingTransfer.setData('text/plain', 'left-group');
        dropOnItem(fixture, surface, 'right-group', siblingTransfer);
        results[surface].push(messagesOf(fixture, 'dragDrop').slice());
      });
    }

    assert.deepStrictEqual(results, {
      tree: [
        [{ type: 'dragDrop', sourceId: 'deep', targetId: 'outer', index: 0 }],
        [
          { type: 'dragDrop', sourceId: 'deep', targetId: 'outer', index: 0 },
          { type: 'dragDrop', sourceId: 'left-group', targetId: 'right-group', index: 0 },
        ],
      ],
      preview: [
        [{ type: 'dragDrop', sourceId: 'deep', targetId: 'outer', index: 0, source: 'preview' }],
        [
          { type: 'dragDrop', sourceId: 'deep', targetId: 'outer', index: 0, source: 'preview' },
          { type: 'dragDrop', sourceId: 'left-group', targetId: 'right-group', index: 0, source: 'preview' },
        ],
      ],
    });
  });

  test('the synthetic Form root keeps its existing single move payload', () => {
    withRuntime((fixture) => {
      sendFormData(fixture, createDropModel());
      const transfer = dragStart(fixture, 'tree', 'source-leaf');
      itemElement(fixture, 'tree', formRootId)
        .dispatchEvent(createFormDragEvent(fixture.dom, 'drop', transfer));

      assert.deepStrictEqual(messagesOf(fixture, 'dragDrop'), [
        { type: 'dragDrop', sourceId: 'source-leaf', targetId: formRootId, index: 0 },
      ]);
    });
  });

  test('a requisite dropped into a nested container creates one correct payload', () => {
    const results: Record<Surface, unknown[]> = { tree: [], preview: [] };
    for (const surface of surfaces) {
      withRuntime((fixture) => {
        sendFormData(fixture, createNestedModel());
        const attribute = fixture.dom.window.document.querySelector<HTMLElement>(
          '#attributes-tbody tr[data-id="attribute-customer"]',
        );
        assert.ok(attribute, 'Expected the Customer requisite drag source');
        const transfer = createFormDataTransfer();
        attribute.dispatchEvent(createFormDragEvent(fixture.dom, 'dragstart', transfer));
        assert.strictEqual(transfer.getData(requisiteType), 'Customer');

        if (surface === 'preview') {
          setPreviewChildGeometry(itemElement(fixture, 'preview', 'source-middle'), [0]);
        }
        dropOnItem(fixture, surface, 'source-middle', transfer, 15);
        results[surface] = messagesOf(fixture, 'addElementFromRequisite');
      });
    }

    assert.deepStrictEqual(results, {
      tree: [{
        type: 'addElementFromRequisite',
        requisiteName: 'Customer',
        dataPath: 'Customer',
        targetId: 'source-middle',
        index: 0,
      }],
      preview: [{
        type: 'addElementFromRequisite',
        requisiteName: 'Customer',
        dataPath: 'Customer',
        targetId: 'source-middle',
        index: 1,
        source: 'preview',
      }],
    });
  });

  test('leaf targets and unknown sources do not emit drag messages on either surface', () => {
    const results: Record<Surface, { leafTarget: unknown[]; unknownSource: unknown[] }> = {
      tree: { leafTarget: [], unknownSource: [] },
      preview: { leafTarget: [], unknownSource: [] },
    };
    for (const surface of surfaces) {
      withRuntime((fixture) => {
        sendFormData(fixture, createDropModel());

        const leafTransfer = createFormDataTransfer();
        leafTransfer.setData('text/plain', 'source-leaf');
        dropOnItem(fixture, surface, 'leaf-target', leafTransfer);
        results[surface].leafTarget = messagesOf(fixture, 'dragDrop').slice();

        const unknownTransfer = createFormDataTransfer();
        unknownTransfer.setData('text/plain', 'unknown-form-element');
        dropOnItem(fixture, surface, 'right-group', unknownTransfer);
        results[surface].unknownSource = messagesOf(fixture, 'dragDrop').slice();
      });
    }

    assert.deepStrictEqual(results, {
      tree: { leafTarget: [], unknownSource: [] },
      preview: { leafTarget: [], unknownSource: [] },
    });
  });

  test('valid dragover highlights only its container, sets move, and clears after leave and drop', () => {
    const results: Record<Surface, unknown[]> = { tree: [], preview: [] };
    for (const surface of surfaces) {
      withRuntime((fixture) => {
        sendFormData(fixture, createDropModel());
        if (surface === 'preview') {
          setPreviewChildGeometry(itemElement(fixture, surface, 'middle'), [0]);
        }

        const transfer = dragStart(fixture, surface, 'source-leaf');
        const over = dragOverOnItem(fixture, surface, 'middle', transfer);
        const highlightedAfterOver = highlightState(fixture, surface, 'middle');
        const rootHighlightedAfterOver = surface === 'tree'
          ? itemElement(fixture, 'tree', formRootId).classList.contains('drop-target')
          : false;
        const messagesAfterOver = messagesOf(fixture, 'dragDrop').slice();

        dragLeaveOnItem(fixture, surface, 'middle');
        const highlightedAfterLeave = highlightState(fixture, surface, 'middle');
        const reenter = dragOverOnItem(fixture, surface, 'middle', transfer);
        const highlightedOnReenter = highlightState(fixture, surface, 'middle');
        const drop = dropOnItem(fixture, surface, 'middle', transfer, 0);

        results[surface] = [
          over.defaultPrevented,
          transfer.dropEffect,
          highlightedAfterOver,
          rootHighlightedAfterOver,
          messagesAfterOver,
          highlightedAfterLeave,
          reenter.defaultPrevented,
          highlightedOnReenter,
          drop.defaultPrevented,
          highlightState(fixture, surface, 'middle'),
          messagesOf(fixture, 'dragDrop'),
        ];
      });
    }

    assert.deepStrictEqual(results, {
      tree: [
        true,
        'move',
        { target: true, ancestors: false },
        false,
        [],
        { target: false, ancestors: false },
        true,
        { target: true, ancestors: false },
        true,
        { target: false, ancestors: false },
        [{ type: 'dragDrop', sourceId: 'source-leaf', targetId: 'middle', index: 0 }],
      ],
      preview: [
        true,
        'move',
        { target: true, ancestors: false },
        false,
        [],
        { target: false, ancestors: false },
        true,
        { target: true, ancestors: false },
        true,
        { target: false, ancestors: false },
        [{ type: 'dragDrop', sourceId: 'source-leaf', targetId: 'middle', index: 0, source: 'preview' }],
      ],
    });
  });

  test('invalid dragovers do not highlight a target or fall back to an ancestor on either surface', () => {
    const invalidCases: Array<{ sourceId: string; targetId: string }> = [
      { sourceId: 'outer', targetId: 'outer' },
      { sourceId: 'outer', targetId: 'middle' },
      { sourceId: 'outer', targetId: 'deep' },
      { sourceId: 'unknown-form-element', targetId: 'right-group' },
      { sourceId: '', targetId: 'right-group' },
      { sourceId: 'source-leaf', targetId: 'leaf-target' },
    ];
    const results: Record<Surface, unknown[][]> = { tree: [], preview: [] };
    for (const surface of surfaces) {
      withRuntime((fixture) => {
        sendFormData(fixture, createDropModel());
        for (const { sourceId, targetId } of invalidCases) {
          const transfer = createFormDataTransfer();
          if (sourceId) { transfer.setData('text/plain', sourceId); }
          const over = dragOverOnItem(fixture, surface, targetId, transfer);
          const highlightedAfterOver = highlightState(fixture, surface, targetId);
          const rootHighlightedAfterOver = surface === 'tree'
            ? itemElement(fixture, 'tree', formRootId).classList.contains('drop-target')
            : false;
          const drop = dropOnItem(fixture, surface, targetId, transfer);
          results[surface].push([
            over.defaultPrevented,
            transfer.dropEffect,
            highlightedAfterOver,
            rootHighlightedAfterOver,
            drop.defaultPrevented,
            highlightState(fixture, surface, targetId),
            messagesOf(fixture, 'dragDrop').slice(),
          ]);
        }
      });
    }

    const expectedInvalidCase = (): unknown[] => [
      true,
      'none',
      { target: false, ancestors: false },
      false,
      true,
      { target: false, ancestors: false },
      [],
    ];
    assert.deepStrictEqual(results, {
      tree: invalidCases.map(expectedInvalidCase),
      preview: invalidCases.map(expectedInvalidCase),
    });
  });

  test('requisite dragover uses copy, clears highlight, and refuses leaf targets on both surfaces', () => {
    const results: Record<Surface, unknown[]> = { tree: [], preview: [] };
    for (const surface of surfaces) {
      withRuntime((fixture) => {
        sendFormData(fixture, createDropModel());
        if (surface === 'preview') {
          setPreviewChildGeometry(itemElement(fixture, surface, 'middle'), [0]);
        }

        const transfer = requisiteTransfer(fixture);
        const over = dragOverOnItem(fixture, surface, 'middle', transfer);
        const highlightAfterOver = highlightState(fixture, surface, 'middle');
        dragLeaveOnItem(fixture, surface, 'middle');
        const highlightAfterLeave = highlightState(fixture, surface, 'middle');
        const reenter = dragOverOnItem(fixture, surface, 'middle', transfer);
        const drop = dropOnItem(fixture, surface, 'middle', transfer, 0);
        const highlightAfterDrop = highlightState(fixture, surface, 'middle');
        const successfulMessages = messagesOf(fixture, 'addElementFromRequisite').slice();

        const leafTransfer = requisiteTransfer(fixture);
        const leafOver = dragOverOnItem(fixture, surface, 'leaf-target', leafTransfer);
        const leafHighlight = highlightState(fixture, surface, 'leaf-target');
        const leafDrop = dropOnItem(fixture, surface, 'leaf-target', leafTransfer);

        results[surface] = [
          over.defaultPrevented,
          transfer.dropEffect,
          highlightAfterOver,
          highlightAfterLeave,
          reenter.defaultPrevented,
          drop.defaultPrevented,
          highlightAfterDrop,
          successfulMessages,
          leafOver.defaultPrevented,
          leafTransfer.dropEffect,
          leafHighlight,
          leafDrop.defaultPrevented,
          highlightState(fixture, surface, 'leaf-target'),
          messagesOf(fixture, 'addElementFromRequisite'),
        ];
      });
    }

    assert.deepStrictEqual(results, {
      tree: [
        true,
        'copy',
        { target: true, ancestors: false },
        { target: false, ancestors: false },
        true,
        true,
        { target: false, ancestors: false },
        [{ type: 'addElementFromRequisite', requisiteName: 'Customer', dataPath: 'Customer', targetId: 'middle', index: 0 }],
        true,
        'none',
        { target: false, ancestors: false },
        true,
        { target: false, ancestors: false },
        [{ type: 'addElementFromRequisite', requisiteName: 'Customer', dataPath: 'Customer', targetId: 'middle', index: 0 }],
      ],
      preview: [
        true,
        'copy',
        { target: true, ancestors: false },
        { target: false, ancestors: false },
        true,
        true,
        { target: false, ancestors: false },
        [{ type: 'addElementFromRequisite', requisiteName: 'Customer', dataPath: 'Customer', targetId: 'middle', index: 0, source: 'preview' }],
        true,
        'none',
        { target: false, ancestors: false },
        true,
        { target: false, ancestors: false },
        [{ type: 'addElementFromRequisite', requisiteName: 'Customer', dataPath: 'Customer', targetId: 'middle', index: 0, source: 'preview' }],
      ],
    });
  });

  test('synthetic Form root highlights valid moves and rejects requisite and unknown sources', () => {
    withRuntime((fixture) => {
      sendFormData(fixture, createDropModel());
      const root = itemElement(fixture, 'tree', formRootId);
      const transfer = dragStart(fixture, 'tree', 'source-leaf');
      const over = dragOverOnItem(fixture, 'tree', formRootId, transfer);
      const highlightedAfterOver = root.classList.contains('drop-target');
      const messagesAfterOver = messagesOf(fixture, 'dragDrop').slice();
      dragLeaveOnItem(fixture, 'tree', formRootId);
      const highlightedAfterLeave = root.classList.contains('drop-target');
      const reenter = dragOverOnItem(fixture, 'tree', formRootId, transfer);
      const highlightedOnReenter = root.classList.contains('drop-target');
      const drop = dropOnItem(fixture, 'tree', formRootId, transfer);
      const highlightedAfterDrop = root.classList.contains('drop-target');
      const validMessages = messagesOf(fixture, 'dragDrop').slice();

      const requisite = requisiteTransfer(fixture);
      const requisiteOver = dragOverOnItem(fixture, 'tree', formRootId, requisite);
      const requisiteHighlighted = root.classList.contains('drop-target');
      const requisiteDrop = dropOnItem(fixture, 'tree', formRootId, requisite);
      const requisiteMessages = messagesOf(fixture, 'addElementFromRequisite').slice();

      const unknown = createFormDataTransfer();
      unknown.setData('text/plain', 'unknown-form-element');
      const unknownOver = dragOverOnItem(fixture, 'tree', formRootId, unknown);
      const unknownHighlighted = root.classList.contains('drop-target');
      const unknownDrop = dropOnItem(fixture, 'tree', formRootId, unknown);

      assert.deepStrictEqual({
        valid: [
          over.defaultPrevented,
          transfer.dropEffect,
          highlightedAfterOver,
          messagesAfterOver,
          highlightedAfterLeave,
          reenter.defaultPrevented,
          highlightedOnReenter,
          drop.defaultPrevented,
          highlightedAfterDrop,
          validMessages,
        ],
        requisite: [
          requisiteOver.defaultPrevented,
          requisite.dropEffect,
          requisiteHighlighted,
          requisiteDrop.defaultPrevented,
          root.classList.contains('drop-target'),
          requisiteMessages,
        ],
        unknown: [
          unknownOver.defaultPrevented,
          unknown.dropEffect,
          unknownHighlighted,
          unknownDrop.defaultPrevented,
          root.classList.contains('drop-target'),
          messagesOf(fixture, 'dragDrop').slice(),
        ],
      }, {
        valid: [
          true,
          'move',
          true,
          [],
          false,
          true,
          true,
          true,
          false,
          [{ type: 'dragDrop', sourceId: 'source-leaf', targetId: formRootId, index: 0 }],
        ],
        requisite: [true, 'none', false, true, false, []],
        unknown: [true, 'none', false, true, false, [
          { type: 'dragDrop', sourceId: 'source-leaf', targetId: formRootId, index: 0 },
        ]],
      });
    });
  });

  test('tree multi-selection continues to prohibit drag sources', () => {
    withRuntime((fixture) => {
      sendFormData(fixture, createDropModel());
      const document = fixture.dom.window.document;
      const first = itemElement(fixture, 'tree', 'source-leaf');
      const second = itemElement(fixture, 'tree', 'left-group');
      first.dispatchEvent(new fixture.dom.window.MouseEvent('click', { bubbles: true }));
      second.dispatchEvent(new fixture.dom.window.MouseEvent('click', { bubbles: true, ctrlKey: true }));

      const transfer = createFormDataTransfer();
      const dragStartEvent = createFormDragEvent(fixture.dom, 'dragstart', transfer);
      first.dispatchEvent(dragStartEvent);
      dropOnItem(fixture, 'tree', 'right-group', transfer);

      assert.strictEqual(dragStartEvent.defaultPrevented, true);
      assert.strictEqual(transfer.getData('text/plain'), '');
      assert.deepStrictEqual(messagesOf(fixture, 'dragDrop'), []);
      assert.ok(document.querySelector('#tree-root .tree-node[data-id="source-leaf"].selected'));
      assert.ok(document.querySelector('#tree-root .tree-node[data-id="left-group"].selected'));
    });
  });

  test('AutoCommandBar and nested CommandBar ancestry works with fallback, numeric and ordinary IDs', () => {
    const modes: CommandBarIdMode[] = ['name-fallback', 'numeric-id', 'ordinary-id'];
    const results: Record<CommandBarIdMode, Record<Surface, unknown>> = {
      'name-fallback': { tree: null, preview: null },
      'numeric-id': { tree: null, preview: null },
      'ordinary-id': { tree: null, preview: null },
    };

    for (const mode of modes) {
      for (const surface of surfaces) {
        withRuntime((fixture) => {
          const { model, ids } = createAutoCommandBarModel(mode);
          sendFormData(fixture, model);

          const mainTransfer = dragStart(fixture, surface, ids.main);
          const mainSourceId = mainTransfer.getData('text/plain');
          dropOnItem(fixture, surface, ids.deep, mainTransfer);
          const descendantDrop = messagesOf(fixture, 'dragDrop').slice();

          if (surface === 'preview') {
            setPreviewChildGeometry(itemElement(fixture, surface, ids.main), [0, 20]);
          }
          const nestedTransfer = dragStart(fixture, surface, ids.nested);
          const nestedSourceId = nestedTransfer.getData('text/plain');
          dropOnItem(fixture, surface, ids.main, nestedTransfer);
          const ancestorDrop = messagesOf(fixture, 'dragDrop').slice();

          if (surface === 'preview') {
            setPreviewChildGeometry(itemElement(fixture, surface, ids.nested), [0]);
          }
          const siblingTransfer = dragStart(fixture, surface, ids.sibling);
          const siblingSourceId = siblingTransfer.getData('text/plain');
          dropOnItem(fixture, surface, ids.nested, siblingTransfer);
          const siblingDrop = messagesOf(fixture, 'dragDrop').slice();

          results[mode][surface] = {
            dragStartIds: [mainSourceId, nestedSourceId, siblingSourceId],
            descendantDrop,
            ancestorDrop,
            siblingDrop,
          };
        });
      }
    }

    const expected = (mode: CommandBarIdMode, surface: Surface): unknown => {
      const { ids } = createAutoCommandBarModel(mode);
      const payload = (sourceId: string, targetId: string): unknown => ({
        type: 'dragDrop',
        sourceId,
        targetId,
        index: 0,
        ...(surface === 'preview' ? { source: 'preview' } : {}),
      });
      return {
        dragStartIds: [ids.main, ids.nested, ids.sibling],
        descendantDrop: [],
        ancestorDrop: [payload(ids.nested, ids.main)],
        siblingDrop: [payload(ids.nested, ids.main), payload(ids.sibling, ids.nested)],
      };
    };
    const expectedResults: Record<CommandBarIdMode, Record<Surface, unknown>> = {
      'name-fallback': { tree: expected('name-fallback', 'tree'), preview: expected('name-fallback', 'preview') },
      'numeric-id': { tree: expected('numeric-id', 'tree'), preview: expected('numeric-id', 'preview') },
      'ordinary-id': { tree: expected('ordinary-id', 'tree'), preview: expected('ordinary-id', 'preview') },
    };

    assert.deepStrictEqual(results, expectedResults);
  });

  test('AutoCommandBar dragover and dragleave use the same ancestry rules for fallback and explicit IDs', () => {
    const modes: CommandBarIdMode[] = ['name-fallback', 'numeric-id', 'ordinary-id'];
    const results: Record<CommandBarIdMode, Record<Surface, unknown>> = {
      'name-fallback': { tree: null, preview: null },
      'numeric-id': { tree: null, preview: null },
      'ordinary-id': { tree: null, preview: null },
    };

    for (const mode of modes) {
      for (const surface of surfaces) {
        withRuntime((fixture) => {
          const { model, ids } = createAutoCommandBarModel(mode);
          sendFormData(fixture, model);
          if (surface === 'preview') {
            setPreviewChildGeometry(itemElement(fixture, surface, ids.main), [0, 20]);
            setPreviewChildGeometry(itemElement(fixture, surface, ids.nested), [0]);
          }

          const invalidTransfer = dragStart(fixture, surface, ids.main);
          const invalidOver = dragOverOnItem(fixture, surface, ids.deep, invalidTransfer);
          const invalidState = [
            invalidOver.defaultPrevented,
            invalidTransfer.dropEffect,
            highlightState(fixture, surface, ids.deep),
            messagesOf(fixture, 'dragDrop').slice(),
          ];
          const invalidDrop = dropOnItem(fixture, surface, ids.deep, invalidTransfer);

          const ancestorTransfer = dragStart(fixture, surface, ids.nested);
          const ancestorOver = dragOverOnItem(fixture, surface, ids.main, ancestorTransfer);
          const ancestorState = [
            ancestorOver.defaultPrevented,
            ancestorTransfer.dropEffect,
            highlightState(fixture, surface, ids.main),
          ];
          dragLeaveOnItem(fixture, surface, ids.main);
          const ancestorAfterLeave = highlightState(fixture, surface, ids.main);
          const ancestorReenter = dragOverOnItem(fixture, surface, ids.main, ancestorTransfer);
          const ancestorDrop = dropOnItem(fixture, surface, ids.main, ancestorTransfer, 0);

          const siblingTransfer = dragStart(fixture, surface, ids.sibling);
          const siblingOver = dragOverOnItem(fixture, surface, ids.nested, siblingTransfer);
          const siblingState = [
            siblingOver.defaultPrevented,
            siblingTransfer.dropEffect,
            highlightState(fixture, surface, ids.nested),
          ];
          dragLeaveOnItem(fixture, surface, ids.nested);
          const siblingAfterLeave = highlightState(fixture, surface, ids.nested);
          const siblingReenter = dragOverOnItem(fixture, surface, ids.nested, siblingTransfer);
          const siblingDrop = dropOnItem(fixture, surface, ids.nested, siblingTransfer, 0);

          results[mode][surface] = {
            invalid: [
              ...invalidState,
              invalidDrop.defaultPrevented,
              highlightState(fixture, surface, ids.deep),
            ],
            ancestor: [
              ...ancestorState,
              ancestorAfterLeave,
              ancestorReenter.defaultPrevented,
              ancestorDrop.defaultPrevented,
            ],
            sibling: [
              ...siblingState,
              siblingAfterLeave,
              siblingReenter.defaultPrevented,
              siblingDrop.defaultPrevented,
            ],
            payloads: messagesOf(fixture, 'dragDrop').slice(),
          };
        });
      }
    }

    const expected = (mode: CommandBarIdMode, surface: Surface): unknown => {
      const { ids } = createAutoCommandBarModel(mode);
      const payload = (sourceId: string, targetId: string): unknown => ({
        type: 'dragDrop',
        sourceId,
        targetId,
        index: 0,
        ...(surface === 'preview' ? { source: 'preview' } : {}),
      });
      return {
        invalid: [
          true,
          'none',
          { target: false, ancestors: false },
          [],
          true,
          { target: false, ancestors: false },
        ],
        ancestor: [
          true,
          'move',
          { target: true, ancestors: false },
          { target: false, ancestors: false },
          true,
          true,
        ],
        sibling: [
          true,
          'move',
          { target: true, ancestors: false },
          { target: false, ancestors: false },
          true,
          true,
        ],
        payloads: [payload(ids.nested, ids.main), payload(ids.sibling, ids.nested)],
      };
    };
    assert.deepStrictEqual(results, {
      'name-fallback': { tree: expected('name-fallback', 'tree'), preview: expected('name-fallback', 'preview') },
      'numeric-id': { tree: expected('numeric-id', 'tree'), preview: expected('numeric-id', 'preview') },
      'ordinary-id': { tree: expected('ordinary-id', 'tree'), preview: expected('ordinary-id', 'preview') },
    });
  });
});
