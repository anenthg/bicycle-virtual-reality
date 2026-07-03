// Dev tool: injects fake SteerState-style steering so game feel and latency
// can be tuned without a camera or a bike (spec M2).
//
//   http://localhost:5173/?fake=sine            — slow sine-wave steering
//   http://localhost:5173/?fake=sine&delay=120  — same, with 120 ms added latency
//   http://localhost:5173/?fake=slider          — on-screen slider you can drag
//
// Remove the query param (or call window.__fakeInput.stop()) to return control
// to camera/keyboard.

import type { InputManager } from '../src/game/input';

declare global {
  interface Window {
    __fakeInput?: { stop: () => void };
  }
}

export function setupFakeInput(input: InputManager, params: URLSearchParams): void {
  const mode = params.get('fake') ?? 'sine';
  const delayMs = Number(params.get('delay') ?? 0);
  const buffer: { t: number; v: number }[] = [];
  let raf = 0;
  let sliderValue = 0;
  let el: HTMLElement | null = null;

  if (mode === 'slider') {
    el = document.createElement('div');
    el.style.cssText =
      'position:absolute;bottom:24px;left:50%;transform:translateX(-50%);z-index:70;' +
      'background:rgba(10,8,24,0.85);padding:10px 18px;border-radius:14px;color:#fff;' +
      'font:13px ui-monospace,monospace;display:flex;gap:10px;align-items:center;';
    el.innerHTML = `fake steer <input type="range" min="-1" max="1" step="0.01" value="0" style="width:260px">
      <span>0.00</span>`;
    document.body.appendChild(el);
    const slider = el.querySelector('input')!;
    const label = el.querySelector('span')!;
    slider.addEventListener('input', () => {
      sliderValue = Number(slider.value);
      label.textContent = sliderValue.toFixed(2);
    });
    // double-click to recenter
    slider.addEventListener('dblclick', () => {
      slider.value = '0';
      sliderValue = 0;
      label.textContent = '0.00';
    });
  }

  const tick = (): void => {
    raf = requestAnimationFrame(tick);
    const now = performance.now();
    const v = mode === 'slider' ? sliderValue : Math.sin(now / 1400) * 0.85;
    buffer.push({ t: now, v });
    // Emit the newest sample that is at least delayMs old
    let emit: number | null = null;
    while (buffer.length && now - buffer[0].t >= delayMs) {
      emit = buffer.shift()!.v;
    }
    if (emit !== null) input.setFakeSteer(emit);
  };
  tick();

  console.info(`[fake-input] mode=${mode} delay=${delayMs}ms — window.__fakeInput.stop() to disable`);
  window.__fakeInput = {
    stop: () => {
      cancelAnimationFrame(raf);
      input.setFakeSteer(null);
      el?.remove();
      delete window.__fakeInput;
    },
  };
}
