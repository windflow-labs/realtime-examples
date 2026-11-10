/** Download only the cleared, pinned public samples for subsequent offline replay. */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
const samples = JSON.parse(await readFile(new URL("./replay-samples.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);
if (args.some((arg) => !Object.hasOwn(samples, arg))) throw new Error("Specify only: lingbot, sana-streaming, helios or longlive-v2; no arguments downloads all four.");
const selected = args.length ? [...new Set(args)] : Object.keys(samples);
await mkdir(new URL("./media/", import.meta.url), { recursive: true });
for (const model of selected) {
  const sample = samples[model];
  const source = new URL(sample.source);
  if (source.origin !== "https://media.windflow.online" || !source.pathname.startsWith("/public/site/") || !/^media\/[a-z0-9-]+\.webm$/.test(sample.file))
    throw new Error("Replay source is outside the fixed public sample allowlist.");
  const destination = new URL(sample.file, import.meta.url);
  const matches = (bytes) => bytes.length === sample.bytes && createHash("sha256").update(bytes).digest("hex") === sample.sha256;
  try { if (matches(await readFile(destination))) { console.log(`${model}: verified local sample already exists.`); continue; } }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const response = await fetch(source, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`${model}: sample download failed (${response.status}).`);
  if (response.headers.get("content-length") && Number(response.headers.get("content-length")) !== sample.bytes)
    throw new Error(`${model}: unexpected download size.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!matches(bytes)) throw new Error(`${model}: sample size/SHA-256 mismatch; no file was installed.`);
  const temporary = new URL(sample.file + ".partial", import.meta.url);
  try { await writeFile(temporary, bytes); await rename(temporary, destination); }
  finally { await rm(temporary, { force: true }); }
  console.log(`${model}: downloaded and verified ${bytes.length} bytes. No inference was requested.`);
}
