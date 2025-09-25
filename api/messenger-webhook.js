// messenger-webhook.js – Messenger ↔ OpenAI + Notion integration with 1-min inactivity batching

import fetch from "node-fetch";
import { saveConversationIfTaskExists } from "./notion.js";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const META_PAGE_TOKEN = process.env.META_PAGE_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// --- In-memory conversation memory and last activity tracking
let conversationMemory = {}; // { psid: [{role, content}, ...] }
let lastActivity = {};      // { psid: timestamp in ms }

// --- Send a text reply back to the user via Facebook Send API
async function sendText(psid, text) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(
    META_PAGE_TOKEN
  )}`;
  const body = { recipient: { id: psid }, messaging_type: "RESPONSE", message: { text } };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error("Send API error:", r.status, t);
  }
}

// --- Ask OpenAI (Chat Completions) with memory support
async function askOpenAI(psid, userText) {
  if (!OPENAI_API_KEY) return `Echo: ${userText}`;

  const systemPrompt = `
You are the assistant for Handyman Grace Company, a handyman/home-repair service in Sacramento County, CA.
Tone: friendly, brief, confident. Keep replies to 2–5 sentences.
Do not guess exact prices. If asked for price, say you can give a ballpark after a few details. If user insists, give general prices.
If the user seems like a lead, collect Name, Contact info, Address, Task description, Timing, Budget.
If outside scope, suggest contacting a licensed GC. For emergencies, advise calling local emergency services.
`;

  if (!conversationMemory[psid]) conversationMemory[psid] = [];
  conversationMemory[psid].push({ role: "user", content: userText });

  // Update last activity timestamp
  lastActivity[psid] = Date.now();

  const messagesToSend = [
    { role: "system", content: systemPrompt },
    ...(conversationMemory[psid] || []),
    { role: "user", content: userText },
  ];

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: "gpt-4.1-mini", messages: messagesToSend, temperature: 0.5, max_tokens: 300 }),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error("OpenAI error:", r.status, t);
    return "[ai-error] Sorry, I hit a snag. Please try again.";
  }

  const data = await r.json().catch(() => ({}));
  const out = data?.choices?.[0]?.message?.content;
  conversationMemory[psid].push({ role: "assistant", content: out || "…" });

  return out || "…";
}

// --- Periodically check for inactive users and save conversations to Notion
setInterval(() => {
  const now = Date.now();
  for (const psid in lastActivity) {
    if (now - lastActivity[psid] > 60_000 && conversationMemory[psid]?.length > 0) { // 1 minute inactivity
      const fullConversation = conversationMemory[psid].map(m => `${m.role}: ${m.content}`).join("\n");
      saveConversationIfTaskExists(fullConversation, psid)
        .then(() => console.log(`Saved conversation for PSID ${psid} after inactivity`))
        .catch(err => console.error("Failed to save conversation to Notion", err));
      // Clear memory and timestamp
      delete conversationMemory[psid];
      delete lastActivity[psid];
    }
  }
}, 10_000); // check every 10 seconds

// --- Webhook handler
export default async function handler(req, res) {
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.status(403).send("Verification failed");
  }

  if (req.method === "POST") {
    try {
      const body = req.body || {};
      if (body.object === "page") {
        for (const entry of body.entry || []) {
          for (const evt of entry.messaging || []) {
            const psid = evt.sender?.id;
            const text = evt.message?.text || evt.postback?.payload;
            if (psid && text) {
              // 1️⃣ Get OpenAI reply
              const reply = await askOpenAI(psid, text);
              // 2️⃣ Send reply to user
              await sendText(psid, reply);
            }
          }
        }
        return res.status(200).send("EVENT_RECEIVED");
      }
      return res.status(404).send("Not Found");
    } catch (e) {
      console.error("Webhook handler error:", e);
      return res.status(200).send("EVENT_RECEIVED");
    }
  }

  res.setHeader("Allow", "GET, POST");
  res.status(405).end("Method Not Allowed");
}
