// Playback with Tone.js: sampled piano or guitar for melody and chords, plus an
// optional rhythm section (upright bass + drums) in swing or latin style.
import { MEASURE_TICKS, BEAT_TICKS, noteTicks, midi, chordVoicing } from './music.js';
import { buildBacking, chordList, countInEvents } from './backing.js';

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
    // Classical nylon-string guitar
    baseUrl: 'https://nbrosowsky.github.io/tonejs-instruments/samples/guitar-nylon/',
    urls: sampleUrls(['E2', 'Fs2', 'A2', 'Cs3', 'D3', 'E3', 'Fs3', 'G3', 'A3', 'Cs4', 'Ds4', 'E4', 'Fs4', 'A4', 'Cs5', 'D5', 'E5', 'Fs5', 'A5']),
    release: 1,
    melodyVel: 0.95,
    chordVel: 0.55,
    strum: 0.028,
  },
};

const BASS = {
  baseUrl: 'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/acoustic_bass-mp3/',
  urls: { E1: 'E1.mp3', G1: 'G1.mp3', 'A#1': 'Bb1.mp3', 'C#2': 'Db2.mp3', E2: 'E2.mp3', G2: 'G2.mp3', 'A#2': 'Bb2.mp3', 'C#3': 'Db3.mp3', E3: 'E3.mp3' },
};

const loaded = {};
let bassPromise = null;
let kitPromise = null;

function loadBass() {
  if (!bassPromise) {
    bassPromise = new Promise((resolve, reject) => {
      const sampler = new Tone.Sampler({
        urls: BASS.urls,
        baseUrl: BASS.baseUrl,
        release: 0.25,
        volume: 3,
        onload: () => resolve(sampler),
        onerror: (e) => { bassPromise = null; reject(e); },
      }).toDestination();
    });
  }
  return bassPromise;
}

// Drum kit: sampled kick / snare / hi-hat / shaker, synthesized ride cymbal
// and cross-stick (no free sampled ones are available).
function loadKit() {
  if (!kitPromise) {
    kitPromise = new Promise((resolve, reject) => {
      const out = new Tone.Volume(-3).toDestination();
      const ride = new Tone.MetalSynth({
        envelope: { attack: 0.001, decay: 1.1, release: 0.3 },
        harmonicity: 5.1,
        modulationIndex: 24,
        resonance: 5000,
        octaves: 1.2,
        volume: -26,
      });
      ride.chain(new Tone.Filter(2500, 'highpass'), out);
      const stick = new Tone.MembraneSynth({
        pitchDecay: 0.006,
        octaves: 2,
        envelope: { attack: 0.001, decay: 0.07, sustain: 0, release: 0.04 },
        volume: -12,
      }).connect(out);
      const samples = new Tone.Sampler({
        urls: { C1: 'acoustic-kit/kick.mp3', D1: 'acoustic-kit/snare.mp3', 'F#1': 'acoustic-kit/hihat.mp3', A1: '../berklee/shaker_1.mp3' },
        baseUrl: 'https://tonejs.github.io/audio/drum-samples/',
        release: 0.4,
        onload: () => resolve({
          play(sound, time, vel) {
            if (sound === 'ride') ride.triggerAttackRelease(320, 0.9, time, vel);
            else if (sound === 'stick') stick.triggerAttackRelease('A5', 0.05, time, vel);
            else samples.triggerAttackRelease({ kick: 'C1', snare: 'D1', hihat: 'F#1', shaker: 'A1' }[sound], 0.6, time, vel);
          },
          stop() { samples.releaseAll(); },
        }),
        onerror: (e) => { kitPromise = null; reject(e); },
      }).connect(out);
    });
  }
  return kitPromise;
}

// ---------------------------------------------------------------- iPhone audio
// iOS mutes Web Audio when the ring/silent switch is on silent. Declaring the
// page as a media player (audioSession) and playing a silent <audio> element
// moves it to the "playback" category, so sound comes out like a music app.

let silentEl = null;

function silentWavUrl() {
  const rate = 8000;
  const samples = rate / 2; // half a second
  const buf = new Uint8Array(44 + samples);
  const dv = new DataView(buf.buffer);
  const str = (o, t) => [...t].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); dv.setUint32(4, 36 + samples, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
  str(36, 'data'); dv.setUint32(40, samples, true);
  buf.fill(128, 44); // 8-bit silence
  let bin = '';
  buf.forEach((b) => { bin += String.fromCharCode(b); });
  return `data:audio/wav;base64,${btoa(bin)}`;
}

