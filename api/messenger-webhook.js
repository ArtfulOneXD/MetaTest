// Vercel Serverless Function – Messenger ↔ OpenAI ↔ Notion bridge

import fetch from "node-fetch";
import {
  saveConversationIfTaskExists
} from "./notion.js"; // Make sure notion.js is in the same folder

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const META_PAGE_TOKEN = process.env.META_PAGE_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// --- In-memory conversation memory
let conversationMemory = {}; // { psid: [{role, content}, ...] }
let inactivityTimers = {};   // { psid: Timeout }

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
If the user seems like a lead, politely collect:
- Name
- Best contact (phone/email)
- Address/area in Sacramento
- Task description (photos/links if any)
- Timing (preferred date/time)
- Budget (optional)
Then offer to pass it to the team.
If it’s outside typical handyman scope, suggest contacting a licensed GC. For emergencies, advise calling local emergency services.
If asked, you may share: (916) 769-2889 or (916) 281-7178.
`;

  if (!conversationMemory[psid]) conversationMemory[psid] = [];
  conversationMemory[psid].push({ role: "user", content: userText });

  // Summarize older messages if memory exceeds 10
  if (conversationMemory[psid].length > 10) {
    const oldMessages = conversationMemory[psid].slice(0, -10);
    const summaryPrompt = `Summarize the following conversation in 2-3 sentences for context: 
${oldMessages.map(m => m.role + ": " + m.content).join("\n")}`;

    try {
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
      conversationMemory[psid] = [
        { role: "system", content: summaryText },
        ...conversationMemory[psid].slice(-10),
      ];
    } catch (e) {
      console.error("OpenAI summary error:", e);
    }
  }

  // Prepare messages for OpenAI
  const messagesToSend = [
    { role: "system", content: systemPrompt },
    ...(conversationMemory[psid] || []),
    { role: "user", content: userText },
  ];

  try {
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
    conversationMemory[psid].push({ role: "assistant", content: out || "…" });

    return out || "…";
  } catch (e) {
    console.error("OpenAI request failed:", e);
    return "[ai-error] Request failed";
  }
}

// --- Save conversation after inactivity
function scheduleNotionSave(psid) {
  if (inactivityTimers[psid]) clearTimeout(inactivityTimers[psid]);
  inactivityTimers[psid] = setTimeout(async () => {
    const conv = conversationMemory[psid]?.map(m => `${m.role}: ${m.content}`).join("\n") || "";
    if (conv) {
      console.log(`Saving conversation for PSID ${psid} to Notion...`);
      await saveConversationIfTaskExists(conv, psid);
    }
  }, 60_000); // 1 minute inactivity
}

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
              const reply = await askOpenAI(psid, text);
              await sendText(psid, reply);
              scheduleNotionSave(psid); // schedule Notion save after inactivity
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
