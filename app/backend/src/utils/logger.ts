/**
 * Safe error logger that redacts sensitive fields from error objects.
 * Prevents accidental exposure of credentials, tokens, or internal details in logs.
 */
export function logError(context: string, error: unknown): void {
  if (error instanceof Error) {
    console.error(context, {
      name: error.name,
      message: error.message,
      ...(('code' in error) && { code: (error as any).code }),
    });
  } else {
    console.error(context, '[non-Error value]');
  }
}
