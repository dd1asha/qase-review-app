#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const envPath = process.env.ENV_PATH || path.join(scriptDir, ".env");
const port = Number(process.env.PORT || 8787);

function loadEnv(filePath, override = false) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }
    const [rawKey, ...rawValueParts] = line.split("=");
    const key = rawKey.trim();
    const value = rawValueParts.join("=").trim().replace(/^["']|["']$/g, "");
    if (key && (override || !process.env[key])) {
      process.env[key] = value;
    }
  }
}

loadEnv(envPath);

function env(name, fallback = "") {
  return (process.env[name] || fallback).trim();
}

function requireEnv(name) {
  loadEnv(envPath, true);
  const value = env(name);
  if (!value) {
    throw new Error(`Missing ${name}. Add it to ${envPath}.`);
  }
  return value;
}

const qaseCaseSchema = {
  type: "object",
  properties: {
    cases: {
      type: "array",
      minItems: 1,
          maxItems: 25,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          preconditions: { type: "string" },
          priority: { type: "integer" },
          severity: { type: "integer" },
          steps_type: { type: "string", enum: ["classic"] },
          steps: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            items: {
              type: "object",
              properties: {
                action: { type: "string" },
                expected_result: { type: "string" },
                data: { type: "string" },
              },
              required: ["action", "expected_result", "data"],
              additionalProperties: false,
            },
          },
          tags: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: [
          "title",
          "description",
          "preconditions",
          "priority",
          "severity",
          "steps_type",
          "steps",
          "tags",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["cases"],
  additionalProperties: false,
};

const suiteSuggestionSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    description: { type: "string" },
  },
  required: ["title", "description"],
  additionalProperties: false,
};

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(data));
}

function sendHtml(response) {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(html);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function extractOutputText(responseBody) {
  if (typeof responseBody.output_text === "string") {
    return responseBody.output_text;
  }

  const pieces = [];
  for (const item of responseBody.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") {
        pieces.push(content.text);
      }
    }
  }
  return pieces.join("\n").trim();
}

function resolveSuiteId(suiteId) {
  const value = Number(suiteId);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Select a valid Qase suite.");
  }
  return value;
}

function normalizeCases(cases, suiteId) {
  const resolvedSuiteId = resolveSuiteId(suiteId);
  return cases.map((testCase) => ({
    title: String(testCase.title || "").slice(0, 255),
    description: String(testCase.description || ""),
    preconditions: String(testCase.preconditions || ""),
    suite_id: resolvedSuiteId,
    priority: Number(testCase.priority || 2),
    severity: Number(testCase.severity || 2),
    steps_type: "classic",
    steps: (testCase.steps || []).map((step) => ({
      action: String(step.action || ""),
      expected_result: String(step.expected_result || ""),
      data: String(step.data || ""),
    })),
    tags: Array.from(new Set([...(testCase.tags || []), "ai-generated"])).filter(Boolean),
  }));
}

function normalizeGeneratedCases(cases) {
  return cases.map((testCase) => ({
    title: String(testCase.title || "").slice(0, 255),
    description: String(testCase.description || ""),
    preconditions: String(testCase.preconditions || ""),
    priority: Number(testCase.priority || 2),
    severity: Number(testCase.severity || 2),
    steps_type: "classic",
    steps: (testCase.steps || []).map((step) => ({
      action: String(step.action || ""),
      expected_result: String(step.expected_result || ""),
      data: String(step.data || ""),
    })),
    tags: Array.from(new Set([...(testCase.tags || []), "ai-generated"])).filter(Boolean),
  }));
}

function qaseHeaders(token) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Token: token,
  };
}

