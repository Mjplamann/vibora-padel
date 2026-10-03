import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createReferee, inDiagonalBox, OUTCOME_LABELS, teamSide } from '../src/rules/referee.js';
import { createMatch } from '../src/rules/scoring.js';

// ---- physics event builders (SPEC §2.2 shapes) ------------------------------

const side = (z) => (z > 0 ? 'near' : 'far');
const evt = (type, x, y, z, extra = {}) => ({
  type,
  t: 0,
  pos: { x, y, z },
  vel: { x: 0, y: 0, z: 0 },
  side: side(z),
  surface: null,
  wall: null,
  impactSpeed: 5,
  via: null,
  ...extra,
});
const bounce = (x, z) => evt('bounce', x, 0, z, { surface: 'turf' });
const glass = (wall, x, y, z) => evt('wall', x, y, z, { surface: 'glass', wall });
const mesh = (wall, x, y, z) => evt('wall', x, y, z, { surface: 'mesh', wall });
const netBody = (x = 0, nearSide = true) => evt('net', x, 0.5, nearSide ? 0.01 : -0.01, { surface: 'netBody' });
const netCord = (x = 0) => evt('netcord', x, 0.9, 0.001, { surface: 'netCord' });
const exit = (via, x, y, z) => evt('exit', x, y, z, { via });
const ceiling = (x, z) => evt('ceiling', x, 10, z, { surface: 'ceiling' });
const rest = (x, z) => evt('rest', x, 0, z, { surface: 'turf' });
const outsideBounce = (x, z) => evt('outside-bounce', x, 0, z, { surface: 'outsideFloor' });

/** Referee wired to an outcome log. */
function ref(opts = {}) {
  const outcomes = [];
  const r = createReferee({ ...opts, onOutcome: (o) => outcomes.push(o) });
  return { r, outcomes, last: () => outcomes[outcomes.length - 1] };
}

/** Referee in a rally where `team` has just struck the ball. */
function rallyAfterHit(team, opts = {}) {
  // A fed ball from the opposite team, returned by `team`.
  const h = ref({ serving: null, feedTeam: 1 - team, ...opts });
  assert.equal(h.r.onHit(team), true);
  return h;
}

function play(r, events) {
  for (const e of events) r.onEvent(e);
}

function assertOutcome(o, winner, reason) {
  assert.ok(o, `expected an outcome ${reason}`);
  assert.equal(o.winner, winner, `winner for ${reason} (got ${o.reason})`);
  assert.equal(o.reason, reason);
  assert.equal(o.label, OUTCOME_LABELS[reason]);
}

describe('referee: labels and helpers', () => {
  test('every SPEC reason has its SPEC label', () => {
    assert.equal(OUTCOME_LABELS['double-bounce'], 'Second bounce');
    assert.equal(OUTCOME_LABELS.net, 'Net');
    assert.equal(OUTCOME_LABELS.out, 'Out');
    assert.equal(OUTCOME_LABELS['own-side'], 'Own side');
    assert.equal(OUTCOME_LABELS['serve-fault'], 'Fault');
    assert.equal(OUTCOME_LABELS['double-fault'], 'Double fault');
    assert.equal(OUTCOME_LABELS['volleyed-serve'], 'Volleyed the serve');
    assert.equal(OUTCOME_LABELS['por-tres'], '¡Por tres!');
    assert.equal(OUTCOME_LABELS['por-cuatro'], '¡Por cuatro!');
    assert.equal(OUTCOME_LABELS.ceiling, 'Ceiling');
    assert.equal(OUTCOME_LABELS.winner, 'Winner');
  });

  test('team sides', () => {
    assert.equal(teamSide(0), 'near');
    assert.equal(teamSide(1), 'far');
  });

  test('diagonal boxes follow §2.6 (named from the receiver, lines in)', () => {
    // Near receiver faces -z: right box is x > 0.
    assert.equal(inDiagonalBox(2, 3, 'near', 'right'), true);
    assert.equal(inDiagonalBox(-2, 3, 'near', 'right'), false);
    assert.equal(inDiagonalBox(-2, 3, 'near', 'left'), true);
    // Far receiver faces +z: right box is x < 0.
    assert.equal(inDiagonalBox(-2, -3, 'far', 'right'), true);
    assert.equal(inDiagonalBox(2, -3, 'far', 'right'), false);
    assert.equal(inDiagonalBox(2, -3, 'far', 'left'), true);
    // Lines count as in: service line and center line.
    assert.equal(inDiagonalBox(-2, -6.95, 'far', 'right'), true);
    assert.equal(inDiagonalBox(0, -3, 'far', 'right'), true);
    assert.equal(inDiagonalBox(0, -3, 'far', 'left'), true);
    assert.equal(inDiagonalBox(-5, -3, 'far', 'right'), true);
    // Beyond the service line or on the wrong half.
    assert.equal(inDiagonalBox(-2, -6.97, 'far', 'right'), false);
    assert.equal(inDiagonalBox(-2, 3, 'far', 'right'), false);
    assert.equal(inDiagonalBox(-5.01, -3, 'far', 'right'), false);
  });
});

