const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const path    = require('path');
const fs      = require('fs');
const db      = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─── FIND PUBLIC FOLDER (handles double-nested unzip edge cases) ──────────────
function findPublicDir() {
  const candidates = [
    path.join(__dirname, 'public'),
    path.join(__dirname, 'nba-predictor', 'public'),
    path.join(__dirname, '..', 'public'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(path.join(p, 'index.html'))) {
      console.log('✅ Found public dir at:', p);
      return p;
    }
  }
  console.error('❌ Could not find public/index.html! Searched:', candidates);
  return path.join(__dirname, 'public'); // fallback
}

const PUBLIC_DIR = findPublicDir();
app.use(express.static(PUBLIC_DIR));

// ─── ENV KEYS (set in Railway dashboard) ─────────────────────────────────────
const ODDS_API_KEY = process.env.ODDS_API_KEY || '';   // https://the-odds-api.com
const BDL_API_KEY  = process.env.BDL_API_KEY  || '';   // https://www.balldontlie.io (free)

// ─── IN-MEMORY CACHE ──────────────────────────────────────────────────────────
// { "YYYY-MM-DD": { games, odds, injuries, stats, fetchedAt } }
const cache = {};
const CACHE_TTL_MS = 30 * 1000; // 30 seconds for active day
const ODDS_TTL_MS  = 5 * 60 * 1000; // 5 min for odds (save API quota)

// ─── ESPN TEAM ID MAP ─────────────────────────────────────────────────────────
const ESPN_ABBR = {
  'Atlanta Hawks':'ATL','Boston Celtics':'BOS','Brooklyn Nets':'BKN',
  'Charlotte Hornets':'CHA','Chicago Bulls':'CHI','Cleveland Cavaliers':'CLE',
  'Dallas Mavericks':'DAL','Denver Nuggets':'DEN','Detroit Pistons':'DET',
  'Golden State Warriors':'GSW','Houston Rockets':'HOU','Indiana Pacers':'IND',
  'LA Clippers':'LAC','Los Angeles Lakers':'LAL','Memphis Grizzlies':'MEM',
  'Miami Heat':'MIA','Milwaukee Bucks':'MIL','Minnesota Timberwolves':'MIN',
  'New Orleans Pelicans':'NOP','New York Knicks':'NYK','Oklahoma City Thunder':'OKC',
  'Orlando Magic':'ORL','Philadelphia 76ers':'PHI','Phoenix Suns':'PHX',
  'Portland Trail Blazers':'POR','Sacramento Kings':'SAC','San Antonio Spurs':'SAS',
  'Toronto Raptors':'TOR','Utah Jazz':'UTA','Washington Wizards':'WAS',
};

const LOGO = abbr => `https://a.espncdn.com/i/teamlogos/nba/500/${
  ({SAS:'sa',GSW:'gs',NYK:'ny',WAS:'wsh',NOP:'no',UTA:'utah'}[abbr]||abbr.toLowerCase())
}.png`;

