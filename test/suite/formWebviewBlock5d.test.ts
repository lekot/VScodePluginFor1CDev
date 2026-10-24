import '../helpers/vscodeStubRegister';
import * as assert from 'assert';
import { createFormWebviewRuntimeFixture } from '../helpers/formWebviewRuntime';

suite('form webview Block 5D - add wizard host config (1CVIEWER-36)', () => {
  test('wizard choices and defaults come from the host payload and invalid entries are discarded', () => {
    const fixture = createFormWebviewRuntimeFixture();
    try {
      fixture.send({
        type: 'formData',
        formModel: {
          childItemsRoot: [{ tag: 'UsualGroup', id: 'group', name: 'Group', properties: {}, childItems: [] }],
          attributes: [],
          commands: [],
          formEvents: [],
        },
        addElementWizardConfig: {
          options: [
            { tag: ' InputField ', defaultName: 'NewInput', hint: 'Добавить поле' },
            { tag: 'Button', defaultName: 'NewButton', hint: 'Добавить кнопку' },
            { tag: 'LabelField' },
            { tag: '  ', defaultName: 'Invalid' },
            { tag: 42, defaultName: 'Invalid' },
            null,
          ],
        },
      });
      const document = fixture.dom.window.document;
      document.getElementById('tb-add-wizard')?.dispatchEvent(new fixture.dom.window.MouseEvent('click', { bubbles: true }));
      const options = Array.from(document.querySelectorAll<HTMLSelectElement>('#add-wizard-type option'));
      assert.deepStrictEqual(options.map((option) => option.value), ['InputField', 'Button', 'LabelField']);
      assert.strictEqual((document.getElementById('add-wizard-name') as HTMLInputElement | null)?.value, 'NewInput');
      assert.strictEqual(document.getElementById('add-wizard-hint')?.textContent, 'Добавить поле');

      const select = document.getElementById('add-wizard-type') as HTMLSelectElement;
      select.value = 'Button';
      (document.getElementById('add-wizard-name') as HTMLInputElement).value = '';
      select.dispatchEvent(new fixture.dom.window.Event('change', { bubbles: true }));
      assert.strictEqual((document.getElementById('add-wizard-name') as HTMLInputElement).value, 'NewButton');
      assert.strictEqual(document.getElementById('add-wizard-hint')?.textContent, 'Добавить кнопку');

      select.value = 'LabelField';
      (document.getElementById('add-wizard-name') as HTMLInputElement).value = '';
      select.dispatchEvent(new fixture.dom.window.Event('change', { bubbles: true }));
      assert.strictEqual((document.getElementById('add-wizard-name') as HTMLInputElement).value, 'NewItem');
      assert.strictEqual(document.getElementById('add-wizard-hint')?.textContent, 'Для выбранного типа нет дополнительной подсказки.');
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    } finally {
      fixture.close();
    }
  });

  test('wizard submits only host-approved tags and posts the selected tag and name', () => {
    const fixture = createFormWebviewRuntimeFixture();
    try {
      fixture.send({
        type: 'formData',
        formModel: {
          childItemsRoot: [{ tag: 'UsualGroup', id: 'group', name: 'Group', properties: {}, childItems: [] }],
          attributes: [],
          commands: [],
          formEvents: [],
        },
        addElementWizardConfig: { options: [{ tag: 'InputField', defaultName: 'NewInput', hint: 'Add a field' }] },
      });
      const document = fixture.dom.window.document;
      document.getElementById('tb-add-wizard')?.dispatchEvent(new fixture.dom.window.MouseEvent('click', { bubbles: true }));
      const select = document.getElementById('add-wizard-type') as HTMLSelectElement;
      const injected = document.createElement('option');
      injected.value = 'UnapprovedTag';
      select.appendChild(injected);
      select.value = injected.value;
      document.getElementById('add-wizard-submit')?.dispatchEvent(new fixture.dom.window.MouseEvent('click', { bubbles: true }));
      assert.deepStrictEqual(fixture.messages.filter((message) => message.type === 'addElementWizard'), []);

      document.getElementById('tb-add-wizard')?.dispatchEvent(new fixture.dom.window.MouseEvent('click', { bubbles: true }));
      const name = document.getElementById('add-wizard-name') as HTMLInputElement;
      name.value = 'CustomName';
      document.getElementById('add-wizard-submit')?.dispatchEvent(new fixture.dom.window.MouseEvent('click', { bubbles: true }));
      const wizardMessage = fixture.messages.find((message) => message.type === 'addElementWizard');
      assert.ok(wizardMessage && wizardMessage.type === 'addElementWizard');
      assert.strictEqual(wizardMessage.tag, 'InputField');
      assert.strictEqual(wizardMessage.name, 'CustomName');
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    } finally {
      fixture.close();
    }
  });
});
