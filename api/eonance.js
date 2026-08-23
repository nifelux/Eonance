import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function send(res, status, payload) {
  res.status(status).json(payload);
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
}

function configured() {
  return Boolean(url && anonKey && serviceKey);
}

function admin() {
  return createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function investor(req) {
  const authorization = req.headers.authorization || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) return { error: "Authentication required" };
  const verifier = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await verifier.auth.getUser(token);
  if (error || !data.user) return { error: "Invalid or expired session" };
  const client = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
  return { user: data.user, client };
}

async function requireAdmin(req) {
  const result = await investor(req);
  if (result.error) return result;
  const { data, error } = await admin().from("profiles").select("is_admin,is_active").eq("id", result.user.id).single();
  if (error || !data?.is_admin || !data?.is_active) return { error: "Administrator access required" };
  return result;
}

async function settings(keys) {
  const { data, error } = await admin().from("site_settings").select("key,value").in("key", keys);
  if (error) throw error;
  return Object.fromEntries((data || []).map(row => [row.key, row.value]));
}

function hydrateNotifications(rows, investorId) {
  return rows.map((row) => ({
    ...row,
    is_read: row.user_id === investorId ? Boolean(row.is_read) : Boolean(row.notification_reads?.some(receipt => receipt.user_id === investorId)),
  }));
}

