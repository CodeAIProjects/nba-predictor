// ─── DATABASE LAYER ───────────────────────────────────────────────────────────
// Uses PostgreSQL on Railway (free). Falls back to JSON file if no DB configured.
// Set DATABASE_URL env var in Railway to enable PostgreSQL.

const fs   = require('fs');
const path = require('path');

let pgClient = null;
let useFile  = false;
const FILE_PATH = path.join(__dirname, 'data.json');

// ── INIT ──────────────────────────────────────────────────────────────────────
async function initDB() {
  const dbUrl = process.env.DATABASE_URL;

  if (dbUrl) {
    try {
      let Client;
      try { Client = require('pg').Client; }
      catch(e) { console.warn('⚠️  pg module not found, using file storage'); throw e; }
      pgClient = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
      await pgClient.connect();
      await createTables();
      console.log('✅ PostgreSQL connected');
      return;
    } catch(e) {
      pgClient = null;
      console.warn('⚠️  PostgreSQL failed, falling back to file storage:', e.message);
    }
  }

  // Fallback: JSON file storage
  useFile = true;
  if (!fs.existsSync(FILE_PATH)) fs.writeFileSync(FILE_PATH, JSON.stringify({ games: {}, picks: {} }));
  console.log('📁 Using file storage (set DATABASE_URL for PostgreSQL)');
}

async function createTables() {
  await pgClient.query(`
    CREATE TABLE IF NOT EXISTS games (
      espn_id       TEXT PRIMARY KEY,
      game_date     DATE NOT NULL,
      home_team     TEXT NOT NULL,
      away_team     TEXT NOT NULL,
      home_name     TEXT,
      away_name     TEXT,
      venue         TEXT,
      start_time    TIMESTAMPTZ,
      status        TEXT DEFAULT 'scheduled',
      home_score    INTEGER DEFAULT 0,
      away_score    INTEGER DEFAULT 0,
      spread        NUMERIC,
      spread_fav    TEXT,
      total         NUMERIC,
      home_injuries JSONB DEFAULT '[]',
      away_injuries JSONB DEFAULT '[]',
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS picks (
      id            SERIAL PRIMARY KEY,
      espn_id       TEXT NOT NULL REFERENCES games(espn_id) ON DELETE CASCADE,
      pick_type     TEXT NOT NULL,   -- 'spread' or 'total'
      pick_side     TEXT NOT NULL,   -- e.g. 'DET -6.5' or 'OVER 224.5'
      line          NUMERIC,
      model_conf    INTEGER DEFAULT 3, -- 1-5 stars
      result        TEXT DEFAULT 'pending', -- pending/win/loss/push
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(espn_id, pick_type)
    );

    CREATE INDEX IF NOT EXISTS idx_games_date   ON games(game_date);
    CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);
    CREATE INDEX IF NOT EXISTS idx_picks_result ON picks(result);
  `);
}

// ── FILE STORAGE HELPERS ──────────────────────────────────────────────────────
function readFile() {
  try { return JSON.parse(fs.readFileSync(FILE_PATH, 'utf8')); }
  catch(e) { return { games: {}, picks: {} }; }
}
function writeFile(data) {
  fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2));
}

// ── UPSERT GAME ───────────────────────────────────────────────────────────────
// Called every poll — saves new games, updates scores/status on existing ones
async function upsertGame(g) {
  const homeInj = JSON.stringify((g.injuries || {})[g.home] || []);
  const awayInj = JSON.stringify((g.injuries || {})[g.away] || []);
  const spread  = g.odds?.spread    ?? null;
  const favTeam = g.odds?.spreadFav ?? null;
  const total   = g.odds?.total     ?? null;

  if (pgClient) {
    await pgClient.query(`
      INSERT INTO games
        (espn_id, game_date, home_team, away_team, home_name, away_name, venue,
         start_time, status, home_score, away_score, spread, spread_fav, total,
         home_injuries, away_injuries, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
      ON CONFLICT (espn_id) DO UPDATE SET
        status        = EXCLUDED.status,
        home_score    = EXCLUDED.home_score,
        away_score    = EXCLUDED.away_score,
        spread        = COALESCE(EXCLUDED.spread,    games.spread),
        spread_fav    = COALESCE(EXCLUDED.spread_fav, games.spread_fav),
        total         = COALESCE(EXCLUDED.total,     games.total),
        home_injuries = EXCLUDED.home_injuries,
        away_injuries = EXCLUDED.away_injuries,
        updated_at    = NOW()
    `, [
      g.espnId, g.startTime?.slice(0,10) || new Date().toISOString().slice(0,10),
      g.home, g.away, g.homeName, g.awayName, g.venue,
      g.startTime, g.status, g.homeScore, g.awayScore,
      spread, favTeam, total, homeInj, awayInj,
    ]);
    return;
  }

  // File fallback
  const db = readFile();
  const existing = db.games[g.espnId] || {};
  db.games[g.espnId] = {
    ...existing,
    espnId: g.espnId, date: g.startTime?.slice(0,10),
    home: g.home, away: g.away, homeName: g.homeName, awayName: g.awayName,
    venue: g.venue, startTime: g.startTime, status: g.status,
    homeScore: g.homeScore, awayScore: g.awayScore,
    spread: spread ?? existing.spread,
    spreadFav: favTeam ?? existing.spreadFav,
    total: total ?? existing.total,
    homeInjuries: JSON.parse(homeInj),
    awayInjuries: JSON.parse(awayInj),
    updatedAt: new Date().toISOString(),
  };
  writeFile(db);
}

