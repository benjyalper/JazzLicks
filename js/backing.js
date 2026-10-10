// Rhythm section: walking/bossa bass, drum patterns and chord comping,
// generated from a phrase's chord symbols. Times are in ticks (24 per beat).
import { MEASURE_TICKS, BEAT_TICKS, CHORD_QUALITIES, rootPc, chordVoicing } from './music.js';

export const STYLES = [
  { id: 'swing', label: 'Swing' },
  { id: 'latin', label: 'Bossa' },
];

const BASS_LOW = 28; // E1
const BASS_HIGH = 52; // E3

// Chord symbols as a list of { chord, tick } in time order.
export function chordList(phrase) {
  const list = [];
  phrase.measures.forEach((measure, m) => {
    (measure.chords || []).forEach((c, slot) => {
      if (c) list.push({ chord: c, tick: m * MEASURE_TICKS + (slot * MEASURE_TICKS) / 2 });
    });
  });
  return list;
}

function chordAt(list, tick) {
  let cur = null;
  for (const c of list) if (c.tick <= tick) cur = c.chord;
  return cur;
}

function intervals(chord) {
  const q = CHORD_QUALITIES.find((x) => x.id === chord.quality) || CHORD_QUALITIES[3];
  return { third: q.intervals[0], fifth: q.intervals[1], seventh: q.intervals[2] };
}

// Place a pitch class in the bass register, as close as possible to `near`.
function bassNote(pc, near) {
  let best = null;
  for (let m = BASS_LOW; m <= BASS_HIGH; m++) {
    if (((m % 12) + 12) % 12 !== ((pc % 12) + 12) % 12) continue;
    if (best === null || Math.abs(m - near) < Math.abs(best - near)) best = m;
  }
  return best;
}

// ---------------------------------------------------------------- bass

function walkingBass(phrase, list) {
  const beats = phrase.measures.length * 4;
  const events = [];
  // Chord "segments" on the beat grid.
  const segs = [];
  for (let b = 0; b < beats; b++) {
    const ch = chordAt(list, b * BEAT_TICKS);
    const last = segs[segs.length - 1];
    const startsHere = list.some((c) => c.tick === b * BEAT_TICKS);
    if (!ch) continue;
    if (last && !startsHere && last.end === b) last.end = b + 1;
    else segs.push({ chord: ch, start: b, end: b + 1 });
  }
  let prev = 38; // around D2
  segs.forEach((seg, k) => {
    const next = segs[k + 1] ? segs[k + 1].chord : phrase.loop && segs.length ? segs[0].chord : null;
    const root = rootPc(seg.chord.root);
    const iv = intervals(seg.chord);
    const len = seg.end - seg.start;
    const line = [0, iv.third, iv.fifth, iv.seventh, 12, iv.fifth, iv.third, iv.fifth];
    for (let p = 0; p < len; p++) {
      let midi;
      if (p === 0) {
        midi = bassNote(root, prev <= 34 ? prev + 3 : prev);
      } else if (p === len - 1 && next) {
        const target = bassNote(rootPc(next.root), prev);
        if (rootPc(next.root) === root) midi = bassNote(root + iv.fifth, prev);
        else {
          // Chromatic approach into the next root, from whichever side is closer.
          const above = target + 1;
          const below = target - 1;
          midi = Math.abs(above - prev) <= Math.abs(below - prev) ? above : below;
          if (midi > BASS_HIGH) midi = below;
          if (midi < BASS_LOW) midi = above;
          if (midi === prev) midi = midi === above ? below : above; // don't repeat a note into the approach
        }
      } else {
        midi = bassNote(root + line[p % line.length], prev);
      }
      events.push({ kind: 'bass', tick: (seg.start + p) * BEAT_TICKS, dur: BEAT_TICKS * 0.92, midi, vel: p === 0 ? 0.85 : 0.72 });
      prev = midi;
    }
  });
  return events;
}

// Bossa nova bass: the chord's root on beat 1, its fifth (above or below,
// whichever is closer) on beat 3. If the chord changes on beat 3, the new root.
function bossaBass(phrase, list) {
  const events = [];
  let prev = 38;
  phrase.measures.forEach((_, m) => {
    const t = m * MEASURE_TICKS;
    const ch1 = chordAt(list, t);
    const ch3 = chordAt(list, t + 48);
    if (ch1) {
      const midi = bassNote(rootPc(ch1.root), prev);
      events.push({ kind: 'bass', tick: t, dur: 44, midi, vel: 0.85 });
      prev = midi;
    }
    if (ch3) {
      const changes = ch3 !== ch1;
      const root = changes ? bassNote(rootPc(ch3.root), prev) : prev;
      let midi = root;
      if (!changes) {
        const up = root + 7;
        const down = root - 5;
        midi = down < BASS_LOW ? up : up > BASS_HIGH ? down : Math.abs(up - prev) < Math.abs(down - prev) ? up : down;
      }
      events.push({ kind: 'bass', tick: t + 48, dur: 44, midi, vel: changes ? 0.85 : 0.75 });
      prev = midi;
    }
  });
  return events;
}

// ---------------------------------------------------------------- drums

