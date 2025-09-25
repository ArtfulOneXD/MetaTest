// notion.js – analyze chats and save to Notion (fixed for your DB)

import fetch from "node-fetch";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.NOTION_DATABASE_ID?.trim();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!NOTION_TOKEN || !DATABASE_ID || !OPENAI_API_KEY) {
  console.warn("Missing Notion or OpenAI environment variables!");
}

// --- Save conversation to Notion
export async function saveConversationToNotion({
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
      "Contact Phone": { rich_text: [{ text: { content: contactPhone } }] },
      "Contact Email": { rich_text: [{ text: { content: contactEmail } }] },
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
    return text;
  } catch (e) {
    console.error("Notion request failed:", e);
    return null;
  }
}

// --- Analyze conversation using OpenAI
export async function analyzeConversation(conversationText, psid) {
  const prompt = `
You are analyzing a handyman chat conversation.
Extract the following fields exactly as they appear in the Notion database:

- Client Name
- Contact Phone
- Contact Email
- Location
- Task
- Description
- Conversation Summary (1-2 sentence summary)
- Time (ISO format if possible)

Return JSON only with these keys. 
Leave fields blank if info is missing.
Do not add extra fields or text.

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
        max_tokens: 300,
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

// --- Save to Notion only if Task exists
export async function saveConversationIfTaskExists(conversationText, psid) {
  const analyzedData = await analyzeConversation(conversationText, psid);
  if (analyzedData && analyzedData.task) {
    return saveConversationToNotion(analyzedData);
  } else {
    console.log("Task missing, skipping Notion save.");
    return null;
  }
}
