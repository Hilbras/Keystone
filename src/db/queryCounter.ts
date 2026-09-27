/**
 * A count of the SQL statements a block of code actually sent.
 *
 * Timing tells you a path got slower; it does not tell you *why*, and on a shared
 * CI runner a timing regression is often just a noisy neighbour. The SCIM group
 * list is the case that matters here: the v3.0.1 analysis called it N+1, §1.2 fixed
 * it, and the fix was a real one — but nothing in the build could tell whether the
 * N had come back. Query count is exact, machine-independent, and the number an
 * N+1 regression is actually made of.
 *
 * Enabled only while a benchmark is measuring, so the production path pays one
 * function call per statement and nothing else.
 */
let counting = false;
let count = 0;

export function startCountingQueries(): void {
  count = 0;
  counting = true;
}

/** Stop counting and return how many statements were sent. */
export function stopCountingQueries(): number {
  counting = false;
  return count;
}

/** Called by the driver for every statement. Not a public API. */
export function noteQuery(): void {
  if (counting) count += 1;
}
