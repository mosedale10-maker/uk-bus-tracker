import { initTrailStore, listTrailKeysForLines, getTrailsForKeys } from "../trail-store.mjs";

await initTrailStore();
for (const line of ["AT1", "AT2", "AT3"]) {
  const keys = await listTrailKeysForLines([line], { days: 30, limit: 20 });
  console.log(line, "keys:", keys.length, JSON.stringify(keys.slice(0, 3)));
  if (keys.length) {
    const first = typeof keys[0] === "string" ? keys[0] : keys[0].key || keys[0].trailKey || "";
    const { trails } = await getTrailsForKeys([first], { days: 30 });
    console.log("   sample", first, "points", trails?.[first]?.length ?? 0);
  }
}