function parseQaseJson(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function qaseError(body, text, status) {
  return body.errorMessage || body.error?.message || body.message || body.raw || text || `Qase status ${status}`;
}

function extractQaseSuites(body) {
  const result = body.result;
  const candidates = [
    result?.entities,
    result?.items,
    result?.suites,
    result,
    body.entities,
    body.suites,
  ];
  const suites = candidates.find(Array.isArray) || [];
  return suites
    .map((suite) => ({
      id: suite.id,
      title: suite.title || suite.name || `Suite ${suite.id}`,
      parent_id: suite.parent_id ?? suite.parentId ?? null,
      description: suite.description || "",
      position: suite.position ?? 0,
      cases_count: suite.cases_count ?? 0,
    }))
    .filter((suite) => suite.id !== undefined && suite.id !== null);
}

function extractQaseCases(body) {
  const result = body.result;
  const candidates = [
    result?.entities,
    result?.items,
    result?.cases,
    result,
    body.entities,
    body.cases,
  ];
  const cases = candidates.find(Array.isArray) || [];
  return cases
    .map((testCase) => ({
      id: testCase.id ?? testCase.case_id ?? testCase.caseId ?? null,
      title: testCase.title || testCase.name || `Case ${testCase.id ?? ""}`.trim(),
      suite_id: testCase.suite_id ?? testCase.suiteId ?? null,
      tags: Array.isArray(testCase.tags) ? testCase.tags : [],
    }))
    .filter((testCase) => testCase.id !== null && testCase.title);
}

function flattenSuites(suites) {
  const byParent = new Map();
  for (const suite of suites) {
    const parent = suite.parent_id ?? null;
    if (!byParent.has(parent)) {
      byParent.set(parent, []);
    }
    byParent.get(parent).push(suite);
  }

  const output = [];
  const visit = (parent, depth) => {
    const children = (byParent.get(parent) || []).sort((a, b) => {
      if (a.position !== b.position) {
        return a.position - b.position;
      }
      return a.title.localeCompare(b.title);
    });
    for (const child of children) {
      output.push({ ...child, depth });
      visit(child.id, depth + 1);
    }
  };

  visit(null, 0);
  const included = new Set(output.map((suite) => suite.id));
  for (const suite of suites) {
    if (!included.has(suite.id)) {
      output.push({ ...suite, depth: 0 });
    }
  }
  return output;
}

async function listQaseSuites(search = "") {
  const token = requireEnv("QASE_API_TOKEN");
  const projectCode = requireEnv("QASE_PROJECT_CODE");
  const limit = 100;
  let offset = 0;
  let total = Infinity;
  const allSuites = [];

  while (offset < total) {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (search) {
      params.set("search", search);
    }

    const response = await fetch(`https://api.qase.io/v1/suite/${projectCode}?${params.toString()}`, {
      method: "GET",
      headers: qaseHeaders(token),
    });

    const text = await response.text();
    const body = parseQaseJson(text);
    if (!response.ok) {
      throw new Error(qaseError(body, text, response.status));
    }

    const pageSuites = extractQaseSuites(body);
    allSuites.push(...pageSuites);

    const result = body.result || {};
    total = Number(result.filtered ?? result.total ?? allSuites.length);
    const count = Number(result.count ?? pageSuites.length);
    if (!count || pageSuites.length === 0) {
      break;
    }
    offset += count;
  }

  return flattenSuites(allSuites);
}

async function createQaseSuite({ title, description = "", parentId = null }) {
  const token = requireEnv("QASE_API_TOKEN");
  const projectCode = requireEnv("QASE_PROJECT_CODE");
  const payload = {
    title: String(title || "").trim(),
    description: String(description || "").trim(),
  };
  if (!payload.title) {
    throw new Error("Suite title is required.");
  }
  if (parentId) {
    payload.parent_id = Number(parentId);
  }

  const response = await fetch(`https://api.qase.io/v1/suite/${projectCode}`, {
    method: "POST",
    headers: qaseHeaders(token),
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  const body = parseQaseJson(text);
  if (!response.ok) {
    throw new Error(qaseError(body, text, response.status));
  }

  const result = body.result && typeof body.result === "object" ? body.result : {};
  return {
    id: result.id ?? body.id ?? null,
    title: payload.title,
    description: payload.description,
    parent_id: payload.parent_id ?? null,
    body,
  };
}

function titleBehavior(testCase) {
  const text = [
    testCase.title,
    testCase.description,
    ...(Array.isArray(testCase.tags) ? testCase.tags : []),
  ].join(" ").toLowerCase();
  if (/\bnegative\b|\binvalid\b|\bcannot\b|\bcan't\b|\bblocked\b|\bmissing\b|\brequired\b|\bunauthorized\b|\bforbidden\b|\bdenied\b|\bempty\b/.test(text)) {
    return "negative";
  }
  if (/\bpositive\b|\bvalid\b|\bsuccess\b|\bsuccessfully\b/.test(text)) {
    return "positive";
  }
  return "";
}

function normalizeCaseTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/\[(positive|negative)\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(a|an|and|are|be|case|check|for|from|in|is|of|on|or|should|test|the|to|user|verify|when|with|without)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleTokens(title) {
  return new Set(normalizeCaseTitle(title).split(" ").filter((token) => token.length > 2));
}

function titleSimilarity(left, right) {
  const leftTokens = titleTokens(left);
  const rightTokens = titleTokens(right);
  if (!leftTokens.size || !rightTokens.size) {
    return 0;
  }
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union ? intersection / union : 0;
}

function compareCaseTitles(left, right) {
  const leftTitle = normalizeCaseTitle(left.title);
  const rightTitle = normalizeCaseTitle(right.title);
  if (!leftTitle || !rightTitle) {
    return null;
  }

  const leftBehavior = titleBehavior(left);
  const rightBehavior = titleBehavior(right);
  const compatibleBehavior = !leftBehavior || !rightBehavior || leftBehavior === rightBehavior;
  if (!compatibleBehavior) {
    return null;
  }

  if (leftTitle === rightTitle) {
    return { score: 1, reason: "same normalized title" };
  }
  if (leftTitle.length >= 20 && rightTitle.length >= 20 && (leftTitle.includes(rightTitle) || rightTitle.includes(leftTitle))) {
    return { score: 0.92, reason: "one title contains the other" };
  }

  const similarity = titleSimilarity(left.title, right.title);
  if (similarity >= 0.68) {
    return { score: Number(similarity.toFixed(2)), reason: "very similar title tokens" };
  }

  return null;
}

async function listQaseCases(suiteId, { projectWide = false } = {}) {
  const token = requireEnv("QASE_API_TOKEN");
  const projectCode = requireEnv("QASE_PROJECT_CODE");
  const resolvedSuiteId = resolveSuiteId(suiteId);
  const limit = 100;
  let offset = 0;
  let total = Infinity;
  const allCases = [];

  while (offset < total) {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    if (!projectWide) {
      params.set("suite_id", String(resolvedSuiteId));
    }
    const response = await fetch(`https://api.qase.io/v1/case/${projectCode}?${params.toString()}`, {
      method: "GET",
      headers: qaseHeaders(token),
    });

    const text = await response.text();
    const body = parseQaseJson(text);
    if (!response.ok) {
      throw new Error(qaseError(body, text, response.status));
    }

    const pageCases = extractQaseCases(body);
    allCases.push(...pageCases);

    const result = body.result || {};
    total = Number(result.filtered ?? result.total ?? allCases.length);
    const count = Number(result.count ?? pageCases.length);
    if (!count || pageCases.length === 0) {
      break;
    }
    offset += count;
  }

  return allCases;
}

async function findQaseDuplicates(cases, suiteId, { projectWide = true } = {}) {
  const projectCode = requireEnv("QASE_PROJECT_CODE");
  const resolvedSuiteId = resolveSuiteId(suiteId);
  const generatedDuplicates = [];
  const existingDuplicates = [];
  const existingCases = await listQaseCases(resolvedSuiteId, { projectWide });

  for (let index = 0; index < cases.length; index += 1) {
    for (let nextIndex = index + 1; nextIndex < cases.length; nextIndex += 1) {
      const match = compareCaseTitles(cases[index], cases[nextIndex]);
      if (match) {
        generatedDuplicates.push({
          index,
          nextIndex,
          title: cases[index].title || "",
          duplicateTitle: cases[nextIndex].title || "",
          ...match,
        });
      }
    }
  }

  for (let index = 0; index < cases.length; index += 1) {
    for (const existingCase of existingCases) {
      const match = compareCaseTitles(cases[index], existingCase);
      if (match) {
        const caseSuiteId = existingCase.suite_id || resolvedSuiteId;
        existingDuplicates.push({
          index,
          title: cases[index].title || "",
          existingId: existingCase.id,
          existingTitle: existingCase.title,
          url: `https://app.qase.io/project/${projectCode}?suite=${caseSuiteId}&case=${existingCase.id}`,
          ...match,
        });
      }
    }
  }

  return {
    suiteId: resolvedSuiteId,
    checkedScope: projectWide ? "project" : "selected suite",
    checkedExistingCount: existingCases.length,
    generatedDuplicates,
    existingDuplicates,
  };
}

function duplicateTotal(duplicates) {
  return (duplicates?.generatedDuplicates || []).length + (duplicates?.existingDuplicates || []).length;
}

function parseClickUpTaskId(input) {
  const value = String(input || "").trim();
  if (!value) {
    throw new Error("ClickUp task URL or ID is empty.");
  }

  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.includes("v") && parts.includes("dc") && !parts.includes("t") && !parts.includes("task")) {
      throw new Error("This looks like a ClickUp view URL, not a direct task link. Open the task and use Copy link from the task menu; the URL should include /t/ or /task/.");
    }

    const taskSegmentIndex = parts.findIndex((part) => part === "t" || part === "task");
    if (taskSegmentIndex >= 0 && parts[taskSegmentIndex + 1]) {
      return decodeURIComponent(parts[taskSegmentIndex + 1]);
    }
    if (parts.length) {
      return decodeURIComponent(parts[parts.length - 1]);
    }
  } catch (error) {
    if (error.message.includes("ClickUp view URL")) {
      throw error;
    }
    // Plain task ID.
  }

  return value;
}

function splitClickUpTaskInputs(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    throw new Error("ClickUp task URL or ID is empty.");
  }

  const directUrls = raw.match(/https?:\/\/[^\s,;]+/g) || [];
  const withoutUrls = directUrls.reduce((text, url) => text.replace(url, "\n"), raw);
  const ids = withoutUrls
    .replace(/[,;]+/g, "\n")
    .split(/\s+/)
    .map((item) => item.trim().replace(/[.,;]+$/g, ""))
    .filter(Boolean);
  const values = [...directUrls.map((url) => url.replace(/[.,;]+$/g, "")), ...ids];
  const unique = Array.from(new Set(values));

  if (unique.length > 10) {
    throw new Error("Load up to 10 ClickUp tasks at once.");
  }
  return unique;
}

async function fetchClickUpTeamId(token) {
  const response = await fetch("https://api.clickup.com/api/v2/team", {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: token,
    },
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    const detail = body.err || body.error || body.raw || text || `ClickUp status ${response.status}`;
    throw new Error(`Could not auto-detect ClickUp workspace ID: ${detail}`);
  }

  const teams = Array.isArray(body.teams) ? body.teams : [];
  if (teams.length === 1) {
    return teams[0].id;
  }

  if (teams.length > 1) {
    const options = teams.map((team) => `${team.name || "Workspace"}=${team.id}`).join(", ");
    throw new Error(`Multiple ClickUp workspaces found. Add CLICKUP_TEAM_ID to .env. Options: ${options}`);
  }

  throw new Error("No ClickUp workspaces found for this token.");
}

async function clickUpQuery(taskId, token) {
  const params = new URLSearchParams({
    include_markdown_description: "true",
    include_subtasks: "true",
  });

  if (taskId.includes("-")) {
    const teamId = env("CLICKUP_TEAM_ID") || await fetchClickUpTeamId(token);
    params.set("custom_task_ids", "true");
    params.set("team_id", teamId);
  }

  return params;
}

function stringifyClickUpValue(value) {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map(stringifyClickUpValue).filter(Boolean).join(", ");
  }
  if (typeof value === "object") {
    return value.name || value.label || value.username || value.email || JSON.stringify(value);
  }
  return String(value);
}

