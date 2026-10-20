# Seven review findings implementation plan

**Goal:** Fix the seven reviewed defects in order, completing plan → regression → implementation → review/test/fix before starting the next issue.

**Architecture:** Preserve the two MCP tools and adapter interface. Use dialect-aware lexical validation, explicit query submission boundaries, current connection lookup, and serialized SSH lifecycle operations.

**Tech stack:** TypeScript, Node test runner, mysql2, pg, ssh2, Zod.

No live database or SSH credentials are needed. Work on `fix/seven-review-findings`; leave changes uncommitted for review.

## Backlog

- [x] 1. Dangerous-query validator
- [x] 2. Unsafe write retries
- [x] 3. Wildcard discovery recovery through MCP
- [x] 4. Multiple-statement contract
- [x] 5. SSH partial/concurrent resource cleanup
- [x] 6. Encrypted SSH key passphrases
- [x] 7. Bounded automatic reconnect loop

## Issue 1 — Dangerous-query validator

Replace independent regex stripping with a sequential scanner in `src/utils/sql-lexer.ts`; preserve keyword matching in `src/utils/query-validator.ts`. Pass the dialect from `src/tools/tool-generator.ts`. A full SQL parser adds unnecessary dependencies; changing regex order alone fails on comments containing quotes. The scanner handles quoted strings/identifiers, doubled quotes, PostgreSQL dollar quotes and nested comments, MySQL hash comments and executable comments. Reject executable comments and unterminated or mode-ambiguous quotes. Treat removed tokens as separators so adjacent keywords stay visible.

- [x] Add `tests/query-validator.test.ts` with bypass, ordinary literals/comments, dialect differences and malformed-input cases.
- [x] Run `node --test --import tsx tests/query-validator.test.ts`; confirm the bypass and dialect regressions fail.
- [x] Implement the scanner and dialect propagation.
- [x] Run focused tests, `npm test`, and `npm run build`.
- [x] Review the diff and independent review feedback; fix and rerun affected checks.

Later issue plans will be recorded only when the preceding cycle is complete.

## Issue 2 — Unsafe write retries

Mark transient errors raised after user SQL submission as `QueryOutcomeUnknownError` in `connection-retry.ts`. Both real adapters track the submission boundary after timeout setup. The retry helper resets the pool but propagates this error without replay; the managed SSH layer reconnects for future use but also propagates it without replay. Connection acquisition/setup errors remain retryable. Do not infer idempotence from SQL keywords (SELECT may call mutating functions).

- [x] Add adapter tests with driver-boundary fakes for committed-write/lost-response, acquisition failure, setup failure, and ordinary SQL errors. Add managed SSH coverage for no replay and recovery failure preserving the unknown outcome.
- [x] Run focused tests and confirm one write currently executes twice.
- [x] Implement the typed error, adapter boundary, and manager propagation. Document outcome semantics in README.
- [x] Run affected tests, full suite, build, and independent review.

Issue 1 evidence: original bypass tests failed, then 36/36 tests and build passed. Review found MySQL Unicode comment whitespace and PostgreSQL non-ASCII identifier boundaries; both fixed with red/green regressions.

## Issue 3 — Wildcard recovery through MCP

Pass the ConnectionManager into tool handlers instead of retaining resolved snapshots. `execute_sql` validates syntax/safety and explicit known databases before network use, then resolves the current connection before the final database check. `list_databases` reads current state and retries unresolved discovery independently per connection, including readable errors without hiding healthy connections. Keep explicit-list lazy connections lazy when listing.

- [x] Add real in-memory MCP tests for startup wildcard failure recovering through both tools, invalid database rejection, and current state after direct manager recovery.
- [x] Confirm old handlers fail those tests.
- [x] Replace snapshots with current lookup; preserve two-tool schema and error response contract.
- [x] Run focused tests, full suite, build, and independent review.

Issue 2 evidence: both adapter regressions initially replayed writes; manager regressions replayed or masked the outcome. Fixed and independently approved; 46 full tests plus 2 additional focused second-attempt tests passed, build green.

## Issue 4 — Single-statement contract

Choose explicit rejection of batches rather than enabling MySQL batching or widening QueryResultData. Both real adapters enforce exactly one statement before acquiring a connection, using the issue1 scanner. The MCP handler enforces it even when dangerous-keyword protection is disabled. Empty SQL is rejected; trailing delimiters/comments and delimiters inside literals remain valid. A single stored routine that returns multiple result sets yields a clear already-executed/unsupported-results error instead of silently dropping data. Update tool schema and README to document required database and one-statement input.

