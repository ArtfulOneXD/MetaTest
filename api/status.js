export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    hasVerifyToken: !!process.env.VERIFY_TOKEN,
    hasMetaToken: !!process.env.META_PAGE_TOKEN,
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
  });
}
