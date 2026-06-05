# Relativity Systems — Notes

---

## Overview

Relativity Systems is an AI integration and automation agency that helps businesses streamline operations using AI workflows, automation systems, and intelligent data handling. The goal is to position as a modern, premium AI consultancy that builds practical systems — not demos.

**Positioning statement:**
> "AI systems designed to streamline operations, automate workflows, and centralize business intelligence."

---

## Brand

**Feel:**
- Modern, minimal, intelligent, premium — technical but approachable

**Visual direction:**
- Space / physics / relativity themes
- Black, white, dark gray palette
- Clean typography with strong hierarchy
- Subtle futuristic elements, smooth animations

**Tone:**
- Confident, intelligent, clear, professional, forward-thinking
- Avoid: corporate buzzwords, excessive jargon, cluttered layouts

**Key messaging lines:**
- "Modern AI infrastructure for growing businesses."
- "Automation, intelligence, and operational scale."
- "Build Your AI Infrastructure"

---

## Core Services

### AI Workflow Automation
Custom business automations using n8n, APIs, webhooks, and CRM/SaaS integrations.

Examples:
- Lead intake automation
- CRM syncing
- AI follow-up and email triage systems
- Automated reporting
- Internal operational workflows

Integrations: Slack, Gmail, Dropbox, CRMs

### AI Knowledge Systems (RAG)
Build AI systems that search and retrieve company knowledge from internal documents.

Sources: PDFs, SOPs, Dropbox, Google Drive, CRM notes, internal docs

Examples:
- Internal AI assistants
- Company knowledge search tools
- AI employee knowledge bases
- SOP & document intelligence

---

## Website

### Goals
1. Look highly professional and modern
2. Build trust quickly
3. Clearly explain services
4. Generate inbound leads
5. Feel like a premium AI consultancy

### CTAs
- "Book a Consultation"
- "Automate Your Business"
- "Build Your AI Infrastructure"

### Current Pages / Sections
- **Hero** — strong headline + CTA
- **Services** — Automation, AI Knowledge Systems, AI Agents & Assistants
- **Examples** — polished system walkthroughs (see backlog for more)
- **Process** — Discovery → System Architecture → Build → Deployment → Optimization
- **Contact** — high-conversion contact form

### Suggested Pages (not yet built)
- Case Studies (placeholder examples fine initially)
- Client Dashboard / Portal

### Editing Reference — Examples Section

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

**Preferred:**
- Next.js
- TailwindCSS
- Framer Motion
- Vercel deployment

**Current site:** Vanilla HTML/CSS/JS (no framework)

**Design priorities:**
- Mobile responsive, fast loading
- Smooth scrolling, modern animations
- Strong typography hierarchy

---

## Client Onboarding System (OAuth)

A future system allowing clients to authorize Relativity to access their tools without handing over passwords. Likely called "OAuth Client Onboarding."

### Supabase Onboarding Flow
1. Client creates their own Supabase project
2. Client invites you as a team member
3. You create the tables and vector database setup
4. You create n8n credentials using their Project URL + secret key
5. You build the RAG / knowledge base workflow
6. If they leave, they keep everything (their project, their data)

### Dropbox OAuth Flow
1. Client clicks "Connect Dropbox" on the website
2. Backend redirects them to Dropbox's permission screen
3. Client logs in and clicks "Allow"
4. Dropbox redirects back to your backend with an authorization code
5. Backend exchanges code for an access token
6. Backend stores token securely in database
7. n8n workflow calls your backend: "Give me Client A's Dropbox files"
8. Backend uses Client A's token to call Dropbox API
9. n8n receives the data and continues the automation

### Portal / Backend Architecture

```
Relativity Website
├── Client dashboard
├── Connect Dropbox button
├── Connect Google Drive button
└── Connect Slack button

Relativity Backend
├── OAuth redirect routes
├── Token storage
├── Refresh token logic
├── Client permissions
└── API endpoints for n8n

n8n
├── Watches webhooks
├── Runs automations
├── Calls your backend
├── Sends data to AI
└── Updates client systems
```

---

## Backlog

### Website
- [ ] Add testimonials / social proof section
- [ ] Add more Example cards (02, 03, etc.)
- [ ] Build out Case Studies page

### Client System
- [ ] Build OAuth client onboarding flow (Dropbox, Google Drive, Slack)
- [ ] Client portal dashboard (view active workflows, connect integrations)
- [ ] Client authorization document / agreement flow
