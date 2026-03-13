# NBA Predictor v3.0 — Setup Guide

## What This Does
- Auto-fetches live NBA scores every 30 seconds (ESPN, free, no key)
- Fetches spread + O/U lines from The Odds API (free tier: 500 req/month)
- Fetches injury reports per team from ESPN (free, no key)
- Fetches player PPG stats from BallDontLie (free tier, needs key)
- Date picker — browse any day's games, past or upcoming
- Fully deployed on Vercel free tier

---

## Step 1 — Get Your API Keys (Free)

### The Odds API (spreads + totals)
1. Go to https://the-odds-api.com
2. Click "Get API Key" — free, no credit card
3. Free tier: **500 requests/month** (enough for ~16 days of daily use)
4. Copy your key — looks like: `abc123def456...`

### BallDontLie (player stats / PPG)
1. Go to https://www.balldontlie.io
2. Sign up free — get API key instantly
3. Free tier: 60 requests/minute — more than enough
4. Copy your key

---

## Step 2 — Deploy to Vercel

### Install Vercel CLI
```bash
npm install -g vercel
```

### Deploy
```bash
cd nba-predictor
vercel
```

Follow the prompts:
- Set up and deploy? **Y**
- Which scope? **your username**
- Link to existing project? **N**
- Project name? **nba-predictor** (or anything)
- Directory? **.** (current)
- Override settings? **N**

Your site will be live at: `https://nba-predictor-xxx.vercel.app`

---

## Step 3 — Add API Keys to Vercel

```bash
vercel env add ODDS_API_KEY
# paste your key when prompted

vercel env add BALLDONTLIE_API_KEY
# paste your key when prompted
```

Then redeploy to apply:
```bash
vercel --prod
```

---

## Step 4 — Verify It Works

Open your Vercel URL and check:

| Feature | What to look for |
|---------|-----------------|
| Scores | Games listed for today's date |
| Odds | Spread + O/U lines next to each game |
| Injuries | Player names with red/yellow dots |
| Player PPG | Numbers next to injured players |
| Auto-refresh | "Updated: HH:MM:SS" clock ticking |
| Live games | Red pulsing badge + green/red breathing boxes |
| Quota | Number in summary bar showing requests remaining |

---

## API Routes (for testing)

After deploying, test each route directly:

```
https://your-site.vercel.app/api/scores?date=20260313
https://your-site.vercel.app/api/odds?date=20260313
https://your-site.vercel.app/api/injuries?teams=DEN,SAS,LAL,BOS
https://your-site.vercel.app/api/stats?search=LeBron+James
```

---

## Quota Management

The Odds API free tier gives you 500 requests/month.
The app only calls `/api/odds` once per page load or date change — not on the 30s refresh (scores are free/unlimited).

| Usage pattern | Monthly quota used |
|---------------|--------------------|
| Check today's games once | ~1 request |
| Browse 5 different dates | ~5 requests |
| Reload page 10 times | ~10 requests |
| Daily use for a month | ~30 requests |

You have plenty of headroom.

---

## Adding Your Own Picks / Analysis

The current version shows raw odds data from the API.
To add model picks (like the Mar 12 version), you can either:

1. **Ask Claude** — paste the day's games and ask for analysis
2. **Manual override** — edit `public/index.html` and add a `MANUAL_PICKS` object keyed by ESPN game ID
3. **Future**: Add a Claude API call to the `/api/analysis` route for AI-generated picks

---

## Environment Variables Summary

| Variable | Source | Required |
|----------|--------|----------|
| `ODDS_API_KEY` | the-odds-api.com | Yes (for lines) |
| `BALLDONTLIE_API_KEY` | balldontlie.io | Yes (for PPG stats) |

---

## Troubleshooting

**No odds showing** → Check ODDS_API_KEY is set: `vercel env ls`

**No injury PPG** → Check BALLDONTLIE_API_KEY is set

**Scores not loading** → ESPN API is free but occasionally rate-limits. Wait 30s and refresh.

**CORS errors locally** → Use `vercel dev` instead of opening index.html directly:
```bash
npm install -g vercel
vercel dev
# opens at http://localhost:3000
```

**Vercel cold starts** → First request may take 2–3 seconds on free tier. Subsequent requests are fast.
