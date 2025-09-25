// test-notion.js – save a test conversation to Notion

import fetch from "node-fetch";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

if (!NOTION_TOKEN || !DATABASE_ID) {
  console.warn("Missing Notion environment variables!");
}

// --- Save conversation to Notion
export default async function handler(req, res) {
  // Example data
  const data = {
    clientName: "Test User",
    contactPhone: "123-456-7890",
    contactEmail: "test@example.com",
    location: "Sacramento",
    task: "Mount TV",
    description: "Testing Notion integration",
    conversationSummary: "This is a test conversation",
    time: new Date().toISOString(),
    followUp: true,
    psid: "123456",
    jobScheduled: false,
    jobDone: false,
  };

  const body = {
    parent: { database_id: DATABASE_ID },
    properties: {
      "Client Name": { title: [{ text: { content: data.clientName } }] },
      "Contact Phone": { rich_text: [{ text: { content: data.contactPhone } }] },
      "Contact Email": { rich_text: [{ text: { content: data.contactEmail } }] },
      "Location": { rich_text: [{ text: { content: data.location } }] },
      "Task": { rich_text: [{ text: { content: data.task } }] },
      "Description": { rich_text: [{ text: { content: data.description } }] },
      "Conversation Summary": { rich_text: [{ text: { content: data.conversationSummary } }] },
      "Time": { date: { start: data.time } },
      "Follow-up Needed": { checkbox: data.followUp },
      "PSID": { rich_text: [{ text: { content: data.psid } }] },
      "Job Scheduled": { checkbox: data.jobScheduled },
      "Job Done": { status: { name: data.jobDone ? "Done" : "Not started" } },
    },
  };

  try {
    const notionRes = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify(body),
    });

    const text = await notionRes.text();
    console.log(notionRes.status, text);

    if (!notionRes.ok) {
      return res.status(notionRes.status).send(text);
    }

    return res.status(200).json({ success: true, result: text });
  } catch (err) {
    console.error("Notion request failed:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
