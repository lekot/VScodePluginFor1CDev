import * as vm from 'vm';
import type { CompositionHostMessage, CompositionWebviewMessage } from '../../src/compositionEditor/compositionContracts';

type DomEvent = {
  type: string;
  target?: RuntimeElement;
  stopPropagation?: () => void;
  preventDefault?: () => void;
  [key: string]: unknown;
};

type DomListener = (event: DomEvent) => void;

class RuntimeElement {
  public children: RuntimeElement[] = [];
  public parentElement: RuntimeElement | undefined;
  public dataset: Record<string, string> = {};
  public style: Record<string, string> = {};
  public value = '';
  public checked = false;
  public disabled = false;
  public indeterminate = false;
  public selected = false;
  public colSpan = 1;
  private text = '';
  private markup = '';
  private readonly classes = new Set<string>();
  private readonly listeners = new Map<string, DomListener[]>();

  constructor(public readonly tagName: string, private readonly fragment = false) {}

  get className(): string {
    return [...this.classes].join(' ');
  }

  set className(value: string) {
    this.classes.clear();
    for (const name of value.split(/\s+/).filter(Boolean)) {
      this.classes.add(name);
    }
  }

  get classList(): {
    add: (name: string) => void;
    remove: (name: string) => void;
    contains: (name: string) => boolean;
  } {
    return {
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
      contains: (name) => this.classes.has(name),
    };
  }

  get textContent(): string {
    return this.text || this.children.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.text = value;
    this.markup = '';
    this.children = [];
  }

  get innerHTML(): string {
    return this.markup;
  }

  set innerHTML(value: string) {
    this.markup = value;
    this.text = '';
    this.children = [];
  }

  addEventListener(type: string, listener: DomListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event: DomEvent): void {
    event.target ??= this;
    event.stopPropagation ??= () => {};
    event.preventDefault ??= () => {};
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
  }

  click(): void {
    if (this.disabled) { return; }
    this.dispatchEvent({ type: 'click', target: this });
  }

  appendChild(child: RuntimeElement): RuntimeElement {
    if (child.fragment) {
      for (const fragmentChild of child.children) {
        this.appendChild(fragmentChild);
      }
      child.children = [];
      return child;
    }
    child.parentElement = this;
    this.children.push(child);
    if (this.tagName === 'SELECT' && child.tagName === 'OPTION' &&
        (child.selected || this.children.length === 1)) {
      this.value = child.value;
    }
    return child;
  }

  getElementsByTagName(tagName: string): RuntimeElement[] {
    const tag = tagName.toUpperCase();
    const result: RuntimeElement[] = [];
    const visit = (element: RuntimeElement): void => {
      for (const child of element.children) {
        if (child.tagName === tag) { result.push(child); }
        visit(child);
      }
    };
    visit(this);
    return result;
  }
}

/** Executes the real composition editor inline script against a small event-capable DOM. */
export class CompositionWebviewRuntime {
  public readonly sentMessages: CompositionWebviewMessage[] = [];
  public readonly pendingExtensionMessages: Promise<void>[] = [];
  private readonly elements = new Map<string, RuntimeElement>();
  private readonly windowListeners = new Map<string, Array<(event: { data: CompositionHostMessage }) => void>>();
  private readonly documentListeners = new Map<string, DomListener[]>();
  private extensionMessageHandler: ((message: CompositionWebviewMessage) => Promise<void>) | undefined;
  private readonly window: {
    __compositionData?: unknown;
    addEventListener: (type: string, listener: (event: { data: CompositionHostMessage }) => void) => void;
  };

  constructor() {
    this.window = {
      addEventListener: (type, listener) => {
        const listeners = this.windowListeners.get(type) ?? [];
        listeners.push(listener);
        this.windowListeners.set(type, listeners);
      },
    };
  }

  connectExtension(handler: (message: CompositionWebviewMessage) => Promise<void>): void {
    this.extensionMessageHandler = handler;
  }

  loadHtml(html: string): void {
    const script = html.match(/<script\b[^>]*>([\s\S]*?)<\/script[^>]*>/i)?.[1];
    if (!script) { throw new Error('Composition webview HTML has no inline script'); }

    this.elements.clear();
    this.windowListeners.clear();
    this.documentListeners.clear();
    const document = {
      getElementById: (id: string) => this.getElement(id),
      createElement: (tag: string) => new RuntimeElement(tag.toUpperCase()),
      createDocumentFragment: () => new RuntimeElement('#FRAGMENT', true),
      addEventListener: (type: string, listener: DomListener) => {
        const listeners = this.documentListeners.get(type) ?? [];
        listeners.push(listener);
        this.documentListeners.set(type, listeners);
      },
    };
    const sandbox = {
      window: this.window,
      document,
      acquireVsCodeApi: () => ({
        postMessage: (message: CompositionWebviewMessage) => this.sendToExtension(message),
      }),
      setTimeout: (callback: () => void) => {
        callback();
        return 1;
      },
      clearTimeout: () => {},
      requestAnimationFrame: (callback: () => void) => callback(),
      confirm: () => true,
      console,
    };

    vm.runInNewContext(script, sandbox);
  }

  postMessageToWebview(message: CompositionHostMessage): void {
    for (const listener of this.windowListeners.get('message') ?? []) {
      listener({ data: message });
    }
  }

  async drainExtensionMessages(): Promise<void> {
    let processed = 0;
    while (processed < this.pendingExtensionMessages.length) {
      const batch = this.pendingExtensionMessages.slice(processed);
      processed = this.pendingExtensionMessages.length;
      await Promise.all(batch);
    }
    this.pendingExtensionMessages.length = 0;
  }

  getElementById(id: string): RuntimeElement {
    return this.getElement(id);
  }

  findObjectRow(ref: string): RuntimeElement | undefined {
    const tableBody = this.getElement('table-body');
    return this.findDescendant(tableBody, (element) => element.dataset.ref === ref);
  }

  findObjectCheckbox(ref: string): RuntimeElement | undefined {
    const row = this.findObjectRow(ref);
    return row?.getElementsByTagName('INPUT')[0];
  }

  findObjectSetting(ref: string): RuntimeElement | undefined {
    const row = this.findObjectRow(ref);
    return row?.getElementsByTagName('SELECT')[0];
  }

  findTypeArrow(typeFolderId: string): RuntimeElement | undefined {
    const tableBody = this.getElement('table-body');
    const row = this.findDescendant(tableBody, (element) =>
      element.classList.contains('type-container-row') &&
      element.children[1]?.textContent.startsWith(`${typeFolderId} (`),
    );
    return row?.getElementsByTagName('SPAN')[0];
  }

  private sendToExtension(message: CompositionWebviewMessage): void {
    this.sentMessages.push(message);
    const task = this.extensionMessageHandler?.(message);
    if (task) { this.pendingExtensionMessages.push(task); }
  }

  private getElement(id: string): RuntimeElement {
    let element = this.elements.get(id);
    if (!element) {
      element = new RuntimeElement('DIV');
      this.elements.set(id, element);
    }
    return element;
  }

  private findDescendant(
    root: RuntimeElement,
    predicate: (element: RuntimeElement) => boolean,
  ): RuntimeElement | undefined {
    for (const child of root.children) {
      if (predicate(child)) { return child; }
      const nested = this.findDescendant(child, predicate);
      if (nested) { return nested; }
    }
    return undefined;
  }
}
