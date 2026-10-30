# Stack Context

Generated: 2026-10-30

## Stack
- **Language**: TypeScript (strict, ES2022, Bun runtime)
- **Framework**: OpenCode V2 plugin SDK (`@opencode/plugin` ^2.1.1)
- **Build**: `bun build src/index.ts --outdir=dist --target=bun`
- **Lint**: `bunx eslint src/ tests/` (package script: `lint`)
- **Typecheck**: `tsc --noEmit` (package script: `typecheck`)
- **Test**: `bun test tests/` (unit + integration; `bun test tests/unit/`, `bun test tests/integration/`)
- **Format**: (no formatter configured; ESLint is the only style gate)

## Skill to Load
`skill(name="typescript-skill")`

## Conventions
- ESM-only (`"type": "module"`), imports use `.js` extensions for TS source
- Source under `src/`, tests under `tests/unit/` and `tests/integration/`
- Types/interfaces PascalCase; enums UPPER_SNAKE_CASE; constants UPPER_SNAKE_CASE
- Errors: typed messages via `throw new Error(...)`; try/catch at plugin hook edges

## CI Gates
- `verify` script: `tsc --noEmit && bunx eslint src/ tests/ && bun test tests/ && bun build ...`
- GitHub Actions CI added in commit `35a60ea` (fix test/verify scripts)

## Override
No `AGENTS.md` present; this file is authoritative for this repo.