/**
 * Global transform increments: translate (scene meters), rotate (degrees)
 * and scale (factor). They drive:
 *  - TransformControls snapping on the gizmo,
 *  - the drag step of numeric fields in the transform panels.
 *
 * A value of 0 disables gizmo snapping; fields then fall back to their own
 * per-field step.
 */

export type IncrementKind = 'translate' | 'rotate' | 'scale';

export interface Increments {
  translate: number;
  rotate: number;
  scale: number;
}

export const DEFAULT_INCREMENTS: Increments = {
  translate: 0.01, // 1 cm
  rotate: 5, // degrees
  scale: 0.01, // 1 %
};

let current: Increments = { ...DEFAULT_INCREMENTS };
const listeners: ((inc: Increments) => void)[] = [];
const STORAGE_KEY = 'floor-leveling.increments';

export function getIncrements(): Increments {
  return { ...current };
}

export function getIncrement(kind: IncrementKind): number {
  return current[kind];
}

/** Set one increment; 0 is allowed (disables snapping for that mode). */
export function setIncrement(kind: IncrementKind, value: number): void {
  if (!Number.isFinite(value) || value < 0) return;
  if (current[kind] === value) return;
  current = { ...current, [kind]: value };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable */
  }
  for (const fn of listeners) fn({ ...current });
}

export function onIncrementsChange(fn: (inc: Increments) => void): void {
  listeners.push(fn);
}

/** Load saved increments. Call before building the UI. */
export function initIncrements(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<Record<IncrementKind, unknown>>;
    const next = { ...DEFAULT_INCREMENTS };
    for (const k of ['translate', 'rotate', 'scale'] as const) {
      const v = Number(parsed?.[k]);
      if (Number.isFinite(v) && v >= 0) next[k] = v;
    }
    current = next;
  } catch {
    /* storage unavailable / malformed */
  }
}
