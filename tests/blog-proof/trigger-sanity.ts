import { readFileSync } from "node:fs";

import type { EvalEntry } from "../../cli/selftune/types.ts";
import { callLlm } from "../../cli/selftune/utils/llm-call.ts";
import {
  buildBatchTriggerCheckPrompt,
  parseBatchTriggerResponse,
} from "../../cli/selftune/utils/trigger-check.ts";

const evalSet: EvalEntry[] = JSON.parse(
  readFileSync("tests/blog-proof/fixtures/seo-audit/synthetic_eval.json", "utf-8"),
);
const queries = evalSet.map((e) => e.query);

const realDesc = `When the user wants to audit, review, or diagnose SEO issues on their site. Also use when the user mentions "SEO audit," "technical SEO," "why am I not ranking," "SEO issues," "on-page SEO," "meta tags review," "SEO health check," "my traffic dropped," "lost rankings," "not showing up in Google," "site isn't ranking," "Google update hit me," "page speed," "core web vitals," "crawl errors," or "indexing issues."`;

const badDesc = `When the user wants to create Italian pasta recipes. Use when the user mentions "spaghetti," "carbonara," "tomato sauce," or "how to boil pasta."`;

const minimalDesc = `When the user wants help with SEO on their website.`;

const systemPrompt =
  "You are an evaluation assistant. For each numbered query, respond with the number followed by YES or NO.";

async function testDescription(label: string, desc: string) {
  const prompt = buildBatchTriggerCheckPrompt(desc, queries);
  const raw = await callLlm(systemPrompt, prompt, "claude", "haiku");
  const results = parseBatchTriggerResponse(raw, queries.length);

  let posCorrect = 0,
    negCorrect = 0;
  const positives = evalSet.filter((e) => e.should_trigger);
  const negatives = evalSet.filter((e) => !e.should_trigger);

  const misses: string[] = [];
  for (let i = 0; i < evalSet.length; i++) {
    const shouldTrigger = evalSet[i].should_trigger;
    const didTrigger = results[i];
    const pass = (shouldTrigger && didTrigger) || (!shouldTrigger && !didTrigger);
    if (pass && shouldTrigger) posCorrect++;
    if (pass && !shouldTrigger) negCorrect++;
    if (!pass)
      misses.push(
        `  ${shouldTrigger ? "FN" : "FP"}: "${evalSet[i].query}" → ${didTrigger ? "YES" : "NO"}`,
      );
  }

  const total = posCorrect + negCorrect;
  console.log(`\n=== ${label} ===`);
  console.log(
    `Overall: ${total}/${evalSet.length} (${((total / evalSet.length) * 100).toFixed(1)}%)`,
  );
  console.log(
    `Positives (recall): ${posCorrect}/${positives.length} (${((posCorrect / positives.length) * 100).toFixed(1)}%)`,
  );
  console.log(
    `Negatives (specificity): ${negCorrect}/${negatives.length} (${((negCorrect / negatives.length) * 100).toFixed(1)}%)`,
  );
  if (misses.length > 0) {
    console.log(`Misses:`);
    for (const m of misses) console.log(m);
  }
  console.log(`\nRaw response (first 800 chars):\n${raw.slice(0, 800)}`);
}

console.log("Trigger check sanity test — 3 descriptions against 50-query eval set\n");
await testDescription("REAL DESC (expect ~95%+)", realDesc);
await testDescription("PASTA DESC (expect <50%)", badDesc);
await testDescription("MINIMAL DESC (expect ~60-70%)", minimalDesc);