// Must be called directly inside a tap/click handler.
export function unlockAudio() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch (e) { /* not supported */ }
  try {
    if (!silentEl) {
      silentEl = document.createElement('audio');
      silentEl.setAttribute('playsinline', '');
      silentEl.setAttribute('x-webkit-airplay', 'deny');
      silentEl.loop = true;
      silentEl.preload = 'auto';
      silentEl.src = silentWavUrl();
    }
    const p = silentEl.play();
    if (p && p.catch) p.catch(() => {});
  } catch (e) { /* ignore */ }
  try {
    const ctx = Tone.getContext().rawContext;
    if (ctx.state !== 'running') ctx.resume();
  } catch (e) { /* ignore */ }
  return Tone.start();
}

function releaseAudioSession() {
  if (silentEl) silentEl.pause();
}


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

// Convert a tick position (24 per beat) to seconds, with an optional swing
// feel: the off-beat eighth lands 2/3 of the way through the beat. Only the
// eighth-note grid swings; triplets and sixteenths keep their even spacing.
function tickToSeconds(tick, tempo, swing) {
  const beat = Math.floor(tick / BEAT_TICKS);
  let frac = (tick % BEAT_TICKS) / BEAT_TICKS;
  if (swing && tick % 12 === 0 && frac === 0.5) frac = 2 / 3;
  return (beat + frac) * (60 / tempo);
}

function noteName(m) {
  return Tone.Frequency(m, 'midi').toNote();
}

export function buildEvents(phrase) {
  const latin = phrase.style === 'latin';
  const tempo = phrase.tempo || 160;
  const bass = phrase.bass !== false;
  const drums = phrase.drums !== false;
  // An optional one-bar count-in shifts everything by a bar.
  const offset = phrase.countIn ? MEASURE_TICKS : 0;
  const sec = (t) => tickToSeconds(t + offset, tempo, !latin);
  const span = (t, d) => Math.max(0.05, sec(t + d) - sec(t));
  const events = [];

  // In swing, a beat containing sixteenths is played straight (16ths are even).
  const straightBeats = new Set();
  phrase.measures.forEach((measure, m) => {
    let tick = m * MEASURE_TICKS;
    for (const note of measure.notes) {
      const end = tick + noteTicks(note);
      if (tick % 12 === 6) straightBeats.add(Math.floor(tick / BEAT_TICKS));
      if (end % 12 === 6) straightBeats.add(Math.floor(end / BEAT_TICKS));
      tick = end;
    }
  });
  const melSec = (t) => tickToSeconds(t + offset, tempo, !latin && !straightBeats.has(Math.floor(t / BEAT_TICKS)));

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
      events.push({ kind: 'mark', time: melSec(f.start), m: f.m, i: f.i });
      continue;
    }
    const prev = flat[k - 1];
    const tiedFromPrev = prev && prev.note.tie && !prev.note.rest && midi(prev.note) === midi(f.note);
    if (tiedFromPrev) {
      events.push({ kind: 'mark', time: melSec(f.start), m: f.m, i: f.i });
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
      kind: 'melody', time: melSec(f.start), dur: Math.max(0.05, melSec(end) - melSec(f.start)) + (last ? 0.6 : 0),
      notes: [noteName(midi(f.note))], m: f.m, i: f.i,
    });
  }

  const total = phrase.measures.length * MEASURE_TICKS;
  // Chords: 'held' (sustained, the original sound), 'comp' (rhythmic) or 'off'.
  const chords = phrase.chords || 'comp';
  if (bass || drums || chords === 'comp') {
    // Rhythm section: comping chords, bass line, drums.
    for (const ev of buildBacking(phrase, { bass, drums, comp: chords === 'comp' })) {
      if (ev.kind === 'drum') events.push({ kind: 'drum', time: sec(ev.tick), sound: ev.sound, vel: ev.vel });
      else if (ev.kind === 'bass') events.push({ kind: 'bass', time: sec(ev.tick), dur: span(ev.tick, ev.dur), notes: [noteName(ev.midi)], vel: ev.vel });
      else events.push({ kind: 'chord', time: sec(ev.tick), dur: span(ev.tick, ev.dur), notes: ev.notes.map(noteName), vel: ev.vel });
    }
  }
  if (chords === 'held') {
    // Held chords: each lasts until the next chord or the end of the phrase.
    const list = chordList(phrase);
    list.forEach((c, k) => {
      const end = k + 1 < list.length ? list[k + 1].tick : total;
      events.push({ kind: 'chord', time: sec(c.tick), dur: sec(end) - sec(c.tick), notes: chordVoicing(c.chord).map(noteName), vel: 1 });
    });
  }
  if (phrase.countIn) {
    for (const ev of countInEvents(phrase)) events.push({ kind: 'drum', time: tickToSeconds(ev.tick, tempo, false), sound: ev.sound, vel: ev.vel });
  }

  return { events, total: sec(total), start: sec(0), needsBass: bass, needsKit: drums || !!phrase.countIn };
}