// ─── HELPERS ─────────────────────────────────────────────────────────────────
async function safeFetch(url, opts={}) {
  try {
    const r = await fetch(url, { timeout: 8000, ...opts });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch(e) {
    console.warn('[fetch error]', url.slice(0,80), e.message);
    return null;
  }
}

function toESPNDate(dateStr) {
  // "YYYY-MM-DD" → "YYYYMMDD"
  return dateStr.replace(/-/g, '');
}

// ─── 1. ESPN SCOREBOARD ───────────────────────────────────────────────────────
async function fetchScores(dateStr) {
  const d = toESPNDate(dateStr);
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${d}&limit=20`;
  const data = await safeFetch(url);
  if (!data?.events) return [];

  return data.events.map(ev => {
    const comp    = ev.competitions[0];
    const home    = comp.competitors.find(c => c.homeAway === 'home');
    const away    = comp.competitors.find(c => c.homeAway === 'away');
    const ABBR_FIX = {'NY':'NYK','GS':'GSW','SA':'SAS','NO':'NOP','WSH':'WAS','UTAH':'UTA'};
    const rawHome = ESPN_ABBR[home?.team?.displayName] || home?.team?.abbreviation || '???';
    const rawAway = ESPN_ABBR[away?.team?.displayName] || away?.team?.abbreviation || '???';
    const homeAbbr = ABBR_FIX[rawHome] || rawHome;
    const awayAbbr = ABBR_FIX[rawAway] || rawAway;
    const status   = ev.status?.type?.name; // 'STATUS_SCHEDULED' | 'STATUS_IN_PROGRESS' | 'STATUS_FINAL'
    const period   = ev.status?.period || 0;
    const clock    = ev.status?.displayClock || '';

    return {
      id:          ev.id,
      espnId:      ev.id,
      startTime:   ev.date,
      status:      status === 'STATUS_FINAL' ? 'closed'
                 : status === 'STATUS_IN_PROGRESS' ? 'inprogress'
                 : 'scheduled',
      period,
      clock,
      home:        homeAbbr,
      away:        awayAbbr,
      homeName:    home?.team?.displayName || homeAbbr,
      awayName:    away?.team?.displayName || awayAbbr,
      homeScore:   parseInt(home?.score || 0),
      awayScore:   parseInt(away?.score || 0),
      homeLogo:    LOGO(homeAbbr),
      awayLogo:    LOGO(awayAbbr),
      homeWinProb: parseFloat(comp.situation?.homeWinPercentage || 50),
      venue:       comp.venue?.fullName || '',
    };
  });
}

// ─── 2. ESPN INJURIES (per team) ──────────────────────────────────────────────
// ESPN team IDs for the 30 teams
const ESPN_TEAM_IDS = {
  ATL:'1',BOS:'2',BKN:'17',CHA:'30',CHI:'4',CLE:'5',DAL:'6',DEN:'7',
  DET:'8',GSW:'9',HOU:'10',IND:'11',LAC:'12',LAL:'13',MEM:'29',MIA:'14',
  MIL:'15',MIN:'16',NOP:'3',NYK:'18',OKC:'25',ORL:'19',PHI:'20',PHX:'21',
  POR:'22',SAC:'23',SAS:'24',TOR:'28',UTA:'26',WAS:'27'
};

// BallDontLie player stats cache { "SEASON": { playerId: { pts, ... } } }
const statsCache = {};

async function fetchTeamInjuries(abbr) {
  const tid = ESPN_TEAM_IDS[abbr];
  if (!tid) return [];

  // Step 1: get the list of $ref links from core API
  const listUrl = `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/teams/${tid}/injuries?limit=50`;
  const data = await safeFetch(listUrl);
  if (!data?.items?.length) return [];

  // Step 2: follow each $ref link in parallel to get actual injury details
  const refs = data.items
    .filter(item => item.$ref)
    .map(item => item.$ref);

  const details = await Promise.all(refs.map(ref => safeFetch(ref)));

  const results = [];
  for (const inj of details) {
    if (!inj) continue;
    try {
      // Fetch athlete details if we only have a $ref
      let athleteName = inj.athlete?.displayName || inj.athlete?.shortName || null;
      if (!athleteName && inj.athlete?.$ref) {
        const athlete = await safeFetch(inj.athlete.$ref);
        athleteName = athlete?.displayName || athlete?.shortName || 'Unknown';
      }

      const raw = (inj.status || inj.type?.description || inj.fantasy?.status?.description || '').toLowerCase();
      const status = (raw.includes('out') || raw.includes('doubt') || raw.includes('ir')) ? 'out'
                   : (raw.includes('quest') || raw.includes('day-to-day') || raw.includes('dtd') || raw.includes('prob')) ? 'ques'
                   : 'ques';
      // Use shortComment if available, otherwise truncate longComment to 120 chars
      const longNote = inj.longComment || inj.shortComment || inj.injury?.description || inj.type?.description || raw || '';
      const note = inj.shortComment
        ? inj.shortComment
        : longNote.length > 120 ? longNote.slice(0, 117) + '...' : longNote;

      results.push({ name: athleteName || 'Unknown', status, note, espnId: inj.athlete?.id || '' });
    } catch(e) {
      console.warn('[injury parse error]', e.message);
    }
  }

  console.log(`[injuries] ${abbr} => ${results.length} players`);
  return results;
}

// ─── 3. BALLDONTLIE PLAYER STATS ─────────────────────────────────────────────
async function fetchPlayerAvgPts(playerName, season = '2025-26') {
  if (!BDL_API_KEY) return null;
  // Search player
  const searchUrl = `https://api.balldontlie.io/v1/players?search=${encodeURIComponent(playerName)}&per_page=5`;
  const headers   = { 'Authorization': BDL_API_KEY };
  const players   = await safeFetch(searchUrl, { headers });
  if (!players?.data?.length) return null;
  const pid = players.data[0].id;

  // Get season averages
  const yr = parseInt(season.split('-')[0]);
  const avgUrl = `https://api.balldontlie.io/v1/season_averages?season=${yr}&player_ids[]=${pid}`;
  const avgs   = await safeFetch(avgUrl, { headers });
  const avg    = avgs?.data?.[0];
  if (!avg) return null;
  return { pts: parseFloat(avg.pts || 0), min: avg.min || '0' };
}

// ─── 4. THE ODDS API ─────────────────────────────────────────────────────────
// Cache odds separately — expensive API calls
let oddsCache = { data: null, fetchedAt: 0 };

async function fetchOdds() {
  if (!ODDS_API_KEY) return [];
  const now = Date.now();
  if (oddsCache.data && now - oddsCache.fetchedAt < ODDS_TTL_MS) return oddsCache.data;

  const url = `https://api.the-odds-api.com/v4/sports/basketball_nba/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=spreads,totals&oddsFormat=american&bookmakers=draftkings`;
  const data = await safeFetch(url);
  if (!data) return oddsCache.data || [];

  const mapped = (data || []).map(ev => {
    const bk      = ev.bookmakers?.[0];
    const spreads = bk?.markets?.find(m => m.key === 'spreads');
    const totals  = bk?.markets?.find(m => m.key === 'totals');

    const homeSpread = spreads?.outcomes?.find(o => o.name === ev.home_team);
    const awaySpread = spreads?.outcomes?.find(o => o.name === ev.away_team);
    const over       = totals?.outcomes?.find(o => o.name === 'Over');

    // The favourite is whichever side has a NEGATIVE spread point
    const homePt = homeSpread?.point ?? null;
    const awayPt = awaySpread?.point ?? null;
    const favSide = (homePt !== null && homePt < 0) ? 'home' : 'away';
    const favPt   = favSide === 'home' ? homePt : awayPt;

    return {
      id:           ev.id,
      homeTeam:     ev.home_team,
      awayTeam:     ev.away_team,
      commenceTime: ev.commence_time,
      spread: {
        home:    homePt,
        away:    awayPt,
        fav:     favSide,
        line:    favPt !== null ? Math.abs(favPt) : null,  // always positive number
      },
      total: over?.point || null,
    };
  });

  oddsCache = { data: mapped, fetchedAt: now };
  return mapped;
}

// Match odds to a game by team names
function matchOdds(game, allOdds) {
  if (!allOdds || !allOdds.length) return null;
  // Build nickname list for each team
  const homeWords = [
    game.home.toLowerCase(),
    ...(game.homeName || '').toLowerCase().split(' '),
  ].filter(w => w.length > 2);
  const awayWords = [
    game.away.toLowerCase(),
    ...(game.awayName || '').toLowerCase().split(' '),
  ].filter(w => w.length > 2);

  return allOdds.find(o => {
    const hn = (o.homeTeam || '').toLowerCase();
    const an = (o.awayTeam || '').toLowerCase();
    const homeMatch = homeWords.some(w => hn.includes(w));
    const awayMatch = awayWords.some(w => an.includes(w));
    return homeMatch && awayMatch;
  }) || null;
}

// ─── 5. ASSEMBLE FULL GAME DATA ───────────────────────────────────────────────
async function assembleGameData(dateStr) {
  console.log(`[assemble] ${dateStr}`);

  // Fetch scores + odds in parallel
  const [games, odds] = await Promise.all([
    fetchScores(dateStr),
    fetchOdds(),
  ]);

  if (!games.length) return { date: dateStr, games: [], fetchedAt: Date.now() };

  // Collect unique teams playing today
  const teams = [...new Set(games.flatMap(g => [g.home, g.away]))];

  // Fetch all injuries in parallel
  const injuryResults = await Promise.all(teams.map(t => fetchTeamInjuries(t)));
  const injuryMap = {};
  teams.forEach((t, i) => { injuryMap[t] = injuryResults[i] || []; });

  // Assemble each game
  const assembled = games.map(game => {
    const gameOdds = matchOdds(game, odds);
    const homeInj  = injuryMap[game.home] || [];
    const awayInj  = injuryMap[game.away] || [];

    return {
      ...game,
      odds: gameOdds ? {
        spread:    gameOdds.spread.line,   // always positive (e.g. 6.5)
        spreadFav: gameOdds.spread.fav === 'home' ? game.home : game.away,  // always ESPN abbr
        total:     gameOdds.total,
      } : null,
      injuries: {
        [game.home]: homeInj,
        [game.away]: awayInj,
      },
    };
  });

  return { date: dateStr, games: assembled, fetchedAt: Date.now() };
}

// ─── 6. BACKGROUND POLLER ────────────────────────────────────────────────────
// Polls today's date every 30s while games are live
function today() {
  return new Date().toISOString().slice(0, 10);
}

// ── PREDICTION MODEL ──────────────────────────────────────────────────────────
// Simple model: used for saving picks to DB. Mirrors evaluateGame() in frontend.
function modelPick(game) {
  const odds = game.odds;
  if (!odds || !odds.spread) return null;

  const homeInj = (game.injuries?.[game.home] || []).filter(p => p.status === 'out').length;
  const awayInj = (game.injuries?.[game.away] || []).filter(p => p.status === 'out').length;
  const totalOut = homeInj + awayInj;
  const injImpact = totalOut * 3;

  const spreadSide = odds.spreadFav;
  const spreadLine = odds.spread;
  const ouSide     = injImpact > 8 ? 'UNDER' : 'OVER';
  const ouLine     = odds.total;

  // Confidence: fewer injuries + tighter spread = higher confidence
  const conf = totalOut >= 4 ? 2 : totalOut >= 2 ? 3 : spreadLine <= 6 ? 4 : 3;

  return {
    spread: { side: spreadSide + ' -' + spreadLine, line: spreadLine, conf },
    total:  { side: ouSide + ' ' + ouLine,          line: ouLine,     conf },
  };
}

// ── RESOLVE PICK RESULT ───────────────────────────────────────────────────────
function resolveResult(game, pickType) {
  if (game.status !== 'closed') return 'pending';
  const hs = game.homeScore, as = game.awayScore;
  const tot = hs + as;
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
    const pick = game._ouPick || (tot > odds.total ? 'OVER' : 'UNDER'); // fallback
    if (tot === odds.total) return 'push';
    if (pick === 'OVER')  return tot > odds.total ? 'win' : 'loss';
    if (pick === 'UNDER') return tot < odds.total ? 'win' : 'loss';
  }
  return 'pending';
}

