/** Find Railway GraphQL types/fields related to volume size. */
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

const types = await gql(`{
  __schema {
    types { name kind }
  }
}`);
const names = (types?.data?.__schema?.types || [])
  .map((t) => t.name)
  .filter((n) => /volume|resize|size|storage|disk/i.test(n));
console.log("types:", names.join("\n"));

for (const name of names) {
  const t = await gql(`query($name: String!) {
    __type(name: $name) {
      name
      kind
      inputFields { name type { kind name ofType { name kind ofType { name } } } }
      fields { name args { name type { kind name ofType { name kind ofType { name } } } } }
      enumValues { name }
    }
  }`, { name });
  const node = t?.data?.__type;
  if (!node) continue;
  if (node.inputFields?.length) {
    console.log("\nINPUT", name, node.inputFields.map((f) => f.name).join(", "));
  }
  if (node.fields?.some((f) => /size|resize/i.test(f.name))) {
    console.log(
      "\nTYPE",
      name,
      node.fields.filter((f) => /size|resize|mb/i.test(f.name)).map((f) => f.name).join(", "),
    );
  }
  if (node.enumValues?.length && /state|size|resize/i.test(name)) {
    console.log("\nENUM", name, node.enumValues.map((e) => e.name).join(", "));
  }
}

// Try querying project volumes with size
const proj = await gql(`query {
  project(id: "883139cf-1e97-48e0-b512-d44d8e418483") {
    volumes {
      edges {
        node {
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
      }
    }
  }
}`);
console.log("\nproject volumes:", JSON.stringify(proj, null, 2).slice(0, 2000));
