/** Waits for every owned drain before surfacing one or more failures to its owner. */
export async function awaitAllDrains(label: string, drains: readonly Promise<void>[]): Promise<void> {
  const settled = await Promise.allSettled(drains);
  const failures = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length === 1) {
    throw failures[0]!.reason;
  }
  if (failures.length > 1) {
    const error = new Error(`${label} failed in ${failures.length} drains.`);
    Object.defineProperty(error, 'causes', {
      configurable: false,
      enumerable: true,
      value: failures.map((failure) => failure.reason),
      writable: false,
    });
    throw error;
  }
}
