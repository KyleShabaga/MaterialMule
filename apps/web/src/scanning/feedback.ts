import { useState } from 'react';

// Optional result sounds (MM-T16). The scanner beeps when it decodes a symbol; these tones say
// what Material Mule made of it, so the two never get confused: one high tone for a match, two low
// tones for anything else. Off unless the user turns them on; the choice is kept per browser.

const STORAGE_KEY = 'materialmule.scanSound';

export function readScanSoundSetting(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'on';
  } catch {
    return false;
  }
}

export function saveScanSoundSetting(on: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    // Private mode or blocked storage: the setting just isn't remembered.
  }
}

let context: AudioContext | null = null;

export function playScanTone(kind: 'success' | 'failure'): void {
  try {
    if (typeof window.AudioContext !== 'function') return;
    context ??= new window.AudioContext();
    const tones =
      kind === 'success'
        ? [[1046, 0]]
        : [
            [220, 0],
            [220, 0.22],
          ];
    for (const [frequency, offset] of tones) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = frequency!;
      gain.gain.value = 0.15;
      oscillator.connect(gain).connect(context.destination);
      const start = context.currentTime + offset!;
      oscillator.start(start);
      oscillator.stop(start + 0.15);
    }
  } catch {
    // Sound is a supplement to the on-screen result; ignore audio failures.
  }
}

export interface ScanSound {
  on: boolean;
  setOn: (on: boolean) => void;
}

/** The optional result sound, remembered per browser. */
export function useScanSound(): ScanSound {
  const [on, setOnState] = useState(readScanSoundSetting);
  return {
    on,
    setOn: (next) => {
      setOnState(next);
      saveScanSoundSetting(next);
    },
  };
}
