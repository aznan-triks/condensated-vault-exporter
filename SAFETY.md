# Safety Warning

> [!CAUTION]
> **DANGEROUS EXPERIMENTAL CRASH-TEST — USE ENTIRELY AT YOUR OWN RISK**

Condensated Vault Exporter is an experimental crash-test project, not production-ready software. Treat it as dangerous and untrusted.

## Verification status

- No independent code analysis or security audit has been performed.
- The project has not been comprehensively tested or validated for safe use with real-world vaults, valuable data, or sensitive information.
- This repository does contain automated tests for selected behavior. They are limited and do not amount to an independent review, security assessment, or safety guarantee.

## Potential risks

The exporter may produce incorrect or incomplete bundles, mishandle note content, or create or overwrite files in the configured destination. Bundles may contain private information if you choose to share them. The credential scanner and preview are fallible; neither guarantees that an export is correct, safe, or free of secrets.

## Required precautions

- Use only a disposable test vault or a disposable copy of a vault.
- Keep a separate, verified backup before running the software.
- Do not use it on valuable, sensitive, or production data.
- Review the destination and inspect the generated files before relying on or sharing them.
- Do not treat passing automated tests, previews, warnings, or credential scans as proof of safety.

By using or running this project, you accept all risks. It is provided "as is"; use it entirely at your own risk.
