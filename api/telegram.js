import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const token = process.env.TELEGRAM_BOT_TOKEN;
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

function client() {
  return createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

function configured() {
  return Boolean(url && serviceKey && token && webhookSecret && process.env.TELEGRAM_APPROVER_MAP);
}

function approverFor(telegramId) {
  const entries = String(process.env.TELEGRAM_APPROVER_MAP || "").split(",").map(value => value.trim()).filter(Boolean);
  const entry = entries.find(value => value.split(":")[0] === String(telegramId));
  return entry ? entry.split(":").slice(1).join(":") : null;
}

async function telegram(method, payload) {
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }).then(response => response.json()).catch(() => null);
}

function confirmationKeyboard(kind, decision, reference) {
  return { inline_keyboard: [[
    { text: decision === "a" ? "Confirm approval" : "Confirm rejection", callback_data: `eon|${kind}|x|${decision}|${reference}` },
    { text: "Cancel", callback_data: "eon|n|x|n|cancel" },
  ]] };
}

function reviewKeyboard(kind, reference) {
  return { inline_keyboard: [[
    { text: "Approve", callback_data: `eon|${kind}|c|a|${reference}` },
    { text: "Reject", callback_data: `eon|${kind}|c|r|${reference}` },
  ]] };
}

function escapeTelegramHtml(value) {
  return String(value || "—").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function withdrawalReviewText(item) {
  return `<b>Pending Eonance withdrawal</b>\nAmount: ₦${Number(item.amount || 0).toLocaleString()}\nReference: ${escapeTelegramHtml(item.request_reference || item.id)}\nBank: ${escapeTelegramHtml(item.bank_name)}\nAccount name: ${escapeTelegramHtml(item.account_name)}\nAccount number: <code>${escapeTelegramHtml(item.account_number)}</code>\nCreated: ${new Date(item.created_at).toISOString()}`;
}

async function sendQueue(chatId, kind) {
  const db = client();
  const source = kind === "d" ? "deposits" : "withdrawals";
  const fields = kind === "d" ? "reference,amount,created_at" : "id,request_reference,amount,bank_name,account_name,account_number,created_at";
  const { data, error } = await db.from(source).select(fields).eq("status", "pending").order("created_at", { ascending: false }).limit(20);
  if (error) throw error;
  if (!(data || []).length) return telegram("sendMessage", { chat_id: chatId, text: `No pending Eonance ${kind === "d" ? "deposits" : "withdrawals"}.` });
  for (const item of data) {
    const reference = kind === "d" ? item.reference : item.id;
    const displayReference = kind === "d" ? item.reference : item.request_reference || item.id;
    await telegram("sendMessage", {
      chat_id: chatId,
      text: kind === "d"
        ? `<b>Pending Eonance deposit</b>\nAmount: ₦${Number(item.amount || 0).toLocaleString()}\nReference: ${escapeTelegramHtml(displayReference)}\nCreated: ${new Date(item.created_at).toISOString()}`
        : withdrawalReviewText(item),
      parse_mode: "HTML",
      reply_markup: reviewKeyboard(kind, reference),
    });
  }
}

async function respond(callback, text, markup) {
  await telegram("answerCallbackQuery", { callback_query_id: callback.id, text, show_alert: false });
  if (callback.message?.chat?.id && callback.message?.message_id) {
    await telegram("editMessageText", {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      text,
      reply_markup: markup,
    });
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
  if (!configured()) return res.status(503).json({ error: "Telegram approvals are not configured" });
  if (req.headers["x-telegram-bot-api-secret-token"] !== webhookSecret) return res.status(401).json({ error: "Invalid Telegram webhook secret" });
  const message = req.body?.message;
  if (message?.text) {
    const approverId = approverFor(message.from?.id);
    if (!approverId) return res.status(200).json({ ok: true });
    if (message.chat?.type !== "private") {
      await telegram("sendMessage", { chat_id: message.chat.id, text: "For account security, request withdrawal details from this bot's private chat." });
      return res.status(200).json({ ok: true });
    }
    const command = String(message.text).trim().toLowerCase().split(/\s+/)[0].replace(/@[^\s]+$/, "");
    try {
      if (["/deposits", "/pending_deposits"].includes(command)) await sendQueue(message.chat.id, "d");
      else if (["/withdrawals", "/pending_withdrawals"].includes(command)) await sendQueue(message.chat.id, "w");
      else if (command === "/pending") { await sendQueue(message.chat.id, "d"); await sendQueue(message.chat.id, "w"); }
      else await telegram("sendMessage", { chat_id: message.chat.id, text: "Eonance commands: /pending, /deposits, /withdrawals" });
    } catch { await telegram("sendMessage", { chat_id: message.chat.id, text: "The pending review queue could not be loaded." }); }
    return res.status(200).json({ ok: true });
  }
  const callback = req.body?.callback_query;
  if (!callback?.data) return res.status(200).json({ ok: true });
  const approverId = approverFor(callback.from?.id);
  if (!approverId) { await telegram("answerCallbackQuery", { callback_query_id: callback.id, text: "You are not authorised to review Eonance transactions.", show_alert: true }); return res.status(200).json({ ok: true }); }
  const [prefix, kind, stage, decision, reference] = String(callback.data).split("|");
  if (prefix !== "eon" || !["d", "w", "n"].includes(kind)) { await telegram("answerCallbackQuery", { callback_query_id: callback.id, text: "Invalid review action.", show_alert: true }); return res.status(200).json({ ok: true }); }
  if (kind === "n") { await respond(callback, "Eonance review cancelled."); return res.status(200).json({ ok: true }); }
  if (stage === "c" && ["a", "r"].includes(decision)) {
    const label = kind === "d" ? "deposit" : "withdrawal";
    await respond(callback, `Confirm ${decision === "a" ? "approval" : "rejection"} for this ${label}?`, confirmationKeyboard(kind, decision, reference));
    return res.status(200).json({ ok: true });
  }
  if (stage !== "x" || !["a", "r"].includes(decision) || !reference) { await telegram("answerCallbackQuery", { callback_query_id: callback.id, text: "Invalid confirmation.", show_alert: true }); return res.status(200).json({ ok: true }); }
  const db = client();
  const { data: profile, error: profileError } = await db.from("profiles").select("id,is_admin,is_active").eq("id", approverId).single();
  if (profileError || !profile?.is_admin || !profile?.is_active) { await telegram("answerCallbackQuery", { callback_query_id: callback.id, text: "Your Eonance admin mapping is invalid.", show_alert: true }); return res.status(200).json({ ok: true }); }
  let result;
  if (kind === "d") {
    if (decision === "a") {
      const { data: deposit, error } = await db.from("deposits").select("amount").eq("reference", reference).single();
      if (error || !deposit) { await telegram("answerCallbackQuery", { callback_query_id: callback.id, text: "Deposit is unavailable.", show_alert: true }); return res.status(200).json({ ok: true }); }
      result = await db.rpc("eonance_telegram_process_deposit", { p_approver_id: approverId, p_reference: reference, p_amount: Number(deposit.amount), p_telegram_user_id: String(callback.from.id) });
    } else result = await db.rpc("eonance_telegram_reject_deposit", { p_approver_id: approverId, p_reference: reference, p_note: "Rejected through Telegram" });
  } else result = await db.rpc("eonance_telegram_review_withdrawal", { p_approver_id: approverId, p_withdrawal_id: reference, p_approved: decision === "a", p_note: `Reviewed through Telegram by ${callback.from.id}` });
  if (result.error || !result.data?.ok) { await telegram("answerCallbackQuery", { callback_query_id: callback.id, text: result.error?.message || result.data?.error || "Review could not be completed.", show_alert: true }); return res.status(200).json({ ok: true }); }
  const label = decision === "a" ? "approved" : "rejected";
  await respond(callback, `Eonance ${kind === "d" ? "deposit" : "withdrawal"} ${label} successfully.`);
  return res.status(200).json({ ok: true });
}