function swingDrums(measures) {
  const ev = [];
  for (let m = 0; m < measures; m++) {
    const t = m * MEASURE_TICKS;
    // Ride: ding, ding-a ding, ding-a
    ev.push({ kind: 'drum', sound: 'ride', tick: t, vel: 0.55 });
    ev.push({ kind: 'drum', sound: 'ride', tick: t + 24, vel: 0.75 });
    ev.push({ kind: 'drum', sound: 'ride', tick: t + 36, vel: 0.4 });
    ev.push({ kind: 'drum', sound: 'ride', tick: t + 48, vel: 0.55 });
    ev.push({ kind: 'drum', sound: 'ride', tick: t + 72, vel: 0.75 });
    ev.push({ kind: 'drum', sound: 'ride', tick: t + 84, vel: 0.4 });
    // Hi-hat foot on 2 and 4, feathered kick on every beat.
    ev.push({ kind: 'drum', sound: 'hihat', tick: t + 24, vel: 0.5 });
    ev.push({ kind: 'drum', sound: 'hihat', tick: t + 72, vel: 0.5 });
    for (let b = 0; b < 4; b++) ev.push({ kind: 'drum', sound: 'kick', tick: t + b * 24, vel: 0.22 });
  }
  return ev;
}

// Bossa nova percussion: shaker in sixteenths (the first of each group of four
// slightly stronger) and a wooden clave on sixteenths 1, 4, 7, 10 and 13.
const BOSSA_CLAVE = [0, 3, 6, 9, 12]; // sixteenth-note positions (0-based) in every bar

function latinDrums(measures) {
  const ev = [];
  for (let m = 0; m < measures; m++) {
    const t = m * MEASURE_TICKS;
    for (let s16 = 0; s16 < 16; s16++) ev.push({ kind: 'drum', sound: 'shaker', tick: t + s16 * 6, vel: s16 % 4 === 0 ? 0.62 : 0.5 });
    for (const s16 of BOSSA_CLAVE) ev.push({ kind: 'drum', sound: 'clave', tick: t + s16 * 6, vel: 0.8 });
  }
  return ev;
}

// ---------------------------------------------------------------- comping

function swingComp(phrase, list) {
  const ev = [];
  const total = phrase.measures.length * MEASURE_TICKS;
  list.forEach((c, k) => {
    const end = k + 1 < list.length ? list[k + 1].tick : total;
    const notes = chordVoicing(c.chord).slice(1); // the bass plays the root
    ev.push({ kind: 'comp', tick: c.tick, dur: Math.min(end - c.tick, 22), notes, vel: 1 });
    // Charleston-style push on the "and" of 2.
    if (end - c.tick >= 48) ev.push({ kind: 'comp', tick: c.tick + 36, dur: 10, notes, vel: 0.85 });
  });
  return ev;
}

// Guitar-style shell voicing for bossa: 3rd, 7th and 9th (♭5 instead of the
// 9th on half-diminished), placed around G3–E4.
function bossaVoicing(chord) {
  const iv = intervals(chord);
  const pc = rootPc(chord.root);
  const tones = chord.quality === 'm7b5' ? [iv.third, iv.fifth, iv.seventh] : [iv.third, iv.seventh, 14];
  const notes = tones.map((t) => {
    let m = 48 + ((((pc + t) % 12) + 12) % 12); // C3..B3
    if (m < 55) m += 12; // keep it within G3..F#4
    return m;
  });
  return notes.sort((a, b) => a - b);
}

// João Gilberto-style nylon guitar: the thumb plays the bass on 1 and 3, the
// fingers pluck the chord in a syncopated two-bar figure, and a chord change
// is anticipated on the "and" of 4.
const BOSSA_FINGERS = [[0, 3, 5], [2, 4, 7]]; // eighth-note positions in bar A / bar B

function bossaGuitar(phrase, list, withBass) {
  const ev = [];
  const total = phrase.measures.length * MEASURE_TICKS;
  phrase.measures.forEach((_, m) => {
    const t = m * MEASURE_TICKS;
    // Thumb: root on 1, fifth (or new root) on 3. Softer when the bassist plays too.
    for (const beat of [0, 2]) {
      const ch = chordAt(list, t + beat * 24);
      if (!ch) continue;
      const changed = beat === 0 || list.some((c) => c.tick === t + 48);
      const pc = rootPc(ch.root) + (changed ? 0 : intervals(ch).fifth);
      let midi = 40 + ((((pc - 4) % 12) + 12) % 12); // E2..D#3
      ev.push({ kind: 'gtr', tick: t + beat * 24, dur: 20, notes: [midi], vel: withBass ? 0.32 : 0.55 });
    }
    // Fingers.
    const pattern = BOSSA_FINGERS[m % 2];
    for (const e of pattern) {
      let tick = t + e * 12;
      let ch = chordAt(list, tick);
      // The last hit of bar B pushes the next bar's chord (anticipation).
      if (e === 7) {
        const nextTick = t + MEASURE_TICKS < total ? t + MEASURE_TICKS : phrase.loop ? 0 : -1;
        if (nextTick >= 0) ch = chordAt(list, nextTick) || ch;
      }
      if (ch) ev.push({ kind: 'gtr', tick, dur: e === 7 ? 18 : 14, notes: bossaVoicing(ch), vel: 0.42 });
    }
  });
  return ev;
}

/** All backing events for a phrase. `opts`: { bass, drums, comp } booleans. */
export function buildBacking(phrase, opts) {
  const list = chordList(phrase);
  const latin = phrase.style === 'latin';
  const ev = [];
  if (opts.bass && list.length) ev.push(...(latin ? bossaBass(phrase, list) : walkingBass(phrase, list)));
  if (opts.drums) ev.push(...(latin ? latinDrums(phrase.measures.length) : swingDrums(phrase.measures.length)));
  if (opts.comp && list.length) ev.push(...(latin ? bossaGuitar(phrase, list, opts.bass) : swingComp(phrase, list)));
  return ev;
}

export function countInEvents(phrase) {
  const sound = phrase.style === 'latin' ? 'clave' : 'hihat';
  return [0, 1, 2, 3].map((b) => ({ kind: 'drum', sound, tick: b * BEAT_TICKS, vel: b === 0 ? 0.9 : 0.7 }));
}
