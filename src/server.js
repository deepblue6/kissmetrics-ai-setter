/**
 * AI Setter Webhook Worker
 *
 * Listens for Scrapely webhook events and generates AI replies using Claude.
 * An AI setter that books calls.
 *
 * Endpoints:
 *   POST /           — Main webhook receiver (new_reply + reply_back_and_forth)
 *   GET  /health     — Health check
 *   GET  /test?conversation_id=XXX — Dry-run (generates reply, doesn't send)
 */

import * as dotenv from "dotenv";
import http from "http";
import axios from "axios";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { callClaude } from "./claude.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "..", ".env.local") });
dotenv.config({ path: path.join(__dirname, "..", ".env") });

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
const SCRAPELY_API_BASE = process.env.SCRAPELY_API_BASE || "https://app.scrapely.co/api/v1";
const SCRAPELY_API_KEY = process.env.SCRAPELY_API_KEY;
const CALENDAR_LINK = process.env.CALENDAR_LINK || "";

// Webhook authentication
const WEBHOOK_SECRETS = new Set(
  (process.env.WEBHOOK_SECRETS || "").split(",").map((s) => s.trim()).filter(Boolean)
);

// Load SDR instructions + offer from .md files
const INSTRUCTIONS = fs.readFileSync(path.join(__dirname, "instructions.md"), "utf-8");
const OFFER = fs.readFileSync(path.join(__dirname, "offer.md"), "utf-8");

// ---------------------------------------------------------------------------
// Startup checks — catch config mistakes before they cause silent failures
// ---------------------------------------------------------------------------
const CONFIG_WARNINGS = [];

if (!process.env.OPENROUTER_API_KEY) {
  CONFIG_WARNINGS.push("OPENROUTER_API_KEY is missing — AI replies will fail. Get one at https://openrouter.ai/keys");
}
if (!SCRAPELY_API_KEY) {
  CONFIG_WARNINGS.push("SCRAPELY_API_KEY is missing — cannot fetch conversations or send DMs. Find yours in Scrapely Dashboard > Settings > API");
}
if (!CALENDAR_LINK) {
  CONFIG_WARNINGS.push("CALENDAR_LINK is not set — the AI won't have a booking link to share with leads");
}
if (WEBHOOK_SECRETS.size === 0) {
  CONFIG_WARNINGS.push("WEBHOOK_SECRETS is not set — anyone can send fake webhook events to your server. Set it to the X-Webhook-Key value from Scrapely Settings");
}
if (OFFER.includes("[Your Company Name]") || OFFER.includes("REPLACE EVERYTHING BELOW")) {
  CONFIG_WARNINGS.push("src/offer.md still has placeholder text — the AI won't know what to sell. Edit it with your business info");
}
if (INSTRUCTIONS.includes("[YOUR PROPOSAL/CASE STUDY LINK]") || INSTRUCTIONS.includes("[YOUR CALENDAR LINK]")) {
  CONFIG_WARNINGS.push("src/instructions.md still has placeholder links — replace [YOUR CALENDAR LINK] and [YOUR PROPOSAL/CASE STUDY LINK] with your actual URLs");
}

if (CONFIG_WARNINGS.length > 0) {
  console.log("\n⚠️  SETUP ISSUES DETECTED:\n");
  CONFIG_WARNINGS.forEach((w, i) => console.log(`  ${i + 1}. ${w}`));
  console.log("\n  Fix these in your .env file or in the src/ folder.\n");
  console.log("  Need help? Open this project in Claude Code and say \"help me set this up\"\n");
}

if (!process.env.OPENROUTER_API_KEY || !SCRAPELY_API_KEY) {
  console.error("❌ Cannot start: OPENROUTER_API_KEY and SCRAPELY_API_KEY are both required.\n");
  process.exit(1);
}

if (WEBHOOK_SECRETS.size === 0) {
  console.error("❌ Cannot start: WEBHOOK_SECRETS is required for security. Without it, anyone can send fake events to your server.");
  console.error("   Set it to the X-Webhook-Key value from Scrapely Dashboard > Settings > Global Webhook.\n");
  process.exit(1);
}

