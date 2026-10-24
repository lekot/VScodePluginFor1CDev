import * as assert from 'assert';
import type { FormMessage } from '../../src/formEditor/formMessageHandler';
import type { FormAttribute, FormChildItem, FormCommand, FormModel } from '../../src/formEditor/formModel';
import {
  createFormDataTransfer,
  createFormDragEvent,
  createFormWebviewRuntimeFixture,
  type FormWebviewRuntimeFixture,
} from '../helpers/formWebviewRuntime';

function makeItem(
  tag: string,
  id: string,
  name: string,
  properties: Record<string, unknown> = {},
  childItems: FormChildItem[] = [],
  events?: Record<string, string>,
): FormChildItem {
  return { tag, id, name, properties, childItems, events };
}

function makeFormModel(): FormModel {
  const fieldOne = makeItem('InputField', 'field-one', 'FirstField', {
    DataPath: 'FirstName',
    Title: 'Имя',
    Placeholder: 'Введите имя',
  }, [], { OnChange: 'OnFirstNameChange' });
  const fieldTwo = makeItem('InputField', 'field-two', 'SecondField', {
    DataPath: 'SecondName',
    Title: 'Имя',
    Placeholder: 'Введите имя',
  }, [], { OnChange: 'OnSecondNameChange' });
  const pageOne = makeItem('Page', 'page-one', 'MainPage', { Title: 'Основная' }, [
    makeItem('Button', 'page-button', 'ApplyButton', { Title: 'Применить' }),
  ]);
  const pageTwo = makeItem('Page', 'page-two', 'AdditionalPage', { Title: 'Дополнительно' }, [
    makeItem('LabelDecoration', 'page-label', 'HelpLabel', { Title: 'Справка' }),
  ]);
  const pages = makeItem('Pages', 'pages-one', 'ContentPages', {}, [pageOne, pageTwo]);
  const group = makeItem('UsualGroup', 'group-one', 'MainGroup', { Title: 'Главная группа' }, [fieldOne, fieldTwo]);
  const attributes: FormAttribute[] = [
    { name: 'FirstName', id: 'attribute-first-name', properties: { Type: 'String(100)' } },
  ];
  const commands: FormCommand[] = [
    { name: 'RunAction', id: 'command-run', properties: { Title: 'Запустить' } },
  ];
  const autoCommandBar = makeItem('AutoCommandBar', 'auto-bar', 'MainCommandBar', {}, [
    makeItem('Button', 'auto-command', 'RunActionButton', { CommandName: 'RunAction' }),
  ]);

  return {
    childItemsRoot: [group, pages],
    attributes,
    commands,
    formEvents: [{ name: 'OnOpen', method: 'OnFormOpen' }],
    autoCommandBarName: autoCommandBar.name,
    autoCommandBarId: autoCommandBar.id,
    autoCommandBar,
    parameters: [{ name: 'Mode', id: 'parameter-mode', properties: { Type: 'String' } }],
  };
}

function sendFormData(fixture: FormWebviewRuntimeFixture, model = makeFormModel()): void {
  fixture.send({
    type: 'formData',
    formModel: model,
    formXmlPath: '/workspace/Forms/Main.xml',
    modulePath: '/workspace/Forms/Ext/Module.bsl',
    addElementWizardConfig: {
      options: [
        { tag: 'InputField', defaultName: 'NewInput', hint: 'Добавить поле ввода' },
        { tag: 'Button', defaultName: 'NewButton', hint: 'Добавить кнопку' },
      ],
    },
  });
}

function click(fixture: FormWebviewRuntimeFixture, selector: string, options: { ctrlKey?: boolean; shiftKey?: boolean } = {}): void {
  const target = fixture.dom.window.document.querySelector(selector);
  assert.ok(target, `Expected DOM element for ${selector}`);
  target.dispatchEvent(new fixture.dom.window.MouseEvent('click', { bubbles: true, ...options }));
}

function messagesOf(fixture: FormWebviewRuntimeFixture, type: string): FormMessage[] {
  return fixture.messages.filter((message) => message.type === type);
}

function lastMessageOf(fixture: FormWebviewRuntimeFixture, type: string): FormMessage {
  const messages = messagesOf(fixture, type);
  const message = messages[messages.length - 1];
  assert.ok(message, `Expected a ${type} message`);
  return message;
}

