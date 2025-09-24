// /api/cron-notion.js – cron job to process inactive conversations

import fetch from "node-fetch";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

// --- Replace this with a persistent store in production
let conversationMemory = {}; // { psid: [{ role, content, timestamp }] }

// --- Save conversation to Notion
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

// --- Analyze conversation with OpenAI
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
    return {
      clientName: "",
      contactInfo: "",
      location: "",
      taskDescription: "",
      conversationSummary: "",
      dateTime: new Date().toISOString(),
      followUp: false,
      psid,
    };
  }
}

// --- Process all inactive conversations
export default async function handler(req, res) {
  const now = Date.now();
  const inactivityThreshold = 60 * 1000; // 1 minute for testing

  for (const psid in conversationMemory) {
    const messages = conversationMemory[psid];
    if (!messages || messages.length === 0) continue;

    const lastMessageTime = messages[messages.length - 1].timestamp || now;
    if (now - lastMessageTime >= inactivityThreshold) {
      const fullConversation = messages.map(m => `${m.role}: ${m.content}`).join("\n");
      const analyzedData = await analyzeConversationForNotion(fullConversation, psid);
      if (analyzedData && analyzedData.taskDescription) {
        await saveConversationToNotion(analyzedData);
        // Optionally clear memory after saving
        conversationMemory[psid] = [];
      }
    }
  }

  res.status(200).send("Cron check completed");
}
