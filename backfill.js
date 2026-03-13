// ─── BACKFILL SCRIPT ──────────────────────────────────────────────────────────
// Run once to load all historical NBA games into the database.
// Usage: node backfill.js
// Usage: node backfill.js --from=2026-01-01 --to=2026-03-13
// Usage: node backfill.js --days=30   (last 30 days only)
//
// It uses the same ESPN + Odds API logic as the main server, but:
//   - Skips the Odds API (past games have no odds lines)
//   - Reads odds from the ESPN game data if available
//   - Resolves all results immediately since games are finished
// ─────────────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');
const db    = require('./db');

// ── CLI ARGS ──────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => a.slice(2).split('='))
);

function toDate(str) { return new Date(str + 'T12:00:00Z'); }
function fmtDate(d)  { return d.toISOString().slice(0, 10); }

let startDate, endDate;

if (args.from && args.to) {
  startDate = toDate(args.from);
  endDate   = toDate(args.to);
} else if (args.days) {
  endDate   = new Date();
  startDate = new Date();
  startDate.setDate(startDate.getDate() - parseInt(args.days));
} else {
  // Default: entire 2025-26 NBA season (Oct 22 2025 → today)
  startDate = toDate('2025-10-22');
  endDate   = new Date();
}

// ── ESPN HELPERS ──────────────────────────────────────────────────────────────
const ESPN_ABBR = {
  'Atlanta Hawks':'ATL','Boston Celtics':'BOS','Brooklyn Nets':'BKN',
  'Charlotte Hornets':'CHA','Chicago Bulls':'CHI','Cleveland Cavaliers':'CLE',
  'Dallas Mavericks':'DAL','Denver Nuggets':'DEN','Detroit Pistons':'DET',
  'Golden State Warriors':'GSW','Houston Rockets':'HOU','Indiana Pacers':'IND',
  'Los Angeles Clippers':'LAC','Los Angeles Lakers':'LAL','Memphis Grizzlies':'MEM',
  'Miami Heat':'MIA','Milwaukee Bucks':'MIL','Minnesota Timberwolves':'MIN',
  'New Orleans Pelicans':'NOP','New York Knicks':'NYK','Oklahoma City Thunder':'OKC',
  'Orlando Magic':'ORL','Philadelphia 76ers':'PHI','Phoenix Suns':'PHX',
  'Portland Trail Blazers':'POR','Sacramento Kings':'SAC','San Antonio Spurs':'SAS',
  'Toronto Raptors':'TOR','Utah Jazz':'UTA','Washington Wizards':'WAS',
};

function toESPNDate(d) { return d.replace(/-/g, ''); }

async function safeFetch(url) {
  try {
    const r = await fetch(url, { timeout: 10000 });
    if (!r.ok) return null;
    return r.json();
  } catch(e) {
    return null;
  }
}

