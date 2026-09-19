# AI Setter Agent — Kissmetrics Workspace

## What This Project Is

AI-powered sales setter for the Kissmetrics Scrapely workspace. Runs 24/7 on Railway. When a lead responds to an outbound DM about attribution/analytics infrastructure, this agent generates a natural reply using Claude AI and sends it back via the Scrapely DM API — goal is booking a discovery call.

Also follows up automatically if leads go quiet (day 2 and day 7).

## Project Structure

```
src/server.js        — Main server. Receives webhooks, processes messages, sends replies.
src/claude.js        — Claude AI API client with retries (Sonnet -> Haiku fallback).
src/instructions.md  — SDR personality and flow logic for analytics/attribution sales.
src/offer.md         — Product context: attribution infrastructure, results, pricing.
.env                 — API keys. Never commit.
.env.example         — Template for required env vars.
```

## Workspace Context

- Workspace: Kissmetrics (Scrapely)
- Offer: Attribution and analytics infrastructure for SaaS teams
- Pitch: "setting up attribution and analytics infrastructure for companies like @unbounce to increase user activation by 20% in 90 days"
- ICP: Verified SaaS founders, tight tool graphs, CTOs/VP Eng with web stacks
- CRM tags: unread, interested_reply, negative_reply, neutral_reply, engaged, calendlyd, booked, not_interested, not_qualified
- Sending accounts: dallan_forster, yosep1956, cameron_riidley, campbell_suthr, aidan_mcalliste (and others)

## Env Vars (Railway)

```
ANTHROPIC_API_KEY=sk-ant-...
SCRAPELY_API_KEY=<kissmetrics workspace API key>
CALENDAR_LINK=<calendly or cal.com link>
WEBHOOK_SECRETS=<X-Webhook-Key from Scrapely webhook settings>
```

## Deploy to Railway

1. Push this repo to GitHub
2. Railway > New Project > Deploy from GitHub
3. Add env vars in Railway Variables tab
4. Enable Public Networking (Settings > Networking > Generate Domain)
5. Copy the public URL, add as webhook in Scrapely Settings > Global Webhook
6. Copy X-Webhook-Key from Scrapely, add as WEBHOOK_SECRETS in Railway
7. Enable "Send Webhook for All Replies" in Scrapely
8. Visit your-url.railway.app/health to verify

## Commands

```
npm install    — Install dependencies
npm start      — Start the server
npm run dev    — Start with auto-restart on file changes
```
