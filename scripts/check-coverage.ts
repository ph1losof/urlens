import { readdir } from "node:fs/promises";

const report = await Bun.file("coverage/lcov.info").text();
const declarationOnlyFiles = new Set(["view-types.ts"]);
const sourceFiles = (await readdir("src"))
  .filter(
    (file) =>
      file.endsWith(".ts") &&
      file !== "index.ts" &&
      !declarationOnlyFiles.has(file)
  )
  .map((file) => `src/${file}`);

const coveredFiles = new Set<string>();
let linesFound = 0;
let linesHit = 0;
let functionsFound = 0;
let functionsHit = 0;
const minimumCoverage = 0.99;

for (const line of report.split("\n")) {
  const [field, value] = line.split(":", 2);
  switch (field) {
    case "SF":
      coveredFiles.add(value);
      break;
    case "LF":
      linesFound += Number(value);
      break;
    case "LH":
      linesHit += Number(value);
      break;
    case "FNF":
      functionsFound += Number(value);
      break;
    case "FNH":
      functionsHit += Number(value);
      break;
  }
}

const missingFiles = sourceFiles.filter((file) => !coveredFiles.has(file));
if (
  missingFiles.length > 0 ||
  linesHit / linesFound < minimumCoverage ||
  functionsHit / functionsFound < minimumCoverage
) {
  console.error(
    `Coverage must be at least 99%: ${linesHit}/${linesFound} lines, ` +
      `${functionsHit}/${functionsFound} functions.`
  );
  if (missingFiles.length > 0) {
    console.error(`Missing source files: ${missingFiles.join(", ")}`);
  }
  process.exit(1);
}

console.log(
  `Coverage gate passed (minimum 99%): ${linesHit}/${linesFound} lines and ` +
    `${functionsHit}/${functionsFound} functions.`
);