// Follow-up chain config
const FOLLOWUP_CHAIN = [
  {
    delayDays: 2,
    prompt: `The lead received our pitch but hasn't responded. Send a short, casual nudge referencing what we sent them. Don't re-explain everything — just poke them naturally. One or two sentences max.`,
  },
  {
    delayDays: 7,
    prompt: `The lead still hasn't responded after the first follow-up. Send a final, slightly more direct follow-up. Keep it human and short. Mention the calendar link naturally at the end. Don't be pushy, just give them one more reason to engage.`,
  },
];
const FOLLOWUP_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// ---------------------------------------------------------------------------
// Scrapely API helpers
// ---------------------------------------------------------------------------
async function fetchAccounts() {
  try {
    const response = await axios({
      method: "GET",
      url: `${SCRAPELY_API_BASE}/accounts`,
      headers: { "X-API-Key": SCRAPELY_API_KEY },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300) {
      console.error(`[Scrapely] Fetch accounts error: ${response.status}`);
      return [];
    }
    return response.data?.accounts || [];
  } catch (err) {
    console.error(`[Scrapely] Fetch accounts exception: ${err.message}`);
    return [];
  }
}

async function sendDM(conversationId, accountId, message) {
  try {
    console.log(`[Scrapely] Sending DM to conversation ${conversationId}...`);
    const response = await axios({
      method: "POST",
      url: `${SCRAPELY_API_BASE}/dm/send`,
      headers: {
        "X-API-Key": SCRAPELY_API_KEY,
        "Content-Type": "application/json",
      },
      data: { conversation_id: conversationId, message, account_id: accountId },
      timeout: 30000,
      validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300) {
      console.error(`[Scrapely] DM send error: ${response.status} - ${JSON.stringify(response.data)}`);
      return false;
    }
    console.log(`[Scrapely] DM sent successfully`);
    return true;
  } catch (err) {
    console.error(`[Scrapely] DM exception: ${err.message}`);
    return false;
  }
}

async function fetchConversation(conversationId) {
  try {
    const response = await axios({
      method: "GET",
      url: `${SCRAPELY_API_BASE}/conversations`,
      params: { conversation_id: conversationId },
      headers: { "X-API-Key": SCRAPELY_API_KEY },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300) {
      console.error(`[Scrapely] Fetch conversation error: ${response.status}`);
      return null;
    }
    return response.data.conversation;
  } catch (err) {
    console.error(`[Scrapely] Fetch conversation exception: ${err.message}`);
    return null;
  }
}

async function fetchCRMConversations(tag) {
  const allConversations = [];
  let cursor = null;

  try {
    while (true) {
      const params = { tag, include_messages: true, limit: 100 };
      if (cursor) params.cursor = cursor;

      const response = await axios({
        method: "GET",
        url: `${SCRAPELY_API_BASE}/crm/conversations`,
        params,
        headers: { "X-API-Key": SCRAPELY_API_KEY },
        timeout: 30000,
        validateStatus: () => true,
      });
      if (response.status < 200 || response.status >= 300) break;

      const tagData = response.data?.columns?.[tag];
      const convos = tagData?.conversations || [];
      allConversations.push(...convos);

      const nextCursor = response.data?.next_cursor;
      if (!nextCursor || convos.length < 100) break;
      cursor = nextCursor;
    }
    return { conversations: allConversations, count: allConversations.length };
  } catch (err) {
    console.error(`[CRM] Fetch exception: ${err.message}`);
    return { conversations: allConversations, count: allConversations.length };
  }
}

async function updateCRMNotes(conversationId, accountHandle, data) {
  try {
    const response = await axios({
      method: "PATCH",
      url: `${SCRAPELY_API_BASE}/crm/update`,
      headers: { "X-API-Key": SCRAPELY_API_KEY, "Content-Type": "application/json" },
      data: { conversation_id: conversationId, account_handle: accountHandle, notes: JSON.stringify(data) },
      timeout: 15000,
      validateStatus: () => true,
    });
    return response.status >= 200 && response.status < 300;
  } catch (err) {
    console.error(`[CRM] Update exception: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------
function parseCRMNotes(conversation) {
  try {
    const notes = conversation?.crm?.notes;
    if (!notes) return null;
    return JSON.parse(notes);
  } catch {
    return null;
  }
}


function sanitizeReply(text) {
  if (!text) return text;
  return text
    .replace(/[\u2013\u2014]/g, ", ")   // en-dash / em-dash -> comma
    .replace(/ - /g, ", ")              // spaced dash -> comma
    .replace(/^- /gm, "")              // leading list dashes
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{200D}\u{2702}-\u{27B0}\u{2300}-\u{23FF}]/gu, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// AI Setter: generate reply for back-and-forth conversations
// ---------------------------------------------------------------------------
async function generateSetterReply(conversationMessages, leadContext, originalOutboundDm) {
  const { senderScreenName, senderName, senderDescription, companyName, website } = leadContext;

  const leadMessages = conversationMessages.filter((m) => !m.isSent).map((m) => m.text);
  const leadTonality = leadMessages.slice(-3).join(" | ");

  let systemPrompt = `You are a Twitter SDR responding to DMs from leads.
Match the lead's style (slang, short, or formal).
Stay natural, casual, never robotic.
Never reveal you're AI.
Use contractions instead of full words (e.g. "don't" instead of "do not").
Include question marks (?) for questions.
NEVER use dashes (-), en-dashes, or em-dashes in your response. Use commas, periods, or separate sentences instead.
NEVER use emojis. Zero. None.

Lead: @${senderScreenName} — ${senderName}
Lead Bio: ${senderDescription || "N/A"}
Lead Style Sample: ${leadTonality}

Account Instructions: ${INSTRUCTIONS}
Account Offer: ${OFFER}`;

  if (companyName) systemPrompt += `\n\nLead's Company: ${companyName}`;
  if (website) systemPrompt += `\nLead's Website: ${website}`;
  if (originalOutboundDm) systemPrompt += `\n\nYour opening DM to this lead was: "${originalOutboundDm}"`;
  systemPrompt += `\n\nCalendar link (use when pushing for a call): ${CALENDAR_LINK}`;
  systemPrompt += `\n\nRespond with your next message only. No quotes, no explanation, no prefixes. Just the message text.`;

  // Map conversation history to Claude messages
  const claudeMessages = [];
  for (const msg of conversationMessages) {
    const role = msg.isSent ? "assistant" : "user";
    if (claudeMessages.length > 0 && claudeMessages[claudeMessages.length - 1].role === role) {
      claudeMessages[claudeMessages.length - 1].content += "\n" + msg.text;
    } else {
      claudeMessages.push({ role, content: msg.text });
    }
  }

  // Claude requires messages to start with user role
  if (claudeMessages.length > 0 && claudeMessages[0].role === "assistant") {
    claudeMessages.shift();
  }

  // Claude requires messages to end with user role
  if (claudeMessages.length === 0 || claudeMessages[claudeMessages.length - 1].role !== "user") {
    console.log(`[Setter] No new user message to respond to, skipping`);
    return null;
  }

  console.log(`[Setter] Generating reply with ${claudeMessages.length} messages in history...`);

  let reply = await callClaude(claudeMessages, { system: systemPrompt, maxTokens: 300 });
  if (reply) {
    reply = sanitizeReply(reply);
    console.log(`[Setter] Generated reply: "${reply}"`);
  }
  return reply;
}

// ---------------------------------------------------------------------------
// Follow-up message generation (for stale leads)
// ---------------------------------------------------------------------------
async function generateFollowUpMessage(leadContext, followupPrompt, conversationMessages) {
  const { senderScreenName, senderName, senderDescription, companyName, website } = leadContext;

  const recentMessages = (conversationMessages || [])
    .slice(-6)
    .map((m) => `${m.isSent || m.is_sent ? "Us" : "Lead"}: ${m.text}`)
    .join("\n");

  const systemPrompt = `You are a Twitter SDR sending a follow-up DM. The lead went silent.
Match their tone from prior messages. Stay casual, human, short. No corporate speak. Max 2-3 sentences.
NEVER use dashes (-), en-dashes, or em-dashes. Use commas, periods, or separate sentences instead.
NEVER use emojis. Zero. None.

Account Instructions: ${INSTRUCTIONS}
Account Offer: ${OFFER}

Lead: @${senderScreenName} — ${senderName}
Lead Bio: ${senderDescription || "N/A"}
${companyName ? `Company: ${companyName}` : ""}
${website ? `Website: ${website}` : ""}
Calendar link: ${CALENDAR_LINK}

Recent conversation:
${recentMessages}

Respond with your follow-up message only. No quotes, no explanation, no prefixes. Just the message text.`;

  const resolvedPrompt = followupPrompt.replace("{calendar_link}", CALENDAR_LINK);

  let reply = await callClaude(
    [{ role: "user", content: resolvedPrompt }],
    { system: systemPrompt, maxTokens: 200 }
  );

  if (reply) {
    reply = sanitizeReply(reply);
    console.log(`[FollowUp] Generated: "${reply}"`);
  }
  return reply;
}

// ---------------------------------------------------------------------------
// Process back-and-forth reply
// ---------------------------------------------------------------------------
async function processBackAndForth(payload) {
  const senderScreenName = payload.sender_screen_name;
  const senderName = payload.lead_name || senderScreenName || "there";
  const conversationId = payload.conversation_id;
  const accountId = payload.account_id;
  const accountHandle = payload.account_twitter_handle;

  if (!conversationId || !accountId) {
    console.error(`[Process] Missing conversation_id or account_id, skipping`);
    return;
  }

  console.log(`[Process] Reply from @${senderScreenName}, fetching conversation...`);

  const conversation = await fetchConversation(conversationId);
  if (!conversation || !conversation.messages || conversation.messages.length === 0) {
    console.error(`[Process] Failed to fetch conversation ${conversationId}`);
    return;
  }

  // Check if AI setter is disabled for this conversation
  if (conversation.crm?.ai_setter_enabled === false) {
    console.log(`[Process] AI setter disabled for @${senderScreenName}, skipping`);
    return;
  }

  // Parse CRM notes for stored context
  const crmData = parseCRMNotes(conversation);
  const companyName = crmData?.company_name || null;
  const website = crmData?.website || null;

  // Find original outbound DM
  const originalOutbound = conversation.messages.find((m) => m.isSent);
  const originalOutboundDm = originalOutbound?.text || null;

  // Check if we've sent 3+ messages in a row without a response
  const messages = conversation.messages;
  let consecutiveSent = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (i === messages.length - 1 && !messages[i].isSent) continue;
    if (messages[i].isSent) consecutiveSent++;
    else break;
  }
  if (consecutiveSent >= 3) {
    console.log(`[Process] Already sent 3+ messages in a row, not responding to @${senderScreenName}`);
    return;
  }

  // Build lead context
  const lead = conversation.lead || {};
  const leadContext = {
    senderScreenName: lead.screen_name || senderScreenName,
    senderName: lead.name || senderName,
    senderDescription: lead.bio || payload.lead_description || null,
    companyName,
    website,

  };

  // Generate AI reply
  const reply = await generateSetterReply(conversation.messages, leadContext, originalOutboundDm);
  if (!reply) {
    console.log(`[Process] No reply generated for @${senderScreenName}`);
    return;
  }

  // Human-like delay (5-15s)
  const delay = 5000 + Math.floor(Math.random() * 10000);
  console.log(`[Process] Waiting ${Math.round(delay / 1000)}s before replying...`);
  await new Promise((r) => setTimeout(r, delay));

  // Send the reply
  await sendDM(conversationId, accountId, reply);

  // Reset follow-up chain
  if (accountHandle && crmData) {
    crmData.followup_count = 0;
    crmData.last_followup_at = null;
    await updateCRMNotes(conversationId, accountHandle, crmData);
  }

  console.log(`[Process] Reply sent to @${senderScreenName}: "${reply}"`);
}

// ---------------------------------------------------------------------------
// Process first reply
// ---------------------------------------------------------------------------
async function processFirstReply(payload) {
  const senderScreenName = payload.sender_screen_name;
  const conversationId = payload.conversation_id;
  const accountId = payload.account_id;

  if (!conversationId || !accountId) {
    console.error(`[Process] Missing conversation_id or account_id, skipping`);
    return;
  }

  console.log(`[Process] First reply from @${senderScreenName}, handling as setter...`);

  // Treat it the same as a back-and-forth — fetch conversation and respond
  await processBackAndForth(payload);
}

// ---------------------------------------------------------------------------
// Route webhook events
// ---------------------------------------------------------------------------
async function processMessage(payload) {
  const isBackAndForth = payload.is_back_and_forth || payload.event === "reply_back_and_forth";
  const messageText = payload.message_text || payload.reply_text || "";

  if (payload.sentiment === "negative") {
    console.log(`[Process] Negative sentiment from @${payload.sender_screen_name}, skipping`);
    return;
  }

  if (!isBackAndForth) {
    await processFirstReply(payload);
    return;
  }

  await processBackAndForth(payload);
}

// ---------------------------------------------------------------------------
// Follow-up loop — periodically checks for stale leads and sends follow-ups
// ---------------------------------------------------------------------------
async function followUpLoop() {
  console.log(`[FollowUp] Checking for stale leads needing follow-up...`);

  try {
    const tagData = await fetchCRMConversations("interested_reply");
    if (!tagData?.conversations || tagData.conversations.length === 0) {
      console.log(`[FollowUp] No interested_reply conversations to check`);
      return;
    }

    // Build handle → account_id lookup (CRM endpoint doesn't return account_id)
    const accounts = await fetchAccounts();
    const handleToAccountId = {};
    for (const acc of accounts) {
      if (acc.handle && acc.id) handleToAccountId[acc.handle.toLowerCase()] = acc.id;
    }

    const now = Date.now();
    let followupsSent = 0;

    for (const conv of tagData.conversations) {
      try {
        const lastMsg = conv.last_message;
        if (!lastMsg || !lastMsg.is_sent) continue;

        if (conv.crm?.ai_setter_enabled === false) continue;

        // Skip conversations from inactive/banned accounts
        const accountHandle = conv.account_handle || conv.lead?.account_handle;
        const accountId = conv.account_id || (accountHandle && handleToAccountId[accountHandle.toLowerCase()]);
        if (!accountId) {
          console.log(`[FollowUp] Skipping conversation ${conv.conversation_id} — account "${accountHandle}" is not active`);
          continue;
        }

        const rawTime = lastMsg.time || 0;
        const lastMsgTime = typeof rawTime === "string" ? new Date(rawTime).getTime() : rawTime;
        const daysSinceLastMsg = (now - lastMsgTime) / (1000 * 60 * 60 * 24);

        const notes = parseCRMNotes(conv) || {};
        const followupCount = notes.followup_count || 0;

        if (followupCount >= FOLLOWUP_CHAIN.length) continue;

        const nextFollowup = FOLLOWUP_CHAIN[followupCount];
        if (daysSinceLastMsg < nextFollowup.delayDays) continue;

        // Build lead context
        const lead = conv.lead || {};
        const leadContext = {
          senderScreenName: lead.screen_name || conv.receiver_screen_name || "unknown",
          senderName: lead.name || "unknown",
          senderDescription: lead.bio || null,
          companyName: notes.company_name || null,
          website: notes.website || null,
        };

        const fullConversation = await fetchConversation(conv.conversation_id);
        if (!fullConversation?.messages) continue;

        const followupMsg = await generateFollowUpMessage(
          leadContext,
          nextFollowup.prompt,
          fullConversation.messages
        );
        if (!followupMsg) continue;

        // Human-like delay
        const delay = 3000 + Math.floor(Math.random() * 7000);
        await new Promise((r) => setTimeout(r, delay));

        const sent = await sendDM(conv.conversation_id, accountId, followupMsg);
        if (!sent) continue;

        // Update follow-up count in CRM
        notes.followup_count = followupCount + 1;
        notes.last_followup_at = new Date().toISOString();
        if (accountHandle) {
          await updateCRMNotes(conv.conversation_id, accountHandle, notes);
        }

        followupsSent++;
        console.log(`[FollowUp] Sent follow-up #${followupCount + 1} to @${leadContext.senderScreenName}`);
      } catch (err) {
        console.error(`[FollowUp] Error processing conversation: ${err.message}`);
      }
    }

    console.log(`[FollowUp] Done. Sent ${followupsSent} follow-ups.`);
  } catch (err) {
    console.error(`[FollowUp] Loop error: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  // Health check (no auth required) — shows config status for debugging
  if (req.method === "GET" && req.url === "/health") {
    const config = {
      status: CONFIG_WARNINGS.length === 0 ? "ok" : "needs_setup",
      service: "ai-setter-agent",
      config: {
        openrouter_key: process.env.OPENROUTER_API_KEY ? "set" : "MISSING",
        scrapely_key: SCRAPELY_API_KEY ? "set" : "MISSING",
        calendar_link: CALENDAR_LINK ? "set" : "MISSING",
        webhook_auth: WEBHOOK_SECRETS.size > 0 ? "set" : "MISSING",
        offer_customized: !OFFER.includes("[Your Company Name]") && !OFFER.includes("REPLACE EVERYTHING BELOW"),
        instructions_customized: !INSTRUCTIONS.includes("[YOUR PROPOSAL/CASE STUDY LINK]"),
      },
      issues: CONFIG_WARNINGS.length > 0 ? CONFIG_WARNINGS : undefined,
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(config, null, 2));
    return;
  }

  // Webhook auth — every request (except /health) must have a valid X-Webhook-Key
  if (!WEBHOOK_SECRETS.has(req.headers["x-webhook-key"])) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Forbidden — invalid or missing X-Webhook-Key header" }));
    return;
  }

  // Test endpoint — dry-run
  if (req.method === "GET" && req.url.startsWith("/test")) {
    const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const conversationId = params.get("conversation_id");

    if (!conversationId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing ?conversation_id= param" }));
      return;
    }

    (async () => {
      try {
        const conversation = await fetchConversation(conversationId);
        if (!conversation?.messages?.length) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Conversation not found or empty" }));
          return;
        }

        const crmData = parseCRMNotes(conversation);
        const lead = conversation.lead || {};
        const originalOutbound = conversation.messages.find((m) => m.isSent);

        const leadContext = {
          senderScreenName: lead.screen_name || "unknown",
          senderName: lead.name || "unknown",
          senderDescription: lead.bio || null,
          companyName: crmData?.company_name || null,
          website: crmData?.website || null,
        };

        const reply = await generateSetterReply(
          conversation.messages,
          leadContext,
          originalOutbound?.text || null
        );

        const followupPreviews = [];
        for (const fu of FOLLOWUP_CHAIN) {
          const fuMsg = await generateFollowUpMessage(leadContext, fu.prompt, conversation.messages);
          followupPreviews.push({ delayDays: fu.delayDays, message: fuMsg });
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          conversation_id: conversationId,
          lead: { handle: leadContext.senderScreenName, name: leadContext.senderName, bio: leadContext.senderDescription },
          crm_context: crmData,
          message_count: conversation.messages.length,
          setter_reply: reply || "(no reply generated)",
          followup_chain_previews: followupPreviews,
          note: "DRY RUN — nothing was sent",
        }, null, 2));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
    return;
  }

  // Root GET — friendly landing page for people visiting in a browser
  if (req.method === "GET" && (req.url === "/" || req.url === "")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      service: "ai-setter-agent",
      status: CONFIG_WARNINGS.length === 0 ? "running" : "needs_setup",
      hint: "This is a webhook server. Scrapely sends POST requests here. Visit /health to check your config.",
      endpoints: {
        health: "/health",
        test: "/test?conversation_id=YOUR_CONVERSATION_ID",
        webhook: "POST /",
      },
    }, null, 2));
    return;
  }

  // Main webhook endpoint
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    // Respond immediately
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ received: true }));

    try {
      const payload = JSON.parse(body);
      console.log(`\n[Webhook] Event: ${payload.event} from @${payload.sender_screen_name || "unknown"} (back_and_forth: ${payload.is_back_and_forth})`);

      if (payload.event !== "new_reply" && payload.event !== "reply_back_and_forth") {
        console.log(`[Webhook] Skipping event type: ${payload.event}`);
        return;
      }

      processMessage(payload).catch((err) => {
        console.error(`[Webhook] Processing error: ${err.message}`);
      });
    } catch (err) {
      console.error(`[Webhook] JSON parse error: ${err.message}`);
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n✅ AI Setter Agent listening on port ${PORT}`);
  console.log(`  Health:  http://localhost:${PORT}/health`);
  console.log(`  Test:    http://localhost:${PORT}/test?conversation_id=XXX`);
  console.log(`  Webhook: POST http://localhost:${PORT}/`);
  console.log(`  Follow-up chain: ${FOLLOWUP_CHAIN.map((f, i) => `#${i + 1} after ${f.delayDays}d`).join(", ")}`);

  if (CONFIG_WARNINGS.length === 0) {
    console.log(`\n  ✅ All config checks passed — ready to receive Scrapely webhook events\n`);
  } else {
    console.log(`\n  ⚠️  Server started with ${CONFIG_WARNINGS.length} config warning(s) — check /health for details\n`);
  }

  console.log(`  📋 NEXT STEPS (if deploying to Railway):`);
  console.log(`     1. Enable Public Networking in Railway (Settings > Networking > Generate Domain)`);
  console.log(`     2. Copy your public URL and add it as a webhook in Scrapely Settings`);
  console.log(`     3. Copy the X-Webhook-Key from Scrapely and add it as WEBHOOK_SECRETS in Railway Variables`);
  console.log(`     4. Visit your-url.com/health to verify everything is configured\n`);

  // Start follow-up loop
  followUpLoop().catch((err) => console.error(`[FollowUp] Initial run error: ${err.message}`));
  setInterval(() => {
    followUpLoop().catch((err) => console.error(`[FollowUp] Loop error: ${err.message}`));
  }, FOLLOWUP_CHECK_INTERVAL_MS);
});