describe('referee: rally (rules 1–5, 7)', () => {
  test('legal bounce then second bounce on the opponent floor: point to hitter', () => {
    const { r, outcomes } = rallyAfterHit(0);
    play(r, [bounce(-2, -7)]);
    assert.equal(outcomes.length, 0);
    assert.equal(r.state.legalBounce, true);
    assert.equal(r.state.bouncesOnSide, 1);
    play(r, [glass('back', -2, 1, -10), bounce(-2, -8.5)]);
    assertOutcome(outcomes[0], 0, 'double-bounce');
    assert.equal(outcomes.length, 1);
    assert.equal(r.state.phase, 'dead');
    assert.deepEqual({ ...outcomes[0].pos }, { x: -2, y: 0, z: -8.5 });
  });

  test('mirror: far team hits, ball bounces twice on the near side', () => {
    const { r, last } = rallyAfterHit(1);
    play(r, [bounce(1, 5), bounce(1, 8)]);
    assertOutcome(last(), 1, 'double-bounce');
  });

  test('ball that bounces and spins back over the net still counts as a second bounce for the hitter', () => {
    const { r, last } = rallyAfterHit(0);
    play(r, [bounce(0, -0.8), netCord(0), bounce(0, 0.5)]);
    assertOutcome(last(), 0, 'double-bounce');
  });

  test('rule 1: own back glass before crossing is legal', () => {
    const { r, outcomes, last } = rallyAfterHit(0);
    play(r, [glass('back', 1, 1.2, 10)]);
    assert.equal(outcomes.length, 0);
    assert.equal(r.state.wallBeforeBounce, true);
    play(r, [bounce(-1, -6), bounce(-1, -9)]);
    assertOutcome(last(), 0, 'double-bounce');
  });

  test('rule 1: own back then own side glass (double wall) before crossing is legal', () => {
    const { r, outcomes } = rallyAfterHit(0);
    play(r, [glass('back', 4.8, 1, 10), glass('side', 5, 1.4, 9.3), bounce(-3, -5)]);
    assert.equal(outcomes.length, 0);
    assert.equal(r.state.legalBounce, true);
  });

  test('far team may also use its own glass', () => {
    const { r, outcomes } = rallyAfterHit(1);
    play(r, [glass('side', -5, 1, -8.5), bounce(2, 6)]);
    assert.equal(outcomes.length, 0);
    assert.equal(r.state.legalBounce, true);
  });

  test("own wire mesh before crossing loses the point (FIP); option ownMeshLegal allows it", () => {
    const a = rallyAfterHit(0);
    play(a.r, [mesh('back', 0, 3.5, 10)]);
    assertOutcome(a.last(), 1, 'own-side');
    assert.equal(a.last().detail, 'own fence');

    const b = rallyAfterHit(0, { ownMeshLegal: true });
    play(b.r, [mesh('back', 0, 3.5, 10), bounce(0, -6)]);
    assert.equal(b.outcomes.length, 0);
    assert.equal(b.r.state.legalBounce, true);
  });

  test("rule 2: opponent's glass before the bounce is out", () => {
    const { r, last } = rallyAfterHit(0);
    play(r, [glass('back', 0, 1.5, -10)]);
    assertOutcome(last(), 1, 'out');
  });

  test("rule 2: opponent's side glass / mesh before the bounce is out", () => {
    const a = rallyAfterHit(0);
    play(a.r, [glass('side', -5, 1, -9)]);
    assertOutcome(a.last(), 1, 'out');
    const b = rallyAfterHit(0);
    play(b.r, [mesh('side', -5, 1.5, -3)]);
    assertOutcome(b.last(), 1, 'out');
    const c = rallyAfterHit(1);
    play(c.r, [mesh('back', 0, 3.4, 10)]);
    assertOutcome(c.last(), 0, 'out');
  });

  test('rule 2: leaving the court before the bounce is out (exit or outside floor)', () => {
    const a = rallyAfterHit(0);
    play(a.r, [exit('back', 0, 4.5, -10)]);
    assertOutcome(a.last(), 1, 'out');
    const b = rallyAfterHit(0);
    play(b.r, [outsideBounce(-6, -3)]);
    assertOutcome(b.last(), 1, 'out');
    // Hit backwards over your own fence is also out.
    const c = rallyAfterHit(0);
    play(c.r, [exit('back', 0, 5, 10)]);
    assertOutcome(c.last(), 1, 'out');
  });

  test("rule 3: bounce on the hitter's own floor is a point to the opponent", () => {
    const { r, last } = rallyAfterHit(0);
    play(r, [bounce(1, 3)]);
    assertOutcome(last(), 1, 'own-side');
    const b = rallyAfterHit(1);
    play(b.r, [bounce(1, -3)]);
    assertOutcome(b.last(), 0, 'own-side');
  });

  test('rule 4: exit over the back wall after a legal bounce is por tres', () => {
    const { r, last } = rallyAfterHit(0);
    play(r, [bounce(0, -4), exit('back', 0.5, 4.2, -10)]);
    assertOutcome(last(), 0, 'por-tres');
  });

  test('rule 4: exit over the side after a legal bounce is por cuatro', () => {
    const { r, last } = rallyAfterHit(0);
    play(r, [bounce(-2, -4), exit('side', -5, 3.2, -5)]);
    assertOutcome(last(), 0, 'por-cuatro');
  });

  test('rule 4: exit kind is inferred from position when via is missing', () => {
    const a = rallyAfterHit(0);
    play(a.r, [bounce(-2, -4), evt('exit', -5, 3.5, -4, { via: null })]);
    assertOutcome(a.last(), 0, 'por-cuatro');
    const b = rallyAfterHit(0);
    play(b.r, [bounce(-2, -4), evt('exit', 1, 4.5, -10, { via: null })]);
    assertOutcome(b.last(), 0, 'por-tres');
  });

  test('rule 4: walls of any kind after the bounce are fine, and a far-team smash por tres works mirrored', () => {
    const { r, outcomes, last } = rallyAfterHit(1);
    play(r, [bounce(0, 4), glass('back', 0, 2, 10), glass('side', 5, 1.5, 9)]);
    assert.equal(outcomes.length, 0);
    assert.equal(r.state.wallsAfterBounce, 2);
    play(r, [exit('back', 0, 4.4, 10)]);
    assertOutcome(last(), 1, 'por-tres');
  });

  test('rule 5: mesh after the bounce is legal in a rally', () => {
    const { r, outcomes, last } = rallyAfterHit(0);
    play(r, [bounce(-3, -5), mesh('side', -5, 2.5, -7), mesh('back', -4, 3.3, -10)]);
    assert.equal(outcomes.length, 0);
    play(r, [bounce(-4, -9)]);
    assertOutcome(last(), 0, 'double-bounce');
  });

  test('rule 7: ball into the net body falls on the hitter side: point to the other team', () => {
    const { r, outcomes, last } = rallyAfterHit(0);
    play(r, [netBody(1, true)]);
    assert.equal(outcomes.length, 0, 'decided when the ball lands, not at the touch');
    assert.equal(r.state.netTouched, true);
    play(r, [bounce(1, 0.4)]);
    assertOutcome(last(), 1, 'net');
  });

  test('rule 7: net then rest on the hitter side is a net point', () => {
    const { r, last } = rallyAfterHit(1);
    play(r, [netBody(0, false), rest(0, -0.2)]);
    assertOutcome(last(), 0, 'net');
  });

  test('net cord trickling over and bouncing in is good in a rally', () => {
    const { r, outcomes, last } = rallyAfterHit(0);
    play(r, [netCord(2), bounce(2, -0.6)]);
    assert.equal(outcomes.length, 0);
    play(r, [bounce(2, -1.2)]);
    assertOutcome(last(), 0, 'double-bounce');
  });

  test('net cord falling back is a net point', () => {
    const { r, last } = rallyAfterHit(0);
    play(r, [netCord(2), bounce(2, 0.3)]);
    assertOutcome(last(), 1, 'net');
  });

  test('ceiling before the bounce loses; after the bounce wins', () => {
    const a = rallyAfterHit(0);
    play(a.r, [ceiling(0, 2)]);
    assertOutcome(a.last(), 1, 'ceiling');
    const b = rallyAfterHit(0);
    play(b.r, [bounce(0, -6), ceiling(0, -8)]);
    assertOutcome(b.last(), 0, 'ceiling');
  });

  test('ball coming to rest after the legal bounce is a winner', () => {
    const { r, last } = rallyAfterHit(0);
    play(r, [bounce(-1, -2), rest(-1, -3)]);
    assertOutcome(last(), 0, 'winner');
  });

  test('a return hands the judgement to the other team (volley allowed in rally)', () => {
    const { r, outcomes, last } = rallyAfterHit(0);
    play(r, [netCord(0)]);
    assert.equal(r.canHit(1), true, 'opponent may volley');
    assert.equal(r.canHit(0), false);
    assert.equal(r.onHit(1, { volley: true }), true);
    assert.equal(r.state.lastHitter, 1);
    assert.equal(r.state.lastHitVolley, true);
    assert.equal(r.state.netTouched, false, 'shot state resets on a new hit');
    play(r, [bounce(2, 6), glass('back', 2, 1, 10)]);
    assert.equal(outcomes.length, 0);
    assert.equal(r.onHit(0), true, 'return off the glass');
    play(r, [bounce(-1, -3), bounce(-1, -6)]);
    assertOutcome(last(), 0, 'double-bounce');
    assert.equal(last().rallyLength, 3);
    assert.equal(last().by, 0);
  });

  test('same team striking twice is a double hit', () => {
    const { r, last } = rallyAfterHit(0);
    assert.equal(r.onHit(0), true);
    assertOutcome(last(), 1, 'double-hit');
  });

  test('outcome fires exactly once; later events and hits are ignored', () => {
    const { r, outcomes } = rallyAfterHit(0);
    play(r, [bounce(0, -5), bounce(0, -7), exit('back', 0, 4.5, -10), rest(0, -11)]);
    assert.equal(r.onHit(1), false);
    play(r, [bounce(0, 4)]);
    assert.equal(outcomes.length, 1);
    assert.equal(r.canHit(0), false);
    assert.equal(r.canHit(1), false);
  });

  test('award() ends the point externally, once', () => {
    const { r, outcomes } = rallyAfterHit(0);
    const o = r.award(0, 'winner', { x: 0, y: 1, z: -3 }, 'ball hit opponent');
    assertOutcome(o, 0, 'winner');
    assert.equal(o.detail, 'ball hit opponent');
    assert.equal(r.award(1), null);
    assert.equal(outcomes.length, 1);
  });

  test('state exposes the SPEC fields', () => {
    const { r } = rallyAfterHit(0);
    for (const k of ['lastHitter', 'phase', 'bouncesOnSide', 'wallBeforeBounce']) assert.ok(k in r.state, k);
    assert.equal(r.state.phase, 'rally');
  });
});

