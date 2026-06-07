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

## Repo Split

| Repo | Responsibility |
|---|---|
| `Relativity` (this repo) | Public website, client login, portal, Dropbox OAuth token storage |
| `dropbox_slack_inngest` | Dropbox folder monitoring, Inngest functions, Slack notifications |

The automation repo reads Dropbox tokens from the shared Supabase database (same `oauth_tokens` table).

---

## Technical Stack

- Vanilla HTML/CSS/JS (no framework)
- Node.js/Express backend (`server.js`)
- Supabase (auth + database)
- Dropbox OAuth for client file access

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

### Backend Routes
| Route | Auth | Purpose |
|---|---|---|
| `GET /auth/config` | None | Returns `{ supabaseUrl, supabaseAnonKey }` for browser SDK |
| `GET /auth/me` | Soft (JWT) | Returns client identity or `{ authenticated: false }` |
| `GET /auth/dropbox/start` | Required (JWT) | Returns `{ url }` for Dropbox OAuth |
| `GET /auth/dropbox/callback` | None (state param) | Exchanges code, stores tokens, redirects |

### Database Tables
- `clients` — id, name, email, slack_channel_id, dropbox_watch_path, is_active
- `client_users` — links `auth.users` → `clients` (auth_user_id is unique)
- `oauth_tokens` — stored Dropbox tokens per client (unique on client_id + provider)

### Key Files
```
server.js                  — Express entry point
config/index.js            — all env config
middleware/clientAuth.js   — JWT → client resolver
routes/auth.js             — /config, /me, /dropbox/start, /dropbox/callback
services/supabaseService.js
services/dropboxService.js — Dropbox OAuth helpers
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
DROPBOX_BASE_PATH          # optional root path override
```

### Running Locally
```bash
node server.js
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
