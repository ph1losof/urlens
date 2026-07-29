import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const root = resolve(import.meta.dir, "..");
const temp = await mkdtemp(join(tmpdir(), "urlens-package-"));
const expectedExports = [
  "decodeQueryComponent",
  "encodeQueryComponent",
  "hasQueryParam",
  "hasScheme",
  "pathnameEndsWith",
  "pathnameStartsWith",
  "queryParamEquals",
  "rawOriginsEqual",
  "readFragment",
  "readHost",
  "readHostname",
  "readOrigin",
  "readPathname",
  "readPort",
  "readQuery",
  "readQueryParam",
  "readQueryParams",
  "readScheme",
  "removeQueryParam",
  "removeQueryParams",
  "setPathname",
  "setPort",
  "setQueryParam",
  "setQueryParams",
  "setScheme",
  "stripFragment",
  "stripQuery",
  "view",
];

async function run(command: string[], cwd = root): Promise<string> {
  const process = Bun.spawn(command, {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed (${exitCode})\n${stdout}${stderr}`
    );
  }
  return stdout;
}

try {
  await run(["bun", "run", "build"]);
  const packOutput = await run([
    "npm",
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    temp,
  ]);
  const [{ filename }] = JSON.parse(packOutput) as [{ filename: string }];
  const tarball = join(temp, filename);
  const fixture = join(temp, "fixture");
  await mkdir(fixture);

  await Bun.write(
    join(fixture, "package.json"),
    JSON.stringify({ name: "urlens-consumer", private: true, type: "module" })
  );
  await run(
    [
      "npm",
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      tarball,
    ],
    fixture
  );
  await Bun.write(
    join(fixture, "consumer.mjs"),
    `import * as api from "urlens";
const actual = Object.keys(api).sort();
const expected = ${JSON.stringify(expectedExports)};
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(\`public exports changed: \${actual.join(", ")}\`);
}
if (api.readQueryParam("https://x.test/?q=hello+world", "q") !== "hello world") {
  throw new Error("bare package import failed");
}
if (api.view("https://x.test/path").pathname() !== "/path") {
  throw new Error("view export failed");
}
`
  );
  await run(["node", "consumer.mjs"], fixture);

  await Bun.write(
    join(fixture, "require.cjs"),
    `try {
  require("urlens");
  throw new Error("CommonJS unexpectedly resolved");
} catch (error) {
  if (error?.message === "CommonJS unexpectedly resolved") throw error;
  if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
}
`
  );
  await run(["node", "require.cjs"], fixture);

  await Bun.write(
    join(fixture, "consumer.ts"),
    `import { readQueryParams, view, type UrlView } from "urlens";
const values = readQueryParams("https://x.test/?a=1&b=2", ["a", "b"] as const);
const current: UrlView = view("https://x.test/");
const first: string | null = values[0];
void current;
void first;
`
  );
  const tsc = join(root, "node_modules", ".bin", "tsc");
  await run(
    [
      tsc,
      "--noEmit",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "consumer.ts",
    ],
    fixture
  );
  await run(
    [
      tsc,
      "--noEmit",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "ESNext",
      "--moduleResolution",
      "Bundler",
      "consumer.ts",
    ],
    fixture
  );
  const tsc5 = join(root, "node_modules", "typescript5", "bin", "tsc");
  await run(
    [
      tsc5,
      "--noEmit",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "consumer.ts",
    ],
    fixture
  );

  await Bun.write(
    join(fixture, "browser.ts"),
    `import { readPathname } from "urlens";
globalThis.__urlensResult = readPathname(globalThis.location.href);
`
  );
  const bundle = await Bun.build({
    entrypoints: [join(fixture, "browser.ts")],
    format: "esm",
    minify: true,
    target: "browser",
  });
  if (!bundle.success) {
    throw new Error(`consumer bundle failed: ${JSON.stringify(bundle.logs)}`);
  }
  const bundled = await bundle.outputs[0].text();
  const gzipBytes = gzipSync(bundled).byteLength;
  if (gzipBytes > 1024) {
    throw new Error(`readPathname bundle exceeds 1 KiB gzip: ${gzipBytes}`);
  }

  console.log(
    `Package consumer checks passed: ${expectedExports.length} exports, ` +
      `${gzipBytes} B gzip for readPathname.`
  );
} finally {
  await rm(temp, { force: true, recursive: true });
}
