// One Euro filter (Casiez et al. 2012) — kills rest jitter without adding lag
// during fast turns. Preferred over an EMA for exactly that reason.

class LowPass {
  private y = 0;
  private initialized = false;

  filter(x: number, alpha: number): number {
    if (!this.initialized) {
      this.initialized = true;
      this.y = x;
      return x;
    }
    this.y = alpha * x + (1 - alpha) * this.y;
    return this.y;
  }

  last(): number {
    return this.y;
  }

  reset(): void {
    this.initialized = false;
  }
}

export class OneEuroFilter {
  minCutoff: number;
  beta: number;
  dCutoff: number;

  private x = new LowPass();
  private dx = new LowPass();
  private lastT: number | null = null;

  constructor(minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  /** @param tSec timestamp in SECONDS */
  filter(value: number, tSec: number): number {
    let dt = 1 / 30;
    if (this.lastT !== null) {
      dt = tSec - this.lastT;
      if (dt <= 0 || dt > 1) dt = 1 / 30; // clock hiccup — don't blow up
    }
    this.lastT = tSec;

    const dValue = (value - this.x.last()) / dt;
    const edValue = this.dx.filter(dValue, this.alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edValue);
    return this.x.filter(value, this.alpha(cutoff, dt));
  }

  reset(): void {
    this.x.reset();
    this.dx.reset();
    this.lastT = null;
  }
}
