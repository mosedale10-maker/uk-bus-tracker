/** One-off: grant Plus months by email. Usage: node scripts/grant-plus.mjs email [months] */
import { initAuthStore, grantPlusByEmail, publicUser } from "../auth-store.mjs";

const email = process.argv[2];
const months = Number(process.argv[3] || 1) || 1;
if (!email) {
  console.error("Usage: node scripts/grant-plus.mjs email [months]");
  process.exit(1);
}

await initAuthStore();
try {
  const user = await grantPlusByEmail(email, { months });
  console.log(JSON.stringify(publicUser(user), null, 2));
} catch (error) {
  console.error(error.message || error);
  process.exit(error.status === 404 ? 2 : 1);
}
process.exit(0);
