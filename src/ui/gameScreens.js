// Game screens of the 10-foot UI (round 4): the hub with its mode tiles, the Circuito Víbora career
// map, the event intro with the opponents' cards, trophies & unlocks, the arcade challenge select with
// leaderboards, free-play setup (venue, level, length), and the rewards / fitness blocks of the results
// screen. HTML builders over data prepared by main.js; ui.js mounts them (createGameScreens(kit)).
// Every control is a <button> so the hand cursor (dwell), keyboard and mouse all work.

const VENUE_ART = {
  club: `<svg viewBox="0 0 320 180" class="venue-art" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs><linearGradient id="vaClub" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b1424"/><stop offset="1" stop-color="#04070c"/></linearGradient></defs>
    <rect width="320" height="180" fill="url(#vaClub)"/>
    <g fill="#e9f4ff" opacity=".85"><rect x="30" y="14" width="56" height="5"/><rect x="132" y="14" width="56" height="5"/><rect x="234" y="14" width="56" height="5"/></g>
    <g fill="#e9f4ff" opacity=".18"><path d="M30 19 L86 19 L120 110 L-4 110Z"/><path d="M132 19 L188 19 L222 110 L98 110Z"/><path d="M234 19 L290 19 L324 110 L200 110Z"/></g>
    <path d="M40 176 L112 70 L208 70 L280 176Z" fill="#2a5aa6"/><path d="M160 70 V176 M86 108 H234 M60 146 H260" stroke="#f4efe4" stroke-width="2" opacity=".85"/>
    <path d="M70 120 L250 120" stroke="#f4efe4" stroke-width="3"/><path d="M40 176 L112 70 M280 176 L208 70" stroke="#8be4ee" stroke-width="2" opacity=".6"/>
  </svg>`,
  sunset: `<svg viewBox="0 0 320 180" class="venue-art" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs><linearGradient id="vaSun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b1b4a"/><stop offset=".45" stop-color="#d9566b"/><stop offset=".75" stop-color="#ffb35c"/><stop offset="1" stop-color="#ffd27a"/></linearGradient></defs>
    <rect width="320" height="180" fill="url(#vaSun)"/>
    <circle cx="232" cy="96" r="26" fill="#ffe7a8" opacity=".95"/>
    <g fill="#1a1222"><path d="M40 120 q4 -40 2 -70 q2 30 6 70z"/><path d="M42 52 q-24 -6 -34 8 q16 -10 34 -6z M42 52 q22 -10 36 4 q-16 -8 -36 -2z M42 52 q-10 -18 -28 -18 q18 4 28 18z M42 52 q14 -16 30 -14 q-18 2 -30 14z"/>
    <path d="M288 124 q3 -34 1 -58 q2 26 5 58z"/><path d="M289 66 q-20 -6 -30 6 q14 -8 30 -4z M289 66 q20 -8 32 4 q-14 -6 -32 -2z M289 66 q-8 -16 -24 -16 q16 4 24 16z"/></g>
    <path d="M40 176 L112 104 L208 104 L280 176Z" fill="#2a5aa6"/><path d="M160 104 V176 M78 140 H242" stroke="#f4efe4" stroke-width="2" opacity=".85"/><path d="M66 128 H254" stroke="#f4efe4" stroke-width="3"/>
  </svg>`,
  stadium: `<svg viewBox="0 0 320 180" class="venue-art" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs><linearGradient id="vaSt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#050a16"/><stop offset="1" stop-color="#0d1a33"/></linearGradient>
    <pattern id="vaCrowd" width="8" height="7" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.6" fill="#c9302c"/><circle cx="6" cy="5" r="1.6" fill="#f4efe4"/><circle cx="6" cy="2" r="1.4" fill="#2a5aa6"/><circle cx="2" cy="5.5" r="1.4" fill="#ffd23f"/></pattern></defs>
    <rect width="320" height="180" fill="url(#vaSt)"/>
    <path d="M0 40 L320 40 L320 104 L0 104Z" fill="#141f36"/><path d="M0 44 L320 44 L320 100 L0 100Z" fill="url(#vaCrowd)" opacity=".75"/>
    <g fill="#fffbe8"><rect x="22" y="10" width="22" height="8"/><rect x="276" y="10" width="22" height="8"/></g><g stroke="#3a4660" stroke-width="2"><path d="M33 18 V40 M287 18 V40"/></g>
    <g fill="#fffbe8" opacity=".12"><path d="M22 18 L44 18 L120 120 L0 120Z"/><path d="M276 18 L298 18 L320 120 L200 120Z"/></g>
    <path d="M40 176 L112 104 L208 104 L280 176Z" fill="#2a5aa6"/><path d="M160 104 V176 M78 140 H242" stroke="#f4efe4" stroke-width="2" opacity=".85"/><path d="M66 128 H254" stroke="#f4efe4" stroke-width="3"/>
    <rect x="100" y="104" width="120" height="6" fill="#dcf53c" opacity=".85"/>
  </svg>`,
};