async function pollToday() {
  const dateStr = today();
  try {
    const existing = cache[dateStr];
    const isLive = existing?.games?.some(g => g.status === 'inprogress');
    const ttl    = isLive ? CACHE_TTL_MS : 60 * 1000;
    if (existing && Date.now() - existing.fetchedAt < ttl) return;

    const data = await assembleGameData(dateStr);
    cache[dateStr] = data;
    console.log(`[poll] ${dateStr} → ${data.games.length} games, live=${isLive}`);

    // ── SAVE TO DATABASE ──────────────────────────────────────────────────────
    for (const game of data.games) {
      try {
        await db.upsertGame(game);

        const picks = modelPick(game);
        if (!picks) continue;

        // Tag game with ouPick for result resolution
        game._ouPick = picks.total.side.startsWith('OVER') ? 'OVER' : 'UNDER';

        // Save/update spread pick
        const spreadResult = resolveResult(game, 'spread');
        await db.upsertPick(game.espnId, 'spread',
          picks.spread.side, picks.spread.line, picks.spread.conf, spreadResult);

        // Save/update total pick
        const totalResult = resolveResult(game, 'total');
        await db.upsertPick(game.espnId, 'total',
          picks.total.side, picks.total.line, picks.total.conf, totalResult);

      } catch(e) {
        console.error('[db upsert error]', game.espnId, e.message);
      }
    }
  } catch(e) {
    console.error('[poll error]', e.message);
  }
}

