// Playback with Tone.js: sampled piano or guitar, swing feel, chords + melody.
import { MEASURE_TICKS, noteTicks, midi, chordVoicing } from './music.js';

function sampleUrls(names) {
  const urls = {};
  for (const n of names) urls[n.replace('s', '#')] = `${n}.mp3`;
  return urls;
}

const PIANO_NOTES = [];
for (let o = 1; o <= 7; o++) for (const p of ['C', 'Ds', 'Fs', 'A']) PIANO_NOTES.push(p + o);

const INSTRUMENTS = {
  piano: {
    baseUrl: 'https://tonejs.github.io/audio/salamander/',
    urls: sampleUrls(PIANO_NOTES),
    release: 1.2,
    melodyVel: 0.8,
    chordVel: 0.38,
    strum: 0,
  },
  guitar: {
    baseUrl: 'https://nbrosowsky.github.io/tonejs-instruments/samples/guitar-electric/',
    urls: sampleUrls(['E2', 'Fs2', 'A2', 'C3', 'Ds3', 'Fs3', 'A3', 'C4', 'Ds4', 'Fs4', 'A4', 'C5', 'Ds5', 'Fs5', 'A5', 'C6']),
    release: 0.8,
    melodyVel: 0.9,
    chordVel: 0.5,
    strum: 0.022,
  },
};

const loaded = {};

function loadInstrument(name) {
  if (!loaded[name]) {
    const def = INSTRUMENTS[name] || INSTRUMENTS.piano;
    loaded[name] = new Promise((resolve, reject) => {
      const sampler = new Tone.Sampler({
        urls: def.urls,
        baseUrl: def.baseUrl,
        release: def.release,
        onload: () => resolve(sampler),
        onerror: (e) => { delete loaded[name]; reject(e); },
      });
      const reverb = new Tone.Reverb({ decay: 1.8, wet: 0.18 }).toDestination();
      sampler.connect(reverb);
    });
  }
  return loaded[name];
}

// Convert a tick position (32 per measure, 8 per beat) to seconds, with an
// optional swing feel: off-beat eighths land 2/3 of the way through the beat.
function tickToSeconds(tick, tempo, swing) {
  const beat = Math.floor(tick / 8);
  let frac = (tick % 8) / 8;
  if (swing) frac = frac < 0.5 ? frac * (4 / 3) : 2 / 3 + (frac - 0.5) * (2 / 3);
  return (beat + frac) * (60 / tempo);
}

function noteName(m) {
  return Tone.Frequency(m, 'midi').toNote();
}

export function buildEvents(phrase) {
  const swing = phrase.swing !== false;
  const tempo = phrase.tempo || 160;
  const sec = (t) => tickToSeconds(t, tempo, swing);
  const events = [];

  // Melody (ties merge into one long note)
  const flat = [];
  phrase.measures.forEach((measure, m) => {
    let tick = m * MEASURE_TICKS;
    measure.notes.forEach((note, i) => {
      flat.push({ note, m, i, start: tick, end: tick + noteTicks(note) });
      tick += noteTicks(note);
    });
  });
  for (let k = 0; k < flat.length; k++) {
    const f = flat[k];
    if (f.note.rest) {
      events.push({ kind: 'mark', time: sec(f.start), m: f.m, i: f.i });
      continue;
    }
    const prev = flat[k - 1];
    const tiedFromPrev = prev && prev.note.tie && !prev.note.rest && midi(prev.note) === midi(f.note);
    if (tiedFromPrev) {
      events.push({ kind: 'mark', time: sec(f.start), m: f.m, i: f.i });
      continue;
    }
    let end = f.end;
    for (let j = k; j < flat.length - 1; j++) {
      const a = flat[j];
      const b = flat[j + 1];
      if (a.note.tie && !b.note.rest && midi(a.note) === midi(b.note)) end = b.end;
      else break;
    }
    // A tie at the very end of the phrase lets the note ring a little longer.
    const last = flat.length && end === flat[flat.length - 1].end && flat[flat.length - 1].note.tie;
    events.push({
      kind: 'melody', time: sec(f.start), dur: Math.max(0.05, sec(end) - sec(f.start)) + (last ? 0.6 : 0),
      notes: [noteName(midi(f.note))], m: f.m, i: f.i,
    });
  }

  // Chords: each lasts until the next chord or the end of the phrase.
  const chordList = [];
  phrase.measures.forEach((measure, m) => {
    (measure.chords || []).forEach((c, slot) => {
      if (c) chordList.push({ chord: c, tick: m * MEASURE_TICKS + slot * 16 });
    });
  });
  const total = phrase.measures.length * MEASURE_TICKS;
  chordList.forEach((c, k) => {
    const end = k + 1 < chordList.length ? chordList[k + 1].tick : total;
    events.push({
      kind: 'chord', time: sec(c.tick), dur: sec(end) - sec(c.tick),
      notes: chordVoicing(c.chord).map(noteName),
    });
  });

  return { events, total: sec(total) };
}

