#!/usr/bin/env node
// Seed realistic demo data into YOUR OWN deployment, so the dashboard has
// something to show when you pitch or rehearse. Reset before the real event:
// curl -X POST -H "Authorization: Bearer $LIVE_DECK_ADMIN_TOKEN" https://SERVICE/api/admin/reset
//
// Usage:
//   node scripts/seed-demo.mjs questions <service-url>
//   node scripts/seed-demo.mjs reactions <service-url> [total] [seconds]

const [, , command, rawUrl, arg3, arg4] = process.argv;

if (!command || !rawUrl || !["questions", "reactions"].includes(command)) {
  usage();
  process.exit(1);
}

let serviceUrl;
try {
  serviceUrl = normalizeServiceUrl(rawUrl);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const headers = {
  "content-type": "application/json",
  "user-agent": "Mozilla/5.0 live-deck-seed-demo",
};

try {
  if (command === "questions") {
    await seedQuestions();
  } else {
    await seedReactions(parsePositiveInteger(arg3, 30, "total", 5000), parsePositiveNumber(arg4, 30, "seconds", 86_400));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function usage() {
  console.error("usage: node scripts/seed-demo.mjs questions <service-url>");
  console.error("       node scripts/seed-demo.mjs reactions <service-url> [total] [seconds]");
}

function normalizeServiceUrl(value) {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("service URL must use http or https");
  }
  if (parsed.username || parsed.password) throw new Error("service URL must not contain credentials");
  parsed.search = "";
  parsed.hash = "";
  return parsed.href.replace(/\/+$/, "");
}

function parsePositiveInteger(value, fallback, name, maximum) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

function parsePositiveNumber(value, fallback, name, maximum) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be greater than 0 and no more than ${maximum}`);
  }
  return parsed;
}

async function request(path, init) {
  const response = await fetch(`${serviceUrl}${path}`, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${data.error || response.status}`);
  return data;
}

async function get(path) {
  return request(path);
}

async function post(path, body) {
  return request(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

function shuffled(list) {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

async function seedQuestions() {
  const questions = [
    ["Will the slides be shared afterwards?", "clarify"],
    ["Can you show that last step once more, slower?", "clarify"],
    ["How does this compare with what we already use day to day?", "bridge"],
    ["What does the pricing look like for a small team?", "chorus"],
    ["Does this work offline, or does it need a stable connection?", "keeper"],
    ["Who maintains the templates once we adopt this?", "chorus"],
    ["What happens to our existing data if we migrate?", "bridge"],
    ["Is there a mobile version, or is it desktop only?", "clarify"],
    ["What are the known limitations we should plan around?", "keeper"],
    ["How steep is the learning curve for non-technical colleagues?", "chorus"],
    ["Can external partners get restricted access?", "keeper"],
    ["Which part of the workflow saves the most time in practice?", "bridge"],
  ];
  const upvoteDistribution = shuffled([0, 0, 1, 1, 2, 2, 3, 4, 5, 7, 9, 12]);
  const config = await get("/api/config");
  const moderation = config.moderation?.enabled ? config.moderation : null;
  const submissions = [];

  for (const [index, [text, lens]] of questions.entries()) {
    const voterId = crypto.randomUUID();
    if (moderation) {
      await post("/api/participant", {
        alias: `Demo participant ${String(index + 1).padStart(2, "0")}`,
        cocVersion: moderation.codeOfConduct.version,
        voterId,
      });
    }
    const result = await post("/api/question", {
      text,
      lens,
      difficulty: 1 + Math.floor(Math.random() * 5),
      voterId,
    });
    submissions.push(result.submission);
  }

  const pendingIds = submissions
    .filter((submission) => submission.visibility !== "public")
    .map((submission) => submission.id);
  if (pendingIds.length > 0) {
    const delaySeconds = Number(moderation?.presentationDelaySeconds) || 0;
    await waitForPublicQuestions(pendingIds, Math.max(5000, (delaySeconds + 5) * 1000));
  }

  const fans = Array.from({ length: 14 }, () => crypto.randomUUID());
  for (const [index, submission] of submissions.entries()) {
    const count = upvoteDistribution[index];
    for (const voterId of shuffled(fans).slice(0, count)) {
      await post("/api/upvote", { questionId: submission.id, voterId });
    }
  }
  console.log(`${submissions.length} questions seeded against ${serviceUrl}`);
}

async function waitForPublicQuestions(questionIds, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const expected = new Set(questionIds);
  while (Date.now() < deadline) {
    const state = await get("/api/state");
    for (const question of state.questions || []) expected.delete(question.id);
    if (expected.size === 0) return;
    await sleep(500);
  }
  throw new Error(
    "questions stayed pending; open or restore them in the moderator view, then run the command again",
  );
}

async function seedReactions(total, seconds) {
  const moods = {
    calm: [3, 2, 1, 1],
    applause: [8, 3, 1, 1],
    insight: [2, 8, 2, 1],
    resonance: [2, 2, 8, 1],
    doubt: [1, 1, 2, 5],
  };
  const kindIds = ["applause", "insight", "resonate", "pause"];
  const devices = Array.from({ length: 6 }, () => crypto.randomUUID());

  function weightedKind(weights) {
    const sum = weights.reduce((acc, weight) => acc + weight, 0);
    let roll = Math.random() * sum;
    for (let index = 0; index < weights.length; index += 1) {
      roll -= weights[index];
      if (roll <= 0) return kindIds[index];
    }
    return kindIds[0];
  }

  let mood = "calm";
  let moodUntil = 0;
  let sent = 0;
  let limited = 0;
  for (let index = 0; index < total; index += 1) {
    const now = Date.now();
    if (now >= moodUntil) {
      mood = pick(Object.keys(moods));
      moodUntil = now + (45 + Math.random() * 45) * 1000;
      console.log(`mood -> ${mood}`);
    }
    try {
      await post("/api/reaction", {
        kind: weightedKind(moods[mood]),
        voterId: devices[index % devices.length],
      });
      sent += 1;
    } catch (error) {
      if (String(error.message).includes("rate limit")) limited += 1;
      else throw error;
    }
    if (sent && sent % 25 === 0) console.log(`  ${sent}/${total} sent`);
    const interval = (seconds * 1000) / total;
    await sleep(interval * (0.4 + Math.random() * 1.2));
  }
  console.log(`reactions sent: ${sent}${limited ? ` (rate-limited: ${limited})` : ""}`);
}
