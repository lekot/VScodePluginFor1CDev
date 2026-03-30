import '../helpers/vscodeStubRegister';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { getWebviewHtml } from '../../src/formEditor/formWebviewHtml';

suite('form webview Block 5D - add wizard host config (1CVIEWER-36)', () => {
  let html: string;

  suiteSetup(() => {
    html = getWebviewHtml({} as vscode.Webview, vscode.ColorThemeKind.Dark);
  });

  test('JS: wizard allow-list is initialized from host payload, not hardcoded list', () => {
    assert.ok(
      html.includes('var addElementWizardConfig = { options: [] };'),
      'wizard config should default to empty until host formData arrives'
    );
    assert.ok(
      html.includes('var options = addElementWizardConfig && Array.isArray(addElementWizardConfig.options)'),
      'wizard options should be read from host-provided config'
    );
    assert.ok(
      html.includes('if (msg.addElementWizardConfig && typeof msg.addElementWizardConfig === \'object\')'),
      'formData should update wizard config from host'
    );
    assert.ok(
      !html.includes("['InputField','Button','CheckBoxField','LabelField']"),
      'legacy hardcoded allow-list should not exist in webview runtime code'
    );
  });

  test('JS: wizard options validation and hint/defaultName mapping are present', () => {
    assert.ok(
      html.includes(".filter(function(option) { return option && typeof option.tag === 'string' && option.tag.trim() !== ''; })"),
      'invalid options should be filtered before rendering'
    );
    assert.ok(
      html.includes("defaultName: typeof option.defaultName === 'string' ? option.defaultName : 'NewItem'"),
      'defaultName fallback should remain stable'
    );
    assert.ok(
      html.includes("hint: typeof option.hint === 'string' ? option.hint : ''"),
      'hint text should come from host option payload'
    );
    assert.ok(
      html.includes("hintEl.textContent = selectedOption && selectedOption.hint"),
      'selected option hint should be shown in wizard UI'
    );
  });

  test('JS: wizard submit validates selected tag against host allow-list', () => {
    assert.ok(
      html.includes('if (!options.some(function(option) { return option.tag === selectedTag; }))'),
      'submit should refuse tags outside current host allow-list'
    );
    assert.ok(
      html.includes("type: 'addElementWizard'") &&
        html.includes('tag: selectedTag'),
      'wizard should post addElementWizard message with selected tag'
    );
  });
});
