// Vercel Serverless Function – Messenger ↔ OpenAI bridge

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const META_PAGE_TOKEN = process.env.META_PAGE_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    console.error("Send API error:", r.status, t);
  }
}

// --- Ask OpenAI (fallback to echo if no key provided)
async function askOpenAI(userText) {
  if (!OPENAI_API_KEY) return `Echo: ${userText}`;
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: "You are a helpful Messenger bot." },
        { role: "user", content: userText },
      ],
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    console.error("OpenAI error:", r.status, t);
    return "Sorry, I hit a glitch. Try again.";
  }
  const data = await r.json();
  return data.output_text || "…";
}

export default async function handler(req, res) {
  // 1) Webhook verification handshake (Meta sends GET)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Verification failed");
  }

  // 2) Webhook events (Meta sends POST)
  if (req.method === "POST") {
    try {
      const body = req.body;
      if (body?.object === "page") {
        for (const entry of body.entry || []) {
          for (const evt of entry.messaging || []) {
            const psid = evt.sender?.id;
            const text = evt.message?.text || evt.postback?.payload;
            if (psid && text) {
              const reply = await askOpenAI(text);
              await sendText(psid, reply);
            }
          }
        }
        // MUST reply in <=20s or Meta retries
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
