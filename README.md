# Agent Incentive Calculator

One Render **web service** serves the page and the save/load API. Daily snapshots go into a shared Render **Key Value** store, under this app's own key prefix.

## Render setup

1. Deploy this repo as a Node web service. Build command: `npm install`. Start command: `npm start`.
2. On that web service, set `REDIS_URL` to the **internal** connection string from the existing Key Value instance (same region). The browser never sees this URL.
3. Leave `REDIS_KEY_PREFIX` as `agent-incentive/` (set in `render.yaml`, or add it yourself). That prefix is the folder this app is allowed to use.

## Shared store isolation

Redis has no real folders. This app only reads and writes keys that start with `agent-incentive/`:

| Key | Purpose |
|-----|---------|
| `agent-incentive/days/YYYY-MM-DD` | One day's snapshot |
| `agent-incentive/day-index` | Set of saved dates |

It does not scan the database, flush it, or touch any other key. Saving the same date again replaces only that day's snapshot.

Example value:

```json
{
  "date": "2026-10-22",
  "savedAt": "2026-10-22T10:30:00.000Z",
  "grandTotal": 190000,
  "agents": {
    "Peter": { "cardMaan": 10, "kouzaMaan": 5, "totalInr": 18000 },
    "Pankaj": { "cardMaan": 2, "kouzaMaan": 3, "totalInr": 650 }
  }
}
```

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | App status, Redis reachability, and key namespace |
| GET | `/api/days` | List saved dates |
| GET | `/api/days/:date` | Load one day |
| PUT | `/api/days/:date` | Save one day |

## Local development

```bash
npm install
cp .env.example .env
npm run dev
```

Open http://localhost:3000. Opening `public/index.html` as a file will not reach the API.
