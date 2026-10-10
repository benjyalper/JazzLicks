// Draws a phrase with VexFlow and answers "what did the user click on?".
import {
  MEASURE_TICKS, DUR_TICKS, noteTicks, measureTicks, accidentalString, chordParts,
  diatonicIndex, MIN_DIATONIC, MAX_DIATONIC, midi, chordDegree,
} from './music.js';
import { chordList } from './backing.js';

const VF = Vex.Flow;
const SVG_NS = 'http://www.w3.org/2000/svg';

const LINE_H = 150; // height of one system (chord row + stave + room below)
const SPACE_ABOVE = 7; // stave "lines" of space above the top line
const MARGIN = 6;
const TOP_LINE_OFFSET = SPACE_ABOVE * 10; // top staff line y, relative to the system top
const CHORD_BASELINE = TOP_LINE_OFFSET - 44; // chord row, relative to the system top
const CHORD_ZONE = TOP_LINE_OFFSET - 37; // clicks above this y go to the chord row
const F5 = diatonicIndex('F', 5); // pitch on the top staff line

const PAD_STEPS = [[96, 'w'], [48, 'h'], [24, 'q'], [12, '8'], [6, '16'], [3, '32']];
const TRIPLET_PAD_STEPS = [[16, 'q'], [8, '8'], [4, '16']];
const HALF_BAR = MEASURE_TICKS / 2;

// Rests that fill an incomplete measure, so it always looks like 4/4.
// An unfinished triplet is completed with triplet rests first.
function padRests(used) {
  const out = [];
  let pos = used;
  while (pos < MEASURE_TICKS) {
    const std = PAD_STEPS.find(([t]) => t <= MEASURE_TICKS - pos && pos % t === 0);
    if (std) {
      out.push({ rest: true, dur: std[1], dots: 0, pad: true });
      pos += std[0];
      continue;
    }
    const toBeat = 24 - (pos % 24);
    const trip = TRIPLET_PAD_STEPS.find(([t]) => t <= toBeat) || TRIPLET_PAD_STEPS[2];
    out.push({ rest: true, dur: trip[1], dots: 0, trip: true, pad: true });
    pos += trip[0];
  }
  return out;
}

function padTicks(n) {
  return n.dur === '32' ? 3 : noteTicks(n);
}

// Group consecutive triplet notes into "3 in the time of 2" units.
function tripletGroups(items) {
  const groups = [];
  let cur = null;
  for (const it of items) {
    if (!it.note.trip) {
      if (cur) groups.push(cur);
      cur = null;
      continue;
    }
    if (!cur) cur = { items: [], sum: 0, target: 2 * DUR_TICKS[it.note.dur] };
    cur.items.push(it);
    it.group = groups.length;
    cur.sum += padTicks(it.note);
    if (cur.sum >= cur.target) {
      groups.push(cur);
      cur = null;
    }
  }
  if (cur) groups.push(cur);
  return groups;
}

const beamable = (n) => !n.rest && (n.dur === '8' || n.dur === '16');

// Beam eighths in half bars (jazz style); any half bar with sixteenths is
// beamed beat by beat instead, and each triplet gets its own beam.
function makeBeams(items) {
  const sixteenthHalves = new Set(items
    .filter((it) => !it.note.rest && !it.note.trip && it.note.dur === '16')
    .map((it) => Math.floor(it.tick / HALF_BAR)));
  const beams = [];
  let run = [];
  let key = null;
  const flush = () => {
    if (run.length >= 2) beams.push(new VF.Beam(run.map((it) => it.sn), true));
    run = [];
  };
  for (const it of items) {
    const half = Math.floor(it.tick / HALF_BAR);
    let k = `h${half}`;
    if (it.group !== undefined) k = `t${it.group}`;
    else if (sixteenthHalves.has(half)) k = `b${Math.floor(it.tick / 24)}`;
    if (!beamable(it.note) || k !== key) flush();
    key = k;
    if (beamable(it.note)) run.push(it);
  }
  flush();
  return beams;
}

function makeStaveNote(n) {
  const dur = n.dur + 'd'.repeat(n.dots || 0);
  let sn;
  if (n.rest) {
    sn = new VF.StaveNote({ keys: [n.dur === 'w' ? 'd/5' : 'b/4'], duration: dur + 'r' });
  } else {
    const key = `${n.step.toLowerCase()}${accidentalString(n.alter)}/${n.oct}`;
    sn = new VF.StaveNote({ keys: [key], duration: dur, auto_stem: true });
  }
  if (n.dots) VF.Dot.buildAndAttach([sn], { all: true });
  return sn;
}