function withRuntime(testBody: (fixture: FormWebviewRuntimeFixture) => void): void {
  const fixture = createFormWebviewRuntimeFixture();
  try {
    testBody(fixture);
  } finally {
    fixture.close();
  }
}

suite('Form webview runtime characterization', () => {
  test('loads locally, renders tree, preview, AutoCommandBar and Pages, and preserves page selection', () => {
    withRuntime((fixture) => {
      assert.deepStrictEqual(messagesOf(fixture, 'load').length, 1);
      const document = fixture.dom.window.document;
      assert.strictEqual(document.querySelectorAll('script[src], link[href]').length, 0, 'the browser fixture does not load external resources');

      sendFormData(fixture);

      assert.match(document.getElementById('tree-root')?.textContent || '', /MainCommandBar/);
      assert.match(document.getElementById('tree-root')?.textContent || '', /FirstField/);
      assert.match(document.getElementById('command-interface-content')?.textContent || '', /RunAction/);
      assert.ok(document.querySelector('.preview-item[data-id="field-one"]'), 'metadata fields are rendered in the preview');
      assert.ok(document.querySelector('.preview-pages-tab[data-page-id="page-one"]'));
      assert.ok(document.querySelector('.preview-pages-tab[data-page-id="page-two"]'));
      assert.ok(document.querySelector('#preview-panel-pages-one-page-one .preview-item[data-id="page-button"]'));

      click(fixture, '.preview-pages-tab[data-page-id="page-two"]');

      assert.strictEqual(
        document.querySelector('.preview-pages-tab[data-page-id="page-two"]')?.getAttribute('aria-selected'),
        'true',
        'selecting a page switches the preview tab',
      );
      assert.ok(document.querySelector('#preview-panel-pages-one-page-two .preview-item[data-id="page-label"]'));
      assert.deepStrictEqual(messagesOf(fixture, 'selectElement'), [], 'changing the preview page is local UI state');
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    });
  });

  test('preserves theme, single/multiple selection and property change messages', () => {
    withRuntime((fixture) => {
      sendFormData(fixture);
      const document = fixture.dom.window.document;

      fixture.send({ type: 'hostColorTheme', kind: 1 });
      assert.strictEqual(document.documentElement.getAttribute('data-vscode-theme'), 'light');

      click(fixture, '#tree-root .tree-node[data-id="field-one"]');
      const selected = lastMessageOf(fixture, 'selectElement');
      assert.deepStrictEqual(selected.selectedIds, ['field-one']);
      assert.strictEqual(selected.elementId, 'field-one');

      const titleInput = document.querySelector('#props-content input[data-key="Title"]');
      assert.ok(titleInput instanceof fixture.dom.window.HTMLInputElement);
      titleInput.value = 'Updated title';
      titleInput.dispatchEvent(new fixture.dom.window.Event('change', { bubbles: true }));
      const change = lastMessageOf(fixture, 'propertyChange');
      assert.strictEqual(change.elementId, 'field-one');
      assert.strictEqual(change.key, 'Title');
      assert.strictEqual(change.value, 'Updated title');

      click(fixture, '#tree-root .tree-node[data-id="field-two"]', { ctrlKey: true });
      assert.deepStrictEqual(lastMessageOf(fixture, 'selectElement').selectedIds, ['field-one', 'field-two']);
      assert.match(document.getElementById('props-header')?.textContent || '', /Выбрано элементов: 2/);

      const commonTitle = document.querySelector('#props-content input[data-key="Title"]');
      assert.ok(commonTitle instanceof fixture.dom.window.HTMLInputElement);
      commonTitle.value = 'Shared title';
      commonTitle.dispatchEvent(new fixture.dom.window.Event('change', { bubbles: true }));
      const multiChange = lastMessageOf(fixture, 'propertyChange');
      assert.deepStrictEqual(multiChange.elementIds, ['field-one', 'field-two']);
      assert.strictEqual(multiChange.key, 'Title');
      assert.strictEqual(multiChange.value, 'Shared title');
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    });
  });

  test('preserves the tree drop handler payload and form attribute/command section controls', () => {
    withRuntime((fixture) => {
      sendFormData(fixture);
      const document = fixture.dom.window.document;
      const source = document.querySelector('#tree-root .tree-node[data-id="group-one"]');
      const target = document.querySelector('#tree-root .tree-node[data-id="pages-one"]');
      assert.ok(source);
      assert.ok(target);

      const transfer = createFormDataTransfer();
      source.dispatchEvent(createFormDragEvent(fixture.dom, 'dragstart', transfer, 0, 0, false));
      assert.strictEqual(transfer.getData('text/plain'), 'group-one');
      target.dispatchEvent(createFormDragEvent(fixture.dom, 'drop', transfer, 0, 0, false));
      const drop = lastMessageOf(fixture, 'dragDrop');
      assert.deepStrictEqual(
        { sourceId: drop.sourceId, targetId: drop.targetId, index: drop.index },
        { sourceId: 'group-one', targetId: 'pages-one', index: 0 },
      );

      const attributeRow = document.querySelector('#attributes-tbody tr');
      assert.ok(attributeRow);
      attributeRow.dispatchEvent(new fixture.dom.window.MouseEvent('click', { bubbles: true }));
      assert.match(document.getElementById('props-header')?.textContent || '', /FirstName/);
      click(fixture, '#btn-add-attribute');
      assert.strictEqual(lastMessageOf(fixture, 'addAttribute').type, 'addAttribute');
      click(fixture, '#btn-delete-attribute');
      assert.strictEqual(lastMessageOf(fixture, 'deleteAttribute').attributeId, 'attribute-first-name');

      click(fixture, '[data-right-tab="commands"]');
      const commandRow = document.querySelector('#commands-tbody tr');
      assert.ok(commandRow);
      commandRow.dispatchEvent(new fixture.dom.window.MouseEvent('click', { bubbles: true }));
      assert.match(document.getElementById('props-header')?.textContent || '', /RunAction/);
      click(fixture, '#btn-add-command');
      assert.strictEqual(lastMessageOf(fixture, 'addCommand').type, 'addCommand');
      click(fixture, '#btn-delete-command');
      assert.strictEqual(lastMessageOf(fixture, 'deleteCommand').commandId, 'command-run');
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    });
  });

  test('preserves sibling move messages and direct tree/preview requisite drop payloads', () => {
    withRuntime((fixture) => {
      sendFormData(fixture);
      const document = fixture.dom.window.document;

      click(fixture, '#tree-root .tree-node[data-id="field-two"]');
      click(fixture, '#tb-up');
      assert.deepStrictEqual(lastMessageOf(fixture, 'moveElementSibling'), {
        type: 'moveElementSibling',
        elementId: 'field-two',
        direction: 'up',
      });
      click(fixture, '#tree-root .tree-node[data-id="field-one"]');
      click(fixture, '#tb-down');
      assert.deepStrictEqual(lastMessageOf(fixture, 'moveElementSibling'), {
        type: 'moveElementSibling',
        elementId: 'field-one',
        direction: 'down',
      });

      const treeTarget = document.querySelector<HTMLElement>('#tree-root .tree-node[data-id="group-one"]');
      assert.ok(treeTarget);
      const treeTransfer = createFormDataTransfer();
      treeTransfer.setData('application/x-1c-form-requisite', 'Customer');
      treeTarget.dispatchEvent(createFormDragEvent(fixture.dom, 'drop', treeTransfer, 0, 0, false));
      assert.deepStrictEqual(lastMessageOf(fixture, 'addElementFromRequisite'), {
        type: 'addElementFromRequisite',
        requisiteName: 'Customer',
        dataPath: 'Customer',
        targetId: 'group-one',
        index: 0,
      });

      const previewTarget = document.querySelector<HTMLElement>('#preview-form .preview-item[data-id="group-one"]');
      assert.ok(previewTarget);
      const previewTransfer = createFormDataTransfer();
      previewTransfer.setData('application/x-1c-form-requisite', 'Customer');
      previewTarget.dispatchEvent(createFormDragEvent(fixture.dom, 'drop', previewTransfer, 0, 0, false));
      assert.deepStrictEqual(lastMessageOf(fixture, 'addElementFromRequisite'), {
        type: 'addElementFromRequisite',
        requisiteName: 'Customer',
        dataPath: 'Customer',
        targetId: 'group-one',
        index: 0,
        source: 'preview',
      });
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    });
  });

  test('preserves toolbar add wizard, delete, copy/paste, save, cancel and host responses', () => {
    withRuntime((fixture) => {
      const model = makeFormModel();
      sendFormData(fixture, model);
      const document = fixture.dom.window.document;

      click(fixture, '#tree-root .tree-node[data-id="group-one"]');
      click(fixture, '#tb-add');
      const add = lastMessageOf(fixture, 'addElement');
      assert.strictEqual(add.parentId, 'group-one');
      assert.strictEqual(add.tag, 'InputField');
      assert.strictEqual(add.name, 'NewItem');

      click(fixture, '#tb-add-wizard');
      assert.strictEqual(document.getElementById('add-wizard-overlay')?.getAttribute('style')?.includes('flex'), true);
      assert.strictEqual((document.getElementById('add-wizard-name') as HTMLInputElement).value, 'NewInput');
      click(fixture, '#add-wizard-submit');
      const wizard = lastMessageOf(fixture, 'addElementWizard');
      assert.strictEqual(wizard.parentId, 'group-one');
      assert.strictEqual(wizard.tag, 'InputField');
      assert.strictEqual(wizard.name, 'NewInput');
      assert.strictEqual(document.getElementById('add-wizard-overlay')?.style.display, 'none');

      click(fixture, '#tree-root .tree-node[data-id="field-one"]');
      click(fixture, '#tb-copy');
      click(fixture, '#tree-root .tree-node[data-id="group-one"]');
      click(fixture, '#tb-paste');
      const paste = lastMessageOf(fixture, 'pasteElement');
      assert.strictEqual(paste.targetId, 'group-one');
      assert.strictEqual((paste.clipboard as Record<string, unknown>).id, 'field-one');

      click(fixture, '#tree-root .tree-node[data-id="field-one"]');
      click(fixture, '#tb-delete');
      assert.strictEqual(lastMessageOf(fixture, 'deleteElement').elementId, 'field-one');
      click(fixture, '#tb-save');
      const save = lastMessageOf(fixture, 'save');
      assert.deepStrictEqual(save.formModel, JSON.parse(JSON.stringify(model)));
      assert.strictEqual(document.getElementById('save-status')?.textContent, 'Сохранение...');
      click(fixture, '#tb-cancel');
      assert.strictEqual(lastMessageOf(fixture, 'cancel').type, 'cancel');

      fixture.send({ type: 'saved' });
      assert.strictEqual(document.getElementById('save-status')?.textContent, 'Сохранено');
      fixture.send({ type: 'error', message: 'Сбой загрузки формы' });
      assert.strictEqual(document.getElementById('tree-error')?.textContent, 'Сбой загрузки формы');
      assert.match(document.getElementById('save-status')?.textContent || '', /Сбой загрузки формы/);
      fixture.send({ type: 'procedures', procedures: ['OnOpen', 'OnChange'] });
      assert.deepStrictEqual(fixture.dom.window.formProcedures, ['OnOpen', 'OnChange']);
      const procedureObjects = [{ name: 'OnObjectProcedure', line: 12 }];
      fixture.send({ type: 'procedures', procedures: procedureObjects });
      assert.deepStrictEqual(fixture.dom.window.formProcedures, procedureObjects, 'legacy host procedures payload remains available unchanged');
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    });
  });

  test('renders hostile model values as text and keeps properties escaped in the inspector', () => {
    withRuntime((fixture) => {
      const model = makeFormModel();
      const hostile = '<img src=x onerror=alert(1)>';
      model.childItemsRoot[0].childItems[0].name = hostile;
      model.childItemsRoot[0].childItems[0].properties.Title = hostile;
      sendFormData(fixture, model);

      const document = fixture.dom.window.document;
      const label = document.querySelector('#tree-root .tree-node[data-id="field-one"] .tree-node-label');
      assert.strictEqual(label?.textContent, `${hostile} (InputField)`);
      assert.strictEqual(document.querySelector('#tree-root img'), null);
      click(fixture, '#tree-root .tree-node[data-id="field-one"]');
      assert.strictEqual(document.querySelector('#props-content img'), null);
      const titleInput = document.querySelector('#props-content input[data-key="Title"]');
      assert.ok(titleInput instanceof fixture.dom.window.HTMLInputElement);
      assert.strictEqual(titleInput.value, hostile);
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    });
  });

  test('renders and selects nested requisite paths when the form has no declared attributes', () => {
    withRuntime((fixture) => {
      const model = makeFormModel();
      model.attributes = [];
      model.childItemsRoot = [makeItem('UsualGroup', 'requisite-group', 'Requisites', {}, [
        makeItem('InputField', 'customer-record', 'CustomerRecord', { DataPath: 'Customer' }),
        makeItem('InputField', 'customer-name', 'CustomerName', { DataPath: 'Customer.Name' }),
        makeItem('InputField', 'customer-city', 'CustomerCity', { DataPath: 'Customer.Address.City' }),
        makeItem('InputField', 'order-total', 'OrderTotal', { DataPath: 'Order.Total' }),
      ])];
      sendFormData(fixture, model);

      const document = fixture.dom.window.document;
      const treeRoot = document.getElementById('attributes-tree-root');
      assert.ok(treeRoot);
      assert.strictEqual(document.getElementById('attributes-table-wrap')?.style.display, 'none');
      assert.strictEqual(document.getElementById('attributes-tree-wrap')?.style.display, 'block');

      let customer = treeRoot.querySelector<HTMLElement>('.requisite-tree-node[data-full-path="Customer"]');
      assert.ok(customer);
      assert.strictEqual(customer.getAttribute('aria-expanded'), 'false');
      assert.strictEqual(customer.querySelector('.requisite-count')?.textContent, '1');
      assert.strictEqual(treeRoot.querySelector('[data-full-path="Customer.Name"]'), null, 'nested paths are initially collapsed');

      customer.querySelector('.tree-chevron')?.dispatchEvent(new fixture.dom.window.MouseEvent('click', { bubbles: true }));
      customer = treeRoot.querySelector<HTMLElement>('.requisite-tree-node[data-full-path="Customer"]');
      assert.ok(customer);
      assert.strictEqual(customer.getAttribute('aria-expanded'), 'true');
      const namePath = treeRoot.querySelector<HTMLElement>('.requisite-tree-node[data-full-path="Customer.Name"]');
      const addressPath = treeRoot.querySelector<HTMLElement>('.requisite-tree-node[data-full-path="Customer.Address"]');
      assert.ok(namePath);
      assert.ok(addressPath);
      assert.strictEqual(namePath.style.paddingLeft, '16px');
      assert.strictEqual(addressPath.getAttribute('aria-expanded'), 'false');

      customer.dispatchEvent(new fixture.dom.window.MouseEvent('click', { bubbles: true }));
      assert.deepStrictEqual(lastMessageOf(fixture, 'selectElement'), {
        type: 'selectElement',
        elementId: 'customer-record',
        selectedIds: ['customer-record'],
      });
      assert.ok(document.querySelector('#tree-root .tree-node[data-id="customer-record"].selected'));

      addressPath.querySelector('.tree-chevron')?.dispatchEvent(new fixture.dom.window.MouseEvent('click', { bubbles: true }));
      const cityPath = treeRoot.querySelector<HTMLElement>('.requisite-tree-node[data-full-path="Customer.Address.City"]');
      assert.ok(cityPath);
      assert.strictEqual(cityPath.style.paddingLeft, '32px');

      const selectionCount = messagesOf(fixture, 'selectElement').length;
      const orderPath = treeRoot.querySelector<HTMLElement>('.requisite-tree-node[data-full-path="Order"]');
      assert.ok(orderPath);
      orderPath.dispatchEvent(new fixture.dom.window.MouseEvent('click', { bubbles: true }));
      assert.strictEqual(messagesOf(fixture, 'selectElement').length, selectionCount, 'selecting a grouping path clears the element selection without a host selection message');
      assert.strictEqual(document.querySelector('#tree-root .tree-node.selected'), null);

      customer = treeRoot.querySelector<HTMLElement>('.requisite-tree-node[data-full-path="Customer"]');
      assert.ok(customer);
      customer.querySelector('.tree-chevron')?.dispatchEvent(new fixture.dom.window.MouseEvent('click', { bubbles: true }));
      assert.strictEqual(treeRoot.querySelector('[data-full-path="Customer.Address"]'), null);
      customer = treeRoot.querySelector<HTMLElement>('.requisite-tree-node[data-full-path="Customer"]');
      assert.ok(customer);
      customer.querySelector('.tree-chevron')?.dispatchEvent(new fixture.dom.window.MouseEvent('click', { bubbles: true }));
      assert.ok(treeRoot.querySelector('.requisite-tree-node[data-full-path="Order"].selected'), 'rendering the requisite tree reapplies its active path selection');
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    });
  });

  test('file-missing form data shows the empty state and disables form actions', () => {
    withRuntime((fixture) => {
      fixture.send({
        type: 'formData',
        formModel: makeFormModel(),
        fileMissing: true,
        fileMissingTitle: 'Файл формы отсутствует',
        fileMissingHint: 'Выберите существующий файл',
      });
      const document = fixture.dom.window.document;
      assert.strictEqual(document.getElementById('tree-empty')?.textContent?.includes('Файл формы отсутствует'), true);
      assert.match(document.getElementById('preview-form')?.textContent || '', /Файл формы не найден/);
      assert.strictEqual(document.getElementById('props-actions')?.style.display, 'none');
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    });
  });

  test('accepts host messages only from the webview origin', () => {
    withRuntime((fixture) => {
      const document = fixture.dom.window.document;
      sendFormData(fixture);
      fixture.send({ type: 'hostColorTheme', kind: 1 });
      fixture.send({ type: 'error', message: 'Trusted error' });
      const trustedProcedures = [{ name: 'TrustedProcedure', line: 4 }];
      fixture.send({ type: 'procedures', procedures: trustedProcedures });

      const foreignModel = makeFormModel();
      foreignModel.childItemsRoot[0].childItems[0].name = 'ForeignOriginField';
      fixture.dispatch({ type: 'formData', formModel: foreignModel }, 'https://attacker.test');
      assert.strictEqual(document.querySelector('#tree-root .tree-node[data-id="field-one"] .tree-node-label')?.textContent?.includes('ForeignOriginField'), false);

      const emptyOriginModel = makeFormModel();
      emptyOriginModel.childItemsRoot[0].childItems[0].name = 'EmptyOriginField';
      fixture.dispatch({ type: 'formData', formModel: emptyOriginModel }, '');
      assert.strictEqual(document.querySelector('#tree-root .tree-node[data-id="field-one"] .tree-node-label')?.textContent?.includes('EmptyOriginField'), false);

      fixture.dispatch({ type: 'hostColorTheme', kind: 2 }, 'https://attacker.test');
      fixture.dispatch({ type: 'hostColorTheme', kind: 2 }, '');
      assert.strictEqual(document.documentElement.getAttribute('data-vscode-theme'), 'light');

      fixture.dispatch({ type: 'saved' }, 'https://attacker.test');
      fixture.dispatch({ type: 'error', message: 'Foreign error' }, '');
      assert.strictEqual(document.getElementById('save-status')?.textContent, 'Ошибка: Trusted error');
      assert.strictEqual(document.getElementById('tree-error')?.textContent, 'Trusted error');

      fixture.dispatch({ type: 'procedures', procedures: ['ForeignProcedure'] }, 'https://attacker.test');
      fixture.dispatch({ type: 'procedures', procedures: ['EmptyOriginProcedure'] }, '');
      assert.deepStrictEqual(fixture.dom.window.formProcedures, trustedProcedures);

      const sameOriginModel = makeFormModel();
      sameOriginModel.childItemsRoot[0].childItems[0].name = 'SameOriginField';
      sendFormData(fixture, sameOriginModel);
      fixture.send({ type: 'hostColorTheme', kind: 2 });
      fixture.send({ type: 'saved' });
      const sameOriginProcedures = [{ name: 'SameOriginProcedure', line: 8 }];
      fixture.send({ type: 'procedures', procedures: sameOriginProcedures });

      assert.strictEqual(document.querySelector('#tree-root .tree-node[data-id="field-one"] .tree-node-label')?.textContent?.includes('SameOriginField'), true);
      assert.strictEqual(document.documentElement.getAttribute('data-vscode-theme'), 'dark');
      assert.strictEqual(document.getElementById('save-status')?.textContent, 'Сохранено');
      assert.deepStrictEqual(fixture.dom.window.formProcedures, sameOriginProcedures);
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    });
  });
});
