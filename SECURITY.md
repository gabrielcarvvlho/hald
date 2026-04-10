# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Hald, please report it responsibly.

**Do not open a public issue.** Instead, email **security@gabrielcarvalho.dev** with:

- A description of the vulnerability
- Steps to reproduce
- Impact assessment (if possible)

You should receive an acknowledgment within 48 hours. We will work with you to understand the issue and coordinate a fix before any public disclosure.

## Scope

Hald processes git history and stores extracted data in a local SQLite database (`.hald/oracle.db`). Security concerns include:

- **API key handling** — Hald reads LLM provider keys from environment variables. Keys are never stored on disk or logged.
- **Local data only** — The knowledge graph is stored locally. Hald does not transmit repository data to any service other than the configured LLM provider for indexing.
- **MCP server** — Runs on stdio (not network-exposed by default). Access is controlled by the host agent platform.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x     | Yes       |
