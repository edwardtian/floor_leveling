/** Tiny DOM helpers for the right-hand tool panel. */
import { getIncrement, type IncrementKind } from './increments';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface Group {
  root: HTMLDivElement;
  body: HTMLDivElement;
}

export function group(title: string, parent: HTMLElement): Group {
  const root = el('div', 'group');
  const t = el('div', 'gtitle', title);
  const body = el('div', 'gbody');
  root.append(t, body);
  parent.appendChild(root);
  return { root, body };
}

export interface UnitField {
  root: HTMLDivElement;
  get: () => number;
  set: (v: number) => void;
  /** Re-render the displayed value for the current unit. */
  refresh: () => void;
}

interface ScrubConfig {
  /** Current value in the input's display units. */
  read: () => number;
  /** Commit a display-unit value (the field clamps/formats). */
  commit: (v: number) => void;
  /** Drag step in display units (start value lets relative steps scale). */
  step: (startValue: number) => number;
  integer?: boolean;
  min?: number;
  max?: number;
}

/**
 * Horizontal drag-to-scrub on a numeric input. A simple click keeps the
 * native focus/caret so the user can type; a horizontal drag changes the
 * value in increments. Pointer capture keeps the drag alive outside the field.
 */
function makeScrubbable(input: HTMLInputElement, cfg: ScrubConfig): void {
  input.classList.add('scrubbable');
  let pointerId: number | null = null;
  let startX = 0;
  let startValue = 0;
  let lastValue = 0;
  let dragging = false;
  let suppressClick = false;

  const clamp = (v: number): number => {
    if (cfg.integer) v = Math.round(v);
    if (cfg.min !== undefined) v = Math.max(cfg.min, v);
    if (cfg.max !== undefined) v = Math.min(cfg.max, v);
    return v;
  };

  input.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const parsed = parseFloat(input.value);
    startValue = clamp(Number.isFinite(parsed) ? parsed : cfg.read());
    lastValue = startValue;
    startX = e.clientX;
    dragging = false;
    suppressClick = false;
    pointerId = e.pointerId;
    try {
      input.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    input.classList.add('scrubbing');
  });

  input.addEventListener('pointermove', (e) => {
    if (pointerId === null) return;
    const dx = e.clientX - startX;
    if (!dragging && Math.abs(dx) > 3) {
      dragging = true;
      input.blur();
      document.body.classList.add('scrubbing');
      e.preventDefault();
    }
    if (!dragging) return;
    const step = cfg.step(startValue);
    if (!(step > 0)) return;
    const next = clamp(startValue + Math.round(dx / 4) * step);
    if (next !== lastValue) {
      lastValue = next;
      cfg.commit(next);
    }
    e.preventDefault();
  });

  const finish = (): void => {
    if (pointerId === null) return;
    try {
      input.releasePointerCapture(pointerId);
    } catch {
      /* ignore */
    }
    pointerId = null;
    input.classList.remove('scrubbing');
    document.body.classList.remove('scrubbing');
    if (dragging) suppressClick = true;
    dragging = false;
  };
  input.addEventListener('pointerup', finish);
  input.addEventListener('pointercancel', finish);
  input.addEventListener('click', (e) => {
    if (suppressClick) {
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
    }
  });
}

/**
 * Unit-aware numeric field: stores scene-space (meters) internally, displays
 * in the active unit (R7/Q6). onChange receives scene-space values.
 */
