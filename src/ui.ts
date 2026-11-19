/** Tiny DOM helpers for the right-hand tool panel. */

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

/**
 * Unit-aware numeric field: stores scene-space (meters) internally, displays
 * in the active unit (R7/Q6). onChange receives scene-space values.
 */
export function unitField(
  label: string,
  sceneValue: number,
  getUnits: () => 'meter' | 'centimeter',
  onChange: (scene: number) => void,
  opts: { step?: number; min?: number; max?: number; integer?: boolean } = {},
): UnitField {
  const root = el('div', 'row');
  const lab = el('label', undefined, label);
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

  input.value = display();
  suf.textContent = suffix();

  input.addEventListener('change', () => {
    const v = parseFloat(input.value);
    if (!isFinite(v)) {
      input.value = display();
      return;
    }
    const u = getUnits();
    scene = u === 'meter' ? v : v / 100;
    if (opts.min !== undefined) scene = Math.max(opts.min, scene);
    if (opts.max !== undefined) scene = Math.min(opts.max, scene);
    input.value = display();
    suf.textContent = suffix();
    onChange(scene);
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

/** Plain numeric field (no units — degrees, counts). */
export function numField(
  label: string,
  value: number,
  onChange: (v: number) => void,
  opts: { step?: number; min?: number; max?: number; integer?: boolean } = {},
): HTMLDivElement {
  const root = el('div', 'row');
  const lab = el('label', undefined, label);
  const input = el('input') as HTMLInputElement;
  input.type = 'number';
  input.step = String(opts.step ?? 1);
  if (opts.min !== undefined) input.min = String(opts.min);
  if (opts.max !== undefined) input.max = String(opts.max);
  input.value = opts.integer ? String(Math.round(value)) : String(value);
  input.addEventListener('change', () => {
    let v = parseFloat(input.value);
    if (!isFinite(v)) {
      input.value = opts.integer ? String(Math.round(value)) : String(value);
      return;
    }
    if (opts.min !== undefined) v = Math.max(opts.min, v);
    if (opts.max !== undefined) v = Math.min(opts.max, v);
    input.value = opts.integer ? String(Math.round(v)) : String(v);
    onChange(v);
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
