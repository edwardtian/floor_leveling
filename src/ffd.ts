import * as THREE from 'three';

/**
 * Trivariate Bernstein–Bézier lattice — the math behind 3ds Max's FFD (box)
 * modifier. An nx×ny×nz grid of control points wraps the object; every vertex
 * keeps its (u,v,w) parametric coordinate inside the lattice and its world
 * position becomes P(u,v,w) = Σ B_i^{nx-1}(u) B_j^{ny-1}(v) B_k^{nz-1}(w) · P_ijk.
 * Moving control points smoothly deforms the enclosed space.
 */
export class FFDLattice {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** Control points in world space, xyz interleaved, length (nx*ny*nz)*3. */
  controlPoints: Float32Array<ArrayBuffer>;
  /** Build-time positions — used by "Reset lattice". */
  readonly restPoints: Float32Array<ArrayBuffer>;
  /** World-space box the lattice was built on (includes margin). */
  readonly box: THREE.Box3;
  /** Binomial coefficients per axis degree, precomputed. */
  private binom: { x: number[]; y: number[]; z: number[] };

  constructor(box: THREE.Box3, nx: number, ny: number, nz: number) {
    this.nx = Math.max(2, Math.round(nx));
    this.ny = Math.max(2, Math.round(ny));
    this.nz = Math.max(2, Math.round(nz));
    this.box = box.clone();

    const n = this.nx * this.ny * this.nz;
    this.controlPoints = new Float32Array(n * 3);
    this.restPoints = new Float32Array(n * 3);

    // Lattice corners from the box; control points evenly spaced in between.
    const min = box.min;
    const size = box.getSize(new THREE.Vector3());
    let p = 0;
    for (let i = 0; i < this.nx; i++) {
      const fx = size.x > 0 ? i / (this.nx - 1) : 0;
      for (let j = 0; j < this.ny; j++) {
        const fy = size.y > 0 ? j / (this.ny - 1) : 0;
        for (let k = 0; k < this.nz; k++) {
          const fz = size.z > 0 ? k / (this.nz - 1) : 0;
          this.controlPoints[p] = min.x + fx * size.x;
          this.controlPoints[p + 1] = min.y + fy * size.y;
          this.controlPoints[p + 2] = min.z + fz * size.z;
          p += 3;
        }
      }
    }
    this.restPoints.set(this.controlPoints);

    this.binom = {
      x: binomialRow(this.nx - 1),
      y: binomialRow(this.ny - 1),
      z: binomialRow(this.nz - 1),
    };
  }

  get count(): number {
    return this.nx * this.ny * this.nz;
  }

  /** Flat index of control point (i,j,k) — i along X, j along Y, k along Z. */
  index(i: number, j: number, k: number): number {
    return (i * this.ny + j) * this.nz + k;
  }

  /** Read control point (i,j,k) into `out`. */
  getPoint(i: number, j: number, k: number, out: THREE.Vector3): THREE.Vector3 {
    const p = this.index(i, j, k) * 3;
    return out.set(this.controlPoints[p], this.controlPoints[p + 1], this.controlPoints[p + 2]);
  }

  /** Write control point (i,j,k). */
  setPoint(i: number, j: number, k: number, v: THREE.Vector3): void {
    const p = this.index(i, j, k) * 3;
    this.controlPoints[p] = v.x;
    this.controlPoints[p + 1] = v.y;
    this.controlPoints[p + 2] = v.z;
  }

  /**
   * Parametric (u,v,w) ∈ [0,1]³ of every position inside the lattice box.
   * Computed once per lattice build; vertices never change their (u,v,w) —
   * only the control points move.
   */
  static localCoordsFor(positions: Float32Array, box: THREE.Box3): Float32Array {
    const min = box.min;
    const size = box.getSize(new THREE.Vector3());
    const sx = size.x > 1e-12 ? 1 / size.x : 0;
    const sy = size.y > 1e-12 ? 1 / size.y : 0;
    const sz = size.z > 1e-12 ? 1 / size.z : 0;
    const n = positions.length / 3;
    const out = new Float32Array(n * 3);
    for (let v = 0; v < n; v++) {
      out[v * 3] = (positions[v * 3] - min.x) * sx;
      out[v * 3 + 1] = (positions[v * 3 + 1] - min.y) * sy;
      out[v * 3 + 2] = (positions[v * 3 + 2] - min.z) * sz;
    }
    return out;
  }

  /**
   * Deform: for each vertex with local coords `local` (from localCoordsFor),
   * write its world position under the CURRENT control points into `out`.
   */
  deform(local: Float32Array, out: Float32Array): void {
    const nx = this.nx, ny = this.ny, nz = this.nz;
    const cp = this.controlPoints;
    const bx = this.binom.x, by = this.binom.y, bz = this.binom.z;
    const ux = new Float64Array(nx);
    const uy = new Float64Array(ny);
    const uz = new Float64Array(nz);
    const nVerts = local.length / 3;

    for (let v = 0; v < nVerts; v++) {
      const u = local[v * 3];
      const w2 = local[v * 3 + 1];
      const w3 = local[v * 3 + 2];
      bernsteinRow(u, nx - 1, bx, ux);
      bernsteinRow(w2, ny - 1, by, uy);
      bernsteinRow(w3, nz - 1, bz, uz);

      let x = 0, y = 0, z = 0;
      for (let i = 0; i < nx; i++) {
        const bxi = ux[i];
        if (bxi === 0) continue;
        for (let j = 0; j < ny; j++) {
          const bxy = bxi * uy[j];
          if (bxy === 0) continue;
          const rowBase = ((i * ny + j) * nz) * 3;
          for (let k = 0; k < nz; k++) {
            const wgt = bxy * uz[k];
            if (wgt === 0) continue;
            const p = rowBase + k * 3;
            x += wgt * cp[p];
            y += wgt * cp[p + 1];
            z += wgt * cp[p + 2];
          }
        }
      }
      out[v * 3] = x;
      out[v * 3 + 1] = y;
      out[v * 3 + 2] = z;
    }
  }
}

/** Binomial coefficients C(n, 0..n). */
function binomialRow(n: number): number[] {
  const row = new Array(n + 1).fill(1);
  for (let i = 1; i < n; i++) row[i] = (row[i - 1] * (n - i + 1)) / i;
  return row;
}

/** Bernstein basis B_i^n(t) into `out` (length n+1). */
function bernsteinRow(t: number, n: number, binom: number[], out: Float64Array): void {
  const s = 1 - t;
  // Powers of t and (1-t).
  let tp = 1;
  for (let i = 0; i <= n; i++) {
    out[i] = binom[i] * tp * Math.pow(s, n - i);
    tp *= t;
  }
}
