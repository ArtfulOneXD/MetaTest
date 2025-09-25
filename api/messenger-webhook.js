// messenger-webhook.js – Messenger ↔ OpenAI + Notion integration

import fetch from "node-fetch";
import { saveConversationIfTaskExists } from "./notion.js"; // <-- Import Notion function

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const META_PAGE_TOKEN = process.env.META_PAGE_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// --- In-memory conversation memory
let conversationMemory = {}; // { psid: [{role, content}, ...] }

// --- Send a text reply back to the user via Facebook Send API
async function sendText(psid, text) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(
    META_PAGE_TOKEN
  )}`;
  const body = {
    recipient: { id: psid },
    messaging_type: "RESPONSE",
    message: { text },
  };
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
Do not guess exact prices. If asked for price, say you can give a ballpark after a few details. But if the user insists, give general prices.
If the user seems like a lead (estimate/availability/onsite), politely collect:
- Name
- Best contact (phone/email)
- Address/area in Sacramento
- Task description (photos/links if any)
- Timing (preferred date/time)
- Budget (optional)
Then offer to pass it to the team now.
If it’s outside typical handyman scope, suggest contacting a licensed GC. For emergencies, advise calling local emergency services.
If asked, you may share: (916) 769-2889 or (916) 281-7178.
`;

  // --- Initialize memory for this user
  if (!conversationMemory[psid]) conversationMemory[psid] = [];

  // --- Append new user message
  conversationMemory[psid].push({ role: "user", content: userText });

  // --- Summarize older messages if memory exceeds 10
  if (conversationMemory[psid].length > 10) {
    const oldMessages = conversationMemory[psid].slice(0, -10);
    const summaryPrompt = `Summarize the following conversation in 2-3 sentences for context: 
${oldMessages.map(m => m.role + ": " + m.content).join("\n")}`;

    const summaryRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [{ role: "system", content: summaryPrompt }],
        temperature: 0.5,
        max_tokens: 150,
      }),
    });

    const summaryData = await summaryRes.json().catch(() => ({}));
    const summaryText = summaryData?.choices?.[0]?.message?.content || "Summary unavailable.";

    // Keep summary + last 10 messages
    conversationMemory[psid] = [
      { role: "system", content: summaryText },
      ...conversationMemory[psid].slice(-10),
    ];
  }

  // --- Prepare messages for OpenAI
  const messagesToSend = [
    { role: "system", content: systemPrompt },
    ...(conversationMemory[psid] || []),
    { role: "user", content: userText },
  ];

  // --- Call OpenAI
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages: messagesToSend,
      temperature: 0.5,
      max_tokens: 300,
    }),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error("OpenAI error:", r.status, t);
    return "[ai-error] Sorry, I hit a snag. Please try again.";
  }

  const data = await r.json().catch(() => ({}));
  const out = data?.choices?.[0]?.message?.content;

  // --- Append assistant response to memory
  conversationMemory[psid].push({ role: "assistant", content: out || "…" });

  return out || "…";
}

// --- Webhook handler
export default async function handler(req, res) {
  // --- Webhook verification handshake (Meta sends GET)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Verification failed");
  }

  // --- Webhook events (Meta sends POST)
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

              // 3️⃣ Save conversation to Notion (non-blocking)
              saveConversationIfTaskExists(text, psid)
                .then(() => console.log("Saved conversation to Notion"))
                .catch(err => console.error("Failed to save conversation to Notion", err));
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
