// combined-webhook.js – Part 1/3
// Full webhook + Notion integration (combined)

import fetch from "node-fetch";

// --- Environment variables
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const META_PAGE_TOKEN = process.env.META_PAGE_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.NOTION_DATABASE_ID?.trim(); // remove whitespace/newlines

if (!VERIFY_TOKEN || !META_PAGE_TOKEN || !OPENAI_API_KEY || !NOTION_TOKEN || !DATABASE_ID) {
  console.warn("Missing one or more required environment variables!");
}

// --- In-memory conversation memory and activity tracking
let conversationMemory = {}; // { psid: [{role, content}, ...] }
let lastActivity = {};      // { psid: timestamp in ms }

// ====================================
// ===== Notion Integration Functions
// ====================================

// --- Save conversation to Notion
async function saveConversationToNotion({
  clientName = "",
  contactPhone = "",
  contactEmail = "",
  location = "",
  task = "",
  description = "",
  conversationSummary = "",
  psid = "",
  dateTime = new Date().toISOString(),
  followUp = false,
  jobScheduled = false,
  jobDone = false,
}) {
  const url = "https://api.notion.com/v1/pages";

  const body = {
    parent: { database_id: DATABASE_ID },
    properties: {
      "Client Name": { title: [{ text: { content: clientName } }] },
      "Contact Phone": { phone_number: contactPhone },
      "Contact Email": { email: contactEmail },
      "Location": { rich_text: [{ text: { content: location } }] },
      "Task": { rich_text: [{ text: { content: task } }] },
      "Description": { rich_text: [{ text: { content: description } }] },
      "Conversation Summary": { rich_text: [{ text: { content: conversationSummary } }] },
      "Time": { date: { start: dateTime } },
      "Follow-up Needed": { checkbox: followUp },
      "PSID": { rich_text: [{ text: { content: psid } }] },
      "Job Scheduled": { checkbox: jobScheduled },
      "Job Done": { status: { name: jobDone ? "Done" : "Not started" } },
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

    const text = await res.text();
    if (!res.ok) console.error("Notion API error:", res.status, text);
    else console.log("Saved conversation to Notion for PSID:", psid);
    return text;
  } catch (e) {
    console.error("Notion request failed:", e);
    return null;
  }
}

// --- Analyze conversation using OpenAI
async function analyzeConversation(conversationText, psid) {
  const prompt = `
You are analyzing a handyman chat conversation.
Extract the following fields exactly as they appear in the Notion database:
{
  "Client Name": "",
  "Contact Phone": "",
  "Contact Email": "",
  "Location": "",
  "Task": "",
  "Description": "",
  "Conversation Summary": "",
  "Time": ""
}
- Return JSON only with these keys, no extra text.
- Leave fields blank if information is missing.
- Task should be extracted from any user request describing a job (mount, repair, install, etc.)
- Conversation Summary should be 1-2 sentences summarizing the user's request.
- Time: current ISO timestamp if not mentioned in conversation.
Conversation:
${conversationText}
`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 400,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("OpenAI API error:", res.status, text);
      return null;
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || "{}";

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = {};
    }

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
    return {
      clientName: "",
      contactPhone: "",
      contactEmail: "",
      location: "",
      task: "",
      description: "",
      conversationSummary: "",
      dateTime: new Date().toISOString(),
      followUp: false,
      psid,
      jobScheduled: false,
      jobDone: false,
    };
  }
}

// --- Save entire conversation to Notion
async function saveConversationFull(conversationText, psid) {
  const analyzedData = await analyzeConversation(conversationText, psid);
  if (analyzedData) {
    return saveConversationToNotion(analyzedData);
  }
}

// combined-webhook.js – Part 2/3
// OpenAI response and memory handling

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

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error("Send API error:", res.status, t);
    }
  } catch (err) {
    console.error("SendText failed:", err);
  }
}

// --- Ask OpenAI for assistant reply with conversation memory
async function askOpenAI(psid, userText) {
  if (!OPENAI_API_KEY) return `Echo: ${userText}`;

  const systemPrompt = `
You are the AI assistant for Handyman Grace Company in Sacramento County, CA.
Tone: friendly, brief, confident, 2–5 sentences per reply.
Collect Name, Contact info, Address, Task description, Timing, Budget if user requests a service.
Suggest licensed GC if outside scope. For emergencies, advise calling local services.
`;

  // Initialize memory if missing
  if (!conversationMemory[psid]) conversationMemory[psid] = [];
  conversationMemory[psid].push({ role: "user", content: userText });

  // Summarize old messages if memory exceeds 10
  if (conversationMemory[psid].length > 10) {
    const oldMessages = conversationMemory[psid].slice(0, -10);
    const summaryPrompt = `Summarize the following conversation in 2-3 sentences for context: 
${oldMessages.map(m => `${m.role}: ${m.content}`).join("\n")}`;

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
      console.error("Summary generation failed:", e);
    }
  }

  // Prepare messages to send to OpenAI
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
    const out = data?.choices?.[0]?.message?.content || "…";

    // Append assistant response to memory
    conversationMemory[psid].push({ role: "assistant", content: out });

    // Update last activity timestamp
    lastActivity[psid] = Date.now();

    return out;
  } catch (err) {
    console.error("askOpenAI failed:", err);
    return "[ai-error] Sorry, I hit a snag. Please try again.";
  }
}


// combined-webhook.js – Part 3/3
// Webhook handler + inactivity timer to save conversations to Notion

// --- Periodically check for inactive users and save their full conversation to Notion
setInterval(() => {
  const now = Date.now();
  for (const psid in lastActivity) {
    if (now - lastActivity[psid] > 60_000 && conversationMemory[psid]?.length > 0) {
      const fullConversation = conversationMemory[psid]
        .map(m => `${m.role}: ${m.content}`)
        .join("\n");

      saveConversationFull(fullConversation, psid)
        .then(() => console.log(`Saved conversation for PSID ${psid} after 1-minute inactivity`))
        .catch(err => console.error("Failed to save conversation to Notion", err));

      // Clear memory and timestamp after saving
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
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
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

              // 3️⃣ Notion saving is handled automatically by inactivity timer
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