const GLYPH = {
  balance: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/></svg>',
  lob: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20 Q12 -6 21 20"/><circle cx="21" cy="20" r="1.6" class="fill"/></svg>',
  power: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 L5 14 h6 l-2 8 l8 -12 h-6z"/></svg>',
  wall: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 3 V21"/><path d="M3 15 L17 9 L8 5"/><circle cx="8" cy="5" r="1.6" class="fill"/></svg>',
  net: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9 H21 M3 13 H21 M3 17 H21 M7 9 V20 M12 9 V20 M17 9 V20"/><path d="M3 9 V20 M21 9 V20"/></svg>',
  touch: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 18 Q8 6 13 14 L15 18"/><path d="M12 20 H20"/><circle cx="15.5" cy="18" r="1.6" class="fill"/></svg>',
  trophy: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3 H17 V9 a5 5 0 0 1 -10 0z"/><path d="M7 5 H3 a4 4 0 0 0 4 5 M17 5 H21 a4 4 0 0 1 -4 5"/><path d="M12 14 V18 M8 21 H16 M9 18 H15"/></svg>',
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="1.5"/><path d="M8 11 V7 a4 4 0 0 1 8 0 V11"/></svg>',
  check: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.5l4 4 8-9"/></svg>',
  flame: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22 c-5 0 -7 -4 -7 -7 c0 -4 4 -6 4 -11 c3 2 5 5 5 8 c1 -1 2 -2 2 -4 c2 2 3 4 3 7 c0 4 -3 7 -7 7z"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4 L20 12 L7 20Z" class="fill"/></svg>',
  target: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.6" class="fill"/></svg>',
  smash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4 L14 14"/><path d="M14 14 L20 10 L22 22 L10 20Z"/></svg>',
  rally: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 16 Q7 6 12 12 T21 8"/><circle cx="21" cy="8" r="1.6" class="fill"/><circle cx="3" cy="16" r="1.6" class="fill"/></svg>',
  volley: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12 H21"/><path d="M8 7 L3 12 L8 17 M16 7 L21 12 L16 17"/></svg>',
  glass: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="16" height="18"/><path d="M12 12 L7 6 M12 12 L18 8 M12 12 L15 19 M12 12 L6 16"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="1.5"/><path d="M3 10 H21 M8 3 V7 M16 3 V7"/></svg>',
  ball: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M5 9 q7 3 14 0 M5 15 q7 -3 14 0"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6l2.75 6.1 6.65.7-5 4.47 1.42 6.53L12 17.1l-5.82 3.3 1.42-6.53-5-4.47 6.65-.7z"/></svg>',
  fitness: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12 H6 L9 5 L14 19 L17 12 H22"/></svg>',
  shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 L20 6 V12 c0 5 -4 8 -8 9 c-4 -1 -8 -4 -8 -9 V6z"/></svg>',
  gold: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M9 12 h6 M12 9 v6"/></svg>',
  timing: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 13 L12 8 M9 2 H15"/></svg>',
  spin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12 a8 8 0 1 1 -3 -6.2"/><path d="M17 2 V6 H21"/></svg>',
  book: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4 H10 a2 2 0 0 1 2 2 V20 a2 2 0 0 0 -2 -2 H4z M20 4 H14 a2 2 0 0 0 -2 2 V20 a2 2 0 0 1 2 -2 H20z"/></svg>',
  arcade: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="18" height="11" rx="3"/><path d="M8 10 V15 M5.5 12.5 H10.5"/><circle cx="15.5" cy="11.5" r="1.3" class="fill"/><circle cx="18" cy="14" r="1.3" class="fill"/></svg>',
  crown: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 18 L5 7 L10 12 L12 5 L14 12 L19 7 L21 18Z"/><path d="M3 21 H21"/></svg>',
};

const PLACE = { 1: ['gold', 'Champion', 'Campeón'], 2: ['silver', 'Finalist', 'Finalista'], 3: ['bronze', 'Semifinal', 'Semifinal'], 4: ['plain', 'Played', 'Jugado'] };