function formatClickUpTaskRequirements(task) {
  const lines = [
    `ClickUp Task: ${task.name || "Untitled task"}`,
    task.url ? `URL: ${task.url}` : "",
    task.status?.status ? `Status: ${task.status.status}` : "",
    task.list?.name ? `List: ${task.list.name}` : "",
    "",
    "Description:",
    task.markdown_description || task.description || task.text_content || "No description.",
  ].filter((line) => line !== "");

  const customFields = (task.custom_fields || [])
    .map((field) => {
      const value = stringifyClickUpValue(field.value);
      return value ? `${field.name}: ${value}` : "";
    })
    .filter(Boolean);

  if (customFields.length) {
    lines.push("", "Custom fields:", ...customFields);
  }

  return lines.join("\n");
}

async function fetchClickUpTask(taskInput) {
  const token = requireEnv("CLICKUP_API_TOKEN");
  const taskId = parseClickUpTaskId(taskInput);
  const params = await clickUpQuery(taskId, token);
  const url = `https://api.clickup.com/api/v2/task/${encodeURIComponent(taskId)}?${params.toString()}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: token,
    },
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    const detail = body.err || body.error || body.raw || text || `ClickUp status ${response.status}`;
    if (String(detail).includes("Team not authorized") || String(body.ECODE).includes("OAUTH_027")) {
      throw new Error("ClickUp API cannot access this task. The token is valid, but this task is not available to the token user/workspace. Check task permissions or paste the requirements manually.");
    }
    throw new Error(detail);
  }

  return {
    taskId: body.id || taskId,
    taskUrl: body.url || "",
    title: body.name || "",
    requirements: formatClickUpTaskRequirements(body),
  };
}

async function fetchClickUpTasks(taskInput) {
  const inputs = splitClickUpTaskInputs(taskInput);
  const tasks = [];
  for (const input of inputs) {
    tasks.push(await fetchClickUpTask(input));
  }

  if (tasks.length === 1) {
    return {
      ...tasks[0],
      taskIds: [tasks[0].taskId],
      tasks,
    };
  }

  const requirements = [
    `ClickUp Tasks Loaded: ${tasks.length}`,
    "",
    ...tasks.map((task, index) => [
      `--- Task ${index + 1} of ${tasks.length} ---`,
      task.requirements,
    ].join("\n")),
  ].join("\n");

  return {
    taskId: tasks[0]?.taskId || "",
    taskIds: tasks.map((task) => task.taskId).filter(Boolean),
    taskUrl: tasks[0]?.taskUrl || "",
    title: `${tasks.length} ClickUp tasks`,
    requirements,
    tasks,
  };
}

async function generateCases(requirements) {
  const openAiKey = requireEnv("OPENAI_API_KEY");
  const model = env("OPENAI_MODEL", "gpt-4o-mini");

  const payload = {
    model,
    input: [
      {
        role: "system",
        content: [
          "You are a senior QA engineer.",
          "Create concise manual test cases for Qase.io.",
          "Prefer clear user-facing steps and observable expected results.",
          "Cover all functionality described in the task, not only the main happy path.",
          "Before writing cases, account for every feature, acceptance criterion, UI state, validation rule, permission rule, integration, API behavior, analytics event, and edge case explicitly mentioned in the requirements.",
          "Do not omit described functionality; if the task is large, group closely related checks while preserving full coverage.",
          "Do not generate only happy-path tests.",
          "For every feature or acceptance criterion, generate both positive and negative test cases.",
          "Keep positive and negative checks as separate test cases; prefix titles with [Positive] or [Negative] and add a matching positive or negative tag.",
          "Negative cases must describe the expected safe or validation behavior, not just say \"error appears\".",
          "If exact validation copy is not specified, describe the safe product behavior: invalid data is not saved, blocked actions do not change state, and the user can correct the problem.",
          "Use priority 1 for high, 2 for medium, 3 for low.",
          "Use severity 1 for blocker/critical, 2 for major, 3 for minor.",
          "Return only data that fits the JSON schema.",
        ].join(" "),
      },
      {
        role: "user",
        content: `Generate Qase test cases from these requirements:\n\n${requirements}`,
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "qase_test_cases",
        schema: qaseCaseSchema,
        strict: true,
      },
    },
    max_output_tokens: 12000,
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    const detail = body.error?.message || body.raw || text || `OpenAI status ${response.status}`;
    throw new Error(detail);
  }

  const outputText = extractOutputText(body);
  if (!outputText) {
    throw new Error("OpenAI response did not include output text.");
  }

  const parsed = JSON.parse(outputText);
  return normalizeGeneratedCases(parsed.cases || []);
}

async function suggestQaseSuite(requirements, suites) {
  const openAiKey = requireEnv("OPENAI_API_KEY");
  const model = env("OPENAI_MODEL", "gpt-4o-mini");
  const existingSuites = suites
    .slice(0, 80)
    .map((suite) => `${suite.id}: ${suite.title}`)
    .join("\n");

  const payload = {
    model,
    input: [
      {
        role: "system",
        content: [
          "You are a QA lead organizing Qase test suites.",
          "Suggest one concise suite title for the provided requirement.",
          "Prefer an existing product area name when it is obvious.",
          "Avoid duplicate names when existing suites already cover the exact area.",
          "Return only data that fits the JSON schema.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          "Existing suites:",
          existingSuites || "No suites provided.",
          "",
          "Requirement:",
          requirements,
        ].join("\n"),
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "qase_suite_suggestion",
        schema: suiteSuggestionSchema,
        strict: true,
      },
    },
    max_output_tokens: 800,
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  const body = parseQaseJson(text);
  if (!response.ok) {
    const detail = body.error?.message || body.raw || text || `OpenAI status ${response.status}`;
    throw new Error(detail);
  }

  const outputText = extractOutputText(body);
  if (!outputText) {
    throw new Error("OpenAI response did not include output text.");
  }

  return JSON.parse(outputText);
}

async function createQaseCases(cases, suiteId) {
  const token = requireEnv("QASE_API_TOKEN");
  const projectCode = requireEnv("QASE_PROJECT_CODE");
  const resolvedSuiteId = resolveSuiteId(suiteId);
  const normalized = normalizeCases(cases, resolvedSuiteId);
  const url = `https://api.qase.io/v1/case/${projectCode}/bulk`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Token: token,
    },
    body: JSON.stringify({ cases: normalized }),
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    const detail = body.errorMessage || body.error?.message || body.raw || text || `Qase status ${response.status}`;
    throw new Error(detail);
  }

  const result = body.result;
  const ids = Array.isArray(result) ? result : Array.isArray(result?.ids) ? result.ids : [];
  const urls = ids.map((id) => `https://app.qase.io/project/${projectCode}?suite=${resolvedSuiteId}&case=${id}`);
  return { body, urls, suiteId: resolvedSuiteId };
}