const SELECTED = { fillStyle: '#d9480f', strokeStyle: '#d9480f' };
const PADDED = { fillStyle: '#c4c0b8', strokeStyle: '#c4c0b8' };

// Notes, beams and triplets for one bar, plus the minimum width it needs.
function buildBar(phrase, measure, m, opts) {
  const items = measure.notes.map((note, i) => ({ note, i, pad: false }))
    .concat(padRests(measureTicks(measure)).map((note) => ({ note, i: -1, pad: true })));
  let tick = 0;
  const sns = items.map((it) => {
    const sn = makeStaveNote(it.note);
    if ((it.pad || it.note.hold) && opts.editing) sn.setStyle(PADDED);
    if (!it.pad && opts.selected && opts.selected.has(`${m}:${it.i}`)) sn.setStyle(SELECTED);
    it.sn = sn;
    it.tick = tick;
    tick += it.pad ? padTicks(it.note) : noteTicks(it.note);
    return sn;
  });
  const tuplets = tripletGroups(items).map((g) => new VF.Tuplet(g.items.map((it) => it.sn), {
    num_notes: 3,
    notes_occupied: 2,
    ratioed: false,
    bracketed: !(g.items.length >= 2 && g.items.every((it) => beamable(it.note))),
  }));
  const voice = new VF.Voice({ num_beats: 4, beat_value: 4 }).setMode(VF.Voice.Mode.SOFT);
  voice.addTickables(sns);
  VF.Accidental.applyAccidentals([voice], phrase.keySig);
  const beams = makeBeams(items);
  // Minimum width from VexFlow, with a little breathing room per note.
  const minW = new VF.Formatter().joinVoices([voice]).preCalculateMinTotalWidth([voice]) + 8 * items.length + 24;
  return { items, voice, beams, tuplets, minW: Math.max(70, minW) };
}

/**
 * Render `phrase` into `host`. Returns a layout object used for hit testing
 * and for highlighting notes during playback.
 */
export function renderPhrase(host, phrase, opts = {}) {
  host.innerHTML = '';
  const pixelWidth = Math.max(240, Math.floor(opts.width || host.clientWidth || 600));
  const n = phrase.measures.length;

  // 1. Build every bar's notes first and ask VexFlow how much room each one
  //    needs, so busy bars get more width than sparse ones.
  const bars = phrase.measures.map((measure, m) => buildBar(phrase, measure, m, opts));
  const probeFirst = new VF.Stave(0, 0, 300).addClef('treble').addKeySignature(phrase.keySig).addTimeSignature('4/4');
  const probeLine = new VF.Stave(0, 0, 300).addClef('treble').addKeySignature(phrase.keySig);
  const modFirst = probeFirst.getNoteStartX() - probeFirst.getX();
  const modLine = probeLine.getNoteStartX() - probeLine.getX();

  // 2. Scale: phones get smaller notation, and shrink further if even a single
  //    bar wouldn't fit on a line.
  // Phones: smaller notation to fit two bars a line, but bigger (one bar a
  // line) while editing so notes are easy to hit with a finger.
  const narrow = pixelWidth < 500;
  let scale = narrow ? (opts.editing ? 1 : 0.8) : 1;
  const maxPerLine = narrow && opts.editing ? 1 : 4;
  const widest = Math.max(...bars.map((b) => b.minW)) + modFirst + 2 * MARGIN;
  if (widest > pixelWidth / scale) scale = Math.max(0.6, pixelWidth / widest);
  const width = pixelWidth / scale;
  const avail = width - 2 * MARGIN;

  // 3. Break into lines: as many bars as fit (max 4), each bar at least its minimum width.
  const lines = [];
  let cur = [];
  let used = 0;
  bars.forEach((b, m) => {
    const mod = lines.length === 0 ? modFirst : modLine;
    if (cur.length && (cur.length >= maxPerLine || mod + used + b.minW > avail)) {
      lines.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(m);
    used += b.minW;
  });
  if (cur.length) lines.push(cur);
  const lineCount = lines.length;

  // Lines with very high notes get extra room so they don't hit the chord row.
  const lineExtra = lines.map((ms) => {
    let maxD = -Infinity;
    for (const m of ms) {
      for (const nt of phrase.measures[m].notes) if (!nt.rest) maxD = Math.max(maxD, diatonicIndex(nt.step, nt.oct));
    }
    const headTop = (F5 - maxD) * 5 - 5; // relative to the top staff line
    const limit = CHORD_BASELINE - TOP_LINE_OFFSET + 12;
    return maxD === -Infinity ? 0 : Math.max(0, Math.ceil(limit - headTop));
  });

  const renderer = new VF.Renderer(host, VF.Renderer.Backends.SVG);
  renderer.resize(pixelWidth, lineCount * LINE_H * scale);
  const ctx = renderer.getContext();
  ctx.scale(scale, scale);
  const svg = host.querySelector('svg');

  const layout = { svg, width, scale, offsetY: 0, measures: [], notes: [], chords: [] };
  const real = []; // real (non-pad) notes in order, for ties
  const chords = chordList(phrase);
  let cursor = 0;

  lines.forEach((ms, L) => {
    const bandTop = cursor; // top of this system (chord row)
    const lineTop = bandTop + lineExtra[L]; // stave y
    const bandBottom = lineTop + LINE_H;
    const group = ctx.openGroup('system');
    const lineMeasures = [];
    const mod = L === 0 ? modFirst : modLine;
    const need = ms.reduce((sum, m) => sum + bars[m].minW, 0);
    // Share the spare room in proportion to each bar's needs. A short last
    // line isn't stretched all the way across.
    const isShortLast = lineCount > 1 && L === lineCount - 1 && need < (avail - mod) * 0.6;
    const room = isShortLast ? need * 1.4 : avail - mod;

    let x = MARGIN;
    ms.forEach((m, k) => {
      const bar = bars[m];
      const w = room * (bar.minW / need) + (k === 0 ? mod : 0);
      const stave = new VF.Stave(x, lineTop, w, { space_above_staff_ln: SPACE_ABOVE });
      if (k === 0) {
        stave.addClef('treble').addKeySignature(phrase.keySig);
        if (L === 0) stave.addTimeSignature('4/4');
      }
      if (m === n - 1) stave.setEndBarType(VF.Barline.type.END);
      stave.setContext(ctx).draw();

      new VF.Formatter().joinVoices([bar.voice]).formatToStave([bar.voice], stave);
      bar.voice.draw(ctx, stave);
      bar.beams.forEach((b) => b.setContext(ctx).draw());
      bar.tuplets.forEach((t) => t.setContext(ctx).draw());

      for (const it of bar.items) {
        const info = {
          m, i: it.i, pad: it.pad, tick: it.tick, line: L, sn: it.sn, note: it.note,
          x: it.sn.getAbsoluteX() + it.sn.getGlyphWidth() / 2,
        };
        layout.notes.push(info);
        if (!it.pad) real.push(info);
      }

      layout.measures.push({
        m, line: L, stave, lineTop, bandTop, bandBottom,
        x0: stave.getX(), x1: stave.getX() + stave.getWidth(),
        noteStart: stave.getNoteStartX(), noteEnd: stave.getNoteEndX(),
        topLine: stave.getYForLine(0),
        items: bar.items,
      });
      lineMeasures.push(layout.measures[layout.measures.length - 1]);
      x += w;
    });
    if (opts.degrees) drawDegrees(group, lineMeasures, real, chords);
    ctx.closeGroup();
    // Start the next system below whatever this one actually drew (long stems, beams…).
    let bottom = bandBottom;
    try {
      const bb = group.getBBox();
      bottom = Math.max(bandBottom, Math.ceil(bb.y + bb.height) + 4);
    } catch (e) { /* ignore */ }
    for (const ml of lineMeasures) ml.bandBottom = bottom;
    cursor = bottom;
  });
  const totalH = cursor;

  drawTies(ctx, real);
  drawChords(svg, phrase, layout, opts);
  fitToContent(svg, layout, totalH, pixelWidth, scale);
  return layout;
}

// Grow the drawing if anything (very high/low notes, triplet numbers) sticks
// out of the planned area, so nothing gets cut off.
function fitToContent(svg, layout, height, pixelWidth, scale) {
  let top = 0;
  let bottom = height;
  try {
    const bb = svg.getBBox();
    top = Math.min(0, Math.floor(bb.y) - 4);
    bottom = Math.max(height, Math.ceil(bb.y + bb.height) + 4);
  } catch (e) { /* not rendered yet */ }
  const h = bottom - top;
  svg.setAttribute('viewBox', `0 ${top} ${layout.width} ${h}`);
  svg.setAttribute('height', h * scale);
  svg.style.height = `${h * scale}px`;
  svg.setAttribute('width', pixelWidth);
  svg.style.width = `${pixelWidth}px`;
  layout.offsetY = top;
}

// Chord-degree numbers (1, 3, 5, 7, 9 …) in a row under each system.
function drawDegrees(group, lineMeasures, real, chords) {
  let below = lineMeasures[0].stave.getYForLine(4) + 26;
  try {
    const bb = group.getBBox();
    below = Math.max(below, Math.ceil(bb.y + bb.height) + 16);
  } catch (e) { /* ignore */ }
  const rowRight = [-Infinity, -Infinity]; // right edge of the last label in each row
  for (const ml of lineMeasures) {
    for (const it of ml.items) {
      if (it.pad || it.note.rest) continue;
      const k = real.findIndex((r) => r.sn === it.sn);
      const prev = real[k - 1];
      if (prev && prev.note.tie && !prev.note.rest && midi(prev.note) === midi(it.note)) continue; // tied: same note
      const tick = ml.m * MEASURE_TICKS + it.tick;
      let chord = null;
      for (const c of chords) if (c.tick <= tick) chord = c.chord;
      if (!chord) continue;
      const deg = chordDegree(it.note, chord);
      const t = document.createElementNS(SVG_NS, 'text');
      t.setAttribute('x', it.sn.getAbsoluteX() + it.sn.getGlyphWidth() / 2);
      t.setAttribute('y', below);
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('class', deg.chordTone ? 'degree' : 'degree tension');
      t.textContent = deg.label;
      group.appendChild(t);
      // Crowded notes: drop a label to a second row instead of overlapping.
      const x = Number(t.getAttribute('x'));
      const w = t.getComputedTextLength ? t.getComputedTextLength() : 12;
      let row = x - w / 2 < rowRight[0] + 2 ? 1 : 0;
      if (row === 1 && x - w / 2 < rowRight[1] + 2) row = 0;
      if (row === 1) t.setAttribute('y', below + 14);
      rowRight[row] = x + w / 2;
    }
  }
}

function drawTies(ctx, real) {
  for (let k = 0; k < real.length; k++) {
    const a = real[k];
    if (!a.note.tie || a.note.rest) continue;
    const b = real[k + 1];
    if (!b || b.note.rest) {
      // Tie into nothing ("let ring"), like the end of a phrase.
      new VF.StaveTie({ first_note: a.sn, first_indices: [0] }).setContext(ctx).draw();
    } else if (a.line === b.line) {
      new VF.StaveTie({ first_note: a.sn, last_note: b.sn, first_indices: [0], last_indices: [0] })
        .setContext(ctx).draw();
    } else {
      new VF.StaveTie({ first_note: a.sn, first_indices: [0] }).setContext(ctx).draw();
      new VF.StaveTie({ last_note: b.sn, last_indices: [0] }).setContext(ctx).draw();
    }
  }
}

// x position of a given tick inside a measure (interpolated between notes).
function tickX(ml, tick) {
  const items = ml.items;
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    const next = items[k + 1];
    const t1 = next ? next.tick : MEASURE_TICKS;
    if (tick >= it.tick && tick < t1) {
      const x0 = it.sn.getAbsoluteX();
      const x1 = next ? next.sn.getAbsoluteX() : ml.noteEnd;
      return x0 + ((tick - it.tick) / (t1 - it.tick)) * (x1 - x0);
    }
  }
  return ml.noteStart;
}

