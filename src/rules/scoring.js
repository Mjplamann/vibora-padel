// Padel match scoring (FIP): points 15/30/40, golden point (punto de oro) or
// advantage, games, sets with a 2-game margin, tie-break at 6-6, optional
// super tie-break as the deciding set, server rotation and service box.
// Pure module: no DOM, no three.
//
// Server rotation: teams alternate every game; within a team the two players
// alternate on that team's turns, so with A,B on team 0 and C,D on team 1 the
// order is A, C, B, D, A, ... It carries over across sets. A tie-break is
// opened by the player whose turn it is; the first point is a single serve,
// then each player serves two points (tennis-style). The next set is opened by
// the team that received first in the tie-break.
//
// Box: the first point of every game is served from the right box, then the
// box alternates by point parity (deuce, 40-40 and every even point count are
// played from the right). The same parity rule gives the tie-break pattern
// R | L R | L R | ...

const POINT_NAMES = ['0', '15', '30', '40'];

/**
 * @param {object} o
 * @param {number} [o.gamesPerSet=6]
 * @param {number} [o.setsToWin=1]
 * @param {boolean} [o.goldenPoint=true]
 * @param {number|null} [o.tiebreakAt=6] games-all score that triggers a tie-break (null/false: advantage sets)
 * @param {number} [o.tiebreakTo=7]
 * @param {{team:0|1, player:0|1}} [o.firstServer]
 * @param {0|1} [o.otherTeamFirstPlayer=0] player of the other team who serves that team's first game
 * @param {boolean} [o.superTiebreak=false] play the deciding set as a super tie-break
 * @param {number} [o.superTiebreakTo=10]
 */
