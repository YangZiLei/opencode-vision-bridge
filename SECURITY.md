# Security Policy

## Supported Versions

Only the latest released version (currently `1.0.1`) receives security fixes.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, use GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Fill in the form with a description, affected version, and reproduction steps.

You can also email the maintainer (see the GitHub profile for contact) if private
reporting is unavailable. We aim to acknowledge reports within 72 hours and provide
a fix or mitigation plan within 14 days.

## Scope notes

- vision-bridge writes pasted images to a temporary directory
  (`%TEMP%/opencode-vision/` on Windows, `$TMPDIR/opencode-vision/` on macOS/Linux).
  It does not transmit data except to the visual model you configure. Handling of
  sensitive images is the user's responsibility (see README → Privacy).
- The plugin reads a blacklist file you control (`text-models.json`). Malformed input
  degrades gracefully to an empty blacklist (see the bad-config test).
