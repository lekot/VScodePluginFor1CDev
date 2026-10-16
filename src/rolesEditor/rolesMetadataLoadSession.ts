/**
 * Manages an active metadata loading session for the Roles and Rights Editor.
 * Enforces bounded concurrency for XML reads, deduplication of in-flight requests,
 * and strict session cancellation.
 */

import { ConfigFormat } from '../parsers/formatDetector';
import { MetadataObject } from './models/metadataObject';
import { RightsMap } from './models/roleModel';
import { loadAttributeRowsForObject } from './metadataLoader';
import { Logger } from '../utils/logger';

/**
 * Bounded concurrency queue to prevent overwhelming I/O with parallel XML parsing.
 */
export class BoundedConcurrencyQueue {
  private activeCount = 0;
  private readonly queue: Array<() => void> = [];

  constructor(public readonly concurrency: number = 4) {}

  public async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeCount >= this.concurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.activeCount++;
    try {
      return await fn();
    } finally {
      this.activeCount--;
      const next = this.queue.shift();
      if (next) {
        next();
      }
    }
  }

  public clear(): void {
    this.queue.length = 0;
  }
}

/**
 * Metadata loading session tied to an open Roles and Rights Editor instance.
 */
export class RolesMetadataLoadSession {
  private disposed = false;
  private readonly attributeCache = new Map<string, MetadataObject[]>();
  private readonly inFlightAttributes = new Map<string, Promise<MetadataObject[]>>();
  private readonly queue: BoundedConcurrencyQueue;

  constructor(
    public readonly sessionId: string,
    public readonly generation: number,
    public readonly configPath: string,
    public readonly format: ConfigFormat,
    concurrency = 4
  ) {
    this.queue = new BoundedConcurrencyQueue(concurrency);
  }

  public isCancelled(): boolean {
    return this.disposed;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.queue.clear();
    this.inFlightAttributes.clear();
    Logger.debug(`RolesMetadataLoadSession ${this.sessionId} disposed`);
  }

  /**
   * Load attribute-level rows for a specific metadata object on-demand.
   * Deduplicates concurrent requests for the same object and caches results.
   */
  public async loadObjectAttributes(
    objectFullName: string,
    currentRights: RightsMap
  ): Promise<MetadataObject[]> {
    if (this.disposed) {
      throw new Error(`Load session ${this.sessionId} is disposed`);
    }

    const cached = this.attributeCache.get(objectFullName);
    if (cached) {
      return cached;
    }

    const existingInFlight = this.inFlightAttributes.get(objectFullName);
    if (existingInFlight) {
      return await existingInFlight;
    }

    const promise = this.queue
      .run(async () => {
        if (this.disposed) {
          throw new Error(`Load session ${this.sessionId} is disposed`);
        }
        return await loadAttributeRowsForObject(
          this.configPath,
          this.format,
          objectFullName,
          currentRights
        );
      })
      .then((results) => {
        if (!this.disposed) {
          this.attributeCache.set(objectFullName, results);
        }
        return results;
      })
      .finally(() => {
        this.inFlightAttributes.delete(objectFullName);
      });

    this.inFlightAttributes.set(objectFullName, promise);
    return await promise;
  }
}
