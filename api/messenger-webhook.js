// Vercel Serverless Function – Messenger ↔ OpenAI ↔ Notion bridge

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const META_PAGE_TOKEN = process.env.META_PAGE_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

let conversationMemory = {}; // { psid: [{role, content}, ...] }
let inactivityTimers = {};   // { psid: timeoutId }

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

// --- Notion helper functions
async function saveConversationToNotion(data) {
  const url = "https://api.notion.com/v1/pages";
  const body = {
    parent: { database_id: DATABASE_ID },
    properties: {
      "Client Name": { title: [{ text: { content: data.clientName } }] },
      "Contact Info": { rich_text: [{ text: { content: data.contactInfo } }] },
      "Location": { rich_text: [{ text: { content: data.location } }] },
      "Task Description": { rich_text: [{ text: { content: data.taskDescription } }] },
      "Conversation Summary": { rich_text: [{ text: { content: data.conversationSummary } }] },
      "Date/Time": { date: { start: data.dateTime } },
      "Follow-up Needed": { checkbox: data.followUp },
      "PSID": { rich_text: [{ text: { content: data.psid } }] },
    },
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text();
      console.error("Notion API error:", res.status, t);
      return false;
    }
    return await res.json();
  } catch (e) {
    console.error("Notion request failed:", e);
    return false;
  }
}

async function analyzeConversationForNotion(conversationText, psid) {
  const prompt = `
You are analyzing a handyman chat conversation.
Extract fields:
- Client Name
- Contact Info (phone/email)
- Location
- Task Description
- Conversation Summary (1-2 sentences)
Return JSON only. Leave missing fields blank.
Conversation:
${conversationText}`;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 300,
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      console.error("OpenAI API error:", res.status, t);
      return null;
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || "{}";
    let parsed;
    try { parsed = JSON.parse(content); } catch { parsed = {}; }
    return {
      clientName: parsed["Client Name"] || "",
      contactInfo: parsed["Contact Info"] || "",
      location: parsed["Location"] || "",
      taskDescription: parsed["Task Description"] || "",
      conversationSummary: parsed["Conversation Summary"] || "",
      dateTime: new Date().toISOString(),
      followUp: Boolean(parsed["Task Description"] || parsed["Contact Info"]),
      psid,
    };
  } catch (e) {
    console.error("OpenAI request failed:", e);
    return { clientName: "", contactInfo: "", location: "", taskDescription: "", conversationSummary: "", dateTime: new Date().toISOString(), followUp: false, psid };
  }
}

async function saveConversationIfTaskExists(conversationText, psid) {
  const analyzedData = await analyzeConversationForNotion(conversationText, psid);
  if (analyzedData && analyzedData.taskDescription) return saveConversationToNotion(analyzedData);
  console.log("Task Description missing, skipping Notion save.");
  return null;
}

// --- Ask OpenAI for chatbot response (original code kept intact)
async function askOpenAI(psid, userText) {
  if (!OPENAI_API_KEY) return `Echo: ${userText}`;
  const systemPrompt = `
You are the AI assistant for Handyman Grace Company, a handyman/home-repair service in Sacramento County, CA.
Tone: friendly, brief, confident. Keep replies to 2–5 sentences.
Do not guess exact prices. If asked for price, say you can give a ballpark after a few details.
If the user seems like a lead, collect info politely.`;

  if (!conversationMemory[psid]) conversationMemory[psid] = [];
  conversationMemory[psid].push({ role: "user", content: userText });

  // --- Summarize older messages if memory exceeds 10
  if (conversationMemory[psid].length > 10) {
    const oldMessages = conversationMemory[psid].slice(0, -10);
    const summaryPrompt = `Summarize the following conversation in 2-3 sentences for context:\n${oldMessages.map(m => m.role + ": " + m.content).join("\n")}`;
    const summaryRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: "gpt-4.1-mini", messages: [{ role: "system", content: summaryPrompt }], temperature: 0.5, max_tokens: 150 }),
    });
    const summaryData = await summaryRes.json().catch(() => ({}));
    const summaryText = summaryData?.choices?.[0]?.message?.content || "Summary unavailable.";
    conversationMemory[psid] = [{ role: "system", content: summaryText }, ...conversationMemory[psid].slice(-10)];
  }

  const messagesToSend = [{ role: "system", content: systemPrompt }, ...(conversationMemory[psid] || []), { role: "user", content: userText }];
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: "gpt-4.1-mini", messages: messagesToSend, temperature: 0.5, max_tokens: 300 }),
  });
  if (!r.ok) { const t = await r.text().catch(() => ""); console.error("OpenAI error:", r.status, t); return "[ai-error] Sorry, I hit a snag."; }
  const data = await r.json().catch(() => ({}));
  const out = data?.choices?.[0]?.message?.content;
  conversationMemory[psid].push({ role: "assistant", content: out || "…" });

  // --- Inactivity timer: 1 minute for testing
  if (inactivityTimers[psid]) clearTimeout(inactivityTimers[psid]);
  inactivityTimers[psid] = setTimeout(() => {
    const fullConversation = conversationMemory[psid].map(m => `${m.role}: ${m.content}`).join("\n");
    saveConversationIfTaskExists(fullConversation, psid);
  }, 1 * 60 * 1000); // 1 minute

  return out || "…";
}

// --- Vercel handler
export default async function handler(req, res) {
  if (req.method === "GET") {
    const mode = req.query["hub.mode"], token = req.query["hub.verify_token"], challenge = req.query["hub.challenge"];
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
            }
          }
        }
        return res.status(200).send("EVENT_RECEIVED");
      }
      return res.status(404).send("Not Found");
    } catch (e) { console.error("Webhook handler error:", e); return res.status(200).send("EVENT_RECEIVED"); }
  }

  res.setHeader("Allow", "GET, POST");
  res.status(405).end("Method Not Allowed");
}
