# Relativity.ai

## my notes
here are some things i dont want to forget to add
- contacts section
- examples / testamonials
- some sort of client onboading process doccument where they can authorize me.
    I think this would be called "OAuth Client Onboarding"
- supabase
1. Client creates Supabase project
2. Client invites you as a team member
3. You create the tables/vector database setup
4. You create n8n credentials using their Project URL + secret key
5. You build the RAG/knowledge base workflow
6. If they leave, they keep everything
- dropbox
1. Client clicks “Connect Dropbox” on your website
2. Your backend sends them to Dropbox’s permission screen
3. Client logs into Dropbox and clicks “Allow”
4. Dropbox redirects back to your backend
5. Your backend receives an authorization code
6. Your backend exchanges that code for an access token
7. Your backend stores the token securely in your database
8. n8n workflow runs later and asks your backend:
   “Give me access to Client A’s Dropbox files”
9. Your backend uses Client A’s token to call Dropbox
10. n8n receives the file/data and continues the automation

## potential website structure for OAuth
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

## Overview
Relativity.ai is an AI integration and automation agency focused on helping businesses streamline operations using AI workflows, automation systems, and intelligent data handling.

The brand should feel:
- Modern
- Minimal
- Intelligent
- Premium
- Technical but approachable

Visual inspiration:
- Space / physics / relativity themes
- Black, white, dark gray color palette
- Clean typography
- Subtle futuristic elements
- Smooth animations and transitions

---

# Core Services

## AI Workflow Automation
Custom business automations using:
- n8n
- APIs
- Webhooks
- CRM integrations
- Slack / Gmail / Dropbox integrations

Examples:
- Lead intake automation
- CRM syncing
- AI follow-up systems
- AI email triage
- Automated reporting
- Internal operational workflows

---

## AI Knowledge Systems (RAG)
Build AI systems that can search and retrieve company knowledge from:
- PDFs
- SOPs
- Dropbox
- Google Drive
- CRM notes
- Internal documents

Examples:
- Internal AI assistants
- AI company search tools
- AI employee knowledge bases

---

# Website Goals

The website should:
1. Look highly professional and modern
2. Build trust quickly
3. Clearly explain services
4. Generate inbound leads
5. Feel like a premium AI consultancy

Main CTA examples:
- “Book a Consultation”
- “Automate Your Business”
- “Build Your AI Infrastructure”

---

# Suggested Pages

## Home
Hero section with strong headline and CTA.

## Services
Break down:
- Automation
- AI integrations
- RAG systems
- Internal AI assistants

## Process
Simple explanation:
1. Discovery
2. Workflow Mapping
3. AI Integration
4. Deployment
5. Ongoing Optimization

## Case Studies
Placeholder examples are fine initially.

## Contact
Simple high-conversion contact form.

---

# Technical Direction

Preferred stack:
- Next.js
- TailwindCSS
- Framer Motion
- Vercel deployment

Design priorities:
- Mobile responsive
- Fast loading
- Minimal but polished
- Smooth scrolling
- Modern animations
- Strong typography hierarchy

---

# Tone

The messaging should feel:
- Confident
- Intelligent
- Clear
- Professional
- Forward-thinking

Avoid:
- Overly corporate buzzwords
- Excessive technical jargon
- Cluttered layouts

---

# Example Messaging

“AI systems designed to streamline operations, automate workflows, and centralize business intelligence.”

“Modern AI infrastructure for growing businesses.”

“Automation, intelligence, and operational scale.”

---

# Goal

Relativity.ai should position itself as a modern AI integration agency that helps businesses implement practical AI systems that save time, reduce operational friction, and improve scalability.