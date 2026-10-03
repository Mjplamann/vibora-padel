// Spoken coach (SPEC §7) on the Web Speech API (speechSynthesis).
//
// - Never overlaps: one utterance at a time; an urgent cue may cut a lower-priority one.
// - Priority queue (max 3 waiting); stale cues expire, duplicates within a few seconds drop.
// - Rate-limited: a minimum gap between cues, and low-priority tips at most every few seconds.
// - Picks the most natural installed voice for the language (macOS: Samantha / Daniel /
//   Mónica, "Enhanced"/"Premium" variants first; Chrome: Google voices; Edge: "Natural").
// - Silent no-op when speechSynthesis is unavailable.
//
// say(text, { priority, es }): priority 0 low | 1 normal | 2 high | 3 urgent (or those names);
// es is the Spanish text used when the language is 'es'.

const PRIORITY = { low: 0, normal: 1, high: 2, urgent: 3 };

const PREFERRED = {
  en: ['Samantha', 'Daniel', 'Karen', 'Serena', 'Moira', 'Tessa', 'Ava', 'Allison', 'Susan', 'Tom', 'Alex',
    'Google UK English Female', 'Google UK English Male', 'Google US English',
    'Microsoft Aria', 'Microsoft Jenny', 'Microsoft Guy', 'Microsoft Sonia', 'Microsoft Ryan'],
  es: ['Mónica', 'Monica', 'Jorge', 'Paulina', 'Marisol', 'Juan', 'Diego', 'Francisca', 'Angélica',
    'Google español', 'Google español de Estados Unidos', 'Microsoft Elvira', 'Microsoft Alvaro', 'Microsoft Dalia'],
};

// macOS novelty voices: never pick these for a coach.
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Fred|Junior|Ralph|Kathy|Grandma|Grandpa|Eddy|Flo|Reed|Rocko|Sandy|Shelley|Deranged|Hysterical|Pipe Organ)\b/i;

/** Ranks installed voices for a language ('en' | 'es') and returns the best one, or null. */
export function pickVoice(voices, lang = 'en') {
  const base = lang.slice(0, 2).toLowerCase();
  const prefer = PREFERRED[base] || [];
  let best = null, bestScore = -Infinity;
  for (const v of voices || []) {
    const vl = (v.lang || '').replace('_', '-').toLowerCase();
    if (!vl.startsWith(base)) continue;
    const name = v.name || '';
    if (NOVELTY.test(name)) continue;
    let score = 0;
    const idx = prefer.findIndex((p) => name.toLowerCase().includes(p.toLowerCase()));
    if (idx >= 0) score += 40 - idx;
    if (/premium/i.test(name)) score += 30;
    else if (/enhanced/i.test(name)) score += 24;
    if (/natural|neural|online/i.test(name)) score += 18;
    // regional preference: es-ES Castilian for padel, en-GB/en-US for English
    if (base === 'es' && vl === 'es-es') score += 6;
    if (base === 'en' && (vl === 'en-gb' || vl === 'en-us')) score += 4;
    if (v.localService) score += 2;
    if (v.default) score += 1;
    if (score > bestScore) {
      best = v;
      bestScore = score;
    }
  }
  return best;
}

const normPriority = (p) => (typeof p === 'number' ? Math.max(0, Math.min(3, p | 0)) : PRIORITY[p] ?? 1);

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
  let curLang = lang;
  let voice = null;
  let current = null; // { text, priority, utt, watchdog }
  let lastEnd = -Infinity;
  let lastLow = -Infinity;
  const recent = new Map(); // text -> time
  const queue = [];
  let pumpTimer = null;
  let primed = false;

  function refreshVoice() {
    if (!available) return;
    try {
      voice = pickVoice(synth.getVoices(), curLang);
    } catch {
      voice = null;
    }
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

  function finish(item) {
    if (current !== item) return;
    clearTimer(item.watchdog);
    current = null;
    lastEnd = now();
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
    const langTag = curLang === 'es' ? 'es-ES' : 'en-GB';
    utt.lang = voice?.lang || langTag;
    if (voice) utt.voice = voice;
    utt.rate = rate;
    utt.pitch = pitch;
    utt.volume = volume;
    item.utt = utt;
    current = item;
    utt.onend = () => finish(item);
    utt.onerror = () => finish(item);
    // Some engines never fire onend (Chrome after a tab switch): release after a generous estimate.
    const estMs = 1500 + (item.text.length / 13) * 1000 / rate;
    item.watchdog = setTimer(() => finish(item), estMs + 2500);
    if (item.priority === 0) lastLow = now();
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
    // drop expired cues
    for (let i = queue.length - 1; i >= 0; i--) if (t > queue[i].expires) queue.splice(i, 1);
    if (!queue.length) return;
    const wait = lastEnd + minGapMs - t;
    if (wait > 0 && queue[0].priority < 3) {
      schedulePump(wait);
      return;
    }
    speakNow(queue.shift());
  }

  function enqueue(item) {
    queue.push(item);
    queue.sort((a, b) => b.priority - a.priority || a.at - b.at);
    while (queue.length > 3) queue.pop();
  }

  return {
    get available() {
      return available;
    },
    get speaking() {
      return !!current;
    },
    get voice() {
      return voice;
    },

    /** Queues a coaching cue. Returns true if it was accepted. */
    say(text, { priority = 1, es = null } = {}) {
      if (!available || !enabled) return false;
      const line = (curLang === 'es' && es ? es : text || '').trim();
      if (!line) return false;
      const p = normPriority(priority);
      const t = now();
      for (const [k, at] of recent) if (t - at > dedupeMs) recent.delete(k);
      if (recent.has(line) && p < 3) return false;
      if (p === 0 && (t - lastLow < lowGapMs || current || queue.length)) return false;
      if (current && current.text === line) return false;
      recent.set(line, t);
      const item = { text: line, priority: p, at: t, expires: t + [2500, 4000, 6000, 8000][p] };
      if (current && p === 3 && current.priority < 3) {
        // urgent: cut the current cue (cancel first, so nothing overlaps)
        const cur = current;
        try {
          synth.cancel();
        } catch {
          /* ignore */
        }
        finish(cur);
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

    setLang(l) {
      curLang = l === 'es' ? 'es' : 'en';
      refreshVoice();
    },

    /** Optional explicit voice by name (settings UI). */
    setVoice(name) {
      if (!available) return;
      const v = synth.getVoices().find((x) => x.name === name);
      if (v) voice = v;
    },

    /** Voices available for the current language, best first. */
    voices() {
      if (!available) return [];
      const base = curLang;
      return synth.getVoices().filter((v) => (v.lang || '').toLowerCase().startsWith(base) && !NOVELTY.test(v.name));
    },

    cancel() {
      queue.length = 0;
      if (pumpTimer != null) clearTimer(pumpTimer);
      pumpTimer = null;
      if (current) {
        const cur = current;
        try {
          synth.cancel();
        } catch {
          /* ignore */
        }
        finish(cur);
      }
    },

    /** Convenience: speak SPEC 'coach:cue' bus events. Returns an unsubscribe fn. */
    bindBus(bus) {
      return bus.on('coach:cue', ({ text, es, priority } = {}) => this.say(text, { es, priority }));
    },
  };
}
