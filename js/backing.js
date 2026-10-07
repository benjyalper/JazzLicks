// Rhythm section: walking/bossa bass, drum patterns and chord comping,
// generated from a phrase's chord symbols. Times are in ticks (24 per beat).
import { MEASURE_TICKS, BEAT_TICKS, CHORD_QUALITIES, rootPc, chordVoicing } from './music.js';

export const STYLES = [
  { id: 'swing', label: 'Swing' },
  { id: 'latin', label: 'Latin' },
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

function bossaBass(phrase, list) {
  const events = [];
  let prev = 38;
  phrase.measures.forEach((_, m) => {
    for (const half of [0, 1]) {
      const tick = m * MEASURE_TICKS + half * 48;
      const ch = chordAt(list, tick);
      if (!ch) continue;
      const root = rootPc(ch.root);
      const changed = half === 0 || list.some((c) => c.tick === tick);
      // Root on the downbeat, fifth on beat 3 (or the new root if the chord changes).
      const pc = changed ? root : root + intervals(ch).fifth;
      const midi = bassNote(pc, changed ? prev : prev - 5);
      events.push({ kind: 'bass', tick, dur: 36, midi, vel: changed ? 0.85 : 0.7 });
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

// Bossa nova: straight eighths on the shaker, cross-stick in a 2-bar clave
// figure, kick "boom-ba boom-ba".
const BOSSA_STICK = [[0, 3, 6], [2, 5]]; // eighth-note positions in bar A / bar B

function latinDrums(measures) {
  const ev = [];
  for (let m = 0; m < measures; m++) {
    const t = m * MEASURE_TICKS;
    for (let e = 0; e < 8; e++) ev.push({ kind: 'drum', sound: 'shaker', tick: t + e * 12, vel: e % 2 ? 0.35 : 0.55 });
    for (const e of BOSSA_STICK[m % 2]) ev.push({ kind: 'drum', sound: 'stick', tick: t + e * 12, vel: 0.7 });
    ev.push({ kind: 'drum', sound: 'kick', tick: t, vel: 0.6 });
    ev.push({ kind: 'drum', sound: 'kick', tick: t + 36, vel: 0.35 });
    ev.push({ kind: 'drum', sound: 'kick', tick: t + 48, vel: 0.6 });
    ev.push({ kind: 'drum', sound: 'kick', tick: t + 84, vel: 0.35 });
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

function latinComp(phrase, list) {
  const ev = [];
  phrase.measures.forEach((_, m) => {
    for (const e of BOSSA_STICK[m % 2]) {
      const tick = m * MEASURE_TICKS + e * 12;
      const ch = chordAt(list, tick);
      if (ch) ev.push({ kind: 'comp', tick, dur: 16, notes: chordVoicing(ch).slice(1), vel: 0.9 });
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
  if (opts.comp && list.length) ev.push(...(latin ? latinComp(phrase, list) : swingComp(phrase, list)));
  return ev;
}

export function countInEvents(phrase) {
  const sound = phrase.style === 'latin' ? 'stick' : 'hihat';
  return [0, 1, 2, 3].map((b) => ({ kind: 'drum', sound, tick: b * BEAT_TICKS, vel: b === 0 ? 0.9 : 0.7 }));
}
