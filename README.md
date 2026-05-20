# Call Analysis Pipeline — Standalone App

Production-deployable monorepo for the **Bajaj Auto Credit Call Analysis Pipeline**.

- **Frontend** — Vite + React + Tailwind, single page UI with batch upload + 8-tab analysis viewer
- **Backend** — FastAPI + ElevenLabs Scribe v2 STT + Azure OpenAI gpt-4o-mini multi-agent sentiment
- **Pipeline** — STT (with diarization) → 5 specialist agents in parallel → synthesizer → granular cost tracking

```
call-analysis-app/
├── README.md                  ← you are here
├── docker-compose.yml         ← local-dev orchestration
├── .env.example
├── backend/
│   ├── api.py                 ← FastAPI entry
│   ├── pipeline.py            ← STT + multi-agent orchestration
│   ├── prompts.py             ← Bajaj-domain agent prompts
│   ├── batch_manager.py       ← in-memory job store + thread pool
│   ├── requirements.txt
│   ├── Dockerfile
│   ├── render.yaml            ← Render.com Blueprint
│   ├── railway.toml           ← Railway config
│   ├── fly.toml               ← Fly.io config (Mumbai region)
│   └── .env.example
└── frontend/
    ├── package.json
    ├── vite.config.ts
    ├── vercel.json            ← Vercel project config
    ├── Dockerfile             ← container deploy fallback
    ├── index.html
    ├── tailwind.config.ts
    ├── src/
    │   ├── App.tsx
    │   ├── main.tsx
    │   ├── components/
    │   │   ├── Layout.tsx
    │   │   ├── LoginPage.tsx
    │   │   ├── ProtectedRoute.tsx
    │   │   └── ui/            ← shadcn primitives
    │   └── pages/
    │       └── CallAnalysisPipeline/
    │           ├── CallAnalysisPipeline.tsx   ← main page
    │           ├── index.tsx                  ← barrel
    │           ├── api.ts
    │           ├── types.ts
    │           ├── BatchUploader.tsx
    │           ├── BatchProgress.tsx
    │           ├── BatchSummary.tsx
    │           ├── FileSelector.tsx
    │           ├── KeytermsInput.tsx
    │           ├── CostBreakdown.tsx
    │           └── views/     ← 5 specialist visualizations
    └── .env.example
```

---

## ⚡ Quick start (local dev)

```bash
# 1. Backend
cd backend
cp .env.example .env
# Fill in ELEVENLABS_API_KEY, AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT in .env
pip install -r requirements.txt
python api.py                  # → http://localhost:8007

# 2. Frontend (new shell)
cd frontend
cp .env.example .env.local     # default points at http://localhost:8007
npm install
npm run dev                    # → http://localhost:8080
```

Login: `admin` / `aiplanet@2024`

Or with Docker Compose (one shell):

```bash
cp .env.example .env
# Fill in the secrets in .env
docker compose up --build
# Frontend: http://localhost:8080  ·  Backend: http://localhost:8007
```

---

## 🚀 Production deploy

We recommend **Vercel for the frontend** and **Render for the backend**. Both have generous free tiers and zero-config flows for our setup.

> ⚠️ **A note on Vercel for the backend**: Vercel's serverless runtime is stateless and per-request (10–60s timeout). Our batch system uses in-memory state + background threads, so it doesn't fit Vercel's model. Run the backend on a long-lived host (Render / Railway / Fly / any VPS) and keep Vercel for the frontend.

### Step 1 — Deploy the backend on Render (free tier)

**Note**: Render's *Blueprint* (auto-deploy from `render.yaml`) requires a paid plan. On the **free tier**, use the **Web Service** path — it's manual but takes ~3 minutes. Both `render.yaml` and Dockerfile are in the repo if you upgrade later; neither is required for the manual path.

