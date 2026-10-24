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
): void {
  itemElement(fixture, surface, targetId)
    .dispatchEvent(createFormDragEvent(fixture.dom, 'drop', transfer, 0, clientY));
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
});