function drawChords(svg, phrase, layout, opts) {
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'chords');
  svg.appendChild(g);
  for (const ml of layout.measures) {
    const chords = phrase.measures[ml.m].chords || [null, null];
    for (let slot = 0; slot < 2; slot++) {
      const chord = chords[slot];
      const x = slot === 0 ? Math.min(tickX(ml, 0), ml.noteStart + 4) - 2 : tickX(ml, HALF_BAR) - 2;
      const y = ml.bandTop + CHORD_BASELINE;
      if (chord) {
        const parts = chordParts(chord);
        const t = document.createElementNS(SVG_NS, 'text');
        t.setAttribute('x', x);
        t.setAttribute('y', y);
        t.setAttribute('class', 'chord');
        const main = document.createElementNS(SVG_NS, 'tspan');
        main.textContent = parts.main;
        const sup = document.createElementNS(SVG_NS, 'tspan');
        sup.textContent = parts.sup;
        sup.setAttribute('class', 'chord-sup');
        sup.setAttribute('dy', '-10');
        t.append(main, sup);
        g.appendChild(t);
        const bb = t.getBBox();
        layout.chords.push({ m: ml.m, slot, x0: bb.x - 4, x1: bb.x + bb.width + 4, y0: bb.y - 4, y1: bb.y + bb.height + 4 });
      } else if (opts.editing) {
        const t = document.createElementNS(SVG_NS, 'text');
        t.setAttribute('x', x);
        t.setAttribute('y', y);
        t.setAttribute('class', 'chord-placeholder');
        t.textContent = '+';
        g.appendChild(t);
      }
    }
  }
}

