# Relativity Systems — Notes

---

## Overview

Relativity Systems is an AI integration and automation agency that helps businesses streamline operations using AI workflows, automation systems, and intelligent data handling.

**Positioning statement:**
> "AI systems designed to streamline operations, automate workflows, and centralize business intelligence."

---

## Brand

- Modern, minimal, intelligent, premium
- Black, white, dark gray palette — space/physics aesthetic
- Confident, clear, professional tone
- Avoid: corporate buzzwords, cluttered layouts

**Key messaging:**
- "Modern AI infrastructure for growing businesses."
- "Automation, intelligence, and operational scale."

---

## Core Services

- **AI Workflow Automation** — custom automations, CRM syncing, lead intake, Slack/Dropbox/Gmail integrations
- **AI Knowledge Systems (RAG)** — AI assistants that search internal docs, SOPs, Dropbox, Google Drive

---

## Website

**Pages/Sections:** Hero, Services, Examples, Process, Contact

**Editing Reference — Examples Section**

| What to change | Where in index.html |
|---|---|
| Card title | `<h3>` inside `<!-- Example 01 -->` |
| Short description | `.example-desc` paragraph |
| Flow node labels | The four `.flow-node-label` spans |
| Feature badges | `.tag` spans inside `.feature-tags` |
| Business outcome line | `<p>` inside `.business-outcome` |
| Add a new card | Duplicate the `<!-- Example 01 -->` div, change number to `02` |

---

## Technical Stack

- Vanilla HTML/CSS/JS (no framework)
- Node.js/Express backend (`server.js`)
- Supabase (auth + database)
- Inngest (automation engine — replaces n8n)
- Dropbox OAuth for client file access
- Slack for client notifications

---

## Client Portal Architecture

### Authentication Flow
1. Client visits `/login.html` → email + password via Supabase Auth
2. After login → redirect to `/portal.html`
3. Portal calls `GET /auth/me` with Bearer token — server resolves client identity from JWT
4. No `clientId` ever appears in the URL or is trusted from the browser

### Dropbox OAuth Flow
1. Client clicks "Connect" on portal → portal fetches `/auth/dropbox/start` with Bearer token
2. Server validates JWT, generates Dropbox OAuth URL server-side, returns `{ url }`
3. Portal redirects browser to Dropbox consent screen
4. Dropbox redirects to `/auth/dropbox/callback` → server exchanges code for tokens, stores in `oauth_tokens`
5. Redirects to `/portal.html?connected=dropbox` (no clientId in URL)

### Inngest Automation Flow
1. Hourly cron (`dropboxScheduledCheck`) fires → sends `dropbox/check-client` event per active client
2. `dropboxCheckClient` function: refreshes Dropbox token if needed → lists day folders → counts files in address folders
3. Waits for stable file counts (2 consecutive polls at same count, 30s apart) before notifying
4. Sends Slack message to `client.slack_channel_id` (fallback to `SLACK_DEFAULT_CHANNEL`)
5. Deduplicates: only notifies when `fileCount !== last_notified_count`
6. Detects deleted folders and notifies once

### Backend Routes
| Route | Auth | Purpose |
|---|---|---|
| `GET /auth/config` | None | Returns `{ supabaseUrl, supabaseAnonKey }` for browser SDK |
| `GET /auth/me` | Soft (JWT) | Returns client identity or `{ authenticated: false }` |
| `GET /auth/dropbox/start` | Required (JWT) | Returns `{ url }` for Dropbox OAuth |
| `GET /auth/dropbox/callback` | None (state param) | Exchanges code, stores tokens, redirects |
| `POST /api/inngest` | Inngest signed | Inngest function handler |
| `GET /api/dropbox/files/:clientId` | API key | Legacy — n8n only |

### Database Tables
- `clients` — id, name, email, slack_channel_id, dropbox_watch_path, is_active
- `client_users` — links `auth.users` → `clients` (auth_user_id is unique)
- `oauth_tokens` — stored Dropbox tokens per client (unique on client_id + provider)
- `folder_states` — Inngest stability tracking (last_count, stable_count, last_notified_count, is_deleted)
- `automation_logs` — append-only event log

### Key Files
```
server.js                  — Express entry point
config/index.js            — all env config
middleware/clientAuth.js   — JWT → client resolver
routes/auth.js             — /config, /me, /dropbox/start, /dropbox/callback
routes/api.js              — legacy n8n route
services/supabaseService.js
services/dropboxService.js — listFolder (paginated), getRecentDayFolders
services/stateService.js   — folder_states DB ops
services/slackService.js   — sendMessage(client, text)
inngest/client.js          — Inngest client export
inngest/functions.js       — 3 Inngest functions
login.html / login.js / login.css
portal.html / portal.js / portal.css
```

### Required Environment Variables
```
SUPABASE_URL
SUPABASE_SERVICE_KEY       # server-side only
SUPABASE_ANON_KEY          # browser-safe, returned by /auth/config
DROPBOX_APP_KEY
DROPBOX_APP_SECRET
DROPBOX_REDIRECT_URI
DROPBOX_BASE_PATH          # default watch path (empty = Dropbox root)
INNGEST_EVENT_KEY
INNGEST_SIGNING_KEY
SLACK_BOT_TOKEN
SLACK_DEFAULT_CHANNEL
```

### Running Locally
```bash
# Terminal 1
node server.js

# Terminal 2
npm run inngest:dev
# → npx inngest-cli@latest dev -u http://localhost:3000/api/inngest
# → Inngest Dev UI at http://localhost:8288
```

### Manual Inngest Test
In Inngest Dev UI → Send Event:
```json
{ "name": "dropbox/check-client", "data": { "clientId": "<uuid>" } }
```

---

## Backlog

### Website
- [ ] Add testimonials / social proof section
- [ ] Add more Example cards (02, 03, etc.)
- [ ] Build out Case Studies page

### Client System
- [ ] Populate portal stats (Active Systems, Workflow Health, etc.)
- [ ] AI Knowledge Assistant (currently "Coming Soon")
- [ ] Google Drive OAuth integration
