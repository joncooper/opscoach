// Tiny Web Audio synth for game feedback. Sounds are generated on the fly (no asset
// files to host or load), so once the AudioContext is unlocked, playback latency is
// effectively zero. Browsers require a user gesture before audio can start, so call
// unlockAudio() from a click/keydown before relying on playback.

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}

/** Resume the AudioContext from within a user gesture so later sounds can play. */
export function unlockAudio(): void {
  const c = getCtx();
  if (c && c.state === "suspended") {
    void c.resume();
  }
}

type Wave = OscillatorType;

function tone(
  c: AudioContext,
  freq: number,
  startOffset: number,
  dur: number,
  peak: number,
  type: Wave = "sine"
): void {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(gain);
  gain.connect(c.destination);
  const t = c.currentTime + startOffset;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.start(t);
  osc.stop(t + dur + 0.03);
}

/** A warm struck bell — one lantern catching light. */
export function playLantern(): void {
  const c = getCtx();
  if (!c) return;
  if (c.state === "suspended") void c.resume();
  tone(c, 880, 0, 0.55, 0.16, "sine"); // A5 fundamental
  tone(c, 1320, 0, 0.42, 0.07, "sine"); // a fifth above
  tone(c, 1760, 0.02, 0.3, 0.045, "sine"); // octave shimmer
}

/** An ascending major arpeggio with a shimmer — the dawn finale. */
export function playDawn(): void {
  const c = getCtx();
  if (!c) return;
  if (c.state === "suspended") void c.resume();
  const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
  notes.forEach((f, i) => tone(c, f, i * 0.14, 0.85, 0.15, "triangle"));
  tone(c, 1567.98, 0.56, 1.3, 0.05, "sine"); // high shimmer over the top
}