describe('referee: serve (rule 6)', () => {
  const serveRef = (team = 0, box = 'right') => ref({ serving: { team, box } });

  test('waits for the serve: drop bounce before the strike is ignored; only server can start', () => {
    const { r, outcomes } = serveRef();
    assert.equal(r.state.phase, 'serve');
    assert.equal(r.canHit(0), true);
    assert.equal(r.canHit(1), false);
    play(r, [bounce(2, 7.6)]); // drop bounce behind the service line
    assert.equal(outcomes.length, 0);
    assert.equal(r.onHit(1), false, 'receiver cannot strike first');
    assert.equal(r.onHit(0, { isServe: true }), true);
    assert.equal(r.state.isServe, true);
    assert.equal(r.state.phase, 'serve');
  });

  test('good serve into the diagonal box, off the glass, unreturned: ace', () => {
    const { r, outcomes, last } = serveRef(0, 'right');
    r.onHit(0, { isServe: true });
    play(r, [bounce(-2.5, -5.5)]);
    assert.equal(outcomes.length, 0);
    play(r, [glass('back', -3, 0.9, -10), glass('side', -5, 0.8, -9)]);
    assert.equal(outcomes.length, 0, 'serve may hit glass after the bounce');
    play(r, [bounce(-4, -8)]);
    assertOutcome(last(), 0, 'double-bounce');
    assert.equal(last().detail, 'ace');
  });

  test('receiver must let the serve bounce: canHit false, canContact true, volley loses', () => {
    const { r, last } = serveRef(0, 'right');
    r.onHit(0, { isServe: true });
    assert.equal(r.canHit(1), false);
    assert.equal(r.canContact(1), true);
    r.onHit(1, { volley: true });
    assertOutcome(last(), 0, 'volleyed-serve');
  });

  test('return of serve after the bounce starts the rally', () => {
    const { r, outcomes, last } = serveRef(0, 'right');
    r.onHit(0, { isServe: true });
    play(r, [bounce(-1, -4)]);
    assert.equal(r.canHit(1), true);
    assert.equal(r.onHit(1), true);
    assert.equal(r.state.phase, 'rally');
    assert.equal(r.state.isServe, false);
    // Rally rules now: return lands near, mesh after bounce is fine in a rally.
    play(r, [bounce(2, 7), mesh('side', 5, 2.5, 7.2)]);
    assert.equal(outcomes.length, 0);
    play(r, [bounce(4.5, 7.5)]);
    assertOutcome(last(), 1, 'double-bounce');
    assert.equal(last().rallyLength, 2);
  });

  test('first fault: replay with a second serve; second fault: double fault', () => {
    const { r, outcomes, last } = serveRef(0, 'right');
    r.onHit(0, { isServe: true });
    play(r, [bounce(2, -4)]); // wrong box
    assert.equal(outcomes.length, 1);
    assert.equal(last().reason, 'serve-fault');
    assert.equal(last().label, 'Fault');
    assert.equal(last().winner, null);
    assert.equal(last().replay, true);
    assert.equal(last().pointOver, false);
    assert.equal(last().faults, 1);
    assert.equal(r.state.phase, 'serve');
    assert.equal(r.state.awaitingServe, true);
    assert.equal(r.state.faults, 1);
    // The faulted ball keeps bouncing: ignored.
    play(r, [bounce(2.5, -6), glass('back', 3, 1, -10)]);
    assert.equal(outcomes.length, 1);
    r.onHit(0, { isServe: true });
    play(r, [bounce(-2, -7.4)]); // long
    assertOutcome(last(), 1, 'double-fault');
    assert.equal(last().pointOver, true);
    assert.equal(r.state.phase, 'dead');
  });

  test('every serve-fault cause', () => {
    const cases = [
      ['wide (wrong box)', [bounce(1, -3)]],
      ['long', [bounce(-1, -7.2)]],
      ['own side', [bounce(1, 3)]],
      ['net body', [netBody(1, true), bounce(1, 0.5)]],
      ['net then rest', [netBody(1, true), rest(1, 0.3)]],
      ['cord then out of box', [netCord(0), bounce(1, -0.5)]],
      ['receiver glass on the full', [glass('back', -2, 1, -10)]],
      ['receiver mesh on the full', [mesh('side', -5, 1.5, -4)]],
      ['own glass first', [glass('back', 2, 1, 10)]],
      ['exit on the full', [exit('side', -5, 4, -5)]],
      ['ceiling', [ceiling(0, -2)]],
      ['mesh after the bounce', [bounce(-3, -6), mesh('side', -5, 2, -6.5)]],
      ['glass then mesh before second bounce', [bounce(-3, -6), glass('back', -4, 1, -10), mesh('side', -5, 2.4, -7)]],
    ];
    for (const [name, events] of cases) {
      const { r, outcomes } = serveRef(0, 'right');
      r.onHit(0, { isServe: true });
      play(r, events);
      assert.equal(outcomes.length, 1, name);
      assert.equal(outcomes[0].reason, 'serve-fault', name);
      assert.equal(outcomes[0].winner, null, name);
    }
  });

  test('mesh after the second bounce is irrelevant (point already over)', () => {
    const { r, outcomes } = serveRef(0, 'right');
    r.onHit(0, { isServe: true });
    play(r, [bounce(-3, -6), bounce(-3.5, -8), mesh('side', -5, 2, -9)]);
    assert.equal(outcomes.length, 1);
    assertOutcome(outcomes[0], 0, 'double-bounce');
  });

  test('let: net cord then lands in the box is replayed without a fault', () => {
    const { r, outcomes, last } = serveRef(0, 'right');
    r.onHit(0, { isServe: true });
    play(r, [netCord(-1), bounce(-1, -1.5)]);
    assert.equal(r.state.letPending, true);
    assert.equal(outcomes.length, 0);
    play(r, [bounce(-1, -3)]);
    assert.equal(last().reason, 'let');
    assert.equal(last().winner, null);
    assert.equal(last().replay, true);
    assert.equal(last().faults, 0);
    assert.equal(r.state.awaitingServe, true);
    assert.equal(r.state.faults, 0);
  });

  test('let on the second serve keeps the first fault', () => {
    const { r, last } = serveRef(0, 'right');
    r.onHit(0, { isServe: true });
    play(r, [bounce(2, -3)]);
    assert.equal(r.state.faults, 1);
    r.onHit(0, { isServe: true });
    play(r, [netCord(-1), bounce(-1, -2), glass('back', -1, 0.6, -10), bounce(-1, -8)]);
    assert.equal(last().reason, 'let');
    assert.equal(r.state.faults, 1);
    r.onHit(0, { isServe: true });
    play(r, [netCord(-1), bounce(-1, 0.4)]);
    assertOutcome(last(), 1, 'double-fault');
  });

  test('let ball that then hits the mesh is a fault, not a let', () => {
    const { r, last } = serveRef(0, 'right');
    r.onHit(0, { isServe: true });
    play(r, [netCord(-1), bounce(-1, -2), mesh('side', -5, 2, -5)]);
    assert.equal(last().reason, 'serve-fault');
  });

  test('receiver playing a let serve still replays it', () => {
    const { r, last } = serveRef(0, 'right');
    r.onHit(0, { isServe: true });
    play(r, [netCord(-1), bounce(-1, -2)]);
    assert.equal(r.canHit(1), true);
    r.onHit(1);
    assert.equal(last().reason, 'let');
    assert.equal(r.state.awaitingServe, true);
  });

  test('far team serving from its left box into the near left box', () => {
    const ok = serveRef(1, 'left');
    ok.r.onHit(1, { isServe: true });
    play(ok.r, [bounce(-2, 4)]); // near left box is x < 0
    assert.equal(ok.outcomes.length, 0);
    play(ok.r, [bounce(-2, 8)]);
    assertOutcome(ok.last(), 1, 'double-bounce');

    const bad = serveRef(1, 'left');
    bad.r.onHit(1, { isServe: true });
    play(bad.r, [bounce(2, 4)]);
    assert.equal(bad.last().reason, 'serve-fault');
  });

  test('serve that bounces in and leaves over the side wall (no mesh) is the server\'s point', () => {
    const { r, last } = serveRef(0, 'right');
    r.onHit(0, { isServe: true });
    play(r, [bounce(-4, -3), exit('side', -5, 3.1, -3.4)]);
    assertOutcome(last(), 0, 'por-cuatro');
  });

  test('server striking twice loses the point', () => {
    const { r, last } = serveRef(0, 'right');
    r.onHit(0, { isServe: true });
    r.onHit(0);
    assertOutcome(last(), 1, 'double-hit');
  });

  test('reset starts a fresh point with zero faults', () => {
    const { r, outcomes } = serveRef(0, 'right');
    r.onHit(0, { isServe: true });
    play(r, [bounce(2, -3)]);
    assert.equal(r.state.faults, 1);
    r.reset({ serving: { team: 1, box: 'left' } });
    assert.equal(r.state.faults, 0);
    assert.equal(r.state.phase, 'serve');
    assert.equal(r.canHit(1), true);
    assert.equal(r.canHit(0), false);
    assert.equal(outcomes.length, 1);
  });
});

