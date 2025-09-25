import fetch from "node-fetch";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.NOTION_DATABASE_ID?.trim(); // make sure no extra spaces

if (!NOTION_TOKEN || !DATABASE_ID) {
  console.warn("Missing Notion environment variables!");
}

// --- Save conversation to Notion
async function saveConversationToNotion(data) {
  const url = "https://api.notion.com/v1/pages";

  const body = {
    parent: { database_id: DATABASE_ID },
    properties: {
      "Client Name": { title: [{ text: { content: data.clientName } }] },       // text
      "Contact Phone": { phone_number: data.contactPhone || "" },                // phone
      "Contact Email": { email: data.contactEmail || "" },                       // email
      "Location": { rich_text: [{ text: { content: data.location || "" } }] },  // text
      "Task": { rich_text: [{ text: { content: data.task || "" } }] },          // text
      "Description": { rich_text: [{ text: { content: data.description || "" } }] }, // text
      "Conversation Summary": { rich_text: [{ text: { content: data.conversationSummary || "" } }] }, // text
      "Time": { date: { start: data.time || new Date().toISOString() } },        // date
      "Follow-up Needed": { checkbox: !!data.followUp },                         // checkbox
      "PSID": { rich_text: [{ text: { content: data.psid || "" } }] },          // text
      "Job Scheduled": { checkbox: !!data.jobScheduled },                        // checkbox
      "Job Done": { status: { name: data.jobDone || "Not started" } },          // status
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
    if (!res.ok) console.error(res.status, text);
    return text;
  } catch (e) {
    console.error("Notion request failed:", e);
    return null;
  }
}

// --- Vercel serverless handler
export default async function handler(req, res) {
  try {
    const testData = {
      clientName: "Test User",
      contactPhone: "+19167692888",
      contactEmail: "test@example.com",
      location: "Sacramento",
      task: "Mount TV",
      description: "Testing Notion integration",
      conversationSummary: "Chat summary test",
      time: new Date().toISOString(),
      followUp: true,
      psid: "123456",
      jobScheduled: false,
      jobDone: "Not started",
    };

    const result = await saveConversationToNotion(testData);
    res.status(200).json({ success: true, result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
}
