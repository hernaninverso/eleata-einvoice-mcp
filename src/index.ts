#!/usr/bin/env node
/**
 * eleata e-invoice MCP server
 * ---------------------------
 * Lets an AI coding agent (Claude, Cursor, Copilot, …) validate EU e-invoices
 * and explain validation error codes, by wrapping the hosted eleata API
 * (https://api.eleata.io) plus a bundled offline error-code reference.
 *
 * Tools:
 *   - validate_einvoice(content, format?, is_pdf?)  -> POST /v1/validate
 *   - list_formats()                                -> GET  /v1/formats
 *   - explain_error_code(rule_id)                   -> offline error-fixes.json
 *
 * Auth: set EINVOICE_API_KEY (a free key from https://eleata.io/signup/).
 *   validate_einvoice needs it; list_formats and explain_error_code do not.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API_BASE = (process.env.EINVOICE_API_BASE || "https://api.eleata.io").replace(/\/+$/, "");
const API_KEY = process.env.EINVOICE_API_KEY || "";
const USER_AGENT = "eleata-einvoice-mcp/0.1.0";
const TIMEOUT_MS = 25_000;
// Cap input so a runaway agent can't OOM the local process or send a huge payload.
const MAX_INPUT_CHARS = 8_000_000;

const FORMAT_VALUES = [
  "auto",
  "peppol-bis-3",
  "en16931-ubl",
  "en16931-cii",
  "xrechnung-ubl",
  "xrechnung-cii",
  "factur-x",
  "ubl",
  "cii",
];

// ---- bundled offline error-code reference ---------------------------------
type ErrorFix = {
  format: string;
  title?: string;
  explanation: string;
  suggested_fix: string;
  example?: string;
};
let ERROR_FIXES: Record<string, ErrorFix> = {};
try {
  const here = dirname(fileURLToPath(import.meta.url));
  // error-fixes.json sits at the package root, next to dist/.
  const raw = JSON.parse(readFileSync(join(here, "..", "error-fixes.json"), "utf8"));
  ERROR_FIXES = (raw.rules ?? {}) as Record<string, ErrorFix>;
} catch (e) {
  // explain_error_code is a core offline feature — make the failure visible (stderr, not the MCP channel).
  process.stderr.write(`warning: could not load bundled error-fixes.json: ${(e as Error).message}\n`);
  ERROR_FIXES = {};
}

// ---- tool definitions (explicit JSON Schema) ------------------------------
const TOOLS = [
  {
    name: "validate_einvoice",
    description:
      "Validate an EU electronic invoice against the official Schematron rules " +
      "(Peppol BIS 3.0, EN 16931 UBL/CII, XRechnung 3.0.x, Factur-X/ZUGFeRD, UBL, CII). " +
      "Returns whether it is valid and, for each violation, the rule id, a plain-English " +
      "explanation and a suggested fix. Use this before a developer ships or transmits an " +
      "invoice so a rejection (an SdI scarto, a Chorus Pro refusal, a KSeF error) is caught early. " +
      "Requires EINVOICE_API_KEY (a free key from https://eleata.io/signup/).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        content: {
          type: "string",
          description:
            "The invoice to validate. For XML formats, the raw XML text. " +
            "For a Factur-X / ZUGFeRD PDF, the base64-encoded PDF bytes (set is_pdf=true).",
          maxLength: MAX_INPUT_CHARS,
        },
        format: {
          type: "string",
          description:
            "Format hint. Default: auto (the server sniffs XML vs PDF and the profile).",
          enum: FORMAT_VALUES,
          default: "auto",
        },
        is_pdf: {
          type: "boolean",
          description: "Set true if `content` is a base64-encoded PDF (Factur-X/ZUGFeRD). Default false.",
          default: false,
        },
      },
      required: ["content"],
    },
  },
  {
    name: "list_formats",
    description:
      "List the EU e-invoice formats eleata can validate today, plus what is on the roadmap " +
      "(e.g. FatturaPA, KSeF). No API key required.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "explain_error_code",
    description:
      "Explain a single e-invoice validation error code (e.g. a FatturaPA SdI control like 00400, " +
      "or an XRechnung rule like BR-DE-21) in plain English, with the suggested fix and an example. " +
      "Works offline; no API key required.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        rule_id: {
          type: "string",
          description: "The rule id / error code, e.g. '00400', 'BR-DE-21', 'PEPPOL-EN16931-R053'.",
          maxLength: 128,
        },
      },
      required: ["rule_id"],
    },
  },
];

// ---- http helper (timeout + normalized errors, never leaks raw upstream bodies) ----
type HttpOk = { ok: true; status: number; text: string };
type HttpErr = { ok: false; message: string };

async function httpRequest(url: string, init: RequestInit): Promise<HttpOk | HttpErr> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    return { ok: true, status: res.status, text };
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return { ok: false, message: `the eleata API did not respond within ${TIMEOUT_MS / 1000}s` };
    }
    return { ok: false, message: `could not reach the eleata API at ${API_BASE}` };
  }
}

// ---- handlers --------------------------------------------------------------
async function validateEinvoice(args: {
  content?: unknown;
  format?: unknown;
  is_pdf?: unknown;
}): Promise<string> {
  if (!API_KEY) {
    return (
      "No API key configured. Set the EINVOICE_API_KEY environment variable for this MCP server. " +
      "Get a free key (200 validations/month, no card) at https://eleata.io/signup/."
    );
  }
  const content = typeof args.content === "string" ? args.content : "";
  if (!content) return "No invoice content provided.";
  if (content.length > MAX_INPUT_CHARS) {
    return (
      `Input too large (${content.length} chars; max ${MAX_INPUT_CHARS}). ` +
      "For large or many files, use the CLI (npx @eleata/validate-einvoice) or the batch endpoint."
    );
  }
  const isPdf = args.is_pdf === true;
  let format = typeof args.format === "string" ? args.format.trim() : "auto";
  if (!FORMAT_VALUES.includes(format)) format = "auto";

  const body = isPdf ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
  const contentType = isPdf ? "application/pdf" : "application/xml";
  const url = `${API_BASE}/v1/validate?format=${encodeURIComponent(format)}`;

  const r = await httpRequest(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": contentType, "User-Agent": USER_AGENT },
    body,
  });
  if (!r.ok) return `Validation request failed: ${r.message}.`;

  let data: any;
  try {
    data = JSON.parse(r.text);
  } catch {
    // Don't echo the raw body (could be an HTML error page / proxy trace).
    return `The eleata API returned an unexpected (non-JSON) response (HTTP ${r.status}). It may be down or rate-limiting; try again shortly.`;
  }
  if (r.status < 200 || r.status >= 300) {
    // Prefer the structured error message; never dump the raw body.
    const msg =
      (data && (data.error?.message || data.detail || data.message)) ||
      `HTTP ${r.status}`;
    return `Validation request failed: ${String(msg).slice(0, 300)}`;
  }

  const valid = data.valid === true;
  const detected = (typeof data.format === "string" && data.format) || format;
  const ruleset = data.ruleset || data.applied_ruleset || "";
  const rawErrors =
    (Array.isArray(data.errors) && data.errors) ||
    (Array.isArray(data.issues) && data.issues) ||
    (Array.isArray(data.violations) && data.violations) ||
    [];
  const errors = rawErrors.filter((e: unknown) => e && typeof e === "object") as Record<string, unknown>[];

  const lines: string[] = [];
  lines.push(
    valid
      ? `✅ VALID — ${detected}`
      : `❌ INVALID — ${detected}  (${errors.length} issue${errors.length === 1 ? "" : "s"})`
  );
  if (ruleset) lines.push(`ruleset: ${String(ruleset)}`);
  for (const err of errors) {
    const id = (err.rule_id as string) || (err.id as string) || "?";
    const sev = err.severity ? `[${String(err.severity)}] ` : "";
    const loc = err.location ? `  (at ${String(err.location)})` : "";
    lines.push("");
    lines.push(`• ${sev}${id}${loc}`);
    if (err.message) lines.push(`  ${String(err.message)}`);
    if (err.fix_hint) lines.push(`  fix: ${String(err.fix_hint)}`);
  }
  return lines.join("\n");
}

async function listFormats(): Promise<string> {
  const r = await httpRequest(`${API_BASE}/v1/formats`, { headers: { "User-Agent": USER_AGENT } });
  if (!r.ok) return `Could not list formats: ${r.message}.`;
  if (r.status < 200 || r.status >= 300) {
    return `Could not list formats (HTTP ${r.status}). The service may be temporarily unavailable.`;
  }
  return r.text;
}

function explainErrorCode(args: { rule_id?: unknown }): string {
  const id = typeof args.rule_id === "string" ? args.rule_id.trim() : "";
  if (!id) return "No rule_id provided.";
  const fix = ERROR_FIXES[id];
  if (!fix) {
    const known = Object.keys(ERROR_FIXES);
    const sample = known.slice(0, 10).join(", ");
    return (
      `No bundled explanation for '${id}'. ` +
      (known.length
        ? `Known codes include: ${sample}${known.length > 10 ? ", …" : ""}. ` +
          `See the full list at https://eleata.io/error/.`
        : `The offline error-code reference is unavailable; see https://eleata.io/error/.`)
    );
  }
  const out: string[] = [];
  out.push(`${id}${fix.title ? ` — ${fix.title}` : ""}  (${fix.format})`);
  out.push("");
  out.push(`What it means: ${fix.explanation}`);
  out.push("");
  out.push(`How to fix it: ${fix.suggested_fix}`);
  if (fix.example) {
    out.push("");
    out.push("Example:");
    out.push(fix.example);
  }
  out.push("");
  out.push(`Reference: https://eleata.io/error/${id}/`);
  return out.join("\n");
}

// ---- server wiring ---------------------------------------------------------
const server = new Server(
  { name: "eleata-einvoice", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    let textOut: string;
    if (name === "validate_einvoice") {
      textOut = await validateEinvoice((args ?? {}) as any);
    } else if (name === "list_formats") {
      textOut = await listFormats();
    } else if (name === "explain_error_code") {
      textOut = explainErrorCode((args ?? {}) as any);
    } else {
      return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    }
    return { content: [{ type: "text", text: textOut }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `Tool ${name} failed: ${(e as Error).message}` }] };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs; stdout is the MCP channel.
  process.stderr.write("eleata-einvoice MCP server running on stdio\n");
}

main().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