describe('referee: fed balls', () => {
  test('default: the feed is judged as the far team\'s shot (player missed -> point to team 1)', () => {
    const { r, last } = ref({ serving: null });
    assert.equal(r.state.lastHitter, 1);
    assert.equal(r.canHit(0), true);
    assert.equal(r.canHit(1), false);
    play(r, [bounce(2.6, 6), bounce(2.6, 8.8)]);
    assertOutcome(last(), 1, 'double-bounce');
  });

  test('default: a feed hitting the near glass on the full is out (point to the player team)', () => {
    const { r, last } = ref({ serving: null });
    play(r, [glass('back', 2, 1.2, 10)]);
    assertOutcome(last(), 0, 'out');
  });

  test('default: a feed into the net is a net point for the player team', () => {
    const { r, last } = ref({ serving: null });
    play(r, [netBody(0, false), bounce(0, -0.5)]);
    assertOutcome(last(), 0, 'net');
  });

  test('default: integrator may announce the feed with onHit(1) without a double hit', () => {
    const { r, outcomes, last } = ref({ serving: null });
    assert.equal(r.onHit(1), true);
    assert.equal(outcomes.length, 0);
    play(r, [bounce(2, 6)]);
    r.onHit(0);
    play(r, [bounce(-2, -7), bounce(-2, -9)]);
    assertOutcome(last(), 0, 'double-bounce');
    assert.equal(last().rallyLength, 1);
  });

  test('neutral feed: feed is not judged, only the player\'s shot', () => {
    const { r, outcomes, last } = ref({ serving: null, feedIsNeutral: true });
    assert.equal(r.state.neutralFeed, true);
    assert.equal(r.canHit(0), true);
    assert.equal(r.canHit(1), false);
    assert.equal(r.onHit(1), false, 'the machine itself is ignored');
    // Feed clips the cord and hits the back glass on the full: not judged.
    play(r, [netCord(1), glass('back', 2, 1, 10), bounce(2, 8)]);
    assert.equal(outcomes.length, 0);
    assert.equal(r.onHit(0), true);
    assert.equal(r.state.neutralFeed, false);
    play(r, [bounce(-2, -8), glass('back', -2, 1, -10)]);
    assert.equal(outcomes.length, 0);
    play(r, [bounce(-2, -8.8)]);
    assertOutcome(last(), 0, 'double-bounce');
  });

  test('neutral feed: player shot that misses is still judged', () => {
    const { r, last } = ref({ serving: null, feedIsNeutral: true });
    play(r, [bounce(2, 6)]);
    r.onHit(0);
    play(r, [glass('back', -1, 1, -10)]);
    assertOutcome(last(), 1, 'out');
  });

  test('neutral feed: missing the feed is a second bounce against the player', () => {
    const { r, last } = ref({ serving: null, feedIsNeutral: true });
    play(r, [bounce(2, 6), glass('back', 2, 1, 10), bounce(2, 8.5)]);
    assertOutcome(last(), 1, 'double-bounce');
    assert.equal(last().detail, 'missed');
  });

  test('neutral feed: bounce then exit is por tres against the player', () => {
    const { r, last } = ref({ serving: null, feedIsNeutral: true });
    play(r, [bounce(0, 6), exit('back', 0, 4.2, 10)]);
    assertOutcome(last(), 1, 'por-tres');
  });

  test('neutral feed that never becomes playable is a dead feed (no winner)', () => {
    const a = ref({ serving: null, feedIsNeutral: true });
    play(a.r, [bounce(0, -1), rest(0, -0.5)]); // died on the machine side
    assert.equal(a.last().reason, 'dead-feed');
    assert.equal(a.last().winner, null);
    const b = ref({ serving: null, feedIsNeutral: true });
    play(b.r, [exit('side', 5, 3.3, 3)]);
    assert.equal(b.last().reason, 'dead-feed');
  });

  test('reset re-arms a fed rally for the next rep', () => {
    const { r, outcomes } = ref({ serving: null, feedIsNeutral: true });
    play(r, [bounce(2, 6), bounce(2, 8)]);
    assert.equal(outcomes.length, 1);
    r.reset({ serving: null, feedIsNeutral: true });
    assert.equal(r.state.phase, 'rally');
    assert.equal(r.state.neutralFeed, true);
    play(r, [bounce(2, 6)]);
    r.onHit(0);
    play(r, [bounce(-2, -7), bounce(-2, -9)]);
    assert.equal(outcomes.length, 2);
    assertOutcome(outcomes[1], 0, 'double-bounce');
  });
});

