import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const cronSecret = process.env.CRON_SECRET;

function authorized(req) {
  const header = String(req.headers.authorization || "");
  return Boolean(cronSecret) && header === `Bearer ${cronSecret}`;
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!url || !serviceKey) return res.status(503).json({ error: "Eonance server configuration is incomplete" });
  if (!authorized(req)) return res.status(401).json({ error: "Cron authorization failed" });

  try {
    const client = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data, error } = await client.rpc("eonance_credit_all_daily_income");
    if (error || !data?.ok) {
      console.error("[eonance:daily-income-cron]", error || data);
      return res.status(500).json({ error: error?.message || data?.error || "Daily income credit failed" });
    }
    return res.status(200).json({ ok: true, ...data, schedule: req.headers["x-vercel-cron-schedule"] || null });
  } catch (error) {
    console.error("[eonance:daily-income-cron]", error);
    return res.status(500).json({ error: error instanceof Error ? error.message : "Unexpected daily income cron failure" });
  }
}
