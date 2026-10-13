# Bigg Boss Tamil 24/7 Voting Engine (Railway Edition)

Automated, high-throughput voting engine for Bigg Boss Tamil polls, containerized with Tor circuit isolation and configured to run **24/7 automatically on Railway**.

---

## 🌟 Highlights

- **24/7 Continuous Execution:** Automatically runs voting batches, cooldowns, and retries in an endless resilient loop.
- **Embedded Tor Multi-Circuit Engine:** Rotates Tor exit IPs across parallel streams (`--tor-streams 12`) for maximum unique IP acceptance.
- **Built-in Web Dashboard & Healthcheck:** Serves a real-time dark-mode status dashboard on Railway's public URL with live vote tallies, velocity, win rate, and streaming console logs.
- **Docker-Ready for Railway:** Includes pre-configured `Dockerfile`, `torrc`, and `entrypoint.sh` optimized for Linux containers.
- **Configurable via Environment Variables:** Switch candidates or tune concurrency anytime from the Railway dashboard without redeploying code.

---

## 🚀 How to Deploy on Railway

### Method 1: Deploy via GitHub (Recommended)

1. **Initialize Git & Push to GitHub:**
   ```bash
   git init
   git add .
   git commit -m "feat: 24/7 Railway deployment setup"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo-name>.git
   git push -u origin main
   ```
   *(Note: Large Windows `.exe` files in `tor-bundle` are already ignored by `.gitignore` and `.dockerignore`)*

2. **Deploy on Railway:**
   - Go to [railway.app](https://railway.app/) and sign in.
   - Click **New Project** → **Deploy from GitHub repo**.
   - Select your repository.
   - Railway will automatically detect the `Dockerfile` and start building your container!

3. **Generate Public URL (To view Live Dashboard):**
   - In your Railway project, click on your service.
   - Go to the **Settings** tab.
   - Under **Networking**, click **Generate Domain** (e.g. `https://bbb-vote-production.up.railway.app`).
   - Open that link on your browser or phone to see the live voting dashboard!

---

### Method 2: Deploy via Railway CLI

If you prefer deploying directly from your terminal:

1. Install Railway CLI:
   ```bash
   npm i -g @railway/cli
   ```
2. Log in and initialize:
   ```bash
   railway login
   railway init
   ```
3. Deploy the project:
   ```bash
   railway up
   ```

---

## ⚙️ Environment Variables (Optional)

You can customize the voting behavior in Railway under **Variables** tab without changing any code:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `VOTE_CONTESTANT` | `Shathika` | Name of the contestant to vote for (must match poll ballot) |
| `TOR_STREAMS` | `12` | Number of parallel isolated Tor circuits |
| `BATCH_TARGET` | `500` | Target counted votes per batch before rotating cycle |
| `BATCH_TIMES` | `800` | Maximum attempt cap per batch |
| `BATCH_DELAY` | `0` | Delay between votes in milliseconds (0 for full speed) |
| `CYCLE_COOLDOWN`| `2` | Cooldown in seconds before starting the next batch |
| `PORT` | `3000` | Assigned automatically by Railway for dashboard & healthcheck |

---

## 📊 Live Web Dashboard Features

When you open your Railway generated domain:
- **Total Votes Counted:** Real-time counter of accepted unique IP votes.
- **Contestant Standings:** Live poll percentage and total vote tally parsed directly from Polldaddy.
- **Win Rate & Velocity:** Success rate % and votes/minute calculation.
- **Live Terminal Feed:** Real-time stream of Tor vote responses and IP rotation status.
- **Healthcheck:** Endpoints at `/health` and `/api/stats` for external uptime monitoring.