// ---- scoring ------------------------------------------------------------------

function win(match, team, n) {
  let r;
  for (let i = 0; i < n; i++) r = match.pointWonBy(team);
  return r;
}
const winGame = (m, team) => win(m, team, 4);
function winGames(m, team, n) {
  for (let i = 0; i < n; i++) winGame(m, team);
}
/** Plays games alternately from 0-0 to n-n (team 0 first). */
function toGamesAll(m, n) {
  for (let i = 0; i < n; i++) {
    winGame(m, 0);
    winGame(m, 1);
  }
}

describe('scoring: points and games', () => {
  test('point names 0 / 15 / 30 / 40 and the game on the fourth point', () => {
    const m = createMatch();
    assert.deepEqual(m.display().points, ['0', '0']);
    m.pointWonBy(0);
    assert.deepEqual(m.display().points, ['15', '0']);
    m.pointWonBy(1);
    assert.deepEqual(m.display().points, ['15', '15']);
    m.pointWonBy(0);
    assert.deepEqual(m.display().points, ['30', '15']);
    m.pointWonBy(0);
    assert.deepEqual(m.display().points, ['40', '15']);
    assert.equal(m.display().flags.gamePoint, 0);
    const r = m.pointWonBy(0);
    assert.deepEqual(r, { gameWon: true, setWon: false, matchWon: false });
    assert.deepEqual(m.display().games, [1, 0]);
    assert.deepEqual(m.display().points, ['0', '0']);
  });

  test('golden point (punto de oro): 40-40 is sudden death', () => {
    const m = createMatch({ goldenPoint: true });
    win(m, 0, 3);
    win(m, 1, 3);
    const d = m.display();
    assert.deepEqual(d.points, ['40', '40']);
    assert.equal(d.flags.goldenPoint, true);
    assert.equal(d.flags.gamePoint, null, 'both teams have game point');
    const r = m.pointWonBy(1);
    assert.equal(r.gameWon, true);
    assert.deepEqual(m.display().games, [0, 1]);
    assert.equal(m.display().flags.goldenPoint, false);
  });

  test('advantage scoring: deuce, AD, back to deuce, win by two', () => {
    const m = createMatch({ goldenPoint: false });
    win(m, 0, 3);
    win(m, 1, 3);
    let d = m.display();
    assert.deepEqual(d.points, ['40', '40']);
    assert.equal(d.flags.goldenPoint, false);
    assert.equal(d.flags.deuce, true);
    assert.equal(d.flags.gamePoint, null);
    assert.equal(m.pointWonBy(0).gameWon, false);
    d = m.display();
    assert.deepEqual(d.points, ['AD', '']);
    assert.equal(d.flags.gamePoint, 0);
    m.pointWonBy(1);
    assert.deepEqual(m.display().points, ['40', '40']);
    m.pointWonBy(1);
    assert.deepEqual(m.display().points, ['', 'AD']);
    assert.equal(m.display().flags.gamePoint, 1);
    m.pointWonBy(1);
    assert.deepEqual(m.display().games, [0, 1]);
    // Long deuce game.
    win(m, 0, 3);
    win(m, 1, 3);
    for (let i = 0; i < 5; i++) {
      m.pointWonBy(0);
      m.pointWonBy(1);
    }
    assert.deepEqual(m.display().points, ['40', '40']);
    assert.equal(m.pointWonBy(0).gameWon, false);
    assert.equal(m.pointWonBy(0).gameWon, true);
    assert.deepEqual(m.display().games, [1, 1]);
  });

  test('love game in advantage mode is still four points', () => {
    const m = createMatch({ goldenPoint: false });
    assert.equal(win(m, 1, 4).gameWon, true);
  });
});