export function createGameScreens(kit) {
  const { esc, ICON, starsHtml, segHtml, fmtInt, courtDiagram } = kit;
  const g = (name) => GLYPH[name] || GLYPH.balance;
  const flagless = (c) => (c ? `<span class="pc-country">${esc(c)}</span>` : '');

  // ---- shared bits ------------------------------------------------------------------
  function xpBarHtml(p, { compact = false } = {}) {
    if (!p) return '';
    const pct = Math.round(Math.max(0, Math.min(1, p.progress || 0)) * 100);
    return `<div class="xp${compact ? ' xp-compact' : ''}">
      <span class="xp-lvl"><b>${esc(p.level)}</b><small>LV</small></span>
      <span class="xp-body"><span class="xp-title">${esc(p.title ? p.title.en : '')}<small>${esc(p.title ? p.title.es : '')}</small></span>
      <span class="xp-bar" role="progressbar" aria-label="Level progress" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></span>
      <span class="xp-num">${fmtInt(p.into)} / ${fmtInt(p.need)} XP</span></span>
    </div>`;
  }

  function personalityBadge(info) {
    if (!info) return '';
    return `<span class="pers"><i class="pers-ico">${g(info.icon)}</i><span>${esc(info.name)}<small>${esc(info.es)}</small></span></span>`;
  }

  function playerCardHtml(p, { side = 'opp', you = false } = {}) {
    if (you) {
      return `<div class="pcard pcard-you"><span class="pc-num">A</span><span class="pc-name">You<small>Tú</small></span><span class="pc-meta">Your racket · ${esc(p && p.racket ? p.racket : '')}</span></div>`;
    }
    if (!p) return '';
    const kit = p.kit || {};
    return `<div class="pcard pcard-${side}" style="--kit:${esc(kit.shirt || '#2a5aa6')};--kit2:${esc(kit.shorts || '#10131a')}">
      <span class="pc-swatch" aria-hidden="true"><i></i><i></i></span>
      <span class="pc-name">${esc(p.name)}${flagless(p.country)}</span>
      <span class="pc-meta">${p.handed === 'left' ? 'Left-handed · zurdo' : 'Right-handed · diestro'}</span>
      ${personalityBadge(p.personalityInfo)}
      <p class="pc-desc">${esc(p.personalityInfo ? p.personalityInfo.desc : '')}</p>
    </div>`;
  }

  // ---- Hub ---------------------------------------------------------------------------
  function hubHtml(data, s, levelLabel) {
    const p = data.profile || null;
    const car = data.career || null;
    const cur = car && car.current ? car.current : null;
    const daily = data.daily || null;
    const st = data.stars || { earned: 0, total: 39 };
    const life = p && p.lifetime ? p.lifetime : null;
    const careerDots = car ? Array.from({ length: car.total || 8 }, (_, i) => `<i class="${i < car.won ? 'won' : cur && i === cur.tier - 1 ? 'cur' : ''}"></i>`).join('') : '';
    return `
      <header class="hub-head">
        <div class="wordmark wordmark-sm" aria-label="Víbora Padel">VÍBORA<span class="wm-sub">PADEL</span></div>
        ${xpBarHtml(p, { compact: true })}
        ${p && p.streak ? `<span class="hub-streak" title="Days in a row">${g('flame')}<b>${esc(p.streak)}</b><small>day${p.streak === 1 ? '' : 's'} · días</small></span>` : ''}
        <nav class="hub-nav" aria-label="Menu">
          <button type="button" class="btn btn-ghost" data-action="trophies" data-focus-key="trophies">Trophies${p && p.newUnlocks ? `<span class="nb">${esc(p.newUnlocks)}</span>` : ''}<span class="es">Trofeos</span></button>
          <button type="button" class="btn btn-ghost" data-action="settings" data-focus-key="settings">Settings<span class="es">Ajustes</span></button>
          <button type="button" class="btn btn-ghost" data-action="recalibrate" data-focus-key="recal">Recalibrate<span class="es">Calibrar</span></button>
          <button type="button" class="btn btn-ghost" data-action="help" data-focus-key="help">Help<span class="es">Ayuda</span></button>
        </nav>
      </header>
      <div class="hub-grid">
        <button type="button" class="mode-tile mt-career" data-action="career" data-focus-key="career" data-autofocus>
          <span class="mt-art">${VENUE_ART[cur ? cur.venue : 'club']}</span>
          <span class="mt-shade"></span>
          <span class="mt-eyebrow">Career · Carrera</span>
          <span class="mt-title">Circuito Víbora</span>
          ${cur ? `<span class="mt-next"><small>${cur.status === 'won' ? 'Champion · revisit' : cur.status === 'in-progress' ? 'Continue · continuar' : 'Next event · siguiente'}</small><b>${esc(cur.name)}</b><span>${esc(cur.roundLabel || '')}</span></span>` : ''}
          <span class="mt-ladder" aria-label="${car ? `${car.won} of ${car.total} events won` : ''}">${careerDots}</span>
          <span class="mt-go">${g('play')}<span>${cur && cur.status === 'in-progress' ? 'Continue' : 'Play'}</span></span>
        </button>
        <button type="button" class="mode-tile mt-arcade" data-action="arcade" data-focus-key="arcade">
          <span class="mt-rings" aria-hidden="true"><i></i><i></i><i></i></span>
          <span class="mt-eyebrow">Arcade · 60–90 s</span>
          <span class="mt-title">Arcade</span>
          ${daily ? `<span class="mt-daily"><small>${g('calendar')} Today's challenge · reto del día</small><b>${esc(daily.baseName)}</b><span>${esc(daily.twist.en)}${daily.best != null ? ` · best ${fmtInt(daily.best)}` : ''}</span></span>` : ''}
          <span class="mt-desc">Por Tres Party · Glass Breaker · Rally Marathon · Volley Wall</span>
        </button>
        <button type="button" class="mode-tile mt-training" data-action="training" data-focus-key="training">
          <canvas class="mt-court" data-mt-court aria-hidden="true"></canvas>
          <span class="mt-eyebrow">Training · Entrenamiento</span>
          <span class="mt-title">Drills</span>
          <span class="mt-desc">13 drills with the ball machine</span>
          <span class="mt-stars">${starsHtml(Math.min(3, Math.round((st.earned / Math.max(1, st.total)) * 3)))}<b>${esc(st.earned)}</b><small>/ ${esc(st.total)} stars</small></span>
        </button>
        <button type="button" class="mode-tile mt-rally" data-action="freeplay" data-mode="rally" data-focus-key="rally">
          <svg class="mt-motif" viewBox="0 0 200 100" aria-hidden="true"><rect x="2" y="2" width="196" height="96"/><path d="M100 0v100" class="net"/><path d="M30.5 2v96M169.5 2v96M30.5 50h139"/><path d="M40 70 Q100 -10 160 40" class="traj"/><circle cx="160" cy="40" r="4" class="ball"/></svg>
          <span class="mt-eyebrow">Live ball · Peloteo</span>
          <span class="mt-title">Rally</span>
          <span class="mt-desc">Open rally against the coach</span>
        </button>
        <button type="button" class="mode-tile mt-match" data-action="freeplay" data-mode="match" data-focus-key="match">
          <span class="mt-score" aria-hidden="true"><b>40</b><i>·</i><b>40</b></span>
          <span class="mt-eyebrow">2 vs 2 · Partido</span>
          <span class="mt-title">Match</span>
          <span class="mt-desc">AI partner, golden point, real serves</span>
        </button>
      </div>
      <footer class="hub-foot">
        <span class="hf-item">${g('fitness')}<b>${life ? fmtInt(Math.round((life.activeSeconds || 0) / 60)) : '0'}</b> active min · minutos</span>
        <span class="hf-item"><b>${life ? fmtInt(life.kcal || 0) : '0'}</b> kcal</span>
        <span class="hf-item"><b>${life ? fmtInt(life.swings || 0) : '0'}</b> swings · golpes</span>
        <span class="hf-item">${g('trophy')}<b>${p ? esc(p.trophies) : 0}</b> trophies</span>
        <span class="hf-item">${g('star')}<b>${p ? esc(p.achievements) : 0}</b> / ${p ? esc(p.achievementsTotal) : 0} achievements</span>
        <span class="hf-sp"></span>
        <span class="hf-item hf-profile">${esc(s.handed === 'left' ? 'Left-handed' : 'Right-handed')} · ${esc(s.height.toFixed(2))} m · Assist ${esc(levelLabel)}${data.player ? ` · ${esc(data.player)}` : ''}</span>
      </footer>`;
  }

  function mountHub(el) {
    const cv = el.querySelector('[data-mt-court]');
    if (cv) courtDiagram(cv, { view: 'full', compact: true, targets: [{ id: 'a', label: '', x0: -5, x1: 0, z0: -9.5, z1: -6.95, points: 100, kind: 'land' }], home: { x: 2.3, z: 7.8 } });
  }

  // ---- Training (the drill grid) -------------------------------------------------------
  // Rendered by ui.js (renderTraining) with its drill cards; nothing here.

  // ---- Career ---------------------------------------------------------------------------
  function careerHtml(data) {
    const events = data.events || [];
    const partners = data.partners || [];
    const tierName = (t) => (t <= 2 ? 'Club' : t <= 5 ? 'Regional' : t <= 7 ? 'National' : 'Pro Tour');
    const card = (e, i) => {
      const place = e.best ? PLACE[e.best] : null;
      const locked = e.status === 'locked';
      const statusTxt = {
        won: ['Champion', 'Campeón'], 'in-progress': ['In progress', 'En juego'], retry: ['Try again', 'Reintentar'], open: ['Open', 'Abierto'], locked: ['Locked', 'Bloqueado'],
      }[e.status] || ['', ''];
      return `<button type="button" class="ev-card ev-${esc(e.status)}${place ? ` ev-${place[0]}` : ''}" data-action="event" data-event="${esc(e.id)}" data-focus-key="ev-${esc(e.id)}"${locked ? ' aria-disabled="true"' : ''}${e.status === 'in-progress' || (!data.anyInProgress && data.currentId === e.id) ? ' data-autofocus' : ''}>
        <span class="ev-art">${VENUE_ART[e.venue] || ''}</span>
        <span class="ev-shade"></span>
        <span class="ev-tier"><b>${i + 1}</b>${esc(tierName(e.tier))}</span>
        <span class="ev-name">${esc(e.name)}<small>${esc(e.es)}</small></span>
        <span class="ev-meta">${esc(e.venueName || e.venue)} · ${e.matches.length} ${e.matches.length === 1 ? 'match' : 'matches'} · first to ${esc(e.games)}</span>
        <span class="ev-meta ev-level">Rivals ${esc(e.oppLabel || levelName(e.level))}${e.recLevel ? ` · for level ${esc(e.recLevel)}+` : ''}${e.openedByAttempts ? ' · opened after 3 tries' : ''}</span>
        <span class="ev-status">${locked ? `<i class="ev-lock">${g('lock')}</i>` : place ? `<i class="trophy-ico t-${place[0]}">${g('trophy')}</i>` : ''}<span>${esc(statusTxt[0])}${e.status === 'in-progress' && e.roundLabel ? ` · ${esc(e.roundLabel)}` : ''}<small>${esc(statusTxt[1])}</small></span></span>
      </button>`;
    };
    return `
      <header class="screen-head">
        <button type="button" class="btn btn-ghost btn-back" data-action="hub" aria-label="Back" data-focus-key="back">${ICON.back}<span>Back</span></button>
        <div><p class="eyebrow">Career · Carrera</p><h2 class="h-display">Circuito Víbora<span class="es">Del club al circuito profesional</span></h2></div>
        <div class="head-actions">${xpBarHtml(data.profile, { compact: true })}<button type="button" class="btn" data-action="trophies" data-focus-key="trophies">Trophies<span class="es">Trofeos</span></button></div>
      </header>
      <div class="career-path">
        <svg class="cp-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="M12 25 H88 V75 H12" /></svg>
        <div class="cp-grid">${events.map(card).join('')}</div>
      </div>
      <section class="partner-pick" aria-label="Choose your partner">
        <div class="pp-head"><p class="eyebrow">Your partner · Tu pareja</p><p class="muted">Plays the left side beside you, calls the ball and covers the middle.</p></div>
        <div class="pp-list" role="radiogroup">${partners.map((pc) => `<button type="button" role="radio" class="pp-card" aria-checked="${pc.id === data.partner}" data-action="partner" data-partner="${esc(pc.id)}" data-focus-key="pp-${esc(pc.id)}" style="--kit:${esc(pc.kit ? pc.kit.shirt : '#2a5aa6')}">
          <span class="pp-name">${esc(pc.name)}${flagless(pc.country)}</span>${personalityBadge(pc.personalityInfo)}<span class="pp-desc">${esc(pc.personalityInfo.desc)}</span>
        </button>`).join('')}</div>
      </section>`;
  }

  // ---- Event intro -------------------------------------------------------------------------
  function eventIntroHtml(data) {
    const e = data.event || {};
    const sp = data.spec || {};
    const opp = data.opponents || [];
    const rounds = (e.matches || []).map((m, i) => `<li class="${i < (data.matchIndex || 0) ? 'done' : i === (data.matchIndex || 0) ? 'cur' : ''}"><b>${esc(m.round)}</b><small>${esc(m.es)}</small></li>`).join('');
    return `
      <header class="screen-head">
        <button type="button" class="btn btn-ghost btn-back" data-action="career" aria-label="Back" data-focus-key="back">${ICON.back}<span>Career</span></button>
        <div><p class="eyebrow">${esc(e.name ? `Event ${e.tier} of 8 · ${e.venueName || ''}` : '')}</p><h2 class="h-display">${esc(e.name || '')}<span class="es">${esc(e.es || '')}</span></h2></div>
        <ol class="ei-rounds">${rounds}</ol>
      </header>
      <div class="ei-grid">
        <div class="ei-team ei-us">
          <p class="eyebrow">Your team · Tu equipo</p>
          ${playerCardHtml({ racket: data.racketName || '' }, { you: true })}
          ${playerCardHtml(data.partner, { side: 'us' })}
        </div>
        <div class="ei-vs">
          <span class="ei-venue">${VENUE_ART[e.venue] || ''}</span>
          <b class="ei-vs-word">VS</b>
          <p class="ei-round">${esc(sp.career ? sp.career.round : '')}<small>${esc(sp.career ? sp.career.roundEs : '')}</small></p>
          <p class="ei-format">One set · first to ${esc(sp.games || e.games)} games · golden point · ${esc(sp.skillLabel || levelName(sp.level))} opponents${e.recLevel ? ` · for level ${esc(e.recLevel)}+` : ''}</p>
          <p class="ei-format ei-adapt">Opponents adapt to your form · los rivales se adaptan a tu nivel</p>
          ${data.resumeScore ? `<p class="ei-resume">Resume at <b>${esc(data.resumeScore)}</b><small>Reanudar el partido</small></p>` : ''}
        </div>
        <div class="ei-team ei-them">
          <p class="eyebrow">${esc(data.pairName || 'Opponents')} · Rivales</p>
          ${opp.map((p) => playerCardHtml(p, { side: 'opp' })).join('')}
        </div>
      </div>
      <div class="btn-row ei-btns">
        <button type="button" class="btn go btn-lg" data-action="start-event" data-event="${esc(e.id || '')}" data-autofocus data-focus-key="start">${data.resumeScore ? 'Resume match' : 'Start match'}<span class="es">${data.resumeScore ? 'Reanudar' : 'Empezar partido'}</span></button>
        ${data.canAbandon ? '<button type="button" class="btn" data-action="abandon-event" data-focus-key="abandon">Withdraw<span class="es">Retirarse del torneo</span></button>' : ''}
        <span class="ei-tip">${g('timing')} Tip: ${esc(data.tip || '')}</span>
      </div>`;
  }
  const levelName = (l) => ({ rookie: 'Rookie', club: 'Club', pro: 'Pro' }[l] || l || '');

  // ---- Trophies & unlocks --------------------------------------------------------------------
  function trophiesHtml(data) {
    const tab = data.tab || 'trophies';
    const tabs = [['trophies', 'Trophies', 'Trofeos'], ['rackets', 'Rackets', 'Palas'], ['outfits', 'Outfits', 'Ropa'], ['achievements', 'Achievements', 'Logros'], ['stats', 'Fitness', 'Forma física']];
    let body = '';
    if (tab === 'trophies') {
      body = `<div class="cabinet">${(data.events || []).map((e) => {
        const pl = e.best ? PLACE[e.best] : null;
        return `<div class="cab-slot ${pl ? `cab-${pl[0]}` : 'cab-empty'}"><i class="cab-cup">${g(e.tier === 8 ? 'crown' : 'trophy')}</i><b>${esc(e.name)}</b><small>${pl ? `${esc(pl[1])} · ${esc(pl[2])}` : e.status === 'locked' ? 'Locked' : 'Not yet won'}</small></div>`;
      }).join('')}</div>`;
    } else if (tab === 'rackets') {
      const bar = (k, v) => `<span class="rk-stat"><span>${esc(k)}</span><span class="rk-bar"><i style="width:${v * 10}%"></i></span><b>${esc(v)}</b></span>`;
      body = `<div class="rk-grid">${(data.rackets || []).map((r) => `<div class="rk-card${r.unlocked ? '' : ' locked'}${r.equipped ? ' equipped' : ''}" style="--rk:${esc(r.color)}">
        <svg class="rk-pic" viewBox="0 0 60 120" aria-hidden="true"><path class="rk-head" d="${r.shape === 'round' ? 'M30 6 C52 6 56 26 56 42 C56 62 44 74 30 76 C16 74 4 62 4 42 C4 26 8 6 30 6Z' : r.shape === 'diamond' ? 'M30 4 L52 22 C56 40 50 62 30 76 C10 62 4 40 8 22Z' : 'M30 4 C50 4 56 24 54 42 C52 62 40 74 30 76 C20 74 8 62 6 42 C4 24 10 4 30 4Z'}"/><path class="rk-handle" d="M26 76 H34 V114 H26Z"/>${[0, 1, 2, 3, 4].map((i) => `<circle cx="${18 + (i % 3) * 12}" cy="${26 + Math.floor(i / 3) * 14}" r="2.2" class="rk-hole"/>`).join('')}</svg>
        <div class="rk-body"><b class="rk-name">${esc(r.name)}</b><small class="rk-tag">${esc(r.tag)}</small>
          ${bar('Power', r.stats.power)}${bar('Control', r.stats.control)}${bar('Sweet spot', r.stats.sweetSpot)}${bar('Spin', r.stats.spin)}
          <p class="rk-desc">${esc(r.desc)}</p>
          ${r.timing ? `<p class="rk-effect">Timing hits: ${esc(Math.round(r.timing.pace * 100))}% pace · spread ×${esc(r.timing.scatter.toFixed(2))} (±${esc((3 * r.timing.scatter).toFixed(1))} m) · on-time band ±${esc(Math.round(60 * r.timing.window))} ms</p>` : ''}
          ${r.unlocked ? (r.equipped ? '<span class="rk-on">Equipped · en uso</span>' : `<button type="button" class="btn btn-sm" data-action="equip" data-kind="racket" data-id="${esc(r.id)}" data-focus-key="rk-${esc(r.id)}">Use this racket</button>`) : `<span class="rk-lock">${g('lock')}${esc(r.unlockText)}</span>`}
          ${r.isNew ? '<span class="new-tag">New</span>' : ''}
        </div></div>`).join('')}</div>`;
    } else if (tab === 'outfits') {
      body = `<div class="of-grid">${(data.outfits || []).map((o) => `<div class="of-card${o.unlocked ? '' : ' locked'}${o.equipped ? ' equipped' : ''}">
        <svg class="of-pic" viewBox="0 0 80 90" aria-hidden="true"><path d="M20 10 L32 4 Q40 10 48 4 L60 10 L74 26 L62 34 L58 28 V60 H22 V28 L18 34 L6 26Z" fill="${esc(o.shirt)}"/><path d="M22 60 H58 L60 84 H44 L40 70 L36 84 H20Z" fill="${esc(o.shorts)}"/><rect x="5" y="25" width="10" height="5" fill="${esc(o.band)}" transform="rotate(30 10 27)"/><rect x="65" y="25" width="10" height="5" fill="${esc(o.band)}" transform="rotate(-30 70 27)"/></svg>
        <b>${esc(o.name)}</b><small>${esc(o.es)}</small>
        ${o.unlocked ? (o.equipped ? '<span class="rk-on">Wearing · puesto</span>' : `<button type="button" class="btn btn-sm" data-action="equip" data-kind="outfit" data-id="${esc(o.id)}" data-focus-key="of-${esc(o.id)}">Wear</button>`) : `<span class="rk-lock">${g('lock')}${esc(o.unlockText)}</span>`}
        ${o.isNew ? '<span class="new-tag">New</span>' : ''}
      </div>`).join('')}</div>`;
    } else if (tab === 'achievements') {
      body = `<div class="ach-grid">${(data.achievements || []).map((a) => `<div class="ach ach-${esc(a.tier)}${a.earned ? ' earned' : ''}"><i class="ach-ico">${g(a.icon)}</i><span><b>${esc(a.name)}</b><small>${esc(a.desc)}</small></span><em>${a.earned ? `+${esc(a.xp)} XP` : ''}</em></div>`).join('')}</div>`;
    } else {
      const L = data.lifetime || {};
      const stat = (v, en, es) => `<div class="stat"><b>${v}</b><span>${esc(en)}<small>${esc(es)}</small></span></div>`;
      body = `<div class="life-grid">
        ${stat(fmtInt(L.sessions || 0), 'Sessions', 'Sesiones')}
        ${stat(fmtInt(Math.round((L.activeSeconds || 0) / 60)), 'Active minutes', 'Minutos activos')}
        ${stat(fmtInt(L.kcal || 0), 'kcal burned', 'Calorías')}
        ${stat(fmtInt(L.swings || 0), 'Swings', 'Golpes')}
        ${stat(fmtInt(L.bestRally || 0), 'Longest rally', 'Peloteo más largo')}
        ${stat(`${fmtInt(data.streak ? data.streak.days : 0)}<small>/ best ${fmtInt(data.streak ? data.streak.best : 0)}</small>`, 'Days in a row', 'Días seguidos')}
      </div>`;
    }
    return `
      <header class="screen-head">
        <button type="button" class="btn btn-ghost btn-back" data-action="hub" aria-label="Back" data-focus-key="back">${ICON.back}<span>Back</span></button>
        <div><p class="eyebrow">Progress · Progreso</p><h2 class="h-display">Trophies &amp; unlocks<span class="es">Trofeos y desbloqueos</span></h2></div>
        <div class="head-actions">${xpBarHtml(data.profile)}</div>
      </header>
      <nav class="tabs" role="tablist">${tabs.map(([id, en, es]) => `<button type="button" role="tab" class="tab" aria-selected="${id === tab}" data-action="tab" data-tab="${id}" data-focus-key="tab-${id}"${id === tab ? ' data-autofocus' : ''}>${esc(en)}<small>${esc(es)}</small></button>`).join('')}</nav>
      <div class="tab-body">${body}</div>`;
  }

  // ---- Arcade -----------------------------------------------------------------------------------
  function boardHtml(rows, title, best) {
    return `<div class="lb">
      <p class="eyebrow">${esc(title)} · Clasificación</p>
      <ol class="lb-list">${(rows || []).map((r) => `<li class="${r.you ? 'you' : ''}"><b>${esc(r.rank)}</b><span>${esc(r.name)}</span><em>${fmtInt(r.score)}</em></li>`).join('')}</ol>
      ${best != null ? `<p class="lb-best">Your best · tu récord <b>${fmtInt(best)}</b></p>` : '<p class="lb-best muted">No score yet · sin puntuación</p>'}
    </div>`;
  }

  function arcadeHtml(data) {
    const sel = data.selected || (data.daily ? data.daily.id : 'por-tres-party');
    const all = [...(data.daily ? [{ ...data.daily, isDaily: true }] : []), ...(data.challenges || [])];
    const cur = all.find((c) => c.id === sel) || all[0];
    const card = (c) => `<button type="button" class="ch-card${c.isDaily ? ' ch-daily' : ''}${c.id === sel ? ' selected' : ''}" data-action="challenge-select" data-challenge="${esc(c.id)}" data-focus-key="ch-${esc(c.id)}"${c.id === sel ? ' data-autofocus' : ''}>
      <i class="ch-ico">${g(c.isDaily ? 'calendar' : c.icon)}</i>
      <span class="ch-eyebrow">${c.isDaily ? `Daily · ${esc(c.date)}` : `${esc(c.duration)} s · ${esc(c.skill)}`}</span>
      <span class="ch-name">${esc(c.isDaily ? c.baseName : c.name)}<small>${esc(c.isDaily ? c.twist.en : c.es)}</small></span>
      <span class="ch-best">${c.best != null ? `Best <b>${fmtInt(c.best)}</b>` : 'New'}</span>
    </button>`;
    const rules = cur && cur.rules ? `<ul class="ch-rules">${cur.rules.map(([t, p]) => `<li><span>${esc(t)}</span><b>${typeof p === 'number' ? fmtInt(p) : esc(p)}</b></li>`).join('')}</ul>` : '';
    return `
      <header class="screen-head">
        <button type="button" class="btn btn-ghost btn-back" data-action="hub" aria-label="Back" data-focus-key="back">${ICON.back}<span>Back</span></button>
        <div><p class="eyebrow">Arcade · Retos</p><h2 class="h-display">Arcade challenges<span class="es">60–90 segundos · combos y récords</span></h2></div>
      </header>
      <div class="arc-grid">
        <div class="arc-list">${all.map(card).join('')}</div>
        <div class="arc-detail panel">
          <p class="eyebrow">${esc(cur && cur.isDaily ? `Daily challenge · ${cur.date}` : 'Challenge · Reto')}</p>
          <h3 class="arc-title">${esc(cur ? (cur.isDaily ? cur.baseName : cur.name) : '')}</h3>
          ${cur && cur.isDaily ? `<p class="arc-twist">${g('star')} ${esc(cur.twist.en)}<small>${esc(cur.twist.es)}</small></p>` : ''}
          <p class="arc-desc">${esc(cur ? cur.desc : '')}</p>
          ${rules}
          <p class="arc-combo">Combos: 3 in a row ×2 · 6 ×3 · 10 ×4 · 15 ×5 · Perfect timing +50%</p>
          <div class="btn-row"><button type="button" class="btn go btn-lg" data-action="start-challenge" data-challenge="${esc(cur ? cur.id : '')}" data-focus-key="play">Play<span class="es">Jugar · ${esc(cur ? cur.duration : 60)} s</span></button></div>
        </div>
        <div class="arc-board panel">${boardHtml((data.boards || {})[cur ? cur.id : ''] || [], cur ? (cur.isDaily ? 'Today' : cur.name) : '', cur ? cur.best : null)}</div>
      </div>`;
  }

  // ---- Free play (rally / match setup) ----------------------------------------------------------------
  function freeplayHtml(data) {
    const mode = data.mode || 'rally';
    const venues = data.venues || [];
    return `
      <header class="screen-head">
        <button type="button" class="btn btn-ghost btn-back" data-action="hub" aria-label="Back" data-focus-key="back">${ICON.back}<span>Back</span></button>
        <div><p class="eyebrow">Free play · Juego libre</p><h2 class="h-display">${mode === 'match' ? 'Match' : 'Rally with Coach'}<span class="es">${mode === 'match' ? 'Partido 2 contra 2' : 'Peloteo con el entrenador'}</span></h2></div>
      </header>
      <div class="fp-grid">
        <div class="fp-col">
          <p class="eyebrow">Mode · Modo</p>
          ${segHtml('fpMode', [['rally', 'Rally', 'Peloteo'], ['match', 'Match', 'Partido']], mode, { label: 'Mode' })}
          <p class="eyebrow">Opponent level · Nivel</p>
          ${segHtml('fpLevel', [['rookie', 'Rookie', 'Iniciación'], ['club', 'Club', 'Club'], ['pro', 'Pro', 'Pro']], data.level || 'club', { label: 'Opponent level' })}
          ${mode === 'match' ? `<p class="eyebrow">Length · Duración</p>${segHtml('fpGames', [['2', 'Short', 'first to 2'], ['4', 'Medium', 'first to 4'], ['6', 'Full set', 'first to 6']], String(data.games || 4), { label: 'Match length' })}` : ''}
        </div>
        <div class="fp-venues" role="radiogroup" aria-label="Venue">
          ${venues.map((v) => `<button type="button" role="radio" class="venue-card" aria-checked="${v.id === data.venue}" data-action="fp-venue" data-venue="${esc(v.id)}" data-focus-key="venue-${esc(v.id)}">
            ${VENUE_ART[v.id] || ''}<span class="vc-name">${esc(v.name)}<small>${esc(v.desc)}</small></span>
          </button>`).join('')}
        </div>
      </div>
      <div class="btn-row fp-btns"><button type="button" class="btn go btn-lg" data-action="free-start" data-autofocus data-focus-key="start">Start<span class="es">Empezar</span></button></div>`;
  }

  // ---- Results extras ---------------------------------------------------------------------------------
  /** Rewards: XP gained (parts), level-ups, unlocks, achievements; career line. */
  function rewardsHtml(r) {
    if (!r) return '';
    const p = r.profile;
    const ups = r.levelUps && r.levelUps.length ? `<span class="rw-up">Level up! · ¡Subes de nivel! <b>${esc(r.levelUps[r.levelUps.length - 1])}</b></span>` : '';
    const unl = (r.unlocks || []).map((u) => `<span class="rw-unlock">${g(u.kind === 'racket' ? 'power' : 'star')}Unlocked: <b>${esc(u.name)}</b></span>`).join('');
    const ach = (r.achievements || []).map((a) => `<span class="rw-ach ach-${esc(a.tier)}">${g(a.icon)}<b>${esc(a.name)}</b><em>+${esc(a.xp)}</em></span>`).join('');
    return `<div class="rewards">
      <div class="rw-head"><span class="rw-xp">+${fmtInt(r.xp)} <small>XP</small></span>${xpBarHtml(p)}</div>
      <div class="rw-parts">${(r.parts || []).map((x) => `<span>${esc(x.en)} <b>+${fmtInt(x.xp)}</b></span>`).join('')}</div>
      ${ups || unl || ach ? `<div class="rw-news">${ups}${unl}${ach}</div>` : ''}
    </div>`;
  }

  /** Fitness recap: active minutes, swings, kcal, session length. */
  function fitnessHtml(f) {
    if (!f) return '';
    const it = (v, en, es) => `<span class="fit-it"><b>${v}</b><span>${esc(en)}<small>${esc(es)}</small></span></span>`;
    return `<div class="fitness"><p class="eyebrow">${g('fitness')} Workout · Ejercicio</p>
      ${it(fmtInt(Math.max((f.kcal || 0) > 0 || (f.activeSeconds || 0) > 0 ? 1 : 0, Math.round((f.activeSeconds || 0) / 60))), 'active min', 'minutos activos')}
      ${it(fmtInt(f.swings || 0), 'swings', 'golpes')}
      ${it(fmtInt(f.kcal || 0), 'kcal', 'calorías')}
      ${f.peakSwingKmh ? it(fmtInt(f.peakSwingKmh), 'top swing km/h', 'swing máx.') : ''}
    </div>`;
  }

  /** Career line on the results: round result, next match or trophy. */
  function careerLineHtml(c) {
    if (!c) return '';
    if (c.eventDone) {
      const pl = PLACE[c.place] || PLACE[4];
      return `<div class="car-line car-${pl[0]}"><i class="trophy-ico t-${pl[0]}">${g(c.place === 1 ? 'crown' : 'trophy')}</i><span><b>${esc(c.eventName)} · ${esc(pl[1])}</b><small>${c.eventWon ? (c.unlockedName ? `Next stop unlocked: ${esc(c.unlockedName)}` : 'Circuit complete') : 'Knocked out · eliminado — try again'}</small></span></div>`;
    }
    return `<div class="car-line car-next"><i class="trophy-ico">${g('check')}</i><span><b>${esc(c.round)} won · ganado</b><small>Next: ${esc(c.nextRound)} vs ${esc(c.nextPair || '')}</small></span></div>`;
  }

  /** Challenge results body. */
  function challengeResultsHtml(sum) {
    const lb = sum.leaderboard || {};
    const stat = (v, en, es) => `<div class="stat"><b>${v}</b><span>${esc(en)}<small>${esc(es)}</small></span></div>`;
    const id = sum.challengeId;
    return `<div class="cres-grid">
      <div class="res-stats">
        ${stat(fmtInt(sum.maxCombo || 0), 'Best combo', 'Mejor combo')}
        ${stat(fmtInt(sum.perfect || 0), 'Perfect timing', 'Golpes perfectos')}
        ${stat(fmtInt(sum.hits || 0), 'Balls hit', 'Bolas golpeadas')}
        ${id === 'glass-breaker' ? stat(fmtInt(sum.shattered || 0), 'Targets shattered', 'Dianas rotas') : ''}
        ${id === 'por-tres-party' ? stat(fmtInt(sum.porTres || 0), 'Por tres / cuatro', 'Por tres / cuatro') : ''}
        ${id === 'rally-marathon' ? stat(fmtInt(sum.longestRally || 0), 'Longest rally', 'Peloteo más largo') : ''}
      </div>
      <div class="arc-board panel">${boardHtml(lb.board || [], sum.name, lb.isBest ? sum.score : lb.previousBest)}</div>
      <div class="res-side">${rewardsHtml(sum.rewards)}${fitnessHtml(sum.fitness)}</div>
    </div>`;
  }

  return {
    hubHtml, mountHub, careerHtml, eventIntroHtml, trophiesHtml, arcadeHtml, freeplayHtml,
    rewardsHtml, fitnessHtml, careerLineHtml, challengeResultsHtml, boardHtml, xpBarHtml, glyph: g, VENUE_ART,
  };
}
