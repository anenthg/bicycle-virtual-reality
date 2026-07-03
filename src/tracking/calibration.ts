// Calibration profile persistence + the wizard's state machine data.
// The wizard UI itself lives in ui/wizard.ts.

import type { CalibrationProfile, HSVWindow } from '../shared/types';
import { DEFAULT_STEER_SIGN, LS } from '../shared/types';

export type WizardStep = 'left-marker' | 'right-marker' | 'center' | 'left-limit' | 'right-limit' | 'done';

export const WIZARD_ORDER: WizardStep[] = [
  'left-marker',
  'right-marker',
  'center',
  'left-limit',
  'right-limit',
  'done',
];

export function loadProfile(): CalibrationProfile | null {
  try {
    const raw = localStorage.getItem(LS.calibration);
    if (!raw) return null;
    const p = JSON.parse(raw) as CalibrationProfile;
    if (p.version !== 2 || !p.left || !p.right) return null;
    return p;
  } catch {
    return null;
  }
}

export function saveProfile(p: CalibrationProfile): void {
  localStorage.setItem(LS.calibration, JSON.stringify(p));
}

export function clearProfile(): void {
  localStorage.removeItem(LS.calibration);
}

/** A profile under construction during the wizard. */
export interface DraftProfile {
  left: HSVWindow | null;
  right: HSVWindow | null;
  centerDeg: number | null;
  leftMaxDeg: number | null;
  rightMaxDeg: number | null;
  centerMidX: number;
  barLength: number;
  expectedArea: number;
  steerSign: 1 | -1;
}

export function newDraft(prev?: CalibrationProfile | null): DraftProfile {
  return {
    left: null,
    right: null,
    centerDeg: null,
    leftMaxDeg: null,
    rightMaxDeg: null,
    centerMidX: 0.5,
    barLength: 0.4,
    expectedArea: 60,
    steerSign: prev?.steerSign ?? DEFAULT_STEER_SIGN,
  };
}

export function finalizeDraft(d: DraftProfile): CalibrationProfile | null {
  if (
    d.left === null ||
    d.right === null ||
    d.centerDeg === null ||
    d.leftMaxDeg === null ||
    d.rightMaxDeg === null
  ) {
    return null;
  }
  return {
    version: 2,
    left: d.left,
    right: d.right,
    centerDeg: d.centerDeg,
    leftMaxDeg: d.leftMaxDeg,
    rightMaxDeg: d.rightMaxDeg,
    centerMidX: d.centerMidX,
    barLength: d.barLength,
    expectedArea: d.expectedArea,
    steerSign: d.steerSign,
  };
}

/** A draft with both hue windows sampled can already run live detection. */
export function draftToProvisionalProfile(d: DraftProfile): CalibrationProfile | null {
  if (d.left === null || d.right === null) return null;
  return {
    version: 2,
    left: d.left,
    right: d.right,
    centerDeg: d.centerDeg ?? 0,
    leftMaxDeg: d.leftMaxDeg ?? -25,
    rightMaxDeg: d.rightMaxDeg ?? 25,
    centerMidX: d.centerMidX,
    barLength: d.barLength,
    expectedArea: d.expectedArea,
    steerSign: d.steerSign,
  };
}
