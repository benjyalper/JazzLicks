// Music theory helpers: pitches, durations, key signatures, chords.

export const STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const STEP_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// Ticks: a 4/4 measure is 32 ticks (one tick = a 32nd note).
export const MEASURE_TICKS = 32;
export const DUR_TICKS = { w: 32, h: 16, q: 8, '8': 4, '16': 2 };
export const DURATIONS = ['16', '8', 'q', 'h', 'w'];

export function noteTicks(n) {
  const base = DUR_TICKS[n.dur];
  return n.dots ? base * 1.5 : base;
}

export function measureTicks(measure) {
  return measure.notes.reduce((sum, n) => sum + noteTicks(n), 0);
}

// Key signatures (major key name as VexFlow expects it).
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
export const KEY_SIGS = [
  { key: 'C', sharps: 0, label: 'C / Am' },
  { key: 'F', flats: 1, label: 'F / Dm' },
  { key: 'Bb', flats: 2, label: 'B♭ / Gm' },
  { key: 'Eb', flats: 3, label: 'E♭ / Cm' },
  { key: 'Ab', flats: 4, label: 'A♭ / Fm' },
  { key: 'Db', flats: 5, label: 'D♭ / B♭m' },
  { key: 'Gb', flats: 6, label: 'G♭ / E♭m' },
  { key: 'B', sharps: 5, label: 'B / G♯m' },
  { key: 'E', sharps: 4, label: 'E / C♯m' },
  { key: 'A', sharps: 3, label: 'A / F♯m' },
  { key: 'D', sharps: 2, label: 'D / Bm' },
  { key: 'G', sharps: 1, label: 'G / Em' },
];

export function keyAlter(key, step) {
  const ks = KEY_SIGS.find((k) => k.key === key) || KEY_SIGS[0];
  if (ks.sharps && SHARP_ORDER.slice(0, ks.sharps).includes(step)) return 1;
  if (ks.flats && FLAT_ORDER.slice(0, ks.flats).includes(step)) return -1;
  return 0;
}

export function isFlatKey(key) {
  const ks = KEY_SIGS.find((k) => k.key === key);
  return !!(ks && ks.flats);
}

// Diatonic index: C0 = 0, D0 = 1 ... used for staff positions.
export function diatonicIndex(step, oct) {
  return oct * 7 + STEPS.indexOf(step);
}

export function fromDiatonic(idx) {
  return { step: STEPS[((idx % 7) + 7) % 7], oct: Math.floor(idx / 7) };
}

// Allowed writing range: G3 .. C7.
export const MIN_DIATONIC = diatonicIndex('G', 3);
export const MAX_DIATONIC = diatonicIndex('C', 7);

export function midi(n) {
  return (n.oct + 1) * 12 + STEP_PC[n.step] + n.alter;
}

export function accidentalString(alter) {
  return alter === 1 ? '#' : alter === -1 ? 'b' : '';
}

export function pitchLabel(n) {
  const acc = n.alter === 1 ? '♯' : n.alter === -1 ? '♭' : '';
  return `${n.step}${acc}${n.oct}`;
}

// Chords
export const CHORD_QUALITIES = [
  { id: 'maj7', label: 'maj7', intervals: [4, 7, 11] },
  { id: 'm7', label: 'm7', intervals: [3, 7, 10] },
  { id: 'm7b5', label: 'm7♭5 (ø)', intervals: [3, 6, 10] },
  { id: '7', label: '7', intervals: [4, 7, 10] },
];

// 12 roots; black keys offer both spellings.
export const CHORD_ROOTS = [
  ['C'], ['C#', 'Db'], ['D'], ['D#', 'Eb'], ['E'], ['F'],
  ['F#', 'Gb'], ['G'], ['G#', 'Ab'], ['A'], ['A#', 'Bb'], ['B'],
];

export function rootPc(root) {
  const base = STEP_PC[root[0]];
  const alter = root[1] === '#' ? 1 : root[1] === 'b' ? -1 : 0;
  return (base + alter + 12) % 12;
}

export function prettyRoot(root) {
  return root[0] + (root[1] === '#' ? '♯' : root[1] === 'b' ? '♭' : '');
}

// Split a chord symbol into the big part and the superscript part,
// in the style of a hand-written lead sheet: Gm⁷, C⁷, Eø, Bbmaj⁷.
export function chordParts(chord) {
  const root = prettyRoot(chord.root);
  switch (chord.quality) {
    case 'maj7': return { main: root, sup: 'maj7' };
    case 'm7': return { main: root + 'm', sup: '7' };
    case 'm7b5': return { main: root, sup: 'ø' };
    default: return { main: root, sup: '7' };
  }
}

export function chordText(chord) {
  const p = chordParts(chord);
  return p.main + p.sup;
}

// A simple jazz piano voicing: root in the bass, then 3rd, 5th and 7th
// kept in the middle register.
export function chordVoicing(chord) {
  const q = CHORD_QUALITIES.find((c) => c.id === chord.quality) || CHORD_QUALITIES[3];
  const pc = rootPc(chord.root);
  let bass = 36 + pc; // C2..B2
  if (bass < 40) bass += 12; // keep the bass at E2 or above
  const notes = [bass];
  for (const iv of q.intervals) {
    let m = 48 + ((pc + iv) % 12); // C3..B3
    if (m < 52) m += 12; // E3..D#4
    notes.push(m);
  }
  return notes.sort((a, b) => a - b);
}