class Player {
  constructor() {
    this.currentId = null;
    this.state = 'stopped';
    this.hooks = null;
    this.sampler = null;
  }

  async toggle(phrase, hooks) {
    if (this.currentId === phrase.id && this.state === 'playing') return this.pause();
    if (this.currentId === phrase.id && this.state === 'paused') return this.resume();
    return this.play(phrase, hooks);
  }

  async play(phrase, hooks) {
    this.stop();
    await Tone.start();
    this.currentId = phrase.id;
    this.hooks = hooks;
    this.state = 'loading';
    hooks.onState('loading');
    let sampler;
    try {
      sampler = await loadInstrument(phrase.instrument);
    } catch (e) {
      this.state = 'stopped';
      this.currentId = null;
      hooks.onState('stopped');
      hooks.onError && hooks.onError('Could not load the instrument sounds. Check your internet connection.');
      return;
    }
    if (this.currentId !== phrase.id || this.state !== 'loading') return; // cancelled meanwhile
    this.sampler = sampler;
    const def = INSTRUMENTS[phrase.instrument] || INSTRUMENTS.piano;
    const { events, total } = buildEvents(phrase);
    const T = Tone.getTransport();
    T.cancel(0);
    T.position = 0;
    for (const ev of events) {
      T.schedule((time) => {
        if (ev.kind === 'melody') {
          sampler.triggerAttackRelease(ev.notes, ev.dur, time, def.melodyVel);
        } else if (ev.kind === 'chord') {
          ev.notes.forEach((nn, k) => sampler.triggerAttackRelease(nn, ev.dur, time + k * def.strum, def.chordVel));
        }
        if (ev.m !== undefined) Tone.getDraw().schedule(() => this.hooks && this.hooks.onNote(ev.m, ev.i), time);
      }, ev.time);
    }
    if (phrase.loop) {
      T.loop = true;
      T.loopStart = 0;
      T.loopEnd = total;
    } else {
      T.loop = false;
      T.schedule((time) => Tone.getDraw().schedule(() => this.stop(), time), total + 0.4);
    }
    this.state = 'playing';
    hooks.onState('playing');
    T.start('+0.05');
  }

  pause() {
    Tone.getTransport().pause();
    if (this.sampler) this.sampler.releaseAll();
    this.state = 'paused';
    this.hooks && this.hooks.onState('paused');
  }

  resume() {
    Tone.getTransport().start('+0.02');
    this.state = 'playing';
    this.hooks && this.hooks.onState('playing');
  }

  stop() {
    const T = Tone.getTransport();
    T.stop();
    T.cancel(0);
    T.loop = false;
    if (this.sampler) this.sampler.releaseAll();
    const hooks = this.hooks;
    this.state = 'stopped';
    this.currentId = null;
    this.hooks = null;
    if (hooks) {
      hooks.onNote(null);
      hooks.onState('stopped');
    }
  }
}

export const player = new Player();

// Short audition of a single pitch while editing (ignored if sounds aren't ready yet).
export async function previewNote(midiNumber, instrument) {
  try {
    await Tone.start();
    const sampler = await loadInstrument(instrument);
    sampler.triggerAttackRelease(noteName(midiNumber), 0.35, undefined, 0.7);
  } catch (e) {
    /* preview is best-effort */
  }
}

export function warmUp(instrument) {
  loadInstrument(instrument).catch(() => {});
}
