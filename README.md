# novi

novi is a local-first OSINT correlation and identity-disambiguation demo. It does not treat a shared name as proof of identity; it stores collected identifiers, scores evidence signals, and exposes the exact `explanation_json` used by the UI.

This first milestone includes:

- FastAPI backend with SQLite persistence.
- GitHub API collector and normalizer.
- Additive scoring for username similarity, bio/name similarity, location, employer, timezone, and account-age evidence.
- `explanation_json` as the single source of truth for confidence explanations.
- React web dashboard with self-audit / consented / public-figure lookup scope, search, progressive graph expansion, and a confidence detail panel.

## Run locally

### Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn novi.main:app --reload --port 8000
```

Optional:

```bash
export GITHUB_TOKEN=ghp_...
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open the Vite URL shown in the terminal. The frontend expects the backend at `http://localhost:8000`.

## Safety boundaries

novi is designed for self-audits, explicitly consented test accounts, and clearly public figures with public data. The current collector uses the official GitHub API only. It does not perform unbounded scraping, does not browse autonomously, and does not use a graph database.

