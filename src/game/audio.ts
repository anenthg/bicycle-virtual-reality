// WebAudio synth SFX — zero audio files. Wheel hum pitched to speed, boings,
// pentatonic star arpeggios, comedic clucks, confetti fanfare.
// Audio starts only after the first user gesture (browser policy).

import { LS } from '../shared/types';

// C major pentatonic, two octaves — star streaks climb this ladder.
const PENTA = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.66, 1318.51, 1567.98, 1760.0];

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private humOsc: OscillatorNode | null = null;
  private humGain: GainNode | null = null;
  private humFilter: BiquadFilterNode | null = null;
  private noiseBuf: AudioBuffer | null = null;

  muted = localStorage.getItem(LS.muted) === '1';

  /** Call from a user-gesture handler. Safe to call repeatedly. */
  init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.55;
    this.master.connect(this.ctx.destination);

    // Shared noise buffer for splashes/whooshes
    const len = this.ctx.sampleRate;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // Wheel hum: quiet sawtooth through a lowpass, pitch follows speed.
    this.humOsc = this.ctx.createOscillator();
    this.humOsc.type = 'sawtooth';
    this.humOsc.frequency.value = 55;
    this.humFilter = this.ctx.createBiquadFilter();
    this.humFilter.type = 'lowpass';
    this.humFilter.frequency.value = 220;
    this.humGain = this.ctx.createGain();
    this.humGain.gain.value = 0;
    this.humOsc.connect(this.humFilter).connect(this.humGain).connect(this.master);
    this.humOsc.start();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    localStorage.setItem(LS.muted, m ? '1' : '0');
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(m ? 0 : 0.55, this.ctx.currentTime, 0.05);
    }
  }

  /** Called every frame with current forward speed (m/s). */
  setSpeed(speed: number, airborne: boolean): void {
    if (!this.ctx || !this.humOsc || !this.humGain || !this.humFilter) return;
    const t = this.ctx.currentTime;
    const norm = Math.min(speed / 26, 1);
    this.humOsc.frequency.setTargetAtTime(45 + norm * 90, t, 0.1);
    this.humFilter.frequency.setTargetAtTime(160 + norm * 480, t, 0.1);
    this.humGain.gain.setTargetAtTime(airborne ? 0.008 : 0.02 + norm * 0.05, t, 0.15);
  }

  /** Star pickup — pitch climbs with the current streak. */
  chime(streak: number): void {
    const f = PENTA[Math.min(streak, PENTA.length - 1)];
    this.tone(f, 0.28, 'triangle', 0.22);
    this.tone(f * 2, 0.18, 'sine', 0.08, 0.02);
  }

  boing(): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(180, t);
    osc.frequency.exponentialRampToValueAtTime(520, t + 0.08);
    osc.frequency.exponentialRampToValueAtTime(240, t + 0.3);
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.4);
  }

  thud(): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.18);
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.3);
    this.noise(0.12, 900, 0.12);
  }

  splash(): void {
    this.noise(0.35, 2400, 0.2);
    this.tone(240, 0.15, 'sine', 0.1);
  }

  whoosh(): void {
    this.noise(0.4, 1200, 0.16);
  }

  cluck(): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      const t0 = t + i * 0.12;
      osc.type = 'square';
      osc.frequency.setValueAtTime(820 + Math.random() * 120, t0);
      osc.frequency.exponentialRampToValueAtTime(420, t0 + 0.07);
      g.gain.setValueAtTime(0.001, t0);
      g.gain.exponentialRampToValueAtTime(0.14, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.09);
      osc.connect(g).connect(this.master);
      osc.start(t0);
      osc.stop(t0 + 0.12);
    }
  }

  magnet(): void {
    this.tone(392, 0.4, 'sine', 0.18);
    this.tone(587.33, 0.4, 'sine', 0.14, 0.08);
    this.tone(783.99, 0.5, 'sine', 0.12, 0.16);
  }

  fanfare(): void {
    const notes = [523.25, 659.25, 783.99, 1046.5, 1046.5];
    notes.forEach((f, i) => {
      this.tone(f, 0.5, 'triangle', 0.2, i * 0.13);
      this.tone(f / 2, 0.5, 'sine', 0.1, i * 0.13);
    });
  }

  click(): void {
    this.tone(880, 0.06, 'sine', 0.12);
  }

  // -------------------------------------------------------------------------

  private tone(
    freq: number,
    dur: number,
    type: OscillatorType,
    vol: number,
    delay = 0,
  ): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  private noise(dur: number, cutoff: number, vol: number): void {
    if (!this.ctx || !this.master || !this.noiseBuf) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.05);
  }
}
