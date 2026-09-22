/** One-off: email thank-you receipts to current Plus users. */
import fs from "node:fs";
import pg from "pg";
import { sendPlusThankYouEmail, mailConfigured } from "../mail.mjs";
import { plusAmount, plusCurrency } from "../paypal-plus.mjs";

const log = [];
const say = (m) => {
  log.push(String(m));
  console.log(m);
};

say("mailConfigured=" + mailConfigured());
say("hasDb=" + Boolean(process.env.DATABASE_URL));

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const { rows } = await pool.query(`
    SELECT id, email, plus, plus_until, plus_cancelled
    FROM users
    WHERE plus = TRUE OR (plus_until IS NOT NULL AND plus_until > NOW())
    ORDER BY id
  `);
  say("plus_users=" + rows.length);
  for (const u of rows) {
    const orderId = `backfill-${u.id}-${Date.now()}`;
    try {
      const result = await sendPlusThankYouEmail({
        email: u.email,
        amount: plusAmount(),
        currency: plusCurrency(),
        orderId,
        provider: "admin",
        plusUntil: u.plus_until,
      });
      say(`sent=${u.email} ${JSON.stringify(result)}`);
    } catch (err) {
      say(`fail=${u.email} ${err?.message || err}`);
    }
  }
} catch (err) {
  say(`ERR ${err?.message || err}`);
} finally {
  await pool.end();
  fs.writeFileSync("backfill-mail-log.txt", log.join("\n"));
}