// ── UPSERT PICK ───────────────────────────────────────────────────────────────
// Save model pick when first seen; resolve result when game closes
async function upsertPick(espnId, pickType, pickSide, line, modelConf, result) {
  if (pgClient) {
    await pgClient.query(`
      INSERT INTO picks (espn_id, pick_type, pick_side, line, model_conf, result, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,NOW())
      ON CONFLICT (espn_id, pick_type) DO UPDATE SET
        result     = CASE WHEN picks.result = 'pending' OR $6 != 'pending'
                          THEN EXCLUDED.result ELSE picks.result END,
        updated_at = NOW()
    `, [espnId, pickType, pickSide, line, modelConf, result]);
    return;
  }

  // File fallback
  const db = readFile();
  const key = espnId + '_' + pickType;
  const existing = db.picks[key] || {};
  db.picks[key] = {
    ...existing,
    espnId, pickType, pickSide, line, modelConf,
    result: (existing.result && existing.result !== 'pending' && result === 'pending')
            ? existing.result : result,
    updatedAt: new Date().toISOString(),
  };
  writeFile(db);
}

// ── GET STATS ─────────────────────────────────────────────────────────────────
async function getStats(days) {
  const since = new Date();
  since.setDate(since.getDate() - (days || 30));
  const sinceStr = since.toISOString().slice(0,10);

  if (pgClient) {
    const overall = await pgClient.query(`
      SELECT
        COUNT(*) FILTER (WHERE result='win')  AS wins,
        COUNT(*) FILTER (WHERE result='loss') AS losses,
        COUNT(*) FILTER (WHERE result='push') AS pushes,
        COUNT(*) FILTER (WHERE result='pending') AS pending,
        COUNT(*) AS total
      FROM picks p
      JOIN games g ON g.espn_id = p.espn_id
      WHERE g.game_date >= $1
    `, [sinceStr]);

    const byType = await pgClient.query(`
      SELECT
        pick_type,
        COUNT(*) FILTER (WHERE result='win')  AS wins,
        COUNT(*) FILTER (WHERE result='loss') AS losses,
        COUNT(*) FILTER (WHERE result='push') AS pushes,
        COUNT(*) AS total
      FROM picks p
      JOIN games g ON g.espn_id = p.espn_id
      WHERE g.game_date >= $1
      GROUP BY pick_type
    `, [sinceStr]);

    const byConf = await pgClient.query(`
      SELECT
        model_conf,
        COUNT(*) FILTER (WHERE result='win')  AS wins,
        COUNT(*) FILTER (WHERE result='loss') AS losses,
        COUNT(*) AS total
      FROM picks p
      JOIN games g ON g.espn_id = p.espn_id
      WHERE g.game_date >= $1 AND result != 'pending'
      GROUP BY model_conf
      ORDER BY model_conf DESC
    `, [sinceStr]);

    const recent = await pgClient.query(`
      SELECT
        g.game_date, g.home_team, g.away_team,
        g.home_score, g.away_score,
        g.spread, g.spread_fav, g.total,
        p.pick_type, p.pick_side, p.result, p.model_conf
      FROM picks p
      JOIN games g ON g.espn_id = p.espn_id
      WHERE g.game_date >= $1
      ORDER BY g.game_date DESC, g.start_time DESC
      LIMIT 100
    `, [sinceStr]);

    return {
      since: sinceStr,
      overall: overall.rows[0],
      byType:  byType.rows,
      byConf:  byConf.rows,
      recent:  recent.rows,
    };
  }

  // File fallback stats
  const db = readFile();
  const picks = Object.values(db.picks).filter(p => {
    const g = db.games[p.espnId];
    return g && g.date >= sinceStr;
  });
  const wins    = picks.filter(p => p.result === 'win').length;
  const losses  = picks.filter(p => p.result === 'loss').length;
  const pushes  = picks.filter(p => p.result === 'push').length;
  const pending = picks.filter(p => p.result === 'pending').length;

  const byType = ['spread','total'].map(t => {
    const tp = picks.filter(p => p.pickType === t);
    return { pick_type: t, wins: tp.filter(p=>p.result==='win').length, losses: tp.filter(p=>p.result==='loss').length, total: tp.length };
  });

  const recent = picks
    .map(p => ({ ...p, ...db.games[p.espnId] }))
    .sort((a,b) => b.date?.localeCompare(a.date))
    .slice(0, 100);

  return { since: sinceStr, overall: { wins, losses, pushes, pending, total: picks.length }, byType, byConf: [], recent };
}

// ── GET HISTORY FOR DATE ──────────────────────────────────────────────────────
async function getHistoryForDate(dateStr) {
  if (pgClient) {
    const res = await pgClient.query(`
      SELECT g.*, 
        json_agg(json_build_object(
          'pickType', p.pick_type, 'pickSide', p.pick_side,
          'line', p.line, 'modelConf', p.model_conf, 'result', p.result
        )) AS picks
      FROM games g
      LEFT JOIN picks p ON p.espn_id = g.espn_id
      WHERE g.game_date = $1
      GROUP BY g.espn_id
      ORDER BY g.start_time
    `, [dateStr]);
    return res.rows;
  }

  const db = readFile();
  return Object.values(db.games)
    .filter(g => g.date === dateStr)
    .map(g => ({
      ...g,
      picks: Object.values(db.picks).filter(p => p.espnId === g.espnId),
    }));
}

module.exports = { initDB, upsertGame, upsertPick, getStats, getHistoryForDate };
