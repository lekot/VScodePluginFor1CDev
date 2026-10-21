import * as vscode from 'vscode';

/** Tracks context subscriptions as root-owned resources at the phase active when they are pushed. */
export class CompositionContextSubscriptions extends Array<vscode.Disposable> {
  static get [Symbol.species](): ArrayConstructor {
    return Array;
  }

  constructor(private readonly adopt: (disposable: vscode.Disposable) => void) {
    super();
  }

  override push(...items: vscode.Disposable[]): number {
    const length = super.push(...items);
    for (const disposable of items) {
      this.adopt(disposable);
    }
    return length;
  }
}

/** Preserves the host ExtensionContext while redirecting only its subscription collection. */
export function createCompositionContext(
  source: vscode.ExtensionContext,
  subscriptions: vscode.Disposable[],
): vscode.ExtensionContext {
  const target = Object.create(Object.getPrototypeOf(source)) as object;
  const boundMethods = new WeakMap<object, unknown>();
  return new Proxy(target, {
    get: (_target, property) => {
      if (property === 'subscriptions') {
        return subscriptions;
      }
      const value = Reflect.get(source, property, source) as unknown;
      if (typeof value !== 'function') {
        return value;
      }
      const existing = boundMethods.get(value);
      if (existing) {
        return existing;
      }
      const bound = value.bind(source);
      boundMethods.set(value, bound);
      return bound;
    },
    set: (_target, property, value) => Reflect.set(source, property, value, source),
    has: (_target, property) => property === 'subscriptions' || Reflect.has(source, property),
    ownKeys: () => Reflect.ownKeys(source),
    getOwnPropertyDescriptor: (_target, property) => {
      if (property === 'subscriptions') {
        return { configurable: true, enumerable: true, value: subscriptions, writable: true };
      }
      const descriptor = Reflect.getOwnPropertyDescriptor(source, property);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  }) as vscode.ExtensionContext;
}
