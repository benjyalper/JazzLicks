// Music theory helpers: pitches, durations, key signatures, chords.

export const STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const STEP_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// Ticks: a beat is 24 ticks so both straight and triplet values are whole
// numbers (eighth = 12, eighth triplet = 8, sixteenth = 6 ...).
export const BEAT_TICKS = 24;
export const MEASURE_TICKS = 4 * BEAT_TICKS;
export const DUR_TICKS = { w: 96, h: 48, q: 24, '8': 12, '16': 6 };
export const DURATIONS = ['16', '8', 'q', 'h', 'w'];
export const TRIPLET_DURATIONS = ['16', '8', 'q'];

export function noteTicks(n) {
  const base = DUR_TICKS[n.dur];
  if (n.trip) return (base * 2) / 3;
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
  return { 2: '##', 1: '#', '-1': 'b', '-2': 'bb' }[alter] || '';
}

export function pitchLabel(n) {
  const acc = { 2: '𝄪', 1: '♯', '-1': '♭', '-2': '𝄫' }[n.alter] || '';
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

// ---------------------------------------------------------------- transposing

const KEY_TONIC = {
  C: ['C', 0], G: ['G', 0], D: ['D', 0], A: ['A', 0], E: ['E', 0], B: ['B', 0],
  F: ['F', 0], Bb: ['B', -1], Eb: ['E', -1], Ab: ['A', -1], Db: ['D', -1], Gb: ['G', -1],
};

// Interval between two major keys as (letter steps, semitones), choosing the
// direction given by `dir` (+1 up, -1 down).
function keyInterval(fromKey, toKey, dir) {
  const [fl, fa] = KEY_TONIC[fromKey];
  const [tl, ta] = KEY_TONIC[toKey];
  let steps = STEPS.indexOf(tl) - STEPS.indexOf(fl);
  let semis = STEP_PC[tl] + ta - (STEP_PC[fl] + fa);
  if (dir > 0 && semis < 0) { steps += 7; semis += 12; }
  if (dir < 0 && semis > 0) { steps -= 7; semis -= 12; }
  if (dir > 0 && semis === 0 && steps < 0) steps += 7;
  return { steps, semis };
}

function transposeNote(n, iv) {
  if (n.rest) return { ...n };
  const target = midi(n) + iv.semis;
  const { step, oct } = fromDiatonic(diatonicIndex(n.step, n.oct) + iv.steps);
  const natural = (oct + 1) * 12 + STEP_PC[step];
  return { ...n, step, oct, alter: target - natural };
}

function spellRoot(pc, preferFlats) {
  const names = CHORD_ROOTS[((pc % 12) + 12) % 12];
  return names.length === 1 ? names[0] : preferFlats ? names[1] : names[0];
}

function transposeRoot(root, iv, toKey) {
  const letter = STEPS[(((STEPS.indexOf(root[0]) + iv.steps) % 7) + 7) % 7];
  const pc = rootPc(root) + iv.semis;
  let alter = (((pc - STEP_PC[letter]) % 12) + 18) % 12 - 6; // -6..5
  if (alter < -1 || alter > 1) return spellRoot(pc, isFlatKey(toKey));
  return letter + (alter === 1 ? '#' : alter === -1 ? 'b' : '');
}

/**
 * Move every note and chord of `phrase` from its key to `toKey`, picking the
 * nearer direction (up or down) that keeps all notes in the writable range.
 * Returns a new measures array.
 */
export function transposeMeasures(measures, fromKey, toKey) {
  const up = keyInterval(fromKey, toKey, 1);
  const down = keyInterval(fromKey, toKey, -1);
  const order = up.semis <= -down.semis ? [up, down] : [down, up];
  const apply = (iv) => measures.map((m) => ({
    chords: (m.chords || [null, null]).map((c) => (c ? { ...c, root: transposeRoot(c.root, iv, toKey) } : null)),
    notes: m.notes.map((n) => transposeNote(n, iv)),
  }));
  const inRange = (ms) => ms.every((m) => m.notes.every((n) => {
    if (n.rest) return true;
    const d = diatonicIndex(n.step, n.oct);
    return d >= MIN_DIATONIC && d <= MAX_DIATONIC;
  }));
  for (const iv of order) {
    const result = apply(iv);
    if (inRange(result)) return result;
  }
  return apply(order[0]);
}