async function createClickUpComment(taskId, qaseUrls, caseCount) {
  const token = requireEnv("CLICKUP_API_TOKEN");
  const url = `https://api.clickup.com/api/v2/task/${encodeURIComponent(taskId)}/comment`;
  const links = qaseUrls.length ? qaseUrls.map((qaseUrl) => `- ${qaseUrl}`).join("\n") : `Created ${caseCount} Qase case(s).`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: token,
    },
    body: JSON.stringify({
      comment_text: `Created Qase test cases:\n${links}`,
      notify_all: false,
    }),
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    const detail = body.err || body.error || body.raw || text || `ClickUp status ${response.status}`;
    throw new Error(detail);
  }

  return body;
}

async function handleRequest(request, response) {
  try {
    loadEnv(envPath, true);
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (request.method === "GET" && url.pathname === "/") {
      sendHtml(response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/config") {
      sendJson(response, 200, {
        projectCode: env("QASE_PROJECT_CODE"),
        suiteId: env("QASE_SUITE_ID"),
        model: env("OPENAI_MODEL", "gpt-4o-mini"),
        hasOpenAiKey: Boolean(env("OPENAI_API_KEY")),
        hasQaseToken: Boolean(env("QASE_API_TOKEN")),
        hasClickUpToken: Boolean(env("CLICKUP_API_TOKEN")),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/qase/suites") {
      const suites = await listQaseSuites(url.searchParams.get("search") || "");
      sendJson(response, 200, { suites });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/qase/suite") {
      const { title, description, parentId } = await readJson(request);
      const suite = await createQaseSuite({ title, description, parentId });
      sendJson(response, 200, { suite });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/qase/suite/suggest") {
      const { requirements } = await readJson(request);
      if (!requirements || !String(requirements).trim()) {
        sendJson(response, 400, { error: "Requirements are empty." });
        return;
      }
      const suites = await listQaseSuites();
      const suggestion = await suggestQaseSuite(String(requirements), suites);
      sendJson(response, 200, { suggestion });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/clickup/task") {
      const { taskInput } = await readJson(request);
      const task = await fetchClickUpTasks(taskInput);
      sendJson(response, 200, task);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/generate") {
      const { requirements } = await readJson(request);
      if (!requirements || !String(requirements).trim()) {
        sendJson(response, 400, { error: "Requirements are empty." });
        return;
      }
      const cases = await generateCases(String(requirements));
      sendJson(response, 200, { cases });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/qase/duplicates") {
      const { cases, suiteId } = await readJson(request);
      if (!Array.isArray(cases) || cases.length === 0) {
        sendJson(response, 400, { error: "No cases selected." });
        return;
      }
      const duplicates = await findQaseDuplicates(cases, suiteId, { projectWide: true });
      sendJson(response, 200, duplicates);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/create") {
      const { cases, suiteId, clickupTaskId, clickupTaskIds, commentToClickUp, allowDuplicates } = await readJson(request);
      if (!Array.isArray(cases) || cases.length === 0) {
        sendJson(response, 400, { error: "No cases selected." });
        return;
      }
      const duplicates = await findQaseDuplicates(cases, suiteId, { projectWide: true });
      if (!allowDuplicates && duplicateTotal(duplicates)) {
        sendJson(response, 409, {
          error: `Potential duplicates found: ${duplicateTotal(duplicates)}. Review them or click Create anyway.`,
          duplicates,
        });
        return;
      }
      const result = await createQaseCases(cases, suiteId);
      const taskIds = Array.isArray(clickupTaskIds) && clickupTaskIds.length ? clickupTaskIds : clickupTaskId ? [clickupTaskId] : [];
      if (commentToClickUp && taskIds.length) {
        result.clickupComments = [];
        result.clickupCommentErrors = [];
        for (const taskId of taskIds) {
          try {
            result.clickupComments.push({ taskId, body: await createClickUpComment(taskId, result.urls || [], cases.length) });
          } catch (error) {
            result.clickupCommentErrors.push({ taskId, error: error.message });
          }
        }
        if (result.clickupCommentErrors.length) {
          result.clickupCommentError = result.clickupCommentErrors.map((item) => `${item.taskId}: ${item.error}`).join("; ");
        }
      }
      sendJson(response, 200, result);
      return;
    }

    sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
}

const html = fs.readFileSync(path.join(scriptDir, "qase_review_app.html"), "utf8");

/*
const html = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Qase Review App</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f6f8;
      --surface: #ffffff;
      --surface-2: #eef2f5;
      --border: #d6dde5;
      --text: #18212f;
      --muted: #657184;
      --blue: #2563eb;
      --blue-dark: #1d4ed8;
      --green: #0f8a5f;
      --red: #b42318;
      --shadow: 0 1px 2px rgba(16, 24, 40, 0.08);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      letter-spacing: 0;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-height: 64px;
      padding: 0 24px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
    }

    h1 {
      margin: 0;
      font-size: 18px;
      font-weight: 650;
    }

    main {
      display: grid;
      grid-template-columns: minmax(320px, 420px) minmax(0, 1fr);
      gap: 16px;
      padding: 16px;
      height: calc(100vh - 64px);
    }

    section {
      min-height: 0;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }

    .input-pane,
    .review-pane {
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .pane-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
      background: #fbfcfd;
    }

    .pane-head h2 {
      margin: 0;
      font-size: 14px;
      font-weight: 650;
    }

    .meta {
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }

    textarea,
    input {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: #fff;
      color: var(--text);
      font: inherit;
      font-size: 13px;
      line-height: 1.45;
      padding: 9px 10px;
      resize: vertical;
    }

    textarea:focus,
    input:focus {
      outline: 2px solid rgba(37, 99, 235, 0.22);
      border-color: var(--blue);
    }

    .requirements {
      flex: 1;
      min-height: 360px;
      border: 0;
      border-radius: 0;
      padding: 14px;
      resize: none;
    }

    .toolbar,
    .case-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      min-height: 34px;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 0 12px;
      background: #fff;
      color: var(--text);
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }

    button:hover {
      background: var(--surface-2);
    }

    button.primary {
      border-color: var(--blue);
      background: var(--blue);
      color: #fff;
    }

    button.primary:hover {
      background: var(--blue-dark);
    }

    button.danger {
      color: var(--red);
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }

    .status {
      min-height: 32px;
      padding: 9px 14px;
      border-top: 1px solid var(--border);
      color: var(--muted);
      font-size: 13px;
    }

    .status.ok {
      color: var(--green);
    }

    .status.error {
      color: var(--red);
    }

    .cases {
      flex: 1;
      overflow: auto;
      padding: 12px;
    }

    .empty {
      display: grid;
      place-items: center;
      height: 100%;
      min-height: 260px;
      border: 1px dashed var(--border);
      border-radius: 8px;
      color: var(--muted);
      font-size: 13px;
    }

    .case {
      display: grid;
      gap: 10px;
      padding: 12px;
      margin-bottom: 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #fff;
    }

    .case-top {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 10px;
    }

    .case-index {
      width: 28px;
      height: 28px;
      display: grid;
      place-items: center;
      border-radius: 6px;
      background: var(--surface-2);
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }

    .fields {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .field.full {
      grid-column: 1 / -1;
    }

    label {
      display: grid;
      gap: 5px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
    }

    .steps {
      display: grid;
      gap: 8px;
    }

    .step {
      display: grid;
      grid-template-columns: 32px minmax(0, 1fr) minmax(0, 1fr) 42px;
      gap: 8px;
      align-items: start;
    }

    .step-num {
      width: 32px;
      height: 32px;
      display: grid;
      place-items: center;
      border-radius: 6px;
      background: var(--surface-2);
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }

    .links {
      display: grid;
      gap: 4px;
      margin-top: 8px;
    }

    a {
      color: var(--blue);
      text-decoration: none;
      font-size: 13px;
      font-weight: 600;
    }

    a:hover {
      text-decoration: underline;
    }

    @media (max-width: 900px) {
      main {
        grid-template-columns: 1fr;
        height: auto;
      }

      .requirements {
        min-height: 300px;
      }

      .fields,
      .step {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <header>
    <h1>Qase Review App</h1>
    <div class="meta" id="configMeta">Loading...</div>
  </header>
  <main>
    <section class="input-pane">
      <div class="pane-head">
        <h2>Requirements</h2>
        <div class="toolbar">
          <button id="sampleBtn" title="Insert sample">Sample</button>
          <button id="generateBtn" class="primary" title="Generate test cases">Generate</button>
        </div>
      </div>
      <textarea id="requirements" class="requirements" spellcheck="true"></textarea>
      <div class="status" id="status">Ready.</div>
    </section>

    <section class="review-pane">
      <div class="pane-head">
        <h2>Review</h2>
        <div class="toolbar">
          <button id="addCaseBtn" title="Add case">Add</button>
          <button id="createBtn" class="primary" title="Create selected cases in Qase" disabled>Create in Qase</button>
        </div>
      </div>
      <div id="cases" class="cases">
        <div class="empty">Generated cases will appear here.</div>
      </div>
    </section>
  </main>

  <script>
    const requirementsEl = document.querySelector("#requirements");
    const generateBtn = document.querySelector("#generateBtn");
    const createBtn = document.querySelector("#createBtn");
    const addCaseBtn = document.querySelector("#addCaseBtn");
    const sampleBtn = document.querySelector("#sampleBtn");
    const casesEl = document.querySelector("#cases");
    const statusEl = document.querySelector("#status");
    const configMetaEl = document.querySelector("#configMeta");

    let cases = [];

    const sample = `Title:
chat_feedback_tell_us_more Mixpanel event is sent when Tell us more popup is opened

Description:
Verify that the chat_feedback_tell_us_more event is sent when the detailed feedback popup is opened.

Steps:
1. Open any chat.
2. Click thumbs up or thumbs down.
3. Open Mixpanel debugger.
4. Click "Tell us more".

Expected Result:
chat_feedback_tell_us_more event is sent with correct chat_id and message_id.`;

    function setStatus(message, type = "") {
      statusEl.textContent = message;
      statusEl.className = `status ${type}`.trim();
    }

    async function api(path, body) {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || `Request failed: ${response.status}`);
      }
      return data;
    }

    function newCase() {
      return {
        title: "",
        description: "",
        preconditions: "",
        priority: 2,
        severity: 2,
        steps_type: "classic",
        steps: [{ action: "", expected_result: "", data: "" }],
        tags: ["ai-generated"],
      };
    }

    function updateCase(index, patch) {
      cases[index] = { ...cases[index], ...patch };
      renderCases();
    }

    function updateStep(caseIndex, stepIndex, patch) {
      cases[caseIndex].steps[stepIndex] = { ...cases[caseIndex].steps[stepIndex], ...patch };
      renderCases();
    }

    function renderCases() {
      createBtn.disabled = cases.length === 0;

      if (!cases.length) {
        casesEl.innerHTML = '<div class="empty">Generated cases will appear here.</div>';
        return;
      }

      casesEl.innerHTML = cases.map((testCase, index) => `
        <article class="case">
          <div class="case-top">
            <div class="case-index">${index + 1}</div>
            <input value="${escapeHtml(testCase.title)}" data-case="${index}" data-field="title" placeholder="Title" />
            <div class="case-actions">
              <button title="Add step" data-add-step="${index}">Step</button>
              <button class="danger" title="Remove case" data-remove-case="${index}">Remove</button>
            </div>
          </div>
          <div class="fields">
            <label class="full">Description
              <textarea rows="3" data-case="${index}" data-field="description">${escapeHtml(testCase.description)}</textarea>
            </label>
            <label class="full">Preconditions
              <textarea rows="2" data-case="${index}" data-field="preconditions">${escapeHtml(testCase.preconditions)}</textarea>
            </label>
            <label>Priority
              <input type="number" min="1" max="3" value="${Number(testCase.priority || 2)}" data-case="${index}" data-field="priority" />
            </label>
            <label>Severity
              <input type="number" min="1" max="3" value="${Number(testCase.severity || 2)}" data-case="${index}" data-field="severity" />
            </label>
            <label class="full">Tags
              <input value="${escapeHtml((testCase.tags || []).join(", "))}" data-case="${index}" data-field="tags" />
            </label>
          </div>
          <div class="steps">
            ${(testCase.steps || []).map((step, stepIndex) => `
              <div class="step">
                <div class="step-num">${stepIndex + 1}</div>
                <textarea rows="2" data-case="${index}" data-step="${stepIndex}" data-step-field="action" placeholder="Action">${escapeHtml(step.action)}</textarea>
                <textarea rows="2" data-case="${index}" data-step="${stepIndex}" data-step-field="expected_result" placeholder="Expected result">${escapeHtml(step.expected_result)}</textarea>
                <button class="danger" title="Remove step" data-remove-step="${index}:${stepIndex}">X</button>
              </div>
            `).join("")}
          </div>
        </article>
      `).join("");
    }

    function escapeHtml(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    }

    casesEl.addEventListener("input", (event) => {
      const target = event.target;
      const caseIndex = Number(target.dataset.case);

      if (target.dataset.field) {
        const field = target.dataset.field;
        let value = target.value;
        if (field === "priority" || field === "severity") {
          value = Number(value || 2);
        }
        if (field === "tags") {
          value = target.value.split(",").map((tag) => tag.trim()).filter(Boolean);
        }
        cases[caseIndex][field] = value;
      }

      if (target.dataset.stepField) {
        const stepIndex = Number(target.dataset.step);
        cases[caseIndex].steps[stepIndex][target.dataset.stepField] = target.value;
      }
    });

    casesEl.addEventListener("click", (event) => {
      const target = event.target;
      if (target.dataset.removeCase) {
        cases.splice(Number(target.dataset.removeCase), 1);
        renderCases();
      }
      if (target.dataset.addStep) {
        cases[Number(target.dataset.addStep)].steps.push({ action: "", expected_result: "", data: "" });
        renderCases();
      }
      if (target.dataset.removeStep) {
        const [caseIndex, stepIndex] = target.dataset.removeStep.split(":").map(Number);
        cases[caseIndex].steps.splice(stepIndex, 1);
        if (!cases[caseIndex].steps.length) {
          cases[caseIndex].steps.push({ action: "", expected_result: "", data: "" });
        }
        renderCases();
      }
    });

    sampleBtn.addEventListener("click", () => {
      requirementsEl.value = sample;
    });

    addCaseBtn.addEventListener("click", () => {
      cases.push(newCase());
      renderCases();
    });

    generateBtn.addEventListener("click", async () => {
      try {
        generateBtn.disabled = true;
        setStatus("Generating...");
        const data = await api("/api/generate", { requirements: requirementsEl.value });
        cases = data.cases || [];
        renderCases();
        setStatus(`Generated ${cases.length} case(s).`, "ok");
      } catch (error) {
        setStatus(error.message, "error");
      } finally {
        generateBtn.disabled = false;
      }
    });

    createBtn.addEventListener("click", async () => {
      try {
        createBtn.disabled = true;
        setStatus("Creating in Qase...");
        const data = await api("/api/create", { cases });
        const urls = data.urls || [];
        const links = urls.map((url) => `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a>`).join("");
        setStatus(`Created ${urls.length || cases.length} case(s).`, "ok");
        casesEl.insertAdjacentHTML("beforeend", `<div class="links">${links}</div>`);
      } catch (error) {
        setStatus(error.message, "error");
      } finally {
        createBtn.disabled = cases.length === 0;
      }
    });

    fetch("/api/config")
      .then((response) => response.json())
      .then((config) => {
        configMetaEl.textContent = `${config.projectCode || "Qase"} / suite ${config.suiteId || "-"} / ${config.model}`;
        if (!config.hasOpenAiKey) {
          setStatus("Add OPENAI_API_KEY to outputs/.env.", "error");
        }
      })
      .catch(() => {
        configMetaEl.textContent = "Config unavailable";
      });
  </script>
</body>
</html>`;

*/

const server = http.createServer(handleRequest);

server.listen(port, "127.0.0.1", () => {
  console.log(`Qase review app: http://localhost:${port}`);
  console.log(`Env file: ${envPath}`);
});
