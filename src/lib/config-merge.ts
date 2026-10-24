/**
 * Three-way merge for the editor's built-time snapshot and the content repo.
 * Unchanged fields take the latest remote value; locally edited fields win.
 * Arrays are intentionally atomic (a reordered list is one local change).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function mergeConfigChanges<T>(baseline: T, edited: T, latest: T): T {
  if (JSON.stringify(edited) === JSON.stringify(baseline)) return latest
  if (isRecord(baseline) && isRecord(edited) && isRecord(latest)) {
    const merged: Record<string, unknown> = { ...latest }
    for (const key of new Set([...Object.keys(baseline), ...Object.keys(edited)])) {
      const value = mergeConfigChanges(baseline[key], edited[key], latest[key])
      if (value === undefined) delete merged[key]
      else merged[key] = value
    }
    return merged as T
  }
  return edited
}
