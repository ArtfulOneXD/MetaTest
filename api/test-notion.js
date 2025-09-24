import fetch from "node-fetch";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

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
  console.log(res.status, text);
}

// --- Test call
saveConversationToNotion({
  clientName: "Test User",
  contactInfo: "test@example.com",
  location: "Sacramento",
  taskDescription: "Mount TV",
  conversationSummary: "Testing Notion integration",
  psid: "123456",
  dateTime: new Date().toISOString(),
  followUp: true,
});