- [x] Add scanner/adapter/MCP batch-rejection tests, single-statement quoted-semicolon cases, and unexpected result-array tests.
- [x] Demonstrate batch submission and incorrect result handling on old code.
- [x] Add shared statement validation, call before connection use, and reject unsupported result sets after execution without replay.
- [x] Run focused tests, full suite, build and independent review.

Issue 3 evidence: three MCP startup/stale-state regressions failed then passed. Full suite 51/51 and build passed; extra lazy/healthy-peer test passed. Independent review approved.

## Issue 5 — SSH and adapter resource ownership

Share in-flight tunnel establishment/recreation per registered connection and in-flight adapter initialization/recovery per manager connection. Release successfully opened jump clients if a later hop fails. Clear published resources before closing them and detach automatic reconnect handlers during intentional cleanup. Closing marks state closed before awaiting in-flight work, aborts pending SSH handshakes, and discards late resources. Concurrent recovery must recognize when another request already replaced its failed adapter. Preserve the existing one-attempt automatic reconnect behavior until issue7.

- [x] Add deterministic tunnel tests: partial hop failure, parallel first use, failure then retry, forwarding setup failure, close during establishment, manual recovery racing first use.
- [x] Add manager tests: parallel lazy initialization, simultaneous errors sharing recovery, and close during initialization.
- [x] Run focused tests and confirm leaks or duplicated creation on old implementation.
- [x] Implement shared promises, bounded ownership and cleanup on failure/shutdown without changing authentication or retry policy.
- [x] Review and run focused/full suites plus build; address feedback before issue6.

Issue 4 evidence: 8 adapter cases and the MCP disabled-policy case failed on old behavior; 65/65 suite and build passed after fix. Independent review approved.

## Issue 6 — Encrypted SSH key passphrases

Include passphrase in the existing authentication result whenever a private key is loaded. Preserve password and unencrypted-key behavior. Both jump and final hosts already forward the credential object into this function.

- [x] Generate a temporary encrypted RSA key; intercept actual Client.connect options at the transport boundary for jump/final hosts and use ssh2.utils.parseKey with the forwarded passphrase. Verify correct distinct passphrases for each hop.
- [x] Run the test before the fix and observe encrypted-key parse failure.
- [x] Add the optional passphrase to getAuthConfig's result/type; preserve password fallback.
- [x] Run focused and full tests, build and independent review. Remove temporary keys through test cleanup.

Issue 5 evidence: all 8 initial race/leak tests failed before fixes. Review found a disconnect during forwarding startup; its new regression failed then passed. 76/76 suite + build passed; 11 focused lifecycle/concurrency tests independently approved.

## Issue 7 — Bounded automatic reconnect

Own the entire automatic recovery sequence with the same per-tunnel operation promise as manual recovery. Retry at 1, 2, 4, 8 and 16 seconds, stop immediately on success, and stop after attempt5 on persistent failure. Cancel backoff through the tunnel's AbortSignal during close. Each failed attempt cleans its partial resources through issue5 logic. Concurrent manual reconnect/ensure callers join the same sequence. Recheck late disconnects after in-flight establishment settles to avoid lost recovery events.

- [x] Add fake-timer tests for recovery after transient failures, exactly five exhausted attempts, duplicate disconnect events, manual recovery joining backoff, and shutdown cancellation.
- [x] Verify existing handler stops after attempt1 and does not cancel scheduled delay.
- [x] Implement bounded loop, cancellable wait and shared-operation ownership.
- [x] Run focused tests, full suite, build and independent review, then final integrated review of all seven fixes.

Issue 6 evidence: after fixing a test import, encrypted-key test failed with missing-passphrase parser error then passed. 77/77 full suite and build passed; independent password-only/unencrypted-key checks approved.

## Implementation-session verification

All seven cycles are complete. Issue7's four fake-timer regressions failed against the previous handler and passed after implementation. Final integrated independent review found no remaining blockers.

- `npm test`: 81 tests passed, 0 failures (also run independently by the reviewer).
- `npm run build`: TypeScript compilation passed.
- `git diff --check`: passed.
- MCP tests use the real SDK Client, McpServer and InMemoryTransport. Adapter and SSH transport boundaries use deterministic local doubles; encrypted keys are temporary and removed.
- Live database and SSH integration were not run. No deployment configuration or credentials were accessed.
- At the end of the implementation session, changes remained uncommitted on `fix/seven-review-findings`; that session did not push, merge, or deploy. Subsequent PR checks and the separate local PostgreSQL demo are recorded in the PR and companion guide.

Compatibility decisions: exactly one SQL statement per call; no automatic replay after SQL submission; executable MySQL comments and mode-ambiguous quotes rejected; wildcard listings may establish an unresolved lazy connection.
