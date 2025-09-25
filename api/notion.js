// notion.js – analyze chats and save to Notion (split functions)

import fetch from "node-fetch";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!NOTION_TOKEN || !DATABASE_ID || !OPENAI_API_KEY) {
  console.warn("Missing Notion or OpenAI environment variables!");
}

// --- Save conversation to Notion
export async function saveConversationToNotion({
  clientName = "",
  contactInfo = "",
  location = "",
  taskDescription = "",
  conversationSummary = "",
  psid = "",
  dateTime = new Date().toISOString(),
  followUp = false,
}) {
  const url = "https://api.notion.com/v1/pages";
  const body = {
    parent: { database_id: DATABASE_ID },
    properties: {
      "Client Name": { title: [{ text: { content: clientName } }] },
      "Contact Info": { rich_text: [{ text: { content: contactInfo } }] },
      "Location": { rich_text: [{ text: { content: location } }] },
      "Task Description": { rich_text: [{ text: { content: taskDescription } }] },
      "Conversation Summary": { rich_text: [{ text: { content: conversationSummary } }] },
      "Date/Time": { date: { start: dateTime } },
      "Follow-up Needed": { checkbox: followUp },
      "PSID": { rich_text: [{ text: { content: psid } }] },
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
      const text = await res.text();
      console.error("Notion API error:", res.status, text);
      return false;
    }

    return await res.json();
  } catch (e) {
    console.error("Notion request failed:", e);
    return false;
  }
}

// --- Analyze conversation using OpenAI
export async function analyzeConversation(conversationText, psid) {
  const prompt = `
You are analyzing a handyman chat conversation.
Extract the following fields:
- Client Name
- Contact Info (phone/email)
- Location
- Task Description
- Conversation Summary (1-2 sentence summary)
Return JSON only with these keys.
Leave fields blank if info is missing.
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

// --- Save to Notion only if Task Description exists
export async function saveConversationIfTaskExists(conversationText, psid) {
  const analyzedData = await analyzeConversation(conversationText, psid);
  if (analyzedData && analyzedData.taskDescription) {
    return saveConversationToNotion(analyzedData);
  } else {
    console.log("Task Description missing, skipping Notion save.");
    return null;
  }
}
