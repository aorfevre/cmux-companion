# Repair Companion update admission and compatibility

Implements the approved manual-self-update design: only managed work gates
activation, and affected SQLite data is backed up and recoverable. The user
explicitly confirmed Companion must update independently of live cmux sessions.

1. Remove unrelated cmux status polling; preserve workflow, request, prompt and
   ownership fencing. Test running/unknown/offline cmux independently of owned work.
2. Declare versioned data compatibility separately from source implementation.
   Recognize legacy releases only through recorded source digests. Require equal
   declared contracts; preserve refusal for unknown or incompatible migrations.
3. Verify favorites compatibility using an immutable pre-favorites settings
   implementation, populated SQLite data, cross-version writes and backup restore.
4. Surface a specific safe compatibility failure instead of an opaque preparation
   error. Test without leaking adapter errors or process output.
5. Verify and merge a PR, then perform a backed-up installer repair because the
   installed old updater cannot admit its own compatibility fix. Preserve paired
   identity, automatic preference and cmux sessions. Verify installed exact SHA.
