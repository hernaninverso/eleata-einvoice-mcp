# eleata e-invoice MCP server

Validate **EU electronic invoices** and explain validation **error codes** directly from your AI
coding agent (Claude, Cursor, Copilot, …). It wraps the hosted [eleata](https://eleata.io) validation
API plus a bundled offline error-code reference.

> Never ship a broken invoice. When you ask your agent "is this FatturaPA / XRechnung / Peppol file
> valid?", it runs the official Schematron rules and gets back the rule id **and the fix** — before a
> rejection (an SdI *scarto*, a Chorus Pro refusal, a KSeF error) ever happens.

## Tools

| Tool | What it does | API key |
|------|--------------|---------|
| `validate_einvoice` | Validate one invoice (Peppol BIS 3.0, EN 16931 UBL/CII, XRechnung 3.0.x, Factur-X/ZUGFeRD, UBL, CII). Returns valid/invalid + each rule id, explanation and fix. | required |
| `list_formats` | List the formats eleata validates today + roadmap. | none |
| `explain_error_code` | Explain one error code (e.g. `00400`, `BR-DE-21`) in plain English, with the fix. Works offline. | none |

## Setup

1. Get a free API key (200 validations/month, no card) at <https://eleata.io/signup/>.
2. Add the server to your agent's MCP config.

### Claude Desktop / Claude Code (`claude_desktop_config.json` or `.mcp.json`)

```json
{
  "mcpServers": {
    "eleata-einvoice": {
      "command": "npx",
      "args": ["-y", "eleata-einvoice-mcp"],
      "env": { "EINVOICE_API_KEY": "your_free_key_here" }
    }
  }
}
```

### Cursor (`~/.cursor/mcp.json`)

Same block as above.

## Example prompts

- "Validate this XRechnung file and tell me what to fix" (paste the XML)
- "What does FatturaPA error 00400 mean and how do I fix it?"
- "Which e-invoice formats can you validate today?"

## Privacy

`validate_einvoice` sends the invoice you pass to the hosted eleata API for validation. `list_formats`
and `explain_error_code` are local/offline (the error-code reference is bundled). See
<https://eleata.io/privacy/>.

## Links

- Web validator, CLI and GitHub Action: <https://eleata.io>
- Error-code reference: <https://eleata.io/error/>
- CLI (`npx @eleata/validate-einvoice`): same API, for CI/CD

MIT licensed. Schematron engines: [Mustang](https://www.mustangproject.org/) /
[phive](https://github.com/phax/phive). Schematron rules from CEN, OpenPeppol, KoSIT.