async function fetchScoresForDate(dateStr) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${toESPNDate(dateStr)}&limit=20`;
  const data = await safeFetch(url);
  if (!data?.events?.length) return [];

  return data.events.map(ev => {
    const comp    = ev.competitions[0];
    const home    = comp.competitors.find(c => c.homeAway === 'home');
    const away    = comp.competitors.find(c => c.homeAway === 'away');
    const homeAbbr = ESPN_ABBR[home?.team?.displayName] || home?.team?.abbreviation || '???';
    const awayAbbr = ESPN_ABBR[away?.team?.displayName] || away?.team?.abbreviation || '???';
    const statusName = ev.status?.type?.name;

    // Try to extract odds from ESPN competition odds data
    const espnOdds  = comp.odds?.[0];
    let spread = null, spreadFav = null, total = null;
    if (espnOdds) {
      const details = espnOdds.details || '';        // e.g. "DET -6.5"
      const overUnder = espnOdds.overUnder || null;
      if (overUnder) total = parseFloat(overUnder);
      const m = details.match(/([A-Z]+)\s+([-+]?\d+\.?\d*)/);
      if (m) {
        const rawLine = parseFloat(m[2]);
        spreadFav = m[1];
        spread    = Math.abs(rawLine);
      }
    }

    return {
      espnId:    ev.id,
      startTime: ev.date,
      status:    statusName === 'STATUS_FINAL'       ? 'closed'
               : statusName === 'STATUS_IN_PROGRESS' ? 'inprogress'
               : 'scheduled',
      home:      homeAbbr, away: awayAbbr,
      homeName:  home?.team?.displayName || homeAbbr,
      awayName:  away?.team?.displayName || awayAbbr,
      homeScore: parseInt(home?.score || 0),
      awayScore: parseInt(away?.score || 0),
      venue:     comp.venue?.fullName || '',
      odds:      spread ? { spread, spreadFav, total } : null,
      injuries:  { [homeAbbr]: [], [awayAbbr]: [] },  // no injuries for past games
    };
  });
}

// ── PREDICTION MODEL (mirrors main server) ────────────────────────────────────
function modelPick(game) {
  const odds = game.odds;
  if (!odds?.spread || !odds?.spreadFav) return null;

  const ouSide = 'OVER';   // no injury data for historical — default to OVER
  const conf   = 3;        // default confidence for historical games

  return {
    spread: { side: odds.spreadFav + ' -' + odds.spread, line: odds.spread, conf },
    total:  { side: ouSide + ' ' + odds.total,           line: odds.total,  conf },
  };
}

function resolveResult(game, pickType, ouSide) {
  if (game.status !== 'closed') return 'pending';
  const hs = game.homeScore, as = game.awayScore, tot = hs + as;
  const odds = game.odds;
  if (!odds) return 'pending';

  if (pickType === 'spread') {
    if (!odds.spread || !odds.spreadFav) return 'pending';
    const favScore = odds.spreadFav === game.home ? hs : as;
    const dogScore = odds.spreadFav === game.home ? as : hs;
    const margin   = favScore - dogScore;
    if (margin > odds.spread)  return 'win';
    if (margin === odds.spread) return 'push';
    return 'loss';
  }

  if (pickType === 'total') {
    if (!odds.total) return 'pending';
    if (tot === odds.total) return 'push';
    if (ouSide === 'OVER')  return tot > odds.total ? 'win' : 'loss';
    if (ouSide === 'UNDER') return tot < odds.total ? 'win' : 'loss';
  }
  return 'pending';
}

// ── MAIN BACKFILL LOOP ────────────────────────────────────────────────────────
async function run() {
  console.log('\n🏀 NBA Predictor — Backfill Script');
  console.log('══════════════════════════════════');
  console.log(`Date range: ${fmtDate(startDate)} → ${fmtDate(endDate)}`);
  console.log('');

  await db.initDB();

  // Build list of dates
  const dates = [];
  const cur = new Date(startDate);
  while (cur <= endDate) {
    dates.push(fmtDate(cur));
    cur.setDate(cur.getDate() + 1);
  }

  console.log(`Fetching ${dates.length} dates...\n`);

  let totalGames = 0, totalPicks = 0, totalWins = 0, totalLosses = 0;
  let datesWithGames = 0;

  for (let i = 0; i < dates.length; i++) {
    const dateStr = dates[i];
    process.stdout.write(`[${i+1}/${dates.length}] ${dateStr} ... `);

    try {
      const games = await fetchScoresForDate(dateStr);

      if (!games.length) {
        process.stdout.write('no games\n');
        // Small delay to avoid hammering ESPN
        await sleep(200);
        continue;
      }

      datesWithGames++;
      let datePicks = 0, dateWins = 0, dateLosses = 0;

      for (const game of games) {
        await db.upsertGame(game);
        totalGames++;

        const picks = modelPick(game);
        if (!picks) continue;

        const ouSide = picks.total.side.startsWith('OVER') ? 'OVER' : 'UNDER';

        const spreadResult = resolveResult(game, 'spread', null);
        await db.upsertPick(game.espnId, 'spread',
          picks.spread.side, picks.spread.line, picks.spread.conf, spreadResult);

        const totalResult = resolveResult(game, 'total', ouSide);
        await db.upsertPick(game.espnId, 'total',
          picks.total.side, picks.total.line, picks.total.conf, totalResult);

        datePicks += 2;
        if (spreadResult === 'win') { dateWins++;   totalWins++; }
        if (spreadResult === 'loss') { dateLosses++; totalLosses++; }
        if (totalResult  === 'win') { dateWins++;   totalWins++; }
        if (totalResult  === 'loss') { dateLosses++; totalLosses++; }
      }

      totalPicks += datePicks;
      const dateRate = (dateWins + dateLosses) > 0
        ? Math.round(dateWins / (dateWins + dateLosses) * 100) + '%'
        : '—';

      process.stdout.write(`${games.length} games · ${datePicks} picks · ${dateWins}W-${dateLosses}L (${dateRate})\n`);

    } catch(e) {
      process.stdout.write(`ERROR: ${e.message}\n`);
    }

    // Polite delay between requests
    await sleep(300);
  }

  // Summary
  const winRate = (totalWins + totalLosses) > 0
    ? Math.round(totalWins / (totalWins + totalLosses) * 100)
    : 0;

  console.log('\n══════════════════════════════════');
  console.log('✅ Backfill Complete');
  console.log(`   Dates processed : ${dates.length} (${datesWithGames} had games)`);
  console.log(`   Games saved      : ${totalGames}`);
  console.log(`   Picks saved      : ${totalPicks}`);
  console.log(`   Record           : ${totalWins}W - ${totalLosses}L (${winRate}%)`);
  console.log('══════════════════════════════════\n');

  process.exit(0);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
