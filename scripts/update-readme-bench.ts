import { readFileSync, writeFileSync } from "node:fs";

const benchOutputPath = process.argv[2] ?? "bench-output.txt";
const readmePath = "README.md";

const ENGINE_LABELS: Record<string, string> = {
  "Chromium (V8)": "V8 (Chrome)",
  "Firefox (SpiderMonkey)": "SpiderMonkey (Firefox)",
  "WebKit (JavaScriptCore)": "JSC (WebKit)",
};

const ENGINE_ORDER = [
  "Chromium (V8)",
  "Firefox (SpiderMonkey)",
  "WebKit (JavaScriptCore)",
];

const PAIR_LABELS: Record<string, string> = {
  "rq.plain vs URL.plain": "read query, plain ASCII",
  "rq.encoded vs URL.encoded": "read query, percent-encoded UTF-8",
  "rq.long vs URL.long": "read query, key in 12th field",
  "rq.miss vs URL.miss": "read query, key absent (miss path)",
  "rq.decoded_key vs URL.decoded_key":
    "read query, encoded URL key (decoded match)",
  "rqs.two vs URL.two": "read 2 keys (`readQueryParams`)",
  "rqs.four vs URL.four": "read 4 keys (`readQueryParams`)",
  "rp.full vs URL.pathname": "read pathname (full URL)",
  "rp.pathOnly vs URL.pathOnly": "read pathname (path-only)",
  "ro.full vs URL.origin": "read origin",
  "rs.full vs URL.protocol": "read scheme",
  "rh.full vs URL.host": "read host",
  "rhn.full vs URL.hostname": "read hostname",
  "rport.full vs URL.port": "read port",
  "sq.replace vs URL.sq.replace": "set query (replace)",
  "sq.append vs URL.sq.append": "set query (append)",
  "sq.delete vs URL.sq.delete": "set query (delete)",
  "sp.replace vs URL.sp.replace": "set pathname",
  "hq.full vs URL.has": "`hasQueryParam`",
  "qpe.ascii vs URL.qpe.ascii": "`queryParamEquals` (ASCII fast path)",
  "pss.full vs URL.startsWith": "`pathnameStartsWith`",
  "om.full vs URL.origin.eq": "`rawOriginsEqual`",
  "rfrag.full vs URL.hash": "read fragment",
  "sp.port.set vs URL.port.set": "set port",
  "view.read1 vs rp.full":
    "`view().pathname()` vs flat `readPathname` (1 read)",
  "view.read5 vs urlens.flat5": "`view()` 5 reads vs flat 5 reads",
  "view.read5 vs URL.read5": "`view()` 5 reads vs `new URL()` + 5 props",
  "view.qp1 vs rq.plain": "`view().queryParam()` vs flat `readQueryParam`",
  "view.qp.batch vs rqs.two":
    "`view().queryParams()` vs `readQueryParams` (2 keys)",
  "rqp.remove1 vs sq.delete": "`removeQueryParam` vs `setQueryParam(…, null)`",
  "rqp.removeN vs rqp.removeN.seq":
    "`removeQueryParams` (bulk) vs N sequential",
};
const PAIR_ORDER = Object.keys(PAIR_LABELS);

interface EngineResults {
  ops: Record<string, number>;
  speedups: Record<string, number>;
}

function parseOps(value: string, unit: string): number {
  const n = parseFloat(value);
  switch (unit) {
    case "K":
      return n * 1e3;
    case "M":
      return n * 1e6;
    case "G":
      return n * 1e9;
    default:
      return n;
  }
}

function parseEngineBlock(body: string): EngineResults {
  const ops: Record<string, number> = {};
  const speedups: Record<string, number> = {};

  const opsRe = /^(\S+)\s+([\d.]+)([KMG]?)\/s\s+\d+/gm;
  for (const m of body.matchAll(opsRe)) {
    ops[m[1]] = parseOps(m[2], m[3]);
  }

  // Bench rows look like "name vs name   12.34x" — but very long names can
  // butt directly against the number with no space (the bench pads to a
  // fixed column width). Accept both.
  const speedRe = /^(\S+ vs \S+?)\s*([\d.]+)x$/gm;
  for (const m of body.matchAll(speedRe)) {
    speedups[m[1]] = parseFloat(m[2]);
  }

  return { ops, speedups };
}

function fmtMillions(n: number): string {
  if (n >= 1e9) {
    return `${(n / 1e9).toFixed(1)}B`;
  }
  if (n >= 1e6) {
    return `${(n / 1e6).toFixed(1)}M`;
  }
  if (n >= 1e3) {
    return `${(n / 1e3).toFixed(0)}K`;
  }
  return n.toFixed(0);
}

function fmtSpeedup(n: number): string {
  return `${n.toFixed(1)}×`;
}

// fallow-ignore-next-line complexity
function main(): void {
  const output = readFileSync(benchOutputPath, "utf8");

  // Split body by engine header. Result is [pre, name1, body1, name2, body2, ...].
  const parts = output.split(/^======== (.+?) ========$/m);
  const engineBodies: Record<string, string> = {};
  for (let i = 1; i < parts.length; i += 2) {
    engineBodies[parts[i].trim()] = parts[i + 1] ?? "";
  }

  const results: Record<string, EngineResults> = {};
  for (const name of ENGINE_ORDER) {
    const body = engineBodies[name];
    if (!body) {
      throw new Error(
        `bench output missing engine block "${name}". Got blocks: ${Object.keys(engineBodies).join(", ")}`
      );
    }
    results[name] = parseEngineBlock(body);
    if (results[name].ops["rq.plain"] === undefined) {
      throw new Error(`bench output missing rq.plain throughput for ${name}`);
    }
    for (const pair of PAIR_ORDER) {
      if (results[name].speedups[pair] === undefined) {
        throw new Error(`bench output missing "${pair}" for ${name}`);
      }
    }
  }

  const lines: string[] = [];
  lines.push(
    `| case | ${ENGINE_ORDER.map((e) => ENGINE_LABELS[e]).join(" | ")} |`
  );
  lines.push(`|---|${ENGINE_ORDER.map(() => "---").join("|")}|`);
  for (const pair of PAIR_ORDER) {
    const cells = ENGINE_ORDER.map((engine) => {
      const v = results[engine].speedups[pair];
      return v === undefined ? "—" : fmtSpeedup(v);
    });
    lines.push(`| ${PAIR_LABELS[pair]} | ${cells.join(" | ")} |`);
  }

  const hotPath = ENGINE_ORDER.map(
    (e) => `~${fmtMillions(results[e].ops["rq.plain"] ?? 0)}`
  ).join(" / ");
  const throughputLine = `Hot-path throughput: **${hotPath} ops/s** for \`readQueryParam\` (V8 / SpiderMonkey / JSC).`;

  const block = [
    "<!-- BENCH:START -->",
    "",
    ...lines,
    "",
    throughputLine,
    "",
    "<!-- BENCH:END -->",
  ].join("\n");

  const readme = readFileSync(readmePath, "utf8");
  const startMarker = "<!-- BENCH:START -->";
  const endMarker = "<!-- BENCH:END -->";
  const startIdx = readme.indexOf(startMarker);
  const endIdx = readme.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(
      `README.md is missing ${startMarker}/${endMarker} markers — cannot auto-update.`
    );
  }

  const updated =
    readme.slice(0, startIdx) + block + readme.slice(endIdx + endMarker.length);

  if (updated === readme) {
    console.log("README bench block unchanged.");
    return;
  }
  writeFileSync(readmePath, updated);
  console.log("README bench block updated.");
}

main();
