#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";

const require = createRequire(import.meta.url);
const { simpleParser } = require("mailparser");
const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_SCRIPT_PATH = path.join(CURRENT_DIR, "bridge", "email_bridge.py");
const DEFAULT_STATE_DIR = path.join(os.homedir(), ".codex", "email-bridge", "mcp-state");
const DEFAULT_MAP_PATH = path.join(DEFAULT_STATE_DIR, "thread-map.json");
const DEFAULT_EMAIL_ENV_FILE = path.join(os.homedir(), ".codex", "email-bridge", ".env");

const SERVER_NAME = "email-mcp";
const SERVER_VERSION = "0.1.0";

const PYTHON_BIN = process.env.EMAIL_MCP_PYTHON || "python3";
const BRIDGE_SCRIPT = process.env.EMAIL_MCP_BRIDGE_SCRIPT || DEFAULT_SCRIPT_PATH;
const MCP_STATE_DIR = process.env.EMAIL_MCP_STATE_DIR || DEFAULT_STATE_DIR;
const MCP_MAP_PATH = process.env.EMAIL_MCP_MAP_FILE || DEFAULT_MAP_PATH;
const LOCAL_EMAIL_ENV = loadSimpleEnvFile(DEFAULT_EMAIL_ENV_FILE);
const DEFAULT_TO =
  (process.env.EMAIL_MCP_DEFAULT_TO || process.env.CODEX_EMAIL_TO || LOCAL_EMAIL_ENV.CODEX_EMAIL_TO || "").trim();