// Start polling immediately then every 30s
pollToday();
setInterval(pollToday, 30000);

// ─── 7. API ROUTES ────────────────────────────────────────────────────────────

// GET /api/data?date=YYYY-MM-DD
// Returns full game data for a date. Uses cache if fresh, else fetches.
app.get('/api/data', async (req, res) => {
  const dateStr = req.query.date || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
  }

  const cached = cache[dateStr];
  const isToday = dateStr === today();
  const ttl = isToday ? CACHE_TTL_MS : 5 * 60 * 1000;

  if (cached && Date.now() - cached.fetchedAt < ttl) {
    return res.json({ ...cached, cached: true });
  }

  try {
    const data = await assembleGameData(dateStr);
    cache[dateStr] = data;
    res.json({ ...data, cached: false });
  } catch(e) {
    console.error('[api/data error]', e);
    if (cached) return res.json({ ...cached, cached: true, stale: true });
    res.status(500).json({ error: e.message });
  }
});

// GET /api/dates — returns last 7 + next 7 days with game counts (uses ESPN)
app.get('/api/dates', async (req, res) => {
  const dates = [];
  const now = new Date();
  for (let i = -7; i <= 7; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }

  // Check cache first, then fetch counts in parallel (lightweight)
  const results = await Promise.all(dates.map(async dateStr => {
    if (cache[dateStr]) return { date: dateStr, count: cache[dateStr].games.length };
    const espnDate = toESPNDate(dateStr);
    const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${espnDate}&limit=1`;
    const data = await safeFetch(url);
    return { date: dateStr, count: data?.events?.length || 0 };
  }));

  res.json({ dates: results, today: today() });
});

// GET /api/player-stats?name=Joel+Embiid
app.get('/api/player-stats', async (req, res) => {
  const name = req.query.name;
  if (!name) return res.status(400).json({ error: 'name required' });
  const stats = await fetchPlayerAvgPts(name);
  res.json({ name, stats });
});

// Debug endpoint — see parsed injury data for a team
app.get('/api/debug/injuries/:abbr', async (req, res) => {
  const abbr = req.params.abbr.toUpperCase();
  const tid = ESPN_TEAM_IDS[abbr];
  if (!tid) return res.json({ error: 'Unknown team', abbr });
  const injuries = await fetchTeamInjuries(abbr);
  res.json({ abbr, tid, count: injuries.length, injuries });
});

// Debug endpoint — see raw odds data
app.get('/api/debug/odds', async (req, res) => {
  oddsCache = { data: null, fetchedAt: 0 }; // force refresh
  const odds = await fetchOdds();
  res.json({ count: odds.length, sample: odds.slice(0,3) });
});

// GET /api/stats?days=30 — model performance
app.get('/api/stats', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const stats = await db.getStats(days);
    res.json(stats);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/history?date=YYYY-MM-DD — saved games + picks for a date
app.get('/api/history', async (req, res) => {
  const dateStr = req.query.date || today();
  try {
    const rows = await db.getHistoryForDate(dateStr);
    res.json({ date: dateStr, games: rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status:  'ok',
    uptime:  process.uptime(),
    cached:  Object.keys(cache).length,
    today:   today(),
    keys: {
      oddsApi: !!ODDS_API_KEY,
      bdlApi:  !!BDL_API_KEY,
      database: !!(process.env.DATABASE_URL),
    }
  });
});

// Serve frontend for all other routes
app.get('*', (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send(`
      <h2>⚠️ index.html not found</h2>
      <p>Looked in: ${PUBLIC_DIR}</p>
      <p>__dirname: ${__dirname}</p>
      <p>Files here: ${fs.readdirSync(__dirname).join(', ')}</p>
    `);
  }
});

// ── BACKGROUND BACKFILL ──────────────────────────────────────────────────────
// Runs once at startup to load recent history. Non-blocking — server starts immediately.
function runBackfillInBackground(days) {
  try {
    console.log('[backfill] Starting in background for last ' + days + ' days...');
    const { spawn } = require('child_process');
    const child = spawn('node', ['backfill.js', '--days=' + days], {
      cwd: __dirname,
      env: process.env,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', d => process.stdout.write('[backfill] ' + d));
    child.stderr.on('data', d => process.stderr.write('[backfill] ' + d));
    child.on('error', e => console.warn('[backfill] spawn error:', e.message));
    child.on('close', code => console.log('[backfill] Done, exit code:', code));
  } catch(e) {
    console.warn('[backfill] Could not start:', e.message);
  }
}

// Start server immediately — DB init happens in background
app.listen(PORT, () => {
  console.log('🏀 NBA Predictor API running on port ' + PORT);
  console.log('   Odds API: ' + (ODDS_API_KEY ? '✅ configured' : '❌ not set'));
  console.log('   BDL API:  ' + (BDL_API_KEY  ? '✅ configured' : '❌ not set'));
  console.log('   Database: ' + (process.env.DATABASE_URL ? '✅ PostgreSQL' : '📁 file fallback'));
});

// Init DB after server is already listening — never blocks or crashes server
db.initDB()
  .then(() => {
    console.log('[db] Ready — starting background backfill...');
    setTimeout(() => runBackfillInBackground(150), 3000);
  })
  .catch(e => {
    console.warn('[db] Init failed (server still running):', e.message);
  });
