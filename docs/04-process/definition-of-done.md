# Definition of Done

A feature or change is "done" when ALL of these are true.

## Code

- [ ] Works end-to-end (not just the happy path)
- [ ] No heavy dependencies added (vanilla -> stdlib -> external hierarchy respected)
- [ ] Under reasonable line count -- no bloat
- [ ] Clean process management -- no orphan browser processes
- [ ] No security vulnerabilities introduced (command injection, XSS, etc.)

## Tests

- [ ] Existing tests still pass: `node --test test/unit/*.test.js test/integration/*.test.js`
- [ ] New behavior has test coverage (integration preferred over unit)
- [ ] Bug fixes include a regression test that fails before the fix

## Documentation

- [ ] `docs/00-context/system-state.md` updated if architecture changed
- [ ] `docs/03-logs/decisions-log.md` updated if a design decision was made
- [ ] `barebrowse.context.md` updated if public API changed
- [ ] `CHANGELOG.md` updated with what changed

## Not required (avoid over-engineering)

- 100% code coverage
- TypeScript types
- Cross-platform testing (Linux first, others later)
- Performance benchmarks (unless performance is the feature)
