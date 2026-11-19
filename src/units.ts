import * as THREE from 'three';
import type { MeasurementUnits } from './types';

export type { MeasurementUnits };

export const METER_TO_UNIT: Record<MeasurementUnits, number> = {
  meter: 1,
  centimeter: 100,
};

/** Convert scene-space length to display value in the selected unit. */
export function toDisplay(sceneLen: number, units: MeasurementUnits): number {
  return sceneLen * METER_TO_UNIT[units];
}

/** Convert a display value in the selected unit to scene-space. */
export function fromDisplay(v: number, units: MeasurementUnits): number {
  return v / METER_TO_UNIT[units];
}

export function fmtLen(sceneLen: number, units: MeasurementUnits): string {
  const v = toDisplay(sceneLen, units);
  const digits = units === 'meter' ? (Math.abs(v) < 1 ? 3 : 2) : 1;
  return `${v.toFixed(digits)} ${units === 'meter' ? 'm' : 'cm'}`;
}

export function fmtCoord(sceneLen: number, units: MeasurementUnits): string {
  const v = toDisplay(sceneLen, units);
  const digits = units === 'meter' ? 3 : 1;
  return v.toFixed(digits);
}

export function parseLen(text: string, units: MeasurementUnits): number {
  const v = parseFloat(text);
  if (!isFinite(v)) return NaN;
  return fromDisplay(v, units);
}

export function axisLabel(axis: 'x' | 'y' | 'z'): string {
  return axis.toUpperCase();
}

export function deg(rad: number): number {
  return (rad * 180) / Math.PI;
}

export function rad(d: number): number {
  return (d * Math.PI) / 180;
}

/** Compact human-readable byte count. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** Clone position/normal buffers of a geometry (for undo snapshots). */
export function cloneAttribArrays(geo: THREE.BufferGeometry): {
  position: Float32Array;
  normal: Float32Array;
} {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nor = geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
  return {
    position: new Float32Array(pos.array as Float32Array),
    normal: nor ? new Float32Array(nor.array as Float32Array) : new Float32Array(0),
  };
}
