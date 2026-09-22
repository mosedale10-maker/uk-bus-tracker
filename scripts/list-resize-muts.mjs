import fs from "fs";
import path from "path";
import os from "os";

const cfg = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".railway", "config.json"), "utf8"),
);
const token = cfg.user.accessToken;

const res = await fetch("https://backboard.railway.com/graphql/v2", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    query: `{ __type(name: "Mutation") { fields { name } } }`,
  }),
});
const data = await res.json();
const names = (data?.data?.__type?.fields || []).map((f) => f.name);
console.log("count", names.length);
console.log(names.filter((n) => /size|disk|storage|capaci|expand|grow|live|quota|plan|billing|stacker|instance/i.test(n)).join("\n"));