export function createMatch({
  gamesPerSet = 6,
  setsToWin = 1,
  goldenPoint = true,
  tiebreakAt = 6,
  tiebreakTo = 7,
  firstServer = { team: 0, player: 0 },
  otherTeamFirstPlayer = 0,
  superTiebreak = false,
  superTiebreakTo = 10,
} = {}) {
  const cfg = {
    gamesPerSet,
    setsToWin,
    goldenPoint,
    tiebreakAt: tiebreakAt === null || tiebreakAt === false ? null : tiebreakAt,
    tiebreakTo,
    superTiebreak: !!superTiebreak && setsToWin > 1,
    superTiebreakTo,
    t0: firstServer.team === 1 ? 1 : 0,
    p0: firstServer.player === 1 ? 1 : 0,
    q0: otherTeamFirstPlayer === 1 ? 1 : 0,
  };

  let s = {
    points: [0, 0], // points in the current game or tie-break
    pointsInGame: 0,
    games: [0, 0],
    sets: [], // completed sets [[a, b], ...]
    setTiebreaks: [], // per completed set: tie-break points [a, b] or null
    setsWon: [0, 0],
    turn: 0, // service turn counter for regular games
    tiebreak: false,
    superTb: false,
    tbStartTurn: 0,
    over: false,
    winner: null,
  };

  function cloneState(src) {
    return {
      ...src,
      points: src.points.slice(),
      games: src.games.slice(),
      sets: src.sets.map((x) => x.slice()),
      setTiebreaks: src.setTiebreaks.map((x) => (x ? x.slice() : null)),
      setsWon: src.setsWon.slice(),
    };
  }

  function serverOfTurn(k) {
    const team = (cfg.t0 + k) % 2;
    const flip = Math.floor(k / 2) % 2;
    const first = team === cfg.t0 ? cfg.p0 : cfg.q0;
    return { team, player: first ^ flip };
  }

  function currentTurn(st) {
    if (!st.tiebreak) return st.turn;
    const i = st.pointsInGame;
    return st.tbStartTurn + (i === 0 ? 0 : Math.floor((i + 1) / 2));
  }

  function tiebreakTarget(st) {
    return st.superTb ? cfg.superTiebreakTo : cfg.tiebreakTo;
  }

  function startTiebreak(st, superTb) {
    st.tiebreak = true;
    st.superTb = superTb;
    st.tbStartTurn = st.turn;
  }

  function winSet(st, team, tbPoints) {
    st.sets.push([st.games[0], st.games[1]]);
    st.setTiebreaks.push(tbPoints);
    st.setsWon[team]++;
    if (st.tiebreak) {
      // The team that received first in the tie-break serves first next set.
      st.turn = st.tbStartTurn + 1;
      st.tiebreak = false;
      st.superTb = false;
    }
    if (st.setsWon[team] >= cfg.setsToWin) {
      st.over = true;
      st.winner = team;
      return true;
    }
    st.games = [0, 0];
    const decider = st.setsWon[0] === cfg.setsToWin - 1 && st.setsWon[1] === cfg.setsToWin - 1;
    if (cfg.superTiebreak && decider) startTiebreak(st, true);
    return false;
  }

  /** Applies one point to state `st` (mutated). */
  function applyPoint(st, team) {
    const res = { gameWon: false, setWon: false, matchWon: false };
    if (st.over) return res;
    const o = 1 - team;
    st.points[team]++;
    st.pointsInGame++;
    const a = st.points[team];
    const b = st.points[o];

    if (st.tiebreak) {
      if (a >= tiebreakTarget(st) && a - b >= 2) {
        const tbPoints = st.points.slice();
        if (st.superTb) st.games[team] = 1; // a super tie-break set is recorded 1-0
        else st.games[team]++;
        st.points = [0, 0];
        st.pointsInGame = 0;
        res.gameWon = true;
        res.setWon = true;
        res.matchWon = winSet(st, team, tbPoints);
      }
      return res;
    }

    const gameWon = cfg.goldenPoint ? a >= 4 : a >= 4 && a - b >= 2;
    if (!gameWon) return res;
    res.gameWon = true;
    st.points = [0, 0];
    st.pointsInGame = 0;
    st.games[team]++;
    st.turn++;
    const g = st.games[team];
    const h = st.games[o];
    if (g >= cfg.gamesPerSet && g - h >= 2) {
      res.setWon = true;
      res.matchWon = winSet(st, team, null);
    } else if (cfg.tiebreakAt !== null && g === cfg.tiebreakAt && h === cfg.tiebreakAt) {
      startTiebreak(st, false);
    }
    return res;
  }

  function pointLabels(st) {
    const [a, b] = st.points;
    if (st.tiebreak) return [String(a), String(b)];
    if (!cfg.goldenPoint && a >= 3 && b >= 3) {
      if (a === b) return ['40', '40'];
      return a > b ? ['AD', ''] : ['', 'AD'];
    }
    return [POINT_NAMES[Math.min(a, 3)], POINT_NAMES[Math.min(b, 3)]];
  }

  /** Team that would win `key` ('gameWon'|'setWon'|'matchWon') with the next point; null if none or both. */
  function pointFor(key) {
    if (s.over) return null;
    const w0 = applyPoint(cloneState(s), 0)[key];
    const w1 = applyPoint(cloneState(s), 1)[key];
    if (w0 && !w1) return 0;
    if (w1 && !w0) return 1;
    return null;
  }

  function server() {
    const sv = serverOfTurn(currentTurn(s));
    return { team: sv.team, player: sv.player, box: s.pointsInGame % 2 === 0 ? 'right' : 'left' };
  }

  function display() {
    const sv = server();
    const lastSet = s.sets[s.sets.length - 1];
    return {
      points: s.over ? ['', ''] : pointLabels(s),
      games: s.over && lastSet ? lastSet.slice() : s.games.slice(),
      sets: s.sets.map((x) => x.slice()),
      setTiebreaks: s.setTiebreaks.map((x) => (x ? x.slice() : null)),
      setsWon: s.setsWon.slice(),
      server: { team: sv.team, player: sv.player },
      box: sv.box,
      flags: {
        goldenPoint: !s.over && !s.tiebreak && cfg.goldenPoint && s.points[0] === 3 && s.points[1] === 3,
        gamePoint: pointFor('gameWon'),
        setPoint: pointFor('setWon'),
        matchPoint: pointFor('matchWon'),
        tiebreak: s.tiebreak,
        superTiebreak: s.superTb,
        deuce: !s.over && !s.tiebreak && !cfg.goldenPoint && s.points[0] >= 3 && s.points[0] === s.points[1],
      },
      isOver: s.over,
      winner: s.winner,
    };
  }

  const history = [];

  return {
    config: Object.freeze({ ...cfg }),
    pointWonBy(team) {
      if (team !== 0 && team !== 1) throw new RangeError(`team must be 0 or 1, got ${team}`);
      if (!s.over) history.push(cloneState(s));
      return applyPoint(s, team);
    },
    /** Reverts the last point (referee overrule / misdetected hit). Returns false if nothing to undo. */
    undo() {
      if (!history.length) return false;
      s = history.pop();
      return true;
    },
    display,
    server,
    /** Raw point counts in the current game/tie-break. */
    get points() {
      return s.points.slice();
    },
    get games() {
      return s.games.slice();
    },
    get inTiebreak() {
      return s.tiebreak;
    },
    get isOver() {
      return s.over;
    },
    get winner() {
      return s.winner;
    },
  };
}