class Player {
  constructor() {
    this.currentId = null;
    this.state = 'stopped';
    this.hooks = null;
    this.sampler = null;
  }

  async toggle(phrase, hooks) {
    unlockAudio();
    if (this.currentId === phrase.id && this.state === 'playing') return this.pause();
    if (this.currentId === phrase.id && this.state === 'paused') return this.resume();
    return this.play(phrase, hooks);
  }

  async play(phrase, hooks) {
    this.stop();
    await unlockAudio();
    this.currentId = phrase.id;
    this.hooks = hooks;
    this.state = 'loading';
    hooks.onState('loading');
    const built = buildEvents(phrase);
    let sampler;
    let bass = null;
    let kit = null;
    try {
      [sampler, bass, kit] = await Promise.all([
        loadInstrument(phrase.instrument),
        built.needsBass ? loadBass().catch(() => null) : null,
        built.needsKit ? loadKit().catch(() => null) : null,
      ]);
    } catch (e) {
      this.state = 'stopped';
      this.currentId = null;
      hooks.onState('stopped');
      hooks.onError && hooks.onError('Could not load the instrument sounds. Check your internet connection.');
      return;
    }
    if (this.currentId !== phrase.id || this.state !== 'loading') return; // cancelled meanwhile
    this.sampler = sampler;
    this.bass = bass;
    this.kit = kit;
    const def = INSTRUMENTS[phrase.instrument] || INSTRUMENTS.piano;
    const { events, total, start } = built;
    const T = Tone.getTransport();
    T.cancel(0);
    T.position = 0;
    for (const ev of events) {
      T.schedule((time) => {
        if (ev.kind === 'melody') {
          sampler.triggerAttackRelease(ev.notes, ev.dur, time, def.melodyVel);
        } else if (ev.kind === 'chord') {
          ev.notes.forEach((nn, k) => sampler.triggerAttackRelease(nn, ev.dur, time + k * def.strum, def.chordVel * ev.vel));
        } else if (ev.kind === 'bass') {
          if (bass) bass.triggerAttackRelease(ev.notes, ev.dur, time, ev.vel);
        } else if (ev.kind === 'drum') {
          if (kit) kit.play(ev.sound, time, ev.vel);
        }
        if (ev.m !== undefined) Tone.getDraw().schedule(() => this.hooks && this.hooks.onNote(ev.m, ev.i), time);
      }, ev.time);
    }
    if (phrase.loop) {
      T.loop = true;
      T.loopStart = start; // the count-in plays only once
      T.loopEnd = total;
    } else {
      T.loop = false;
      T.schedule((time) => Tone.getDraw().schedule(() => this.stop(), time), total + 0.4);
    }
    this.state = 'playing';
    hooks.onState('playing');
    T.start('+0.05');
  }

  releaseAll() {
    if (this.sampler) this.sampler.releaseAll();
    if (this.bass) this.bass.releaseAll();
    if (this.kit) this.kit.stop();
  }

  pause() {
    Tone.getTransport().pause();
    this.releaseAll();
    releaseAudioSession();
    this.state = 'paused';
    this.hooks && this.hooks.onState('paused');
  }

  resume() {
    unlockAudio();
    Tone.getTransport().start('+0.02');
    this.state = 'playing';
    this.hooks && this.hooks.onState('playing');
  }

  stop() {
    const T = Tone.getTransport();
    T.stop();
    T.cancel(0);
    T.loop = false;
    this.releaseAll();
    releaseAudioSession();
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
let previewTimer = null;
export async function previewNote(midiNumber, instrument) {
  try {
    await unlockAudio();
    const sampler = await loadInstrument(instrument);
    sampler.triggerAttackRelease(noteName(midiNumber), 0.35, undefined, 0.7);
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => { if (player.state !== 'playing') releaseAudioSession(); }, 1500);
  } catch (e) {
    /* preview is best-effort */
  }
}

export function warmUp(instrument) {
  loadInstrument(instrument).catch(() => {});
}
