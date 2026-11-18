// Safe error description for logs: the class name only, never the message (messages can echo ChMS
// values, bound SQL parameters or tokens).

/** An error's class name, constrained to identifier characters (never a message). */
export function errorClassName(err: unknown): string {
  const n = err instanceof Error ? err.name : typeof err;
  return /^[A-Za-z_$][\w$]{0,63}$/.test(n) ? n : 'unknown';
}
