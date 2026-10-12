export async function cleanupSmokeFile(
  closeTabs: (() => Promise<void>) | undefined,
  unlinkFile: () => Promise<void>
): Promise<void> {
  const errors: unknown[] = [];
  if (closeTabs) {
    try {
      await closeTabs();
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await unlinkFile();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    const AggregateErrorConstructor = (
      globalThis as unknown as {
        AggregateError: new (errors: unknown[], message?: string) => Error & { errors: unknown[] };
      }
    ).AggregateError;
    throw new AggregateErrorConstructor(
      errors,
      'Failed to close BSL smoke tabs and remove the temporary file'
    );
  }
}