describe('scoring: server rotation and boxes', () => {
  test('rotation A, C, B, D across games', () => {
    const m = createMatch({ firstServer: { team: 0, player: 0 } });
    const seen = [];
    for (let g = 0; g < 6; g++) {
      const s = m.server();
      seen.push(`${s.team}${s.player}`);
      winGame(m, g % 2);
    }
    assert.deepEqual(seen, ['00', '10', '01', '11', '00', '10']);
  });

  test('rotation honours firstServer and otherTeamFirstPlayer', () => {
    const m = createMatch({ firstServer: { team: 1, player: 1 }, otherTeamFirstPlayer: 1 });
    const seen = [];
    for (let g = 0; g < 4; g++) {
      const s = m.server();
      seen.push(`${s.team}${s.player}`);
      winGame(m, 0);
    }
    assert.deepEqual(seen, ['11', '01', '10', '00']);
  });

  test('server stays the same through a game; box alternates right/left from the right', () => {
    const m = createMatch({ goldenPoint: false });
    const boxes = [];
    for (let i = 0; i < 8; i++) {
      const s = m.server();
      assert.equal(s.team, 0);
      assert.equal(s.player, 0);
      boxes.push(s.box);
      m.pointWonBy(i % 2); // 15-0, 15-15, ... deuce game
    }
    assert.deepEqual(boxes, ['right', 'left', 'right', 'left', 'right', 'left', 'right', 'left']);
    // At deuce (even number of points) serve is from the right box.
    assert.deepEqual(m.display().points, ['40', '40']);
    assert.equal(m.server().box, 'right');
    m.pointWonBy(0);
    assert.equal(m.server().box, 'left');
    m.pointWonBy(0);
    assert.equal(m.server().box, 'right', 'new game starts from the right');
    assert.equal(m.server().team, 1);
    assert.equal(m.display().box, 'right');
    assert.deepEqual(m.display().server, { team: 1, player: 0 });
  });

  test('tie-break: single first serve, then two points each, box by point parity', () => {
    const m = createMatch();
    toGamesAll(m, 6);
    assert.equal(m.display().flags.tiebreak, true);
    assert.equal(m.inTiebreak, true);
    const seq = [];
    for (let i = 0; i < 8; i++) {
      const s = m.server();
      seq.push(`${s.team}${s.player}${s.box[0]}`);
      m.pointWonBy(i % 2);
    }
    // 12 games played: turn 12 -> A opens. A r | C l r | B l r | D l r | A l
    assert.deepEqual(seq, ['00r', '10l', '10r', '01l', '01r', '11l', '11r', '00l']);
  });

  test('after a tie-break the team that received first serves the next set', () => {
    const m = createMatch({ setsToWin: 2 });
    toGamesAll(m, 6);
    const opener = m.server();
    win(m, 0, 7);
    assert.deepEqual(m.display().sets, [[7, 6]]);
    const next = m.server();
    assert.notEqual(next.team, opener.team);
    assert.equal(next.box, 'right');
  });

  test('rotation continues across a regular set', () => {
    const m = createMatch({ setsToWin: 2 });
    winGames(m, 0, 6); // servers 00,10,01,11,00,10 -> next is 01
    assert.deepEqual(m.display().sets, [[6, 0]]);
    const s = m.server();
    assert.equal(s.team, 0);
    assert.equal(s.player, 1);
  });
});

