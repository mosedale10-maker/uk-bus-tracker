import fs from "node:fs";

const key = process.env.RESEND_API_KEY;
const domainName = process.env.RESEND_DOMAIN || "owenstream.co.uk";
const out = [];
const say = (m) => {
  out.push(String(m));
  console.log(m);
};

const headers = {
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
};

say("domain=" + domainName);

// List existing domains first
const listRes = await fetch("https://api.resend.com/domains", { headers });
const listBody = await listRes.json().catch(() => ({}));
say("listStatus=" + listRes.status);
fs.writeFileSync("resend-domains-list.json", JSON.stringify(listBody, null, 2));

let domain = null;
const existing = Array.isArray(listBody?.data)
  ? listBody.data.find((d) => d.name === domainName)
  : null;

if (existing) {
  say("exists=" + existing.id);
  const getRes = await fetch(`https://api.resend.com/domains/${existing.id}`, { headers });
  domain = await getRes.json();
  say("getStatus=" + getRes.status);
} else {
  const createRes = await fetch("https://api.resend.com/domains", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: domainName }),
  });
  domain = await createRes.json().catch(() => ({}));
  say("createStatus=" + createRes.status);
}

fs.writeFileSync("resend-domain-setup.json", JSON.stringify(domain, null, 2));
say(JSON.stringify(domain, null, 2));
fs.writeFileSync("resend-setup-log.txt", out.join("\n"));