export function unitField(
  label: string,
  sceneValue: number,
  getUnits: () => 'meter' | 'centimeter',
  onChange: (scene: number) => void,
  opts: { step?: number; min?: number; max?: number; integer?: boolean; axis?: 'x' | 'y' | 'z'; increment?: IncrementKind } = {},
): UnitField {
  const root = el('div', 'row');
  const lab = el('label', undefined, label);
  if (opts.axis) {
    lab.style.color = AXIS_UI_COLOR[opts.axis];
    lab.style.fontWeight = '600';
  }
  const input = el('input') as HTMLInputElement;
  input.type = 'number';
  input.step = String(opts.step ?? 0.1);
  if (opts.min !== undefined) input.min = String(opts.min);
  if (opts.max !== undefined) input.max = String(opts.max);
  const suf = el('span', 'hint', '');

  let scene = sceneValue;

  const display = (): string => {
    const u = getUnits();
    const v = u === 'meter' ? scene : scene * 100;
    return opts.integer ? String(Math.round(v)) : v.toFixed(u === 'meter' ? 3 : 1);
  };
  const suffix = (): string => (getUnits() === 'meter' ? 'm' : 'cm');
  const clampScene = (v: number): number => {
    if (opts.min !== undefined) v = Math.max(opts.min, v);
    if (opts.max !== undefined) v = Math.min(opts.max, v);
    return v;
  };
  const setScene = (v: number, fire: boolean): void => {
    scene = clampScene(v);
    input.value = display();
    suf.textContent = suffix();
    if (fire) onChange(scene);
  };
  const commitDisplay = (v: number): void => {
    const u = getUnits();
    setScene(u === 'meter' ? v : v / 100, true);
  };

  input.value = display();
  suf.textContent = suffix();

  input.addEventListener('change', () => {
    const v = parseFloat(input.value);
    if (!isFinite(v)) {
      input.value = display();
      return;
    }
    commitDisplay(v);
  });

  const minDisplay = opts.min !== undefined
    ? (getUnits() === 'meter' ? opts.min : opts.min * 100)
    : undefined;
  const maxDisplay = opts.max !== undefined
    ? (getUnits() === 'meter' ? opts.max : opts.max * 100)
    : undefined;
  makeScrubbable(input, {
    read: () => {
      const v = parseFloat(input.value);
      return Number.isFinite(v) ? v : (getUnits() === 'meter' ? scene : scene * 100);
    },
    commit: commitDisplay,
    step: (startDisplay) => {
      if (opts.increment === 'translate') {
        const inc = getIncrement('translate');
        if (inc > 0) return getUnits() === 'meter' ? inc : inc * 100;
      } else if (opts.increment === 'scale') {
        const inc = getIncrement('scale');
        if (inc > 0) return Math.abs(startDisplay) * inc;
      }
      return opts.step ?? 0.1;
    },
    integer: opts.integer,
    min: minDisplay,
    max: maxDisplay,
  });

  root.append(lab, input, suf);
  return {
    root,
    get: () => scene,
    set: (v: number) => {
      scene = v;
      input.value = display();
      suf.textContent = suffix();
    },
    refresh: () => {
      input.value = display();
      suf.textContent = suffix();
    },
  };
}

/** Viewport gizmo axis colors (shared with navGizmo). */
export const AXIS_UI_COLOR: Record<'x' | 'y' | 'z', string> = {
  x: '#e0554e',
  y: '#8bc34a',
  z: '#42a5f5',
};

/** Plain numeric field (no units — degrees, counts). */
export function numField(
  label: string,
  value: number,
  onChange: (v: number) => void,
  opts: { step?: number; min?: number; max?: number; integer?: boolean; axis?: 'x' | 'y' | 'z'; increment?: IncrementKind } = {},
): HTMLDivElement {
  const root = el('div', 'row');
  const lab = el('label', undefined, label);
  if (opts.axis) {
    lab.style.color = AXIS_UI_COLOR[opts.axis];
    lab.style.fontWeight = '600';
  }
  const input = el('input') as HTMLInputElement;
  input.type = 'number';
  input.step = String(opts.step ?? 1);
  if (opts.min !== undefined) input.min = String(opts.min);
  if (opts.max !== undefined) input.max = String(opts.max);
  let last = opts.integer ? Math.round(value) : value;
  const format = (v: number): string => (opts.integer ? String(Math.round(v)) : String(v));
  const commit = (v: number, fire: boolean): void => {
    if (opts.integer) v = Math.round(v);
    if (opts.min !== undefined) v = Math.max(opts.min, v);
    if (opts.max !== undefined) v = Math.min(opts.max, v);
    last = v;
    input.value = format(v);
    if (fire) onChange(v);
  };
  input.value = format(last);
  input.addEventListener('change', () => {
    const v = parseFloat(input.value);
    if (!isFinite(v)) {
      input.value = format(last);
      return;
    }
    commit(v, true);
  });
  makeScrubbable(input, {
    read: () => {
      const v = parseFloat(input.value);
      return Number.isFinite(v) ? v : last;
    },
    commit: (v) => commit(v, true),
    step: () => {
      if (opts.increment) {
        const inc = getIncrement(opts.increment);
        if (inc > 0) return inc;
      }
      return opts.step ?? 1;
    },
    integer: opts.integer,
    min: opts.min,
    max: opts.max,
  });
  root.append(lab, input);
  return root;
}