describe('scoring: sets, tie-breaks, match', () => {
  test('6-4 wins the set; 6-5 does not; 7-5 does', () => {
    const a = createMatch({ setsToWin: 2 });
    toGamesAll(a, 4);
    winGame(a, 0);
    const r = winGame(a, 0);
    assert.equal(r.setWon, true);
    assert.deepEqual(a.display().sets, [[6, 4]]);
    assert.deepEqual(a.display().games, [0, 0]);

    const b = createMatch({ setsToWin: 2 });
    toGamesAll(b, 5);
    assert.equal(winGame(b, 0).setWon, false);
    assert.deepEqual(b.display().games, [6, 5]);
    assert.equal(winGame(b, 0).setWon, true);
    assert.deepEqual(b.display().sets, [[7, 5]]);
  });

  test('tie-break at 6-6: digits, first to 7 by two', () => {
    const m = createMatch({ setsToWin: 2 });
    toGamesAll(m, 6);
    win(m, 0, 5);
    win(m, 1, 5);
    let d = m.display();
    assert.deepEqual(d.points, ['5', '5']);
    assert.equal(d.flags.goldenPoint, false, 'no golden point in a tie-break');
    m.pointWonBy(0);
    d = m.display();
    assert.equal(d.flags.setPoint, 0);
    m.pointWonBy(1); // 6-6
    assert.equal(m.pointWonBy(0).setWon, false); // 7-6, needs two
    assert.deepEqual(m.display().points, ['7', '6']);
    m.pointWonBy(1); // 7-7
    m.pointWonBy(1); // 7-8
    const r = m.pointWonBy(1); // 7-9
    assert.deepEqual(r, { gameWon: true, setWon: true, matchWon: false });
    assert.deepEqual(m.display().sets, [[6, 7]]);
    assert.deepEqual(m.display().setTiebreaks, [[7, 9]]);
    assert.equal(m.display().flags.tiebreak, false);
  });

  test('7-0 tie-break', () => {
    const m = createMatch();
    toGamesAll(m, 6);
    const r = win(m, 1, 7);
    assert.deepEqual(r, { gameWon: true, setWon: true, matchWon: true });
    assert.deepEqual(m.display().sets, [[6, 7]]);
  });

  test('advantage set (no tie-break) runs until a two-game lead', () => {
    const m = createMatch({ tiebreakAt: null, setsToWin: 2 });
    toGamesAll(m, 6);
    assert.equal(m.display().flags.tiebreak, false);
    winGame(m, 0);
    winGame(m, 1);
    assert.deepEqual(m.display().games, [7, 7]);
    winGame(m, 1);
    assert.equal(winGame(m, 1).setWon, true);
    assert.deepEqual(m.display().sets, [[7, 9]]);
  });

  test('set point and match point flags (best of three)', () => {
    const m = createMatch({ setsToWin: 2 });
    toGamesAll(m, 4);
    winGame(m, 0); // 5-4
    win(m, 0, 3); // 40-0
    let f = m.display().flags;
    assert.equal(f.gamePoint, 0);
    assert.equal(f.setPoint, 0);
    assert.equal(f.matchPoint, null);
    m.pointWonBy(0); // 6-4
    winGames(m, 0, 5);
    win(m, 0, 3);
    f = m.display().flags;
    assert.equal(f.setPoint, 0);
    assert.equal(f.matchPoint, 0);
    // Golden point at 5-0 in set 2: only team 0 has set/match point.
    win(m, 1, 3);
    f = m.display().flags;
    assert.equal(f.goldenPoint, true);
    assert.equal(f.gamePoint, null);
    assert.equal(f.setPoint, 0);
    assert.equal(f.matchPoint, 0);
    const r = m.pointWonBy(0);
    assert.deepEqual(r, { gameWon: true, setWon: true, matchWon: true });
    assert.equal(m.isOver, true);
    assert.equal(m.winner, 0);
  });

  test('receiving team break point shows as their game point', () => {
    const m = createMatch();
    win(m, 1, 3);
    assert.equal(m.server().team, 0);
    assert.equal(m.display().flags.gamePoint, 1);
  });

  test('one-set match ends and freezes', () => {
    const m = createMatch();
    winGames(m, 1, 5);
    assert.equal(m.display().flags.matchPoint, null);
    win(m, 1, 3);
    assert.equal(m.display().flags.matchPoint, 1);
    const r = m.pointWonBy(1);
    assert.deepEqual(r, { gameWon: true, setWon: true, matchWon: true });
    assert.equal(m.isOver, true);
    assert.equal(m.winner, 1);
    const d = m.display();
    assert.deepEqual(d.sets, [[0, 6]]);
    assert.deepEqual(d.games, [0, 6], 'final games stay visible');
    assert.equal(d.flags.matchPoint, null);
    assert.deepEqual(m.pointWonBy(0), { gameWon: false, setWon: false, matchWon: false });
    assert.deepEqual(m.display().sets, [[0, 6]]);
  });

  test('best of three goes to a third set', () => {
    const m = createMatch({ setsToWin: 2 });
    winGames(m, 0, 6);
    winGames(m, 1, 6);
    assert.equal(m.isOver, false);
    assert.deepEqual(m.display().sets, [[6, 0], [0, 6]]);
    winGames(m, 0, 6);
    assert.equal(m.isOver, true);
    assert.equal(m.winner, 0);
    assert.deepEqual(m.display().setsWon, [2, 1]);
  });

  test('optional super tie-break decider to 10', () => {
    const m = createMatch({ setsToWin: 2, superTiebreak: true });
    winGames(m, 0, 6);
    winGames(m, 1, 6);
    const d = m.display();
    assert.equal(d.flags.tiebreak, true);
    assert.equal(d.flags.superTiebreak, true);
    win(m, 0, 9);
    win(m, 1, 9);
    assert.deepEqual(m.display().points, ['9', '9']);
    assert.equal(m.pointWonBy(0).matchWon, false);
    m.pointWonBy(1);
    m.pointWonBy(1);
    assert.equal(m.pointWonBy(1).matchWon, true);
    assert.deepEqual(m.display().sets, [[6, 0], [0, 6], [0, 1]]);
    assert.deepEqual(m.display().setTiebreaks, [null, null, [10, 12]]);
    assert.equal(m.winner, 1);
  });

  test('shorter sets (e.g. 4 games, tie-break at 4-4)', () => {
    const m = createMatch({ gamesPerSet: 4, tiebreakAt: 4 });
    toGamesAll(m, 3);
    winGame(m, 0);
    assert.equal(winGame(m, 1).setWon, false);
    assert.equal(m.inTiebreak, true);
    assert.equal(win(m, 0, 7).matchWon, true);
    assert.deepEqual(m.display().sets, [[5, 4]]);
  });

  test('undo restores the previous score', () => {
    const m = createMatch();
    win(m, 0, 3);
    m.pointWonBy(0);
    assert.deepEqual(m.display().games, [1, 0]);
    assert.equal(m.undo(), true);
    assert.deepEqual(m.display().games, [0, 0]);
    assert.deepEqual(m.display().points, ['40', '0']);
    assert.equal(createMatch().undo(), false);
  });

  test('invalid team throws', () => {
    assert.throws(() => createMatch().pointWonBy(2), RangeError);
  });
});
