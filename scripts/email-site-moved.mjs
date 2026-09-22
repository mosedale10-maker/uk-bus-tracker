/** Email every registered account about the move to https://ukbustracker.co.uk */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initAuthStore, listAllUsers, userHasPlus } from "../auth-store.mjs";
import { sendSiteMovedEmail, mailConfigured } from "../mail.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

if (!process.env.DATABASE_URL) {
  const local = path.join(root, "data", "pc-database.url");
  if (fs.existsSync(local)) {
    process.env.DATABASE_URL = fs.readFileSync(local, "utf8").trim();
  }
}

if (!mailConfigured()) {
  console.error("RESEND_API_KEY missing");
  process.exit(1);
}

await initAuthStore();
const users = await listAllUsers({ limit: 2000 });
console.log(`[move-mail] accounts=${users.length}`);

let sent = 0;
let failed = 0;
for (const user of users) {
  const email = String(user?.email || "").trim();
  if (!email) continue;
  try {
    const result = await sendSiteMovedEmail({
      email,
      hasPlus: userHasPlus(user),
    });
    console.log(`[move-mail] sent ${email}`, result?.id || "");
    sent += 1;
    await new Promise((r) => setTimeout(r, 400));
  } catch (error) {
    failed += 1;
    console.error(`[move-mail] fail ${email}`, error?.message || error);
  }
}

console.log(`[move-mail] done sent=${sent} failed=${failed}`);
