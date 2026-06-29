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
} catch {
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
        },
        format: {
          type: "string",
          description:
            "Format hint: auto | peppol-bis-3 | en16931-ubl | en16931-cii | " +
            "xrechnung-ubl | xrechnung-cii | factur-x | ubl | cii. Default: auto (the server sniffs it).",
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
        },
      },
      required: ["rule_id"],
    },
  },
];

// ---- handlers --------------------------------------------------------------
async function validateEinvoice(args: {
  content: string;
  format?: string;
  is_pdf?: boolean;
}): Promise<string> {
  if (!API_KEY) {
    return (
      "No API key configured. Set the EINVOICE_API_KEY environment variable for this MCP server. " +
      "Get a free key (200 validations/month, no card) at https://eleata.io/signup/."
    );
  }
  const format = (args.format || "auto").trim();
  const body = args.is_pdf ? Buffer.from(args.content, "base64") : Buffer.from(args.content, "utf8");
  const contentType = args.is_pdf ? "application/pdf" : "application/xml";
  const url = `${API_BASE}/v1/validate?format=${encodeURIComponent(format)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": contentType,
        "User-Agent": USER_AGENT,
      },
      body,
    });
  } catch (e) {
    return `Could not reach the eleata API at ${API_BASE}: ${(e as Error).message}`;
  }

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return `eleata API returned a non-JSON response (HTTP ${res.status}): ${text.slice(0, 500)}`;
  }
  if (!res.ok) {
    const msg = data?.error?.message || data?.detail || text.slice(0, 400);
    return `Validation request failed (HTTP ${res.status}): ${msg}`;
  }

  const valid = data.valid === true;
  const detected = data.format || format;
  const ruleset = data.ruleset || data.applied_ruleset || "";
  const errors: any[] = Array.isArray(data.errors) ? data.errors : [];

  const lines: string[] = [];
  lines.push(valid ? `✅ VALID — ${detected}` : `❌ INVALID — ${detected}  (${errors.length} issue${errors.length === 1 ? "" : "s"})`);
  if (ruleset) lines.push(`ruleset: ${ruleset}`);
  for (const err of errors) {
    const id = err.rule_id || err.id || "?";
    const sev = err.severity ? `[${err.severity}] ` : "";
    lines.push("");
    lines.push(`• ${sev}${id}${err.location ? `  (at ${err.location})` : ""}`);
    if (err.message) lines.push(`  ${err.message}`);
    if (err.fix_hint) lines.push(`  fix: ${err.fix_hint}`);
  }
  return lines.join("\n");
}

async function listFormats(): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/v1/formats`, { headers: { "User-Agent": USER_AGENT } });
  } catch (e) {
    return `Could not reach the eleata API at ${API_BASE}: ${(e as Error).message}`;
  }
  const text = await res.text();
  if (!res.ok) return `Could not list formats (HTTP ${res.status}): ${text.slice(0, 400)}`;
  return text;
}

function explainErrorCode(args: { rule_id: string }): string {
  const id = (args.rule_id || "").trim();
  const fix = ERROR_FIXES[id];
  if (!fix) {
    const known = Object.keys(ERROR_FIXES);
    const sample = known.slice(0, 10).join(", ");
    return (
      `No bundled explanation for '${id}'. ` +
      (known.length
        ? `Known codes include: ${sample}${known.length > 10 ? ", …" : ""}. ` +
          `See the full list at https://eleata.io/error/.`
        : `See https://eleata.io/error/.`)
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
