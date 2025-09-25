// messenger-webhook.js – Combined OpenAI + Notion integration with inactivity logic

import fetch from "node-fetch";

// --- ENV variables
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const META_PAGE_TOKEN = process.env.META_PAGE_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.NOTION_DATABASE_ID?.trim();

if (!VERIFY_TOKEN || !META_PAGE_TOKEN || !OPENAI_API_KEY || !NOTION_TOKEN || !DATABASE_ID) {
  console.warn("Missing environment variables!");
}

// --- In-memory conversation storage per user
let conversationMemory = {}; // { psid: { messages: [{role,content}], timeout: Timeout } }

// --- Send text via Facebook Send API
async function sendText(psid, text) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(META_PAGE_TOKEN)}`;
  const body = { recipient: { id: psid }, messaging_type: "RESPONSE", message: { text } };
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("Send API error:", res.status, t);
  }
}

// --- Save to Notion
async function saveConversationToNotion(data) {
  const url = "https://api.notion.com/v1/pages";
  const body = {
    parent: { database_id: DATABASE_ID },
    properties: {
      "Client Name": { title: [{ text: { content: data.clientName || "" } }] },
      "Contact Phone": { phone_number: data.contactPhone || "" },
      "Contact Email": { email: data.contactEmail || "" },
      "Location": { rich_text: [{ text: { content: data.location || "" } }] },
      "Task": { rich_text: [{ text: { content: data.task || "" } }] },
      "Description": { rich_text: [{ text: { content: data.description || "" } }] },
      "Conversation Summary": { rich_text: [{ text: { content: data.conversationSummary || "" } }] },
      "Time": { date: { start: data.dateTime || new Date().toISOString() } },
      "Follow-up Needed": { checkbox: data.followUp || false },
      "PSID": { rich_text: [{ text: { content: data.psid || "" } }] },
      "Job Scheduled": { checkbox: data.jobScheduled || false },
      "Job Done": { status: { name: data.jobDone ? "Done" : "Not started" } },
    },
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${NOTION_TOKEN}`, "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) console.error("Notion API error:", res.status, text);
    return text;
  } catch (e) { console.error("Notion request failed:", e); return null; }
}

// --- Analyze conversation using OpenAI
async function analyzeConversation(conversationText, psid) {
  const prompt = `
You are analyzing a handyman chat conversation.
Extract exactly the following fields to match the Notion database:

- Client Name
- Contact Phone
- Contact Email
- Location
- Task
- Description
- Conversation Summary (1-2 sentences)
- Time (ISO format if possible)

Return JSON only with these keys. Leave blank if missing.
Conversation:
${conversationText}
`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: 400 }),
    });
    if (!res.ok) { const t = await res.text(); console.error("OpenAI error:", res.status, t); return null; }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || "{}";
    let parsed;
    try { parsed = JSON.parse(content); } catch { parsed = {}; }

    return {
      clientName: parsed["Client Name"] || "",
      contactPhone: parsed["Contact Phone"] || "",
      contactEmail: parsed["Contact Email"] || "",
      location: parsed["Location"] || "",
      task: parsed["Task"] || "",
      description: parsed["Description"] || "",
      conversationSummary: parsed["Conversation Summary"] || "",
      dateTime: parsed["Time"] || new Date().toISOString(),
      followUp: Boolean(parsed["Task"] || parsed["Contact Phone"] || parsed["Contact Email"]),
      psid,
      jobScheduled: false,
      jobDone: false,
    };
  } catch (e) {
    console.error("OpenAI request failed:", e);
    return { clientName: "", contactPhone: "", contactEmail: "", location: "", task: "", description: "", conversationSummary: "", dateTime: new Date().toISOString(), followUp: false, psid, jobScheduled: false, jobDone: false };
  }
}

// --- Webhook handler
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
              // Append to memory
              if (!conversationMemory[psid]) conversationMemory[psid] = { messages: [], timeout: null };
              conversationMemory[psid].messages.push({ role: "user", content: text });

              // Send reply immediately
              const reply = await askOpenAI(psid, text);
              await sendText(psid, reply);

              // Reset inactivity timer
              if (conversationMemory[psid].timeout) clearTimeout(conversationMemory[psid].timeout);
              conversationMemory[psid].timeout = setTimeout(async () => {
                const last20 = conversationMemory[psid].messages.slice(-20);
                const combinedText = last20.map(m => m.role + ": " + m.content).join("\n");
                const analyzedData = await analyzeConversation(combinedText, psid);
                await saveConversationToNotion(analyzedData);
                console.log(`Saved conversation to Notion after inactivity for PSID ${psid}`);
              }, 60_000);
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
