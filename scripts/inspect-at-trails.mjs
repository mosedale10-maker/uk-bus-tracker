import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("D:/Projects/uk-bus-tracker/data/trails/trails.sqlite", {
  readOnly: true,
});
const q = (sql, ...a) => db.prepare(sql).all(...a);
const g = (sql, ...a) => db.prepare(sql).get(...a);

console.log(
  "AT lines",
  q(
    `SELECT line, COUNT(*) AS n FROM vehicle_trail_points
     WHERE UPPER(COALESCE(line,'')) IN ('AT1','AT2','AT3')
        OR UPPER(COALESCE(line,'')) LIKE 'AT%'
     GROUP BY line ORDER BY n DESC`,
  ),
);
console.log("at: keys", g(`SELECT COUNT(*) AS n FROM vehicle_trail_points WHERE trail_key LIKE 'at:%'`));
console.log("staff- keys", g(`SELECT COUNT(*) AS n FROM vehicle_trail_points WHERE trail_key LIKE 'staff-%'`));
console.log(
  "dest Alton",
  g(`SELECT COUNT(*) AS n FROM vehicle_trail_points WHERE destination LIKE '%Alton%'`),
);
console.log(
  "sample staff",
  q(`SELECT trail_key, line, operator, destination, COUNT(*) AS n, MAX(t) AS t1
     FROM vehicle_trail_points WHERE trail_key LIKE 'staff-%' OR trail_key LIKE 'at:%'
     GROUP BY trail_key, line, operator, destination ORDER BY t1 DESC LIMIT 20`),
);