export function selectField<T extends string>(
  label: string,
  options: { value: T; label: string }[],
  value: T,
  onChange: (v: T) => void,
): { root: HTMLDivElement; select: HTMLSelectElement } {
  const root = el('div', 'row');
  const lab = el('label', undefined, label);
  const select = el('select') as HTMLSelectElement;
  for (const o of options) {
    const opt = el('option') as HTMLOptionElement;
    opt.value = o.value;
    opt.textContent = o.label;
    select.appendChild(opt);
  }
  select.value = value;
  select.addEventListener('change', () => onChange(select.value as T));
  root.append(lab, select);
  return { root, select };
}

export function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLLabelElement {
  const lab = el('label', 'chk');
  const input = el('input') as HTMLInputElement;
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  lab.append(input, el('span', undefined, label));
  return lab;
}

export function button(label: string, onClick: () => void, cls = 'btn'): HTMLButtonElement {
  const b = el('button', cls, label) as HTMLButtonElement;
  b.addEventListener('click', onClick);
  return b;
}

export function slider(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onChange: (v: number) => void,
): HTMLDivElement {
  const root = el('div', 'row');
  const lab = el('label', undefined, label);
  const input = el('input') as HTMLInputElement;
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const val = el('span', 'hint', String(value));
  input.addEventListener('input', () => {
    val.textContent = input.value;
    onChange(parseFloat(input.value));
  });
  root.append(lab, input, val);
  return root;
}

export function hint(text: string): HTMLDivElement {
  return el('div', 'hint', text);
}

export function badge(text: string, on = false): HTMLSpanElement {
  const b = el('span', `badge${on ? ' on' : ''}`, text);
  return b;
}

// ---------- toast ----------

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function toast(message: string, type: 'info' | 'ok' | 'err' = 'info'): void {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = message;
  t.className = type === 'err' ? 'err' : type === 'ok' ? 'ok' : '';
  t.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3800);
}

// ---------- modal ----------

export interface ModalButton {
  label: string;
  value: string;
  primary?: boolean;
}

export function modal(title: string, bodyHtml: string, buttons: ModalButton[]): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = el('div');
    overlay.className = 'modal-overlay';
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:100;';
    const box = el('div');
    box.style.cssText =
      'background:var(--bg2);border:1px solid var(--border);border-radius:8px;min-width:340px;max-width:460px;padding:16px 18px;box-shadow:0 10px 40px rgba(0,0,0,0.5);';
    const h = el('div', undefined, title);
    h.style.cssText = 'font-weight:600;margin-bottom:10px;font-size:14px;';
    const body = el('div');
    body.innerHTML = bodyHtml;
    body.style.cssText = 'font-size:12.5px;line-height:1.5;color:var(--fg);margin-bottom:14px;';
    const row = el('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    for (const b of buttons) {
      const btn = el('button', b.primary ? 'btn primary' : 'btn', b.label) as HTMLButtonElement;
      btn.addEventListener('click', () => {
        overlay.remove();
        resolve(b.value);
      });
      row.appendChild(btn);
    }
    box.append(h, body, row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        overlay.remove();
        resolve(null);
      }
    });
  });
}