function measureAt(layout, x, y) {
  return layout.measures.find((ml) => x >= ml.x0 && x <= ml.x1 && y >= ml.bandTop && y < ml.bandBottom);
}

function diatonicAt(ml, y) {
  const steps = Math.round((y - ml.topLine) / 5);
  return Math.max(MIN_DIATONIC, Math.min(MAX_DIATONIC, F5 - steps));
}

export function yForDiatonic(ml, d) {
  return ml.topLine + (F5 - d) * 5;
}

/** Work out what is under the pointer at svg coordinates (x, y). */
export function hitTest(layout, x, y) {
  for (const c of layout.chords) {
    if (x >= c.x0 && x <= c.x1 && y >= c.y0 && y <= c.y1) return { type: 'chord', m: c.m, slot: c.slot };
  }
  const ml = measureAt(layout, x, y);
  if (!ml) return null;
  if (y < ml.bandTop + CHORD_ZONE) {
    const mid = tickX(ml, HALF_BAR) - 6;
    return { type: 'chord', m: ml.m, slot: x < mid ? 0 : 1 };
  }
  const diatonic = diatonicAt(ml, y);
  const inMeasure = layout.notes.filter((nt) => nt.m === ml.m && !nt.pad);
  let best = null;
  for (const nt of inMeasure) {
    const d = Math.abs(nt.x - x);
    if (d < 13 && (!best || d < best.d)) best = { nt, d };
  }
  // Clicking a triplet placeholder means "put a note here".
  if (best && best.nt.note.hold) return { type: 'staff', m: ml.m, insertIndex: best.nt.i, diatonic };
  if (best) return { type: 'note', m: ml.m, i: best.nt.i, diatonic, tick: best.nt.tick };
  const insertIndex = inMeasure.filter((nt) => nt.x < x).length;
  // Over the empty part of a bar: report the beat position that was tapped.
  // The empty part of a bar is drawn as rests; work out the beat position
  // from where the tap falls between the rests' positions.
  let padTick;
  const all = layout.notes.filter((nt) => nt.m === ml.m);
  let k = -1;
  for (let j = 0; j < all.length; j++) if (all[j].x - 12 <= x) k = j;
  if (k < 0 && all.length && all[0].pad) padTick = 0;
  if (k >= 0 && all[k].pad) {
    const cur = all[k];
    const next = all[k + 1];
    const x0 = cur.x - 12;
    const x1 = next ? next.x - 12 : ml.noteEnd;
    const t1 = next ? next.tick : MEASURE_TICKS;
    const frac = Math.max(0, Math.min(1, (x - x0) / Math.max(1, x1 - x0)));
    padTick = cur.tick + frac * (t1 - cur.tick);
  }
  return { type: 'staff', m: ml.m, insertIndex, diatonic, padTick };
}

/** Staff position (diatonic step) under a y coordinate in a given bar. */
export function diatonicUnder(layout, m, y) {
  const ml = layout.measures.find((x) => x.m === m);
  return ml ? diatonicAt(ml, y) : null;
}

/** Where to draw the hover "ghost" note head. */
export function ghostAt(layout, x, y) {
  const ml = measureAt(layout, x, y);
  if (!ml || y < ml.bandTop + CHORD_ZONE) return null;
  const d = diatonicAt(ml, y);
  const gy = yForDiatonic(ml, d);
  const ledgers = [];
  const top = diatonicIndex('A', 5);
  const bottom = diatonicIndex('C', 4);
  for (let k = top; k <= d; k += 2) ledgers.push(yForDiatonic(ml, k));
  for (let k = bottom; k >= d; k -= 2) ledgers.push(yForDiatonic(ml, k));
  return { x, y: gy, diatonic: d, ledgers, m: ml.m };
}

export function noteElement(layout, m, i) {
  const info = layout.notes.find((nt) => nt.m === m && nt.i === i);
  return info ? info.sn.getSVGElement() : null;
}
