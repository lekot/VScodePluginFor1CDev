import * as vscode from 'vscode';
import { Logger } from '../utils/logger';

export interface ActivationDisposableOwner {
  registerDisposable(
    name: string,
    disposable: vscode.Disposable | { dispose: () => Promise<void> | void } | (() => Promise<void> | void),
  ): void;
}

/**
 * Gives activation helpers an ExtensionContext-compatible view whose subscriptions are
 * owned by the composition root, including registrations made after activation.
 */
export class ActivationSubscriptionScope {
  readonly context: vscode.ExtensionContext;
  readonly subscriptions: vscode.Disposable[];
  private owner: ActivationDisposableOwner | null = null;
  private closed = false;
  private readonly boundMethods = new WeakMap<object, unknown>();

  constructor(sourceContext: vscode.ExtensionContext) {
    this.subscriptions = new ScopedSubscriptions(this);
    const target = Object.create(Object.getPrototypeOf(sourceContext)) as object;
    this.context = new Proxy(target, {
      get: (_target, property) => {
        if (property === 'subscriptions') {
          return this.subscriptions;
        }
        const value = Reflect.get(sourceContext, property, sourceContext) as unknown;
        if (typeof value !== 'function') {
          return value;
        }
        const existing = this.boundMethods.get(value);
        if (existing) {
          return existing;
        }
        const bound = value.bind(sourceContext);
        this.boundMethods.set(value, bound);
        return bound;
      },
      set: (_target, property, value) => Reflect.set(sourceContext, property, value, sourceContext),
      has: (_target, property) => property === 'subscriptions' || Reflect.has(sourceContext, property),
      ownKeys: () => Reflect.ownKeys(sourceContext),
      getOwnPropertyDescriptor: (_target, property) => {
        if (property === 'subscriptions') {
          return { configurable: true, enumerable: true, value: this.subscriptions, writable: true };
        }
        const descriptor = Reflect.getOwnPropertyDescriptor(sourceContext, property);
        return descriptor ? { ...descriptor, configurable: true } : undefined;
      },
    }) as vscode.ExtensionContext;
  }

  bind(owner: ActivationDisposableOwner): void {
    if (this.closed) {
      throw new Error('Cannot attach a closed activation subscription scope.');
    }
    if (this.owner && this.owner !== owner) {
      throw new Error('Activation subscriptions already belong to another composition root.');
    }
    if (this.owner) {
      return;
    }
    this.owner = owner;
    for (const subscription of this.subscriptions) {
      owner.registerDisposable('activation subscription', subscription);
    }
  }

  close(): void {
    this.closed = true;
    this.subscriptions.splice(0);
  }

  register(subscription: vscode.Disposable): number {
    if (this.closed) {
      if (this.owner) {
        this.owner.registerDisposable('late activation subscription', subscription);
      } else {
        void Promise.resolve()
          .then(() => subscription.dispose())
          .catch((error) => Logger.error('Late activation subscription disposal failed', error));
      }
      return this.subscriptions.length;
    }
    const length = Array.prototype.push.call(this.subscriptions, subscription) as number;
    this.owner?.registerDisposable('activation subscription', subscription);
    return length;
  }
}

class ScopedSubscriptions extends Array<vscode.Disposable> {
  static get [Symbol.species](): ArrayConstructor {
    return Array;
  }

  constructor(private readonly scope: ActivationSubscriptionScope) {
    super();
    Object.setPrototypeOf(this, ScopedSubscriptions.prototype);
  }

  override push(...items: vscode.Disposable[]): number {
    let length = this.length;
    for (const item of items) {
      length = this.scope.register(item);
    }
    return length;
  }
}

const scopes = new WeakMap<object, ActivationSubscriptionScope>();

export function createActivationSubscriptionScope(
  context: vscode.ExtensionContext,
): ActivationSubscriptionScope {
  const scope = new ActivationSubscriptionScope(context);
  scopes.set(scope.context, scope);
  return scope;
}

export function getActivationSubscriptionScope(
  context: vscode.ExtensionContext,
): ActivationSubscriptionScope | undefined {
  return scopes.get(context);
}
