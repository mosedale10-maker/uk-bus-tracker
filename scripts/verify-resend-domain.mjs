import fs from "node:fs";

const key = process.env.RESEND_API_KEY;
const domainId = process.env.RESEND_DOMAIN_ID || "cbbc9857-2ade-4505-9332-365ddcd84d56";
const headers = {
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
};

const out = [];
const say = (m) => {
  out.push(String(m));
  console.log(m);
};

say("verify " + domainId);
const verifyRes = await fetch(`https://api.resend.com/domains/${domainId}/verify`, {
  method: "POST",
  headers,
});
const verifyBody = await verifyRes.json().catch(() => ({}));
say("verifyStatus=" + verifyRes.status);
say(JSON.stringify(verifyBody));

// Poll status a few times
let domain = null;
for (let i = 0; i < 6; i++) {
  await new Promise((r) => setTimeout(r, 4000));
  const getRes = await fetch(`https://api.resend.com/domains/${domainId}`, { headers });
  domain = await getRes.json().catch(() => ({}));
  say(`poll${i + 1} status=${domain.status}`);
  if (domain.status === "verified" || domain.status === "failed") break;
}

fs.writeFileSync("resend-domain-verify.json", JSON.stringify(domain, null, 2));
fs.writeFileSync("resend-verify-log.txt", out.join("\n"));
say(JSON.stringify(domain?.records || [], null, 2));