async function notify(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  }).catch(() => undefined);
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!configured()) return send(res, 503, { error: "Eonance server configuration is incomplete" });
  const action = String(req.query?.action || req.body?.action || "").toLowerCase();

  try {
    if (req.method === "GET" && action === "config") return send(res, 200, { url, anonKey });
    if (req.method === "GET" && action === "plans") {
      const { data, error } = await admin().from("products").select("*").eq("status", "active").order("sort_order");
      if (error) throw error;
      return send(res, 200, { plans: data || [] });
    }
    if (req.method === "GET" && action === "dashboard") {
      const auth = await investor(req); if (auth.error) return send(res, 401, { error: auth.error });
      const [profile, wallet, holdings, activity, notifications] = await Promise.all([
        auth.client.from("profiles").select("*").eq("id", auth.user.id).single(),
        auth.client.from("wallets").select("*").eq("user_id", auth.user.id).single(),
        auth.client.from("user_products").select("*, products(*)").eq("user_id", auth.user.id).order("created_at", { ascending: false }),
        auth.client.from("wallet_transactions").select("*").eq("user_id", auth.user.id).order("created_at", { ascending: false }).limit(12),
        auth.client.from("notifications").select("*, notification_reads(user_id)").or(`user_id.eq.${auth.user.id},user_id.is.null`).order("created_at", { ascending: false }).limit(10),
      ]);
      const error = [profile, wallet, holdings, activity, notifications].find(item => item.error)?.error;
      if (error) throw error;
      return send(res, 200, { profile: profile.data, wallet: wallet.data, holdings: holdings.data || [], activity: activity.data || [], notifications: hydrateNotifications(notifications.data || [], auth.user.id) });
    }
    if (req.method === "GET" && action === "alerts") {
      const auth = await investor(req); if (auth.error) return send(res, 401, { error: auth.error });
      const { data, error } = await auth.client.from("notifications").select("*, notification_reads(user_id)").or(`user_id.eq.${auth.user.id},user_id.is.null`).order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      return send(res, 200, { alerts: hydrateNotifications(data || [], auth.user.id) });
    }
    if (req.method === "GET" && action === "admin-summary") {
      const auth = await requireAdmin(req); if (auth.error) return send(res, 403, { error: auth.error });
      const [users, deposits, withdrawals, products, activity, settingRows] = await Promise.all([
        admin().from("profiles").select("id,email,full_name,is_active,is_admin,created_at,wallets(deposit_balance,income_balance,total_invested,total_income)").order("created_at", { ascending: false }).limit(100),
        admin().from("deposits").select("*, profiles(full_name,email)").order("created_at", { ascending: false }).limit(100),
        admin().from("withdrawals").select("*, profiles(full_name,email)").order("created_at", { ascending: false }).limit(100),
        admin().from("products").select("*").order("sort_order"),
        admin().from("wallet_transactions").select("*, profiles(full_name,email)").order("created_at", { ascending: false }).limit(100),
        admin().from("site_settings").select("key,value"),
      ]);
      const error = [users, deposits, withdrawals, products, activity, settingRows].find(item => item.error)?.error;
      if (error) throw error;
      return send(res, 200, { users: users.data || [], deposits: deposits.data || [], withdrawals: withdrawals.data || [], products: products.data || [], activity: activity.data || [], settings: Object.fromEntries((settingRows.data || []).map(row => [row.key, row.value])) });
    }
    if (req.method !== "POST") return send(res, 405, { error: "Unsupported request" });
    const auth = action.startsWith("admin-") ? await requireAdmin(req) : await investor(req);
    if (auth.error) return send(res, action.startsWith("admin-") ? 403 : 401, { error: auth.error });
    const body = req.body || {};

    if (action === "purchase") {
      const { data, error } = await auth.client.rpc("eonance_purchase_product", { p_product_id: body.product_id });
      if (error || !data?.ok) return send(res, 400, { error: error?.message || data?.error || "Purchase failed" });
      await notify(`<b>Eonance package activated</b>\nInvestor: ${auth.user.email || auth.user.id}`);
      return send(res, 200, data);
    }
    if (action === "collect-income") {
      const { data, error } = await auth.client.rpc("eonance_collect_daily_income", { p_user_id: auth.user.id });
      if (error || !data?.ok) return send(res, 400, { error: error?.message || data?.error || "No earnings available" });
      return send(res, 200, data);
    }
    if (action === "check-in") {
      const { data, error } = await auth.client.rpc("eonance_claim_daily_checkin", { p_user_id: auth.user.id });
      if (error || !data?.ok) return send(res, 400, { error: error?.message || data?.error || "Check-in failed" });
      return send(res, 200, data);
    }
    if (action === "create-deposit") {
      const { data, error } = await auth.client.rpc("eonance_open_deposit", { p_user_id: auth.user.id, p_amount: Number(body.amount), p_method: body.method || "manual" });
      if (error || !data?.ok) return send(res, 400, { error: error?.message || data?.error || "Deposit request failed" });
      const bank = await settings(["bank_name", "account_name", "account_number"]);
      await notify(`<b>New Eonance deposit review</b>\nAmount: ₦${Number(body.amount).toLocaleString()}\nReference: ${data.reference}`);
      return send(res, 200, { ...data, bank });
    }
    if (action === "withdraw") {
      const { data, error } = await auth.client.rpc("eonance_request_withdrawal", { p_user_id: auth.user.id, p_amount: Number(body.amount), p_bank_name: body.bank_name, p_account_number: body.account_number, p_account_name: body.account_name });
      if (error || !data?.ok) return send(res, 400, { error: error?.message || data?.error || "Withdrawal request failed" });
      await notify(`<b>New Eonance withdrawal review</b>\nAmount: ₦${Number(body.amount).toLocaleString()}\nInvestor: ${auth.user.email || auth.user.id}`);
      return send(res, 200, data);
    }
    if (action === "redeem-gift") {
      const { data, error } = await auth.client.rpc("eonance_redeem_gift_code", { p_user_id: auth.user.id, p_code: String(body.code || "").toUpperCase() });
      if (error || !data?.ok) return send(res, 400, { error: error?.message || data?.error || "Gift code failed" });
      return send(res, 200, data);
    }
    if (action === "update-profile") {
      const { error } = await auth.client.from("profiles").update({ full_name: String(body.full_name || "").trim(), phone: String(body.phone || "").trim() || null }).eq("id", auth.user.id);
      if (error) throw error;
      return send(res, 200, { ok: true });
    }
    if (action === "save-bank-account") {
      const { error: clearError } = await auth.client.from("bank_accounts").update({ is_default: false }).eq("user_id", auth.user.id).eq("is_default", true);
      if (clearError) throw clearError;
      const { error } = await auth.client.from("bank_accounts").insert({ user_id: auth.user.id, bank_name: String(body.bank_name || "").trim(), account_number: String(body.account_number || "").trim(), account_name: String(body.account_name || "").trim(), is_default: true });
      if (error) throw error;
      return send(res, 200, { ok: true });
    }
    if (action === "support-ticket") {
      const { error } = await auth.client.from("support_tickets").insert({ user_id: auth.user.id, subject: String(body.subject || "").trim(), message: String(body.message || "").trim() });
      if (error) throw error;
      await notify(`<b>New Eonance support request</b>\nInvestor: ${auth.user.email || auth.user.id}\nSubject: ${String(body.subject || "").slice(0, 120)}`);
      return send(res, 200, { ok: true });
    }
    if (action === "mark-alert-read") {
      const { data: notification, error: notificationError } = await auth.client.from("notifications").select("id,user_id").eq("id", body.notification_id).single();
      if (notificationError || !notification) return send(res, 404, { error: "Notification is unavailable" });
      const write = notification.user_id === auth.user.id
        ? auth.client.from("notifications").update({ is_read: true }).eq("id", notification.id).eq("user_id", auth.user.id)
        : notification.user_id === null
          ? auth.client.from("notification_reads").upsert({ notification_id: notification.id, user_id: auth.user.id }, { onConflict: "notification_id,user_id" })
          : null;
      if (!write) return send(res, 403, { error: "Notification is unavailable" });
      const { error } = await write;
      if (error) throw error;
      return send(res, 200, { ok: true });
    }
    if (action === "admin-review-deposit") {
      const { data, error } = await admin().rpc("eonance_process_deposit", { p_reference: body.reference, p_amount: Number(body.amount), p_payload: { source: "eonance_vercel_operations" } });
      if (error || !data?.ok) return send(res, 400, { error: error?.message || data?.error || "Deposit review failed" });
      return send(res, 200, data);
    }
    if (action === "admin-reject-deposit") {
      const { error } = await admin().from("deposits").update({ status: "rejected", approved_by: auth.user.id, approved_at: new Date().toISOString() }).eq("reference", body.reference).eq("status", "pending");
      if (error) throw error;
      return send(res, 200, { ok: true, status: "rejected" });
    }
    if (action === "admin-review-withdrawal") {
      const { data, error } = await auth.client.rpc("eonance_review_withdrawal", { p_withdrawal_id: body.withdrawal_id, p_approved: Boolean(body.approved), p_note: body.note || null });
      if (error || !data?.ok) return send(res, 400, { error: error?.message || data?.error || "Withdrawal review failed" });
      return send(res, 200, data);
    }
    if (action === "admin-credit") {
      const { data, error } = await auth.client.rpc("eonance_admin_credit_balance", { p_user_id: body.user_id, p_balance_type: body.balance_type, p_amount: Number(body.amount), p_reason: body.reason });
      if (error || !data?.ok) return send(res, 400, { error: error?.message || data?.error || "Balance credit failed" });
      return send(res, 200, data);
    }
    if (action === "admin-settings") {
      const allowed = new Set(["bank_name", "account_name", "account_number", "min_deposit", "min_withdraw", "withdrawal_fee_percent", "welcome_bonus", "daily_checkin_bonus", "gift_code_release_time", "referral_percent_l1", "referral_percent_l2", "referral_percent_l3", "support_email", "service_phone", "telegram_link"]);
      const rows = Object.entries(body.settings || {}).filter(([key]) => allowed.has(key)).map(([key, value]) => ({ key, value: String(value) }));
      if (!rows.length) return send(res, 400, { error: "No permitted settings were supplied" });
      const { error } = await admin().from("site_settings").upsert(rows, { onConflict: "key" });
      if (error) throw error;
      return send(res, 200, { ok: true });
    }
    if (action === "admin-investor-status") {
      const { error } = await admin().from("profiles").update({ is_active: Boolean(body.is_active) }).eq("id", body.user_id);
      if (error) throw error;
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "Unknown Eonance action" });
  } catch (error) {
    return send(res, 500, { error: error instanceof Error ? error.message : "Unexpected Eonance server error" });
  }
}
