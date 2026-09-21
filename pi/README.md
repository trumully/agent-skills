# Reusable Pi profile snapshot

This directory is a copy-only snapshot of reusable material from
`C:\Users\truma\.pi\agent`. It is intentionally kept under `pi/` so the
repository's existing files remain untouched.

## Included

- `settings.json`, copied unchanged.
- User agents under `agents/`.
- Skills and their source scripts under `skills/`.
- Extension source, prompts/snippets, tests, documentation, and configuration
  under `extensions/`.
- npm package manifests, lockfiles, and package-area ignore/configuration files
  under `npm/` and individual extension directories.

The copied source payload is **131 files (1,438,777 bytes)**. The two files
created specifically for this snapshot are this README and `.gitignore`; they
are not source files from the profile.

## Deliberate exclusions

The following were not copied:

- Credentials/authentication: `auth.json`.
- Private or runtime state: sessions, MCP caches/onboarding state, model-store
  state, trust state, and web-search cache.
- Browser profiles (`.profile`), binaries (`bin/`), and the `git/` package
  cache.
- All `node_modules/` trees and other installed dependencies. Package
  manifests and lockfiles are included, but dependencies are not.
- Any `.git/` trees, Python `__pycache__/` output, and generated/build/runtime
  artifacts.

The pre-copy inventory checked the selected tree for symbolic links and Windows
reparse points/junctions; none were present, and links were not followed.

## Review and source preservation

Before copying, the selected files were read for credential-like secret
patterns and sensitive JSON key/value fields without printing values. No
embedded credential, API-key, bearer-token, or private-key match was found, so
no source file was redacted or altered. The copy is byte-for-byte unchanged for
all 131 source files.

Some source text intentionally retains machine-specific assumptions, including
references to `~/.pi/agent` and Windows absolute-path examples. These occur in
extension code/documentation/tests and in the session-analysis skill/scripts.
They were left unchanged as required; users relocating this snapshot may need
manual configuration or path adjustments.

The scan was heuristic: it checked readable selected text/JSON files for common
credential signatures and key names, not every possible encoding or secret
format. Excluded private files were not copied. No copied code was executed.

## Activation and compatibility limitations

No activation, synchronization, dependency installation, upgrade, or install
automation was added or run. `settings.json` names provider/model and npm
packages that may not exist in another environment. Several extensions assume
Pi's APIs and local facilities such as Node/TypeScript, tmux, browser/runtime
support, or the host operating system; lockfiles can also contain
platform-specific optional dependencies. This is not a tested portable
installation—perform any setup and compatibility checks manually before use.
