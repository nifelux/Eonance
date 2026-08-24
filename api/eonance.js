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

function reviewKeyboard(kind, reference) {
  const compactKind = kind === "deposit" ? "d" : "w";
  return { inline_keyboard: [[
    { text: "Approve", callback_data: `eon|${compactKind}|c|a|${reference}` },
    { text: "Reject", callback_data: `eon|${compactKind}|c|r|${reference}` },
  ]] };
}

async function notify(text, replyMarkup) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", reply_markup: replyMarkup }),
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
      const [profile, wallet, holdings, activity, notifications, announcement] = await Promise.all([
        auth.client.from("profiles").select("*").eq("id", auth.user.id).single(),
        auth.client.from("wallets").select("*").eq("user_id", auth.user.id).single(),
        auth.client.from("user_products").select("*, products(*)").eq("user_id", auth.user.id).order("created_at", { ascending: false }),
        auth.client.from("wallet_transactions").select("*").eq("user_id", auth.user.id).order("created_at", { ascending: false }).limit(12),
        auth.client.from("notifications").select("*, notification_reads(user_id)").or(`user_id.eq.${auth.user.id},user_id.is.null`).order("created_at", { ascending: false }).limit(10),
        settings(["announcement_enabled", "announcement_title", "announcement_message", "telegram_channel_link", "telegram_group_link", "customer_service_link", "telegram_link", "support_email", "service_phone"]),
      ]);
      const error = [profile, wallet, holdings, activity, notifications].find(item => item.error)?.error;
      if (error) throw error;
      return send(res, 200, { profile: profile.data, wallet: wallet.data, holdings: holdings.data || [], activity: activity.data || [], notifications: hydrateNotifications(notifications.data || [], auth.user.id), announcement });
    }
    if (req.method === "GET" && action === "alerts") {
      const auth = await investor(req); if (auth.error) return send(res, 401, { error: auth.error });
      const { data, error } = await auth.client.from("notifications").select("*, notification_reads(user_id)").or(`user_id.eq.${auth.user.id},user_id.is.null`).order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      return send(res, 200, { alerts: hydrateNotifications(data || [], auth.user.id) });
    }
    if (req.method === "GET" && action === "income-history") {
      const auth = await investor(req); if (auth.error) return send(res, 401, { error: auth.error });
      const requestUrl = new URL(req.url || "/api/eonance", "https://eonance.local");
      const page = Math.max(1, Math.floor(Number(req.query?.page || requestUrl.searchParams.get("page") || 1)) || 1);
      const limit = Math.min(50, Math.max(5, Math.floor(Number(req.query?.limit || requestUrl.searchParams.get("limit") || 20)) || 20));
      const from = (page - 1) * limit;
      const { data, error, count } = await auth.client.from("wallet_transactions").select("id,amount,description,reference,metadata,created_at", { count: "exact" }).eq("user_id", auth.user.id).eq("balance_type", "income").eq("type", "daily_income").order("created_at", { ascending: false }).range(from, from + limit - 1);
      if (error) throw error;
      return send(res, 200, { transactions: data || [], page, limit, total: count || 0, has_more: from + (data || []).length < (count || 0) });
    }
    if (req.method === "GET" && action === "team") {
      const auth = await investor(req); if (auth.error) return send(res, 401, { error: auth.error });
      const [profile, levelOne] = await Promise.all([
        admin().from("profiles").select("referral_code").eq("id", auth.user.id).single(),
        admin().from("profiles").select("id,full_name,created_at").eq("referred_by", auth.user.id).order("created_at", { ascending: false }).limit(100),
      ]);
      const error = [profile, levelOne].find(item => item.error)?.error;
      if (error) throw error;
      const levelOneRows = levelOne.data || [];
      const levelOneIds = levelOneRows.map(member => member.id);
      const { data: levelTwoRows, error: levelTwoError } = levelOneIds.length
        ? await admin().from("profiles").select("id,full_name,created_at").in("referred_by", levelOneIds).order("created_at", { ascending: false }).limit(300)
        : { data: [], error: null };
      if (levelTwoError) throw levelTwoError;
      const levelTwoIds = (levelTwoRows || []).map(member => member.id);
      const { data: levelThreeRows, error: levelThreeError } = levelTwoIds.length
        ? await admin().from("profiles").select("id,full_name,created_at").in("referred_by", levelTwoIds).order("created_at", { ascending: false }).limit(900)
        : { data: [], error: null };
      if (levelThreeError) throw levelThreeError;
      const team = [
        ...levelOneRows.map(member => ({ ...member, level: 1 })),
        ...(levelTwoRows || []).map(member => ({ ...member, level: 2 })),
        ...(levelThreeRows || []).map(member => ({ ...member, level: 3 })),
      ];
      const memberIds = team.map(member => member.id);
      const [teamDeposits, verifiedDepositLedger, activeProducts] = memberIds.length
        ? await Promise.all([
          admin().from("deposits").select("user_id,amount").in("user_id", memberIds).eq("status", "completed"),
          admin().from("wallet_transactions").select("user_id,amount").in("user_id", memberIds).eq("balance_type", "deposit").eq("type", "verified_deposit"),
          admin().from("user_products").select("user_id").in("user_id", memberIds).eq("status", "active"),
        ])
        : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }];
      const depositsError = [teamDeposits, verifiedDepositLedger, activeProducts].find(item => item.error)?.error;
      if (depositsError) throw depositsError;
      const depositsByMember = new Map();
      const ledgerByMember = new Map();
      const activeProductsByMember = new Map();
      for (const deposit of teamDeposits.data || []) depositsByMember.set(deposit.user_id, Number(depositsByMember.get(deposit.user_id) || 0) + Number(deposit.amount || 0));
      for (const credit of verifiedDepositLedger.data || []) ledgerByMember.set(credit.user_id, Number(ledgerByMember.get(credit.user_id) || 0) + Number(credit.amount || 0));
      for (const product of activeProducts.data || []) activeProductsByMember.set(product.user_id, Number(activeProductsByMember.get(product.user_id) || 0) + 1);
      const enrichedTeam = team.map(member => ({ ...member, verified_deposits: Math.max(Number(depositsByMember.get(member.id) || 0), Number(ledgerByMember.get(member.id) || 0)), active_packages: Number(activeProductsByMember.get(member.id) || 0) }));
      const levels = [1, 2, 3].map(level => {
        const membersAtLevel = enrichedTeam.filter(member => member.level === level);
        return { level, members: membersAtLevel, verified_deposits: membersAtLevel.reduce((sum, member) => sum + member.verified_deposits, 0) };
      });
      return send(res, 200, { referral_code: profile.data?.referral_code || "", team: enrichedTeam, levels, team_deposits: enrichedTeam.reduce((sum, member) => sum + member.verified_deposits, 0) });
    }
    if (req.method === "GET" && action === "deposit-status") {
      const auth = await investor(req); if (auth.error) return send(res, 401, { error: auth.error });
      const requestUrl = new URL(req.url || "/api/eonance", "https://eonance.local");
      const reference = String(req.query?.reference || requestUrl.searchParams.get("reference") || "").trim();
      if (!reference) return send(res, 400, { error: "Deposit reference is required" });
      let { data: deposit, error } = await auth.client.from("deposits").select("id,amount,reference,narration,status,created_at,expires_at,approved_at,paid_at").eq("reference", reference).eq("user_id", auth.user.id).single();
      if (error && /expires_at/i.test(error.message || "")) {
        const fallback = await auth.client.from("deposits").select("id,amount,reference,narration,status,created_at,approved_at,paid_at").eq("reference", reference).eq("user_id", auth.user.id).single();
        deposit = fallback.data ? { ...fallback.data, expires_at: new Date(new Date(fallback.data.created_at).getTime() + 10 * 60 * 1000).toISOString() } : null;
        error = fallback.error;
      }
      if (error) return send(res, 500, { error: "Deposit status could not be loaded", detail: error.message || "The deposit lookup failed" });
      if (!deposit) return send(res, 404, { error: "Deposit reservation is unavailable" });
      const bank = await settings(["bank_name", "account_name", "account_number"]);
      return send(res, 200, { deposit, bank, expired: deposit.status === "pending" && new Date(deposit.expires_at).getTime() <= Date.now() });
    }
    if (req.method === "GET" && action === "admin-summary") {
      const auth = await requireAdmin(req); if (auth.error) return send(res, 403, { error: auth.error });
      const [profileRows, walletRows, deposits, withdrawals, products, activity, settingRows, giftCodes] = await Promise.all([
        admin().from("profiles").select("id,email,full_name,is_active,is_admin,created_at").order("created_at", { ascending: false }).limit(100),
        admin().from("wallets").select("user_id,deposit_balance,income_balance,total_invested,total_income").limit(100),
        admin().from("deposits").select("*").order("created_at", { ascending: false }).limit(100),
        admin().from("withdrawals").select("*").order("created_at", { ascending: false }).limit(100),
        admin().from("products").select("*").order("sort_order"),
        admin().from("wallet_transactions").select("*").order("created_at", { ascending: false }).limit(100),
        admin().from("site_settings").select("key,value"),
        admin().from("gift_codes").select("id,code,amount,max_uses,uses,status,expires_at,created_at").order("created_at", { ascending: false }).limit(50),
      ]);
      const error = [profileRows, walletRows, deposits, withdrawals, products, activity, settingRows, giftCodes].find(item => item.error)?.error;
      if (error) {
        console.error("[eonance:admin-summary]", error);
        return send(res, 500, { error: "Operations data could not be loaded", detail: error.message || "The Supabase operations query failed" });
      }
      const profilesById = new Map((profileRows.data || []).map(profile => [profile.id, profile]));
      const walletsByUserId = new Map((walletRows.data || []).map(wallet => [wallet.user_id, wallet]));
      const profileFor = userId => {
        const profile = profilesById.get(userId);
        return profile ? { full_name: profile.full_name, email: profile.email } : null;
      };
      const users = (profileRows.data || []).map(profile => ({ ...profile, wallets: walletsByUserId.has(profile.id) ? [walletsByUserId.get(profile.id)] : [] }));
      return send(res, 200, {
        users,
        deposits: (deposits.data || []).map(row => ({ ...row, profiles: profileFor(row.user_id) })),
        withdrawals: (withdrawals.data || []).map(row => ({ ...row, profiles: profileFor(row.user_id) })),
        products: products.data || [],
        activity: (activity.data || []).map(row => ({ ...row, profiles: profileFor(row.user_id) })),
        settings: Object.fromEntries((settingRows.data || []).map(row => [row.key, row.value])),
        gift_codes: giftCodes.data || [],
      });
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
      await notify(`<b>New Eonance deposit review</b>\nInvestor: ${auth.user.email || auth.user.id}\nAmount: ₦${Number(body.amount).toLocaleString()}\nReference: ${data.reference}\nApproval window: 10 minutes`, reviewKeyboard("deposit", data.reference));
      return send(res, 200, { ...data, bank });
    }
    if (action === "withdraw") {
      const { data, error } = await auth.client.rpc("eonance_request_withdrawal", { p_user_id: auth.user.id, p_amount: Number(body.amount), p_bank_name: body.bank_name, p_account_number: body.account_number, p_account_name: body.account_name });
      if (error || !data?.ok) return send(res, 400, { error: error?.message || data?.error || "Withdrawal request failed" });
      await notify(`<b>New Eonance withdrawal review</b>\nAmount: ₦${Number(body.amount).toLocaleString()}\nInvestor: ${auth.user.email || auth.user.id}\nReference: ${data.withdrawal_id}`, reviewKeyboard("withdrawal", data.withdrawal_id));
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
    if (action === "admin-reconcile-referrals") {
      const limit = Math.min(2000, Math.max(1, Math.floor(Number(body.limit || 500)) || 500));
      const { data, error } = await admin().rpc("eonance_reconcile_referral_rewards", { p_limit: limit });
      if (error || !data?.ok) return send(res, 400, { error: error?.message || data?.error || "Referral reward reconciliation failed" });
      return send(res, 200, data);
    }
    if (action === "admin-gift-code") {
      const amount = Number(body.amount);
      const maxUses = Math.max(1, Math.floor(Number(body.max_uses || 1)));
      const requested = String(body.code || "").trim().toUpperCase();
      const code = requested || `EON-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
      if (!Number.isFinite(amount) || amount <= 0) return send(res, 400, { error: "Gift-code amount must be greater than zero" });
      if (!/^EON-[A-Z0-9-]{4,32}$/.test(code)) return send(res, 400, { error: "Gift code must begin with EON- and use letters, numbers, or hyphens" });
      const expiresAt = body.expires_at ? new Date(body.expires_at) : null;
      if (expiresAt && Number.isNaN(expiresAt.getTime())) return send(res, 400, { error: "Gift-code expiry is invalid" });
      const { data, error } = await admin().from("gift_codes").insert({ code, amount, max_uses: maxUses, expires_at: expiresAt?.toISOString() || null }).select("id,code,amount,max_uses,uses,status,expires_at").single();
      if (error) return send(res, 400, { error: error.message || "Gift-code generation failed" });
      return send(res, 200, { ok: true, gift_code: data });
    }
    if (action === "admin-settings") {
      const allowed = new Set(["bank_name", "account_name", "account_number", "min_deposit", "min_withdraw", "withdrawal_fee_percent", "welcome_bonus", "daily_checkin_bonus", "gift_code_release_time", "referral_percent_l1", "referral_percent_l2", "referral_percent_l3", "support_email", "service_phone", "telegram_link", "announcement_enabled", "announcement_title", "announcement_message", "telegram_channel_link", "telegram_group_link", "customer_service_link"]);
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
    console.error("[eonance:api]", error);
    return send(res, 500, { error: "Unexpected Eonance server error", detail: error instanceof Error ? error.message : "Unexpected server-side failure" });
  }
}
