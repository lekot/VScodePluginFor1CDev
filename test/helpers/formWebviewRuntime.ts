import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { JSDOM, VirtualConsole } from 'jsdom';
import type { Webview } from 'vscode';
import type { FormMessage } from '../../src/formEditor/formMessageHandler';
import { getWebviewHtml } from '../../src/formEditor/formWebviewHtml';

export interface FormWebviewRuntimeFixture {
  dom: JSDOM;
  messages: FormMessage[];
  runtimeErrors: Error[];
  send(message: FormMessage): void;
  dispatch(message: FormMessage, origin: string): void;
  close(): void;
}

export interface FormDataTransferShim {
  readonly types: string[];
  dropEffect: string;
  effectAllowed: string;
  setData(format: string, value: string): void;
  getData(format: string): string;
}

export function createFormDataTransfer(): FormDataTransferShim {
  const values = new Map<string, string>();
  return {
    types: [],
    dropEffect: 'none',
    effectAllowed: 'uninitialized',
    setData(format, value) {
      if (!values.has(format)) {
        this.types.push(format);
      }
      values.set(format, value);
    },
    getData(format) {
      return values.get(format) || '';
    },
  };
}

export function createFormDragEvent(
  dom: JSDOM,
  type: 'dragstart' | 'dragover' | 'drop',
  dataTransfer: FormDataTransferShim,
  clientX = 0,
  clientY = 0,
  bubbles = true,
): Event {
  const event = new dom.window.Event(type, { bubbles, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: dataTransfer },
    clientX: { value: clientX },
    clientY: { value: clientY },
  });
  return event;
}

const repositoryRoot = path.resolve(__dirname, '..', '..', '..');
const outputDirectory = path.join(repositoryRoot, 'out');
const scriptFilename = path.join(outputDirectory, 'form-webview-runtime.generated.js');

export function createFormWebviewRuntimeFixture(): FormWebviewRuntimeFixture {
  const messages: FormMessage[] = [];
  const runtimeErrors: Error[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => runtimeErrors.push(error));

  const webview = { cspSource: 'vscode-webview-resource:' } as Webview;
  const html = getWebviewHtml(webview);
  const scriptMatch = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/);
  if (!scriptMatch) { throw new Error('Generated form webview HTML has no inline browser script'); }
  const browserBundle = scriptMatch[1];
  fs.writeFileSync(scriptFilename, browserBundle, 'utf8');
  const dom = new JSDOM(html, {
    url: 'https://form-editor.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      Object.defineProperty(window, 'acquireVsCodeApi', {
        configurable: true,
        value: () => ({
          postMessage(message: FormMessage) {
            messages.push(JSON.parse(JSON.stringify(message)) as FormMessage);
          },
        }),
      });
    },
  });

  try {
    new vm.Script(browserBundle, { filename: scriptFilename }).runInContext(dom.getInternalVMContext());
  } catch (error) {
    dom.window.close();
    throw error;
  }

  return {
    dom,
    messages,
    runtimeErrors,
    send(message) {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
        data: message,
        origin: dom.window.location.origin,
      }));
    },
    dispatch(message, origin) {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message, origin }));
    },
    close() {
      dom.window.close();
    },
  };
}