const PROCESS_FALLBACK_SESSION_KEY =
  (process.env.EMAIL_MCP_PROCESS_SESSION_KEY || "").trim() ||
  `proc-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
const BRIDGE_STATE_DIR = path.resolve(
  process.env.CODEX_EMAIL_STATE_DIR ||
    LOCAL_EMAIL_ENV.CODEX_EMAIL_STATE_DIR ||
    path.join(os.homedir(), ".codex", "email-bridge", "state"),
);

const IMAP_HOST = (process.env.CODEX_EMAIL_IMAP_HOST || LOCAL_EMAIL_ENV.CODEX_EMAIL_IMAP_HOST || "imap.gmail.com").trim();
const IMAP_PORT = Number(process.env.CODEX_EMAIL_IMAP_PORT || LOCAL_EMAIL_ENV.CODEX_EMAIL_IMAP_PORT || "993");
const IMAP_MAILBOX = (process.env.CODEX_EMAIL_IMAP_MAILBOX || LOCAL_EMAIL_ENV.CODEX_EMAIL_IMAP_MAILBOX || "INBOX").trim() || "INBOX";
const IMAP_USER = (
  process.env.CODEX_EMAIL_USERNAME ||
  LOCAL_EMAIL_ENV.CODEX_EMAIL_USERNAME ||
  process.env.CODEX_EMAIL_ADDRESS ||
  LOCAL_EMAIL_ENV.CODEX_EMAIL_ADDRESS ||
  ""
).trim();
const IMAP_PASSWORD = (process.env.CODEX_EMAIL_PASSWORD || LOCAL_EMAIL_ENV.CODEX_EMAIL_PASSWORD || "").trim();
const SMTP_HOST = (process.env.CODEX_EMAIL_SMTP_HOST || LOCAL_EMAIL_ENV.CODEX_EMAIL_SMTP_HOST || "smtp.gmail.com").trim();
const SMTP_PORT = Number(process.env.CODEX_EMAIL_SMTP_PORT || LOCAL_EMAIL_ENV.CODEX_EMAIL_SMTP_PORT || "465");
const SMTP_STARTTLS =
  String(process.env.CODEX_EMAIL_SMTP_STARTTLS || LOCAL_EMAIL_ENV.CODEX_EMAIL_SMTP_STARTTLS || "false")
    .trim()
    .toLowerCase() === "true";
const SMTP_ADDRESS = (process.env.CODEX_EMAIL_ADDRESS || LOCAL_EMAIL_ENV.CODEX_EMAIL_ADDRESS || "").trim();
const SMTP_USER = (
  process.env.CODEX_EMAIL_USERNAME ||
  LOCAL_EMAIL_ENV.CODEX_EMAIL_USERNAME ||
  SMTP_ADDRESS ||
  ""
).trim();
const SMTP_PASSWORD = (process.env.CODEX_EMAIL_PASSWORD || LOCAL_EMAIL_ENV.CODEX_EMAIL_PASSWORD || "").trim();
const PREWARM_ENABLED =
  String(process.env.EMAIL_MCP_PREWARM || "true")
    .trim()
    .toLowerCase() !== "false";

const TOOL_DEFS = [
  {
    name: "email_update",
    description: "Send a progress update email in the session's single Gmail thread.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Update body text to send." },
        subject: { type: "string", description: "Human readable subject. Default: Codex update" },
        to: { type: "string", description: "Recipient email. Optional when CODEX_EMAIL_TO is set." },
        context_id: {
          type: "string",
          description:
            "Optional explicit mapping key; otherwise uses CODEX_THREAD_ID/CODEX_SESSION_ID, then a process-scoped fallback.",
        },
      },
      required: ["message"],
      additionalProperties: false,
    },
  },
  {
    name: "email_ask",
    description:
      "Send a question in the session's thread and block until a new reply arrives (or timeout).",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Question body text." },
        subject: { type: "string", description: "Human readable subject. Default: Codex question" },
        to: { type: "string", description: "Recipient email. Optional when CODEX_EMAIL_TO is set." },
        poll_seconds: { type: "integer", minimum: 1, description: "Polling interval. Default 5." },
        timeout_seconds: {
          type: "integer",
          minimum: 0,
          description: "Wait timeout in seconds. 0 waits forever. Default 120.",
        },
        context_id: {
          type: "string",
          description:
            "Optional explicit mapping key; otherwise uses CODEX_THREAD_ID/CODEX_SESSION_ID, then a process-scoped fallback.",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
  {
    name: "email_fetch_response",
    description:
      "Fetch replies from the same mapped thread without sending a new message. Use for non-blocking polling.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max replies to return. Default 10." },
        advance: {
          type: "boolean",
          description: "Whether to advance cursor. true returns only unseen next time. Default true.",
        },
        context_id: {
          type: "string",
          description:
            "Optional explicit mapping key; otherwise uses CODEX_THREAD_ID/CODEX_SESSION_ID, then a process-scoped fallback.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "email_watch_response",
    description:
      "Wait for the next reply on the same mapped thread without sending a new message. Use for watcher agents.",
    inputSchema: {
      type: "object",
      properties: {
        poll_seconds: { type: "integer", minimum: 1, description: "Fallback polling interval. Default 30." },
        timeout_seconds: {
          type: "integer",
          minimum: 0,
          description: "Watch timeout in seconds. 0 waits forever. Default 0.",
        },
        context_id: {
          type: "string",
          description:
            "Optional explicit mapping key; otherwise uses CODEX_THREAD_ID/CODEX_SESSION_ID, then a process-scoped fallback.",
        },
      },
      additionalProperties: false,
    },
  },
];

let imapClient = null;
let imapConnectPromise = null;
let smtpTransport = null;
let smtpConnectPromise = null;
let prewarmPromise = null;

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function loadSimpleEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }
  const output = {};
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const idx = trimmed.indexOf("=");
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) {
      output[key] = value;
    }
  }
  return output;
}

function nowIso() {
  return new Date().toISOString();
}

function ensureDirectories() {
  mkdirSync(MCP_STATE_DIR, { recursive: true });
  mkdirSync(BRIDGE_STATE_DIR, { recursive: true });
}

function loadThreadMap() {
  ensureDirectories();
  if (!existsSync(MCP_MAP_PATH)) {
    return { version: 1, threads: {} };
  }
  const payload = safeJsonParse(readFileSync(MCP_MAP_PATH, "utf8"), null);
  if (!payload || typeof payload !== "object") {
    return { version: 1, threads: {} };
  }
  if (!payload.threads || typeof payload.threads !== "object") {
    payload.threads = {};
  }
  return payload;
}

function saveThreadMap(map) {
  ensureDirectories();
  writeFileSync(MCP_MAP_PATH, JSON.stringify(map, null, 2), "utf8");
}

function threadMarker(threadId) {
  return `[codex-thread:${threadId}]`;
}

function statePath(threadId) {
  return path.join(BRIDGE_STATE_DIR, `${threadId}.json`);
}

function loadBridgeState(threadId) {
  const fallback = {
    thread_id: threadId,
    to: "",
    subject: "",
    marker: threadMarker(threadId),
    last_seen_uid: 0,
    known_message_ids: [],
    last_message_id: "",
  };
  const filePath = statePath(threadId);
  if (!existsSync(filePath)) {
    return fallback;
  }
  const payload = safeJsonParse(readFileSync(filePath, "utf8"), null);
  if (!payload || typeof payload !== "object") {
    return fallback;
  }
  return {
    thread_id: String(payload.thread_id || threadId),
    to: String(payload.to || ""),
    subject: String(payload.subject || ""),
    marker: String(payload.marker || threadMarker(threadId)),
    last_seen_uid: Number(payload.last_seen_uid || 0) || 0,
    known_message_ids: Array.isArray(payload.known_message_ids)
      ? payload.known_message_ids.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
    last_message_id: String(payload.last_message_id || ""),
  };
}

function saveBridgeState(state) {
  ensureDirectories();
  writeFileSync(statePath(state.thread_id), JSON.stringify(state, null, 2), "utf8");
}

function uniqueIds(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const cleaned = String(value || "").trim();
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

function smtpDirectEnabled() {
  return Boolean(SMTP_ADDRESS && SMTP_USER && SMTP_PASSWORD && SMTP_HOST);
}

function ensureSmtpConfigured() {
  if (!smtpDirectEnabled()) {
    throw new Error(
      "Missing SMTP config for pooled sender. Required: CODEX_EMAIL_ADDRESS, CODEX_EMAIL_PASSWORD, and SMTP host settings.",
    );
  }
}

async function getSmtpTransport() {
  ensureSmtpConfigured();

  if (smtpTransport) {
    return smtpTransport;
  }

  if (smtpConnectPromise) {
    return smtpConnectPromise;
  }

  smtpConnectPromise = (async () => {
    const secure = SMTP_STARTTLS ? false : Number.isFinite(SMTP_PORT) ? SMTP_PORT === 465 : true;
    const transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number.isFinite(SMTP_PORT) ? SMTP_PORT : 465,
      secure,
      requireTLS: SMTP_STARTTLS,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASSWORD,
      },
      pool: true,
      maxConnections: 1,
      maxMessages: Infinity,
      connectionTimeout: 180000,
      greetingTimeout: 60000,
      socketTimeout: 300000,
    });

    transport.on("error", () => {
      if (smtpTransport === transport) {
        smtpTransport = null;
      }
    });

    await transport.verify();
    smtpTransport = transport;
    return transport;
  })();

  try {
    return await smtpConnectPromise;
  } finally {
    smtpConnectPromise = null;
  }
}

function newThreadId() {
  return crypto.randomBytes(6).toString("hex");
}

function ensureImapConfigured() {
  if (!IMAP_USER || !IMAP_PASSWORD) {
    throw new Error(
      "Missing IMAP credentials. Set CODEX_EMAIL_USERNAME/CODEX_EMAIL_PASSWORD or CODEX_EMAIL_ADDRESS/CODEX_EMAIL_PASSWORD.",
    );
  }
}

async function getImapClient() {
  ensureImapConfigured();
  if (imapClient && imapClient.usable) {
    if (!imapClient.mailbox || imapClient.mailbox.path !== IMAP_MAILBOX) {
      await imapClient.mailboxOpen(IMAP_MAILBOX);
    }
    return imapClient;
  }

  if (imapConnectPromise) {
    return imapConnectPromise;
  }

  imapConnectPromise = (async () => {
    const client = new ImapFlow({
      host: IMAP_HOST,
      port: Number.isFinite(IMAP_PORT) ? IMAP_PORT : 993,
      secure: true,
      auth: {
        user: IMAP_USER,
        pass: IMAP_PASSWORD,
      },
      logger: false,
      connectionTimeout: 180000,
      greetingTimeout: 60000,
      socketTimeout: 300000,
      disableAutoIdle: false,
      maxIdleTime: 180000,
    });

    client.on("error", () => {
      if (imapClient === client) {
        imapClient = null;
      }
    });
    client.on("close", () => {
      if (imapClient === client) {
        imapClient = null;
      }
    });

    await client.connect();
    await client.mailboxOpen(IMAP_MAILBOX);
    imapClient = client;
    return client;
  })();

  try {
    return await imapConnectPromise;
  } finally {
    imapConnectPromise = null;
  }
}

async function parseFetchedMessage(raw, uid) {
  const parsed = await simpleParser(raw);
  const referencesValue = Array.isArray(parsed.references)
    ? parsed.references.join(" ")
    : parsed.references
      ? String(parsed.references)
      : "";
  return {
    uid,
    subject: (parsed.subject || "").trim(),
    from: (parsed.from?.text || "").trim(),
    message_id: (parsed.messageId || "").trim(),
    in_reply_to: (parsed.inReplyTo || "").trim(),
    references: referencesValue.trim(),
    date: parsed.date instanceof Date ? parsed.date.toISOString() : parsed.date ? String(parsed.date) : "",
    body: (parsed.text || "").trim(),
  };
}

function matchesThread(message, marker, knownMessageIds) {
  const subject = String(message.subject || "");
  if (subject.includes(marker)) {
    return true;
  }
  const refsBlob = `${message.in_reply_to || ""} ${message.references || ""}`.trim();
  return knownMessageIds.some((messageId) => messageId && refsBlob.includes(messageId));
}

async function fetchRepliesPersistent({ threadId, limit = 10, advance = true }) {
  const state = loadBridgeState(threadId);
  const marker = state.marker || threadMarker(threadId);
  const client = await getImapClient();
  const minUid = Math.max(1, Number(state.last_seen_uid || 0) + 1);
  const searched = await client.search({ uid: `${minUid}:*` }, { uid: true });
  const uidList = Array.isArray(searched) ? searched.map((item) => Number(item)).filter(Number.isFinite) : [];
  uidList.sort((a, b) => b - a);

  const replies = [];
  const scannedUids = [];

  for (const uid of uidList) {
    scannedUids.push(uid);
    if (uid <= state.last_seen_uid) {
      continue;
    }
    const fetched = await client.fetchOne(uid, { uid: true, source: true }, { uid: true });
    if (!fetched || !fetched.source) {
      continue;
    }
    const parsed = await parseFetchedMessage(fetched.source, uid);
    if (!matchesThread(parsed, marker, state.known_message_ids)) {
      continue;
    }
    replies.push(parsed);
    if (parsed.message_id) {
      state.known_message_ids = uniqueIds([...state.known_message_ids, parsed.message_id]);
      state.last_message_id = parsed.message_id;
    }
    if (replies.length >= Math.max(1, limit)) {
      break;
    }
  }

  replies.reverse();

  if (advance) {
    const replyUids = replies.map((item) => Number(item.uid)).filter(Number.isFinite);
    const maxScanned = scannedUids.length > 0 ? Math.max(...scannedUids) : 0;
    const maxMatched = replyUids.length > 0 ? Math.max(...replyUids) : 0;
    const nextSeen = Math.max(Number(state.last_seen_uid || 0), maxScanned, maxMatched);
    if (nextSeen > Number(state.last_seen_uid || 0)) {
      state.last_seen_uid = nextSeen;
    }
    saveBridgeState(state);
  }

  return {
    thread_id: threadId,
    reply_count: replies.length,
    last_seen_uid: Number(state.last_seen_uid || 0),
    replies,
  };
}

async function waitForMailboxActivity(maxWaitMs) {
  const client = await getImapClient();
  return await new Promise((resolve) => {
    let done = false;
    let timer = null;

    const finish = (value) => {
      if (done) {
        return;
      }
      done = true;
      client.off("exists", onExists);
      client.off("close", onClose);
      client.off("error", onError);
      if (timer) {
        clearTimeout(timer);
      }
      resolve(value);
    };

    const onExists = () => finish(true);
    const onClose = () => finish(false);
    const onError = () => finish(false);

    client.on("exists", onExists);
    client.on("close", onClose);
    client.on("error", onError);

    if (maxWaitMs > 0) {
      timer = setTimeout(() => finish(false), maxWaitMs);
    }
  });
}

async function waitForReplyPersistent({ threadId, pollSeconds = 5, timeoutSeconds = 0 }) {
  const started = Date.now();
  while (true) {
    const fetched = await fetchRepliesPersistent({
      threadId,
      limit: 10,
      advance: true,
    });
    if (fetched.replies.length > 0) {
      return fetched;
    }

    if (timeoutSeconds > 0) {
      const elapsed = Date.now() - started;
      if (elapsed >= timeoutSeconds * 1000) {
        return {
          thread_id: threadId,
          reply_count: 0,
          timed_out: true,
          replies: [],
        };
      }
      const remainingMs = timeoutSeconds * 1000 - elapsed;
      await waitForMailboxActivity(Math.max(1, Math.min(remainingMs, Math.max(1, pollSeconds) * 1000)));
      continue;
    }

    await waitForMailboxActivity(Math.max(1, pollSeconds) * 1000);
  }
}

function composeThreadSubject(subjectBase, threadId) {
  return `${threadMarker(threadId)} ${String(subjectBase || "").trim()}`.trim();
}

async function seedLastSeenUidFromWarmImap(state) {
  if (!imapClient || !imapClient.usable) {
    return;
  }
  try {
    if (!imapClient.mailbox || imapClient.mailbox.path !== IMAP_MAILBOX) {
      await imapClient.mailboxOpen(IMAP_MAILBOX);
    }
    let uidNext = Number(imapClient.mailbox?.uidNext || 0);
    if (!uidNext) {
      const status = await imapClient.status(IMAP_MAILBOX, { uidNext: true });
      uidNext = Number(status?.uidNext || 0);
    }
    if (uidNext > 1) {
      state.last_seen_uid = Math.max(Number(state.last_seen_uid || 0), uidNext - 1);
    }
  } catch {
    // best effort only
  }
}

async function sendThreadedEmailPooled({ threadId, to, subjectBase, body }) {
  const transport = await getSmtpTransport();
  const state = loadBridgeState(threadId);
  state.thread_id = threadId;
  state.to = to;
  state.subject = subjectBase;
  state.marker = state.marker || threadMarker(threadId);

  const subject = composeThreadSubject(subjectBase, threadId);
  const references = uniqueIds([...state.known_message_ids, state.last_message_id]);

  const message = {
    from: SMTP_ADDRESS,
    to,
    subject,
    text: body,
    date: new Date(),
    headers: {
      "X-Codex-Thread": threadId,
    },
  };
  if (state.last_message_id) {
    message.inReplyTo = state.last_message_id;
  }
  if (references.length > 0) {
    message.references = references.join(" ");
  }

  const info = await transport.sendMail(message);
  const messageId = String(info?.messageId || "").trim();
  if (messageId) {
    state.last_message_id = messageId;
    state.known_message_ids = uniqueIds([...state.known_message_ids, messageId]);
  }
  await seedLastSeenUidFromWarmImap(state);
  saveBridgeState(state);

  return {
    thread_id: threadId,
    subject,
    message_id: messageId,
    to,
    state_file: statePath(threadId),
  };
}

async function sendThreadedEmailBridgeFallback({ threadId, to, subjectBase, body }) {
  const flags = threadId
    ? ["--thread-id", threadId, "--subject", subjectBase, "--to", to]
    : ["--subject", subjectBase, "--to", to];
  return await runBridgeCommand("send", flags, body);
}

async function sendThreadedEmail({ threadId, to, subjectBase, body }) {
  if (smtpDirectEnabled()) {
    return await sendThreadedEmailPooled({ threadId, to, subjectBase, body });
  }
  return await sendThreadedEmailBridgeFallback({ threadId, to, subjectBase, body });
}

async function prewarmConnections() {
  if (!PREWARM_ENABLED) {
    return { prewarm_enabled: false, imap: false, smtp: false };
  }
  if (prewarmPromise) {
    return prewarmPromise;
  }

  prewarmPromise = (async () => {
    const result = { prewarm_enabled: true, imap: false, smtp: false };

    if (smtpDirectEnabled()) {
      try {
        await getSmtpTransport();
        result.smtp = true;
      } catch {
        result.smtp = false;
      }
    }

    try {
      await getImapClient();
      result.imap = true;
    } catch {
      result.imap = false;
    }

    return result;
  })();

  return prewarmPromise;
}

function startPrewarmBackground() {
  if (!PREWARM_ENABLED) {
    return;
  }
  void prewarmConnections().catch(() => {
    // best effort prewarm
  });
}

function resolveSessionKey(args) {
  if (args && typeof args.context_id === "string" && args.context_id.trim()) {
    return args.context_id.trim();
  }
  const envSessionKey = (process.env.CODEX_THREAD_ID || "").trim() || (process.env.CODEX_SESSION_ID || "").trim();
  if (envSessionKey) {
    return envSessionKey;
  }
  return PROCESS_FALLBACK_SESSION_KEY;
}

function getMappedThread(sessionKey) {
  const map = loadThreadMap();
  return map.threads[sessionKey] || null;
}

function updateMappedThread(sessionKey, patch) {
  const map = loadThreadMap();
  const existing = map.threads[sessionKey] || { created_at: nowIso() };
  map.threads[sessionKey] = {
    ...existing,
    ...patch,
    updated_at: nowIso(),
  };
  saveThreadMap(map);
  return map.threads[sessionKey];
}

async function runBridgeCommand(subcommand, flags, stdinText = "") {
  if (!existsSync(BRIDGE_SCRIPT)) {
    throw new Error(`email_bridge.py not found at ${BRIDGE_SCRIPT}`);
  }
  const argv = [BRIDGE_SCRIPT, subcommand, ...flags];
  const { stdout, stderr, code } = await new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, argv, {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let out = "";
    let err = "";

    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });

    child.on("error", (error) => reject(error));
    child.on("close", (exitCode) => resolve({ stdout: out, stderr: err, code: exitCode ?? 1 }));

    if (stdinText) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();
  });

  if (code !== 0) {
    const details = (stderr || stdout || "unknown failure").trim();
    throw new Error(`Bridge command failed (${subcommand}): ${details}`);
  }

  const parsed = safeJsonParse(stdout, null);
  if (!parsed) {
    throw new Error(`Bridge command returned non-JSON output for ${subcommand}: ${stdout.trim()}`);
  }
  return parsed;
}

function pickRecipient(args, threadEntry) {
  const fromArgs = (args.to || "").trim();
  if (fromArgs) {
    return fromArgs;
  }
  if (threadEntry?.to) {
    return threadEntry.to;
  }
  if (DEFAULT_TO) {
    return DEFAULT_TO;
  }
  return "";
}

function stripThreadPrefix(subject, threadId) {
  const raw = typeof subject === "string" ? subject.trim() : "";
  const tid = typeof threadId === "string" ? threadId.trim() : "";
  if (!raw || !tid) {
    return raw;
  }
  const marker = `[codex-thread:${tid}]`;
  if (raw.startsWith(marker)) {
    return raw.slice(marker.length).trim();
  }
  return raw;
}

function resolveSubjectBase({ mapped, requestedSubject, fallbackSubject }) {
  const requested = typeof requestedSubject === "string" ? requestedSubject.trim() : "";
  const fallback = typeof fallbackSubject === "string" ? fallbackSubject.trim() : "";
  if (mapped?.subject_base && String(mapped.subject_base).trim()) {
    return String(mapped.subject_base).trim();
  }
  if (mapped?.last_subject && mapped?.thread_id) {
    const derived = stripThreadPrefix(String(mapped.last_subject), String(mapped.thread_id));
    if (derived) {
      return derived;
    }
  }
  if (requested) {
    return requested;
  }
  return fallback || "Codex thread";
}

async function ensureThreadForSession({ sessionKey, to, subjectBase, body }) {
  const existing = getMappedThread(sessionKey);
  if (existing?.thread_id) {
    return { threadId: existing.thread_id, created: false, threadEntry: existing };
  }

  const threadId = newThreadId();
  const sendResult = await sendThreadedEmail({
    threadId,
    to,
    subjectBase,
    body,
  });

  const saved = updateMappedThread(sessionKey, {
    thread_id: sendResult.thread_id,
    to: sendResult.to || to,
    subject_base: subjectBase,
    last_subject: sendResult.subject || subjectBase,
  });

  return { threadId: saved.thread_id, created: true, threadEntry: saved, sendResult };
}

function normalizeLimit(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.min(100, Math.max(1, Math.floor(num)));
}

function normalizeTimeout(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.max(0, Math.floor(num));
}

function normalizePoll(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.max(1, Math.floor(num));
}

function toolResponse(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

async function handleEmailUpdate(rawArgs = {}) {
  const args = rawArgs || {};
  const message = typeof args.message === "string" ? args.message.trim() : "";
  if (!message) {
    throw new Error("email_update requires non-empty `message`.");
  }

  const sessionKey = resolveSessionKey(args);
  const requestedSubject = typeof args.subject === "string" && args.subject.trim() ? args.subject.trim() : "Codex update";
  const mapped = getMappedThread(sessionKey);
  const subjectBase = resolveSubjectBase({ mapped, requestedSubject, fallbackSubject: "Codex update" });
  const to = pickRecipient(args, mapped);
  if (!to) {
    throw new Error("Recipient missing. Pass `to` or set CODEX_EMAIL_TO.");
  }

  let threadId = mapped?.thread_id || "";
  let sendResult;

  if (!threadId) {
    const created = await ensureThreadForSession({
      sessionKey,
      to,
      subjectBase,
      body: message,
    });
    threadId = created.threadId;
    sendResult = created.sendResult;
  } else {
    sendResult = await sendThreadedEmail({
      threadId,
      to,
      subjectBase,
      body: message,
    });
    updateMappedThread(sessionKey, {
      thread_id: threadId,
      to: sendResult.to || to,
      subject_base: subjectBase,
      last_subject: sendResult.subject || subjectBase,
    });
  }

  return {
    ok: true,
    mode: "update",
    session_key: sessionKey,
    thread_id: threadId,
    to: sendResult.to || to,
    subject: sendResult.subject || subjectBase,
    subject_base: subjectBase,
    message_id: sendResult.message_id || "",
    state_file: sendResult.state_file || "",
  };
}

async function handleEmailAsk(rawArgs = {}) {
  const args = rawArgs || {};
  const question = typeof args.question === "string" ? args.question.trim() : "";
  if (!question) {
    throw new Error("email_ask requires non-empty `question`.");
  }

  const sessionKey = resolveSessionKey(args);
  const requestedSubject = typeof args.subject === "string" && args.subject.trim() ? args.subject.trim() : "Codex question";
  const pollSeconds = normalizePoll(args.poll_seconds, 5);
  const timeoutSeconds = normalizeTimeout(args.timeout_seconds, 120);

  const mapped = getMappedThread(sessionKey);
  const subjectBase = resolveSubjectBase({ mapped, requestedSubject, fallbackSubject: "Codex question" });
  const to = pickRecipient(args, mapped);
  if (!to) {
    throw new Error("Recipient missing. Pass `to` or set CODEX_EMAIL_TO.");
  }

  let threadId = mapped?.thread_id || "";
  let sendResult;

  if (!threadId) {
    const created = await ensureThreadForSession({
      sessionKey,
      to,
      subjectBase,
      body: question,
    });
    threadId = created.threadId;
    sendResult = created.sendResult;
  } else {
    await fetchRepliesPersistent({
      threadId,
      limit: 100,
      advance: true,
    });
    sendResult = await sendThreadedEmail({
      threadId,
      to,
      subjectBase,
      body: question,
    });
    updateMappedThread(sessionKey, {
      thread_id: threadId,
      to: sendResult.to || to,
      subject_base: subjectBase,
      last_subject: sendResult.subject || subjectBase,
    });
  }

  const waitResult = await waitForReplyPersistent({
    threadId,
    pollSeconds,
    timeoutSeconds,
  });

  const replies = Array.isArray(waitResult.replies) ? waitResult.replies : [];
  const latestReply = replies.length > 0 ? replies[replies.length - 1] : null;

  return {
    ok: true,
    mode: "ask",
    session_key: sessionKey,
    thread_id: threadId,
    to: sendResult.to || to,
    subject: sendResult.subject || subjectBase,
    subject_base: subjectBase,
    question_message_id: sendResult.message_id || "",
    timed_out: Boolean(waitResult.timed_out),
    reply_count: waitResult.reply_count || replies.length,
    latest_reply: latestReply,
    replies,
  };
}

async function handleEmailFetchResponse(rawArgs = {}) {
  const args = rawArgs || {};
  const sessionKey = resolveSessionKey(args);
  const limit = normalizeLimit(args.limit, 10);
  const advance = typeof args.advance === "boolean" ? args.advance : true;

  const mapped = getMappedThread(sessionKey);
  if (!mapped?.thread_id) {
    return {
      ok: true,
      mode: "fetch_response",
      session_key: sessionKey,
      thread_exists: false,
      reply_count: 0,
      replies: [],
    };
  }

  const fetchResult = await fetchRepliesPersistent({
    threadId: mapped.thread_id,
    limit,
    advance,
  });
  return {
    ok: true,
    mode: "fetch_response",
    session_key: sessionKey,
    thread_exists: true,
    thread_id: mapped.thread_id,
    advance,
    reply_count: fetchResult.reply_count || 0,
    last_seen_uid: fetchResult.last_seen_uid || 0,
    replies: Array.isArray(fetchResult.replies) ? fetchResult.replies : [],
  };
}

async function handleEmailWatchResponse(rawArgs = {}) {
  const args = rawArgs || {};
  const sessionKey = resolveSessionKey(args);
  const pollSeconds = normalizePoll(args.poll_seconds, 30);
  const timeoutSeconds = normalizeTimeout(args.timeout_seconds, 0);

  const mapped = getMappedThread(sessionKey);
  if (!mapped?.thread_id) {
    return {
      ok: true,
      mode: "watch_response",
      session_key: sessionKey,
      thread_exists: false,
      timed_out: true,
      reply_count: 0,
      replies: [],
    };
  }

  const watchResult = await waitForReplyPersistent({
    threadId: mapped.thread_id,
    pollSeconds,
    timeoutSeconds,
  });
  const replies = Array.isArray(watchResult.replies) ? watchResult.replies : [];
  const latestReply = replies.length > 0 ? replies[replies.length - 1] : null;

  return {
    ok: true,
    mode: "watch_response",
    session_key: sessionKey,
    thread_exists: true,
    thread_id: mapped.thread_id,
    timed_out: Boolean(watchResult.timed_out),
    reply_count: watchResult.reply_count || replies.length,
    last_seen_uid: watchResult.last_seen_uid || 0,
    latest_reply: latestReply,
    replies,
  };
}

const server = new Server(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOL_DEFS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const name = request.params?.name;
    const args = request.params?.arguments || {};

    if (name === "email_update") {
      const result = await handleEmailUpdate(args);
      return toolResponse(result);
    }
    if (name === "email_ask") {
      const result = await handleEmailAsk(args);
      return toolResponse(result);
    }
    if (name === "email_fetch_response") {
      const result = await handleEmailFetchResponse(args);
      return toolResponse(result);
    }
    if (name === "email_watch_response") {
      const result = await handleEmailWatchResponse(args);
      return toolResponse(result);
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return toolResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

async function run() {
  ensureDirectories();
  startPrewarmBackground();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${SERVER_NAME} failed: ${message}\n`);
  process.exit(1);
});
