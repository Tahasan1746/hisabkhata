
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;

function bdDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function supabase(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase request failed (${response.status}): ${text}`);
  }

  return text ? JSON.parse(text) : null;
}

async function sendTelegram(chatId, message) {
  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
      }),
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(`Telegram send failed: ${result.description || response.status}`);
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!CRON_SECRET || req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !TELEGRAM_BOT_TOKEN) {
    return res.status(500).json({ error: "Server environment variables are missing" });
  }

  const today = bdDate();
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  try {
    const candidates = await supabase(
      `rpc/due_reminder_candidates?p_today=${today}&p_window_days=3`,
      { method: "POST", body: "{}" }
    );

    for (const item of candidates || []) {
      for (const chatId of item.chat_destinations || []) {
        // Upcoming/today reminders: once per due date.
        // Overdue reminders: once per day.
        const sentOn =
          item.event_kind === "overdue" ? today : item.due_date;

        const filters =
          `transaction_id=eq.${item.transaction_id}` +
          `&channel=eq.telegram` +
          `&event_kind=eq.${item.event_kind}` +
          `&due_date=eq.${item.due_date}` +
          `&sent_on=eq.${sentOn}`;

        const existing = await supabase(
          `reminder_deliveries?${filters}&select=id&limit=1`
        );

        if (existing.length) {
          skipped++;
          continue;
        }

        const taka = (Number(item.remaining_paisa) / 100).toLocaleString(
          "en-BD",
          { minimumFractionDigits: 2, maximumFractionDigits: 2 }
        );

        const type =
          item.loan_type === "given"
            ? "তুমি টাকা পাবে"
            : item.loan_type === "taken"
              ? "তোমার টাকা দিতে হবে"
              : "ঋণের হিসাব";

        const status =
          item.event_kind === "overdue"
            ? "⚠️ মেয়াদ পার হয়েছে"
            : item.event_kind === "today"
              ? "🔔 আজই পরিশোধের তারিখ"
              : "📅 সামনে পরিশোধের তারিখ";

        const message =
          `📒 HisabKhata Reminder\n\n` +
          `${status}\n` +
          `👤 ব্যক্তি: ${item.person_name}\n` +
          `📌 ধরন: ${type}\n` +
          `💰 বাকি: ৳${taka}\n` +
          `📆 Due date: ${item.due_date}\n\n` +
          `HisabKhata থেকে পাঠানো স্বয়ংক্রিয় রিমাইন্ডার।`;

        try {
          await sendTelegram(chatId, message);

          await supabase("reminder_deliveries", {
            method: "POST",
            headers: {
              Prefer: "return=minimal",
            },
            body: JSON.stringify({
              user_id: item.user_id,
              transaction_id: item.transaction_id,
              channel: "telegram",
              event_kind: item.event_kind,
              due_date: item.due_date,
              sent_on: sentOn,
            }),
          });

          sent++;
        } catch (error) {
          failed++;
          console.error("Reminder delivery failed:", error.message);
        }
      }
    }

    return res.status(200).json({
      ok: true,
      date: today,
      sent,
      skipped,
      failed,
    });
  } catch (error) {
    console.error("Reminder job failed:", error.message);
    return res.status(500).json({ error: "Reminder job failed" });
  }
          }
