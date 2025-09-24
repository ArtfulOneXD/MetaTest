// metaNotionLogger.js
import { Client } from "@notionhq/client";

// -------------------- CONFIG --------------------
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const databaseId = process.env.NOTION_DATABASE_ID;

let messageBuffer = [];
let inactivityTimer = null;
const INACTIVITY_MS = 60 * 1000; // 1 minute inactivity
// For quick test, change to 5 * 1000 (5 sec)

// -------------------- SAVE TO NOTION --------------------
async function saveToNotion(messages) {
  if (messages.length === 0) return;

  const content = messages.join("\n");

  try {
    await notion.pages.create({
      parent: { database_id: databaseId },
      properties: {
        "Client Name": {
          title: [
            {
              text: { content },
            },
          ],
        },
      },
    });
    console.log("✅ Messages saved to Notion:", content);
  } catch (err) {
    console.error("❌ Error saving to Notion:", err);
  }
}

// -------------------- HANDLE NEW MESSAGE --------------------
export function handleMessage(msg) {
  console.log("Received message:", msg);
  messageBuffer.push(msg);

  // Reset inactivity timer
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(() => {
    saveToNotion(messageBuffer);
    messageBuffer = [];
  }, INACTIVITY_MS);
}

// -------------------- INTEGRATION WITH META + OPENAI --------------------
// Example usage:
// Replace this part with your actual Meta webhook message handler
export function onMetaMessage(event) {
  // event.message.text = user text
  // event.sender.id = sender id (optional)
  const msg = `[Meta] ${event.sender?.id || "unknown"}: ${event.message.text}`;
  handleMessage(msg);

  // If you have OpenAI response:
  // const aiReply = await openai.createChatCompletion({...});
  // handleMessage(`[AI] ${aiReply}`);
}

// -------------------- TESTING --------------------
if (process.env.TEST_NOTION === "true") {
  console.log("Running test mode: sending 3 test messages...");
  handleMessage("Test message 1");
  setTimeout(() => handleMessage("Test message 2"), 1000);
  setTimeout(() => handleMessage("Test message 3"), 2000);
  console.log("Waiting for inactivity to save to Notion...");
}
