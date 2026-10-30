/** Maximum allowed message content length (matches Slack's 40k limit). */
export const MAX_MESSAGE_LENGTH = 40000;

/**
 * Strictly parse a route parameter as a positive integer.
 * Unlike parseInt(), rejects strings like "123abc" or "1.5".
 * Returns null for any invalid input.
 */
export function parseIntParam(value: string | string[] | undefined): number | null {
  if (!value || Array.isArray(value)) return null;
  if (!/^\d+$/.test(value)) return null;
  const num = Number(value);
  if (num <= 0 || num > Number.MAX_SAFE_INTEGER) return null;
  return num;
}
