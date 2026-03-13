# 🏀 NBA Predictor — Automated Live Dashboard

Auto-refreshing NBA dashboard: live scores, betting lines, injuries — all in one dark UI.

## What it fetches automatically
| Data | Source | Free? |
|------|--------|-------|
| Live scores + game clock | ESPN public API | ✅ Free, no key |
| Team injuries + status | ESPN public API | ✅ Free, no key |
| Spreads + O/U lines | The Odds API (DraftKings) | ✅ Free (500 req/mo) |
| Player PPG stats | BallDontLie API | ✅ Free with key |

---

## Step 1 — Get API Keys (both free)

### The Odds API
1. Go to https://the-odds-api.com
2. Click **Get API Key** → sign up free
3. Copy your key (looks like: `abc123def456...`)

### BallDontLie API
1. Go to https://www.balldontlie.io
2. Sign up free → go to your dashboard
3. Copy your API key

---

## Step 2 — Deploy to Railway (free plan)

1. **Install Railway CLI** (optional but easier):
   ```bash
   npm install -g @railway/cli
   railway login
   ```

2. **Upload to GitHub first:**
   ```bash
   git init
   git add .
   git commit -m "Initial NBA Predictor"
   # Create a new repo on github.com then:
   git remote add origin https://github.com/YOUR_USERNAME/nba-predictor.git
   git push -u origin main
   ```

3. **Go to railway.app:**
   - Click **New Project** → **Deploy from GitHub repo**
   - Select your `nba-predictor` repo
   - Railway auto-detects Node.js and deploys

4. **Set Environment Variables in Railway:**
   - Go to your project → **Variables** tab
   - Add:
     ```
     ODDS_API_KEY = your_key_from_step_1
     BDL_API_KEY  = your_key_from_step_1
     ```
   - Railway auto-restarts with the new keys

5. **Get your URL:**
   - Railway gives you a free URL like `nba-predictor-production.up.railway.app`
   - Open it — dashboard loads automatically!

---

## Step 3 — Local Testing (optional)

```bash
# Create .env file
echo "ODDS_API_KEY=your_key_here" >> .env
echo "BDL_API_KEY=your_key_here" >> .env

# Install and run
npm install
node index.js

# Open: http://localhost:3000
```

---

## How it works

```
Railway Server (runs 24/7)
│
├── Polls ESPN every 30s → live scores + game clock
├── Polls ESPN every 60s → team injury reports
├── Polls Odds API every 5min → spreads + O/U lines (saves quota)
├── BallDontLie → player PPG stats (on demand)
│
└── Serves to browser:
    ├── GET /api/data?date=YYYY-MM-DD  → full game data
    ├── GET /api/dates                  → 7-day date chips
    └── GET /                           → dashboard HTML
```

**Frontend auto-refreshes every 30 seconds** on today's date.
Selecting a past date shows that day's data without auto-refresh.

---

## Extending the Model

The prediction model lives in `evaluateGame()` in `public/index.html`.
Currently uses: injury count + odds line value.

To add your full model:
1. Add model logic to `evaluateGame(g)` — receives the full game object
2. Return picks, confidence, difficulty, reasoning
3. Everything else (rendering, accordion, scoring) is automatic

---

## Railway Free Plan Limits
- **$5 free credit/month** (enough for ~500 hours — basically unlimited for this)
- If you exceed: upgrade to Hobby ($5/mo) or it sleeps
- Alternatively: Render.com free tier (750 hrs/mo, also works)

---

## API Quota Notes
- **The Odds API free**: 500 requests/month. At 1 req/5min = 8,640/mo. 
  → Reduce to 1 req/15min if needed: change `ODDS_TTL_MS` in index.js
- **BallDontLie free**: 60 req/min, unlimited/month ✅
- **ESPN**: No limits, public API ✅
