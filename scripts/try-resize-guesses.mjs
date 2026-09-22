import fs from "fs";
import path from "path";
import os from "os";

const cfg = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".railway", "config.json"), "utf8"),
);
const token = cfg.user.accessToken;
const INSTANCE = "6118d25f-f26d-48c0-91e6-c5204c48e85b";

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

const guesses = [
  {
    name: "helpStationResizeVolume",
    query: `mutation($input: HelpStationResizeVolumeInput!) {
      helpStationResizeVolume(input: $input) { mode }
    }`,
    variables: {
      input: {
        preferOnline: true,
        reason: "Postgres disk full — restore Plus login",
        targetSizeMB: 2048,
        volumeInstanceId: INSTANCE,
      },
    },
  },
  {
    name: "volumeInstanceResize",
    query: `mutation { volumeInstanceResize(id: "${INSTANCE}", sizeMB: 2048) }`,
  },
  {
    name: "volumeResize",
    query: `mutation { volumeResize(volumeId: "77151d7b-1f51-4258-9164-501b610d28ff", sizeMB: 2048) }`,
  },
  {
    name: "volumeInstanceUpdate size via JSON",
    query: `mutation {
      volumeInstanceUpdate(
        volumeId: "77151d7b-1f51-4258-9164-501b610d28ff"
        environmentId: "6958170d-4591-4fed-8e98-a9b3530f49e4"
        input: { mountPath: "/var/lib/postgresql/data" }
      )
    }`,
  },
];

for (const g of guesses) {
  const r = await gql(g.query, g.variables);
  const msg = r.errors?.[0]?.message || JSON.stringify(r.data);
  console.log(g.name + ":", msg);
}

const after = await gql(
  `query($id:String!){ volumeInstance(id:$id){ sizeMB currentSizeMB } }`,
  { id: INSTANCE },
);
console.log("size now:", after?.data?.volumeInstance);
