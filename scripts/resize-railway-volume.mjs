/** Resize Railway Postgres volume via GraphQL (no token printed). */
import fs from "fs";
import path from "path";
import os from "os";

const cfgPath = path.join(os.homedir(), ".railway", "config.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const token =
  cfg?.user?.accessToken ||
  cfg?.user?.token?.accessToken ||
  cfg?.user?.token ||
  cfg?.token ||
  Object.values(cfg?.users || {})[0]?.token;
if (!token || typeof token !== "string") {
  console.error("no-token", typeof token);
  process.exit(1);
}

async function gql(query, variables) {
  const res = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  return data;
}

const VOLUME_ID = "77151d7b-1f51-4258-9164-501b610d28ff";
const ENV_ID = "6958170d-4591-4fed-8e98-a9b3530f49e4";
const TARGET_MB = Number(process.env.TARGET_SIZE_MB || 2048);

// Discover mutation field names related to volume/resize
const intro = await gql(`{
  __type(name: "Mutation") {
    fields { name }
  }
}`);
const muts = (intro?.data?.__type?.fields || [])
  .map((f) => f.name)
  .filter((n) => /volume|resize|size/i.test(n));
console.log("mutations:", muts.join(", ") || "(none)");

const inputIntro = await gql(`{
  __type(name: "VolumeInstanceUpdateInput") {
    inputFields { name type { kind name ofType { kind name ofType { name } } } }
  }
}`);
console.log(
  "VolumeInstanceUpdateInput:",
  JSON.stringify(inputIntro?.data?.__type?.inputFields || inputIntro, null, 2),
);

// Try the standard resize path
const attempts = [
  {
    name: "volumeInstanceUpdate.sizeMB",
    query: `mutation($volumeId: String!, $environmentId: String, $input: VolumeInstanceUpdateInput!) {
      volumeInstanceUpdate(volumeId: $volumeId, environmentId: $environmentId, input: $input)
    }`,
    variables: {
      volumeId: VOLUME_ID,
      environmentId: ENV_ID,
      input: { sizeMB: TARGET_MB },
    },
  },
  {
    name: "volumeInstanceUpdate.mountPath+sizeMB",
    query: `mutation($volumeId: String!, $environmentId: String, $input: VolumeInstanceUpdateInput!) {
      volumeInstanceUpdate(volumeId: $volumeId, environmentId: $environmentId, input: $input)
    }`,
    variables: {
      volumeId: VOLUME_ID,
      environmentId: ENV_ID,
      input: { mountPath: "/var/lib/postgresql/data", sizeMB: TARGET_MB },
    },
  },
];

for (const attempt of attempts) {
  const result = await gql(attempt.query, attempt.variables);
  console.log(attempt.name, JSON.stringify(result));
  if (!result.errors && result.data) {
    console.log("SUCCESS via", attempt.name);
    break;
  }
}

const check = await gql(
  `query($id: String!) {
    volume(id: $id) {
      id
      name
      volumeInstances {
        edges {
          node {
            id
            sizeMB
            currentSizeMB
            environmentId
            mountPath
          }
        }
      }
    }
  }`,
  { id: VOLUME_ID },
);
console.log("after:", JSON.stringify(check?.data || check, null, 2));
