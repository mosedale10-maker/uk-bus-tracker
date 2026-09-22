import fs from "fs";
import path from "path";
import os from "os";

const cfg = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".railway", "config.json"), "utf8"),
);
const token = cfg.user.accessToken;

async function gql(query, variables) {
  const res = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

for (const name of [
  "ServiceInstanceLimitsUpdateInput",
  "ServiceInstanceUpdateInput",
  "VolumeCreateInput",
  "VolumeUpdateInput",
]) {
  const t = await gql(
    `query($name:String!){ __type(name:$name){ name inputFields{ name description type{ kind name ofType{ name kind ofType{ name }}}} } }`,
    { name },
  );
  console.log(name, JSON.stringify(t?.data?.__type?.inputFields || t, null, 2));
}

// serviceInstanceLimitsUpdate args
const m = await gql(`{
  __type(name:"Mutation") {
    fields(includeDeprecated:true) {
      name
      args { name type { kind name ofType { name kind ofType { name } } } }
    }
  }
}`);
const field = (m?.data?.__type?.fields || []).find(
  (f) => f.name === "serviceInstanceLimitsUpdate",
);
console.log("serviceInstanceLimitsUpdate args", JSON.stringify(field, null, 2));

// Try volumeInstance query with instance id
const vi = await gql(
  `query($id:String!){ volumeInstance(id:$id){ id sizeMB currentSizeMB } }`,
  { id: "6118d25f-f26d-48c0-91e6-c5204c48e85b" },
);
console.log("volumeInstance", JSON.stringify(vi));
