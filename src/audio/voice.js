// Spoken voices (SPEC §7) on the Web Speech API (speechSynthesis): the coach, the umpire and the
// players on court (partner and rivals) share ONE queue, so nothing ever talks over anything else.
//
// - Never overlaps: one utterance at a time. An urgent cue (priority 3) cuts anything; a call with
//   `cut: true` (the partner's "¡Mía!") cuts a lower-priority cue; otherwise cues wait their turn.
// - Priority queue (max 4 waiting); stale cues expire (each cue may set expireMs: a partner call is
//   worthless 1 s late), duplicates within a few seconds drop.
// - Rate-limited: a minimum gap between cues; low-priority coach tips at most every few seconds.
// - Each speaker has its own installed voice where the system has several (macOS: Samantha /
//   Daniel / Karen / Moira ... and Mónica / Jorge / Paulina ...), plus its own pitch and rate.
// - onSpeaking(fn): fn(true|false, speaker) when speech starts / stops (the audio engine ducks the
//   crowd and the ambience under it). setVolume(v) follows the master volume.
// - Silent no-op when speechSynthesis is unavailable.
//
// say(text, { priority, es, speaker, lang, expireMs, cut }): priority 0 low | 1 normal | 2 high |
// 3 urgent (or those names); es is the Spanish text used when the language is 'es'; lang forces a
// language for this line (a Spanish call like "¡Mía!" keeps a Spanish voice in English mode).

const PRIORITY = { low: 0, normal: 1, high: 2, urgent: 3 };

const PREFERRED = {
  en: ['Samantha', 'Daniel', 'Karen', 'Serena', 'Moira', 'Tessa', 'Ava', 'Allison', 'Susan', 'Tom', 'Alex',
    'Google UK English Female', 'Google UK English Male', 'Google US English',
    'Microsoft Aria', 'Microsoft Jenny', 'Microsoft Guy', 'Microsoft Sonia', 'Microsoft Ryan'],
  es: ['Mónica', 'Monica', 'Jorge', 'Paulina', 'Marisol', 'Juan', 'Diego', 'Francisca', 'Angélica',
    'Google español', 'Google español de Estados Unidos', 'Microsoft Elvira', 'Microsoft Alvaro', 'Microsoft Dalia'],
};

/**
 * Speakers: rank = which of the language's best voices (0 best, 1 second best, ...); pitch / rate
 * keep characters apart even on a system with a single voice per language.
 */
export const SPEAKERS = Object.freeze({
  coach: Object.freeze({ rank: 0, pitch: 1.0, rate: 1.04 }),
  umpire: Object.freeze({ rank: 1, pitch: 0.9, rate: 0.98 }),
  partner: Object.freeze({ rank: 2, pitch: 1.12, rate: 1.14 }),
  opponent: Object.freeze({ rank: 3, pitch: 0.82, rate: 1.1 }),
  opponent2: Object.freeze({ rank: 4, pitch: 1.2, rate: 1.06 }),
  crowd: Object.freeze({ rank: 2, pitch: 1.05, rate: 1.1 }),
});

// macOS novelty voices: never pick these for a coach.
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Fred|Junior|Ralph|Kathy|Grandma|Grandpa|Eddy|Flo|Reed|Rocko|Sandy|Shelley|Deranged|Hysterical|Pipe Organ)\b/i;

function scoreVoice(v, base, prefer) {
  const vl = (v.lang || '').replace('_', '-').toLowerCase();
  if (!vl.startsWith(base)) return -Infinity;
  const name = v.name || '';
  if (NOVELTY.test(name)) return -Infinity;
  let score = 0;
  const idx = prefer.findIndex((p) => name.toLowerCase().includes(p.toLowerCase()));
  if (idx >= 0) score += 40 - idx;
  if (/premium/i.test(name)) score += 30;
  else if (/enhanced/i.test(name)) score += 24;
  if (/natural|neural|online/i.test(name)) score += 18;
  if (base === 'es' && vl === 'es-es') score += 6;
  if (base === 'en' && (vl === 'en-gb' || vl === 'en-us')) score += 4;
  if (v.localService) score += 2;
  if (v.default) score += 1;
  return score;
}

/** Installed voices for a language ('en' | 'es'), best first (novelty voices dropped). */
export function rankVoices(voices, lang = 'en') {
  const base = lang.slice(0, 2).toLowerCase();
  const prefer = PREFERRED[base] || [];
  return (voices || [])
    .map((v) => ({ v, s: scoreVoice(v, base, prefer) }))
    .filter((x) => x.s > -Infinity)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.v);
}

/** Ranks installed voices for a language ('en' | 'es') and returns the best one, or null. */
export function pickVoice(voices, lang = 'en') {
  return rankVoices(voices, lang)[0] || null;
}

/** The voice for a speaker: its rank among the language's voices (wrapping), or null. */
export function voiceForSpeaker(voices, lang, speaker = 'coach') {
  const list = rankVoices(voices, lang);
  if (!list.length) return null;
  const sp = SPEAKERS[speaker] || SPEAKERS.coach;
  return list[sp.rank % list.length];
}

/** True when a line reads as Spanish (¡ ¿ ñ accents, common padel calls). */
export function looksSpanish(text) {
  return /[¡¿ñáéíóú]|\b(m[ií]a|tuya|vamos|bote|fuera|cambio|bien|venga|toma|dentro|pared|globo|punto|juego)\b/i.test(text || '');
}

const normPriority = (p) => (typeof p === 'number' ? Math.max(0, Math.min(3, p | 0)) : PRIORITY[p] ?? 1);
const DEFAULT_EXPIRE = [2500, 4000, 6000, 8000];

/**
 * @param {object} o
 * @param {'en'|'es'} [o.lang]
 * Injectables for tests: synth, Utterance, now (ms), setTimer/clearTimer.
 */
export function createVoice({
  lang = 'en',
  rate = 1.04,
  pitch = 1,
  volume = 1,
  minGapMs = 700,
  lowGapMs = 4000,
  dedupeMs = 5000,
  synth = globalThis.speechSynthesis,
  Utterance = globalThis.SpeechSynthesisUtterance,
  now = () => (globalThis.performance ? performance.now() : Date.now()),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  const available = !!(synth && Utterance);
  let enabled = true;
  let coachOn = true; // the voice coach alone (Settings → Voice coach: Off keeps the umpire and the calls)
  let curLang = lang;
  let vol = volume;
  let voice = null;
  let current = null; // { text, priority, speaker, utt, watchdog }
  let lastEnd = -Infinity;
  let lastLow = -Infinity;
  const recent = new Map(); // speaker:text -> time
  const queue = [];
  let pumpTimer = null;
  let primed = false;
  const speakingFns = new Set();
  const stats = { spoken: 0, cut: 0, expired: 0, dropped: 0 };

  function allVoices() {
    try {
      return synth.getVoices() || [];
    } catch {
      return [];
    }
  }

  function refreshVoice() {
    if (!available) return;
    voice = pickVoice(allVoices(), curLang);
  }

  if (available) {
    refreshVoice();
    try {
      if (synth.addEventListener) synth.addEventListener('voiceschanged', refreshVoice);
      else synth.onvoiceschanged = refreshVoice;
    } catch {
      /* ignore */
    }
  }

  const emitSpeaking = (on, speaker) => {
    for (const fn of speakingFns) {
      try {
        fn(on, speaker);
      } catch {
        /* a listener must not break speech */
      }
    }
  };

  function finish(item) {
    if (current !== item) return;
    clearTimer(item.watchdog);
    current = null;
    lastEnd = now();
    emitSpeaking(false, item.speaker);
    schedulePump(minGapMs);
  }

  function speakNow(item) {
    if (!primed) {
      // Safari sometimes keeps a stale, paused queue after page load.
      try {
        synth.cancel();
      } catch {
        /* ignore */
      }
      primed = true;
    }
    const utt = new Utterance(item.text);
    const sp = SPEAKERS[item.speaker] || SPEAKERS.coach;
    const itemLang = item.lang || curLang;
    const v = item.speaker === 'coach' && itemLang === curLang ? voice : voiceForSpeaker(allVoices(), itemLang, item.speaker);
    const langTag = itemLang === 'es' ? 'es-ES' : 'en-GB';
    utt.lang = v?.lang || langTag;
    if (v) utt.voice = v;
    utt.rate = item.speaker === 'coach' ? rate : sp.rate;
    utt.pitch = item.speaker === 'coach' ? pitch : sp.pitch;
    utt.volume = vol;
    item.utt = utt;
    current = item;
    utt.onend = () => finish(item);
    utt.onerror = () => finish(item);
    // Some engines never fire onend (Chrome after a tab switch): release after a generous estimate.
    const estMs = 1500 + ((item.text.length / 13) * 1000) / utt.rate;
    item.watchdog = setTimer(() => finish(item), estMs + 2500);
    if (item.priority === 0 && item.speaker === 'coach') lastLow = now();
    stats.spoken++;
    emitSpeaking(true, item.speaker);
    try {
      synth.speak(utt);
    } catch {
      finish(item);
    }
  }

  function schedulePump(ms) {
    if (pumpTimer != null) clearTimer(pumpTimer);
    pumpTimer = setTimer(() => {
      pumpTimer = null;
      pump();
    }, Math.max(0, ms));
  }

  function pump() {
    if (!enabled || current) return;
    const t = now();
    for (let i = queue.length - 1; i >= 0; i--) {
      if (t > queue[i].expires) {
        queue.splice(i, 1);
        stats.expired++;
      }
    }
    if (!queue.length) return;
    // Quick calls (short expiry: the players on court) go out without the courtesy gap.
    const wait = lastEnd + (queue[0].quick ? 120 : minGapMs) - t;
    if (wait > 0 && queue[0].priority < 3) {
      schedulePump(wait);
      return;
    }
    speakNow(queue.shift());
  }

  function enqueue(item) {
    queue.push(item);
    queue.sort((a, b) => b.priority - a.priority || a.at - b.at);
    while (queue.length > 4) {
      queue.pop();
      stats.dropped++;
    }
  }

  function cutCurrent() {
    const cur = current;
    try {
      synth.cancel();
    } catch {
      /* ignore */
    }
    stats.cut++;
    finish(cur);
  }

  return {
    get available() {
      return available;
    },
    get speaking() {
      return !!current;
    },
    /** The speaker talking now ('coach', 'umpire', 'partner', ...) or null. */
    get speaker() {
      return current ? current.speaker : null;
    },
    get voice() {
      return voice;
    },
    get queued() {
      return queue.length;
    },
    get stats() {
      return { ...stats };
    },

    /** Queues a line. Returns true if it was accepted. */
    say(text, { priority = 1, es = null, speaker = 'coach', lang = null, expireMs = null, cut = false } = {}) {
      if (!available || !enabled) return false;
      if (speaker === 'coach' && !coachOn) return false;
      const forced = lang === 'es' || lang === 'en' ? lang : null;
      const line = ((forced ? forced === 'es' : curLang === 'es') && es ? es : text || '').trim();
      if (!line) return false;
      const p = normPriority(priority);
      const t = now();
      const key = `${speaker}:${line}`;
      for (const [k, at] of recent) if (t - at > dedupeMs) recent.delete(k);
      if (recent.has(key) && p < 3 && expireMs == null) return false;
      if (p === 0 && speaker === 'coach' && (t - lastLow < lowGapMs || current || queue.length)) return false;
      if (current && current.text === line && current.speaker === speaker) return false;
      recent.set(key, t);
      const item = {
        text: line, priority: p, speaker, lang: forced, at: t, quick: expireMs != null && expireMs < 2000,
        expires: t + (expireMs ?? DEFAULT_EXPIRE[p]),
      };
      if (current && ((p === 3 && current.priority < 3) || (cut && current.priority < p))) {
        // Cut the current line first (cancel), so nothing overlaps.
        cutCurrent();
        queue.unshift(item);
        lastEnd = -Infinity;
        pump();
        return true;
      }
      enqueue(item);
      if (!current) pump();
      return true;
    },

    setEnabled(b) {
      enabled = !!b;
      if (!enabled) this.cancel();
    },

    /** The coach's own lines on / off (umpire and player calls keep speaking). */
    setCoach(b) {
      coachOn = !!b;
      if (!coachOn) for (let i = queue.length - 1; i >= 0; i--) if (queue[i].speaker === 'coach') queue.splice(i, 1);
    },

    setLang(l) {
      curLang = l === 'es' ? 'es' : 'en';
      refreshVoice();
    },

    get lang() {
      return curLang;
    },

    /** Speech volume 0..1 (follows the app's master volume). */
    setVolume(v) {
      if (Number.isFinite(v)) vol = Math.max(0, Math.min(1, v));
    },

    /** Subscribes fn(on, speaker) to speech start / stop. Returns an unsubscribe fn. */
    onSpeaking(fn) {
      speakingFns.add(fn);
      return () => speakingFns.delete(fn);
    },

    /** Optional explicit voice by name (settings UI). */
    setVoice(name) {
      if (!available) return;
      const v = allVoices().find((x) => x.name === name);
      if (v) voice = v;
    },

    /** Voices available for the current language, best first. */
    voices() {
      if (!available) return [];
      return rankVoices(allVoices(), curLang);
    },

    cancel() {
      queue.length = 0;
      if (pumpTimer != null) clearTimer(pumpTimer);
      pumpTimer = null;
      if (current) cutCurrent();
    },

    /** Convenience: speak SPEC 'coach:cue' bus events. Returns an unsubscribe fn. */
    bindBus(bus) {
      return bus.on('coach:cue', ({ text, es, priority } = {}) => this.say(text, { es, priority }));
    },
  };
}