1. Push this repo to GitHub (you've already done this).
2. Go to [dashboard.render.com](https://dashboard.render.com) → **New +** → **Web Service**.
3. **Connect a repository** → pick `call-analysis-app`. (First time: authorize Render to read your GitHub.)
4. Fill in:
   - **Name**: `call-analysis-pipeline-api` (or anything you like)
   - **Region**: **Singapore** (lowest latency for Indian users; or **Frankfurt** / **Oregon**)
   - **Branch**: `main`
   - **Root Directory**: `backend`
   - **Runtime**: **Python 3**
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn api:app --host 0.0.0.0 --port $PORT`
   - **Instance Type**: **Free**
5. Scroll to **Environment Variables** → add these (paste from your `backend/.env`):
   | Key | Value |
   |---|---|
   | `ELEVENLABS_API_KEY` | (your ElevenLabs key) |
   | `AZURE_OPENAI_API_KEY` | (your Azure key) |
   | `AZURE_OPENAI_ENDPOINT` | `https://your-resource.openai.azure.com/` |
   | `AZURE_OPENAI_API_VERSION` | `2024-12-01-preview` |
   | `AZURE_DEPLOYMENT` | `gpt-4o-mini` |
   | `ALLOWED_ORIGINS` | `*` (tighten to your Vercel URL after step 2) |
6. Click **Create Web Service**. Render builds + deploys (~3-5 min first time).
7. Copy the URL it gives you (e.g. `https://call-analysis-pipeline-api.onrender.com`).
8. Smoke-test: `curl https://your-render-url.onrender.com/health` should return `credentials_loaded.elevenlabs=true`.

**Free tier caveats**:
- Sleeps after 15 min idle → first request after sleep takes 30-50s (cold start)
- 750 hours/month free (enough for one always-pinged service)
- 512 MB RAM (plenty for our use case)
- For production / no-cold-starts, upgrade to **Starter ($7/mo)**

> Note: If you later upgrade to a paid plan and want the Blueprint flow, the included [`backend/render.yaml`](backend/render.yaml) is ready to use.

### Step 2 — Deploy the frontend on Vercel

1. Go to [vercel.com](https://vercel.com) → **Add New** → **Project**.
2. Import the same repo. Vercel will detect Vite.
3. In **Project Settings**:
   - **Root directory**: `frontend/`
   - Framework preset: **Vite**
   - Build command: `npm run build` (auto-detected from `vercel.json`)
   - Output directory: `dist` (auto-detected)
4. In **Environment Variables**, add:
   - Name: `VITE_CALL_ANALYSIS_API_URL`
   - Value: `https://call-analysis-pipeline-api.onrender.com` (from step 1)
5. Click **Deploy**.

Vercel auto-deploys on every push to the main branch.

### Step 3 — Tighten CORS (post-deploy)

On Render, update the `ALLOWED_ORIGINS` env var to include the Vercel URL:

```
ALLOWED_ORIGINS=https://your-app.vercel.app,https://your-custom-domain.com
```

Render will auto-restart the service.

---

## 🔄 Alternative backend hosts

The backend ships with configs for several platforms. Pick whichever fits your ops:

| Platform | Config file | Notes |
|---|---|---|
| **Render** | [`backend/render.yaml`](backend/render.yaml) | Recommended. Easiest. Free tier works for testing. |
| **Railway** | [`backend/railway.toml`](backend/railway.toml) | Similar to Render. Charges per CPU-second. |
| **Fly.io** | [`backend/fly.toml`](backend/fly.toml) | Pre-configured for **Mumbai region** (`bom`) — best latency for Indian users. Auto-scales to 0. |
| **Any Docker host** | [`backend/Dockerfile`](backend/Dockerfile) | Generic. Works on DigitalOcean App Platform, Heroku container deploy, AWS ECS, GCP Cloud Run, etc. |

### Fly.io (Mumbai region — best for India)

```bash
cd backend
fly auth login
fly launch                      # accepts the included fly.toml
fly secrets set \
  ELEVENLABS_API_KEY=... \
  AZURE_OPENAI_API_KEY=... \
  AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/ \
  ALLOWED_ORIGINS=https://your-app.vercel.app
fly deploy
```

### Railway

```bash
cd backend
railway login
railway link             # link to your Railway project
railway variables set ELEVENLABS_API_KEY=... AZURE_OPENAI_API_KEY=... AZURE_OPENAI_ENDPOINT=... ALLOWED_ORIGINS=...
railway up
```

---

## 🛠️ Configuration reference

### Backend env vars

| Variable | Required | Default | Notes |
|---|---|---|---|
| `ELEVENLABS_API_KEY` | ✅ | — | Get from [elevenlabs.io/app/account](https://elevenlabs.io/app/account) |
| `AZURE_OPENAI_API_KEY` | ✅ | — | Your Azure OpenAI resource key |
| `AZURE_OPENAI_ENDPOINT` | ✅ | — | `https://YOUR-RESOURCE.openai.azure.com/` |
| `AZURE_OPENAI_API_VERSION` | — | `2024-12-01-preview` | API version |
| `AZURE_DEPLOYMENT` | — | `gpt-4o-mini` | Deployment name in your Azure resource |
| `PORT` | — | `8007` | Render/Railway/etc. inject this automatically |
| `HOST` | — | `0.0.0.0` | Bind address |
| `ALLOWED_ORIGINS` | — | `*` | Comma-separated CORS origins. **Tighten in production.** |

### Frontend env vars

| Variable | Required | Default | Notes |
|---|---|---|---|
| `VITE_CALL_ANALYSIS_API_URL` | ✅ | `http://localhost:8007` | Public URL of your deployed backend |

---

## 📊 API endpoints

| Method | Path | Use |
|---|---|---|
| GET | `/` | Service identity (smoke test) |
| GET | `/health` | Liveness + credential status |
| GET | `/pricing` | Current rate card |
| POST | `/analyze` | Single-file synchronous analysis (returns full result in ~25-60s) |
| POST | `/batch` | Multi-file batch — returns `job_id` immediately |
| GET | `/batch/{job_id}` | Poll batch status + per-file results |
| GET | `/batches` | List recent batch jobs |
| DELETE | `/batch/{job_id}` | Remove a job from memory |

Interactive API docs (Swagger UI) at `/docs` when the backend is running.

---

## 💰 Cost model

| Component | Rate | Notes |
|---|---|---|
| ElevenLabs Scribe v2 base | $0.22/hr of audio | |
| Keyterms surcharge | +$0.05/hr | Only when `keyterms` param is used |
| Azure gpt-4o-mini input | $0.20 per 1M tokens | |
| Azure gpt-4o-mini output | $0.60 per 1M tokens | |

**Measured**: ~$0.0065/min audio for a typical Bajaj call (3-5 min, code-mixed Hindi). See the **Cost** tab in the UI for granular per-call accounting.

---

## ⚠️ Known limitations & upgrade paths

| Limitation | When it matters | Upgrade path |
|---|---|---|
| **In-memory job store** | Jobs lost if backend restarts | Swap `batch_manager.py` to Redis-backed (Upstash works well). Required for multi-instance horizontal scaling. |
| **No authentication beyond simple login** | Anyone with `admin/aiplanet@2024` gets in | Plug in Auth0/Clerk/Supabase auth in `ProtectedRoute.tsx` |
| **No persistent result storage** | Old jobs eviction | Add Postgres / S3 result storage. Currently jobs live until process restart. |
| **Free-tier ElevenLabs quota = 10,000 credits** | ~125 minutes of audio total | Upgrade to a paid ElevenLabs plan; at 90K+ calls/mo you should also talk to ElevenLabs sales about enterprise rates (typical ~30-45% discount on $0.22/hr). |
| **Single-instance backend** | Cold start on Render free tier (~30s) | Render Starter ($7/mo) keeps it warm. For high traffic, scale horizontally (requires Redis state). |

---

## 🧪 Smoke testing a deployment

After deploying, verify each piece:

```bash
# Backend health
curl https://your-backend.onrender.com/health
# expect: status=ok, credentials_loaded.elevenlabs=true, credentials_loaded.azure_openai=true

# Rate card
curl https://your-backend.onrender.com/pricing

# Frontend reachability
curl -I https://your-app.vercel.app
# expect: HTTP/2 200
```

Then open the frontend in a browser, log in, drop an audio file, watch the pipeline run.

---

## 📁 Related repos / context

- This standalone app was extracted from the broader `ai-planet-explore-main` marketplace. The marketplace integration there still works in parallel; both share the same backend (point `VITE_CALL_ANALYSIS_API_URL` in either repo at the deployed backend).
- Original cost analysis: see `STT_QUALITY_COST_HEAD_TO_HEAD.md`, `ELEVENLABS_VS_SARVAM_HEAD_TO_HEAD.md`, `FULL_PIPELINE_COST_ANALYSIS.md` at the repo root.
