/**
 * dept-map.ts
 *
 * Case-insensitive access to the department-keyed JSONB maps on `issues` --
 * dept_assignees, dept_statuses, and the per-department SLA log.
 *
 * These helpers lived privately inside jira-pg-api.ts, where the handler used
 * them everywhere, while the display layer (getEffectiveIssueStatus in
 * utils.ts) did a plain, case-sensitive `map[dept]` instead. The two layers
 * therefore disagreed about whether a department name matched: with
 * current_department stored as "Pre-sales" and the snapshot's own key written
 * as "Pre-Sales", the handler found the entry and the UI did not. CF-29995
 * showed a leftover QA status while sitting in Pre-Sales, and its status
 * dropdown offered nothing, because the display fell through to the stale
 * global statusId. Extracted here so both sides share one rule rather than
 * two implementations that can drift apart again -- which is precisely how
 * that bug appeared.
 *
 * ZERO IMPORTS, deliberately. utils.ts is client-bundled, so anything this
 * module pulled in would be pulled into the browser bundle too; the same
 * constraint is why internal-job-secret.ts is its own tiny leaf file. It also
 * makes this module directly unit-testable under `node --test`, which matters
 * because the test runner resolves real node_modules and utils.ts's own clsx
 * import puts it out of reach of a dependency-free test.
 *
 * Why department names are compared case-insensitively at all: a queue admin
 * types a "Waiting for X" / "Routed to X" status label into a free-text input
 * (spaces/[spaceKey]/queue/[queueId]/workflow), which is never validated
 * against the canonical department list. The target department is then regex-
 * parsed back out of that label, so its casing is whatever was typed, while
 * the manual Change Department dropdown always writes the canonical casing.
 * Both must address the same entry.
 */

/**
 * Normalised form of the department name being LOOKED UP.
 *
 * Note the asymmetry with storedKey() below: the requested name is trimmed,
 * the stored key is not. That is not an oversight -- it reproduces exactly
 * what the private implementation in jira-pg-api.ts did
 * (`k.toLowerCase() === dept.trim().toLowerCase()`) across its 39 call sites.
 * Trimming both sides looks tidier and was tried first, but it changes stored
 * data in the handoff path: with an existing key of " Dev " a write for "DEV"
 * would overwrite that entry instead of adding a separate one, which is a
 * behaviour change nobody asked for and which no production data was checked
 * against. Matching the old rule exactly keeps this refactor a refactor.
 *
 * Whitespace-padded stored keys are therefore still missed, exactly as before
 * -- a real but separate latent bug, left for its own change.
 */
function lookupKey(dept: string | null | undefined): string {
  return String(dept ?? '').trim().toLowerCase();
}

/** Normalised form of a key as actually stored. Deliberately NOT trimmed. */
function storedKey(key: string): string {
  return key.toLowerCase();
}

/**
 * The map's own existing key for `dept`, whatever casing it was stored under,
 * or undefined if this department has never been recorded in this map.
 *
 * An empty/absent `dept` never matches. Without that guard a null
 * current_department would normalise to '' and could collide with a literal
 * '' key -- and getEffectiveIssueStatus passes a nullable value straight in.
 */
export function deptMapFindKey(
  map: Record<string, any> | null | undefined,
  dept: string | null | undefined,
): string | undefined {
  const wanted = lookupKey(dept);
  if (!wanted || !map) return undefined;
  return Object.keys(map).find((k) => storedKey(k) === wanted);
}

/** Read a department's entry regardless of the casing it was stored under. */
export function deptMapGet(
  map: Record<string, any> | null | undefined,
  dept: string | null | undefined,
): any {
  const key = deptMapFindKey(map, dept);
  return key === undefined ? undefined : (map as Record<string, any>)[key];
}

/**
 * Write a department's entry, reusing whichever casing this map already holds
 * for that department and falling back to the given string only when the
 * department has never been recorded here. That keeps a single ticket's own
 * history internally consistent no matter which of the two casings triggered
 * the write, instead of accumulating "Dev" and "dev" as separate entries.
 *
 * A blank department is ignored rather than creating an '' key.
 */
export function deptMapSet(
  map: Record<string, any>,
  dept: string | null | undefined,
  value: any,
): void {
  if (!lookupKey(dept)) return;
  const existingKey = deptMapFindKey(map, dept);
  map[existingKey ?? String(dept)] = value;
}

/** Remove a department's entry whatever casing it was stored under. */
export function deptMapDelete(
  map: Record<string, any>,
  dept: string | null | undefined,
): void {
  const existingKey = deptMapFindKey(map, dept);
  if (existingKey !== undefined) delete map[existingKey];
}
