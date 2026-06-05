# CP-SAT Migration Plan

## Why CP-SAT over ILP (HiGHS)

### Current Issues with ILP
1. **Non-monotonic training scenarios**: Adding a subrole to a worker can degrade global coverage because the MIP solver finds a structurally different optimum. Mitigated with baseline floor constraints (C1b) but this is a patch, not a fix.
2. **Objective function fragility**: The weighted sum objective (FILL_WEIGHT + buckets + preferences) creates unintuitive tradeoffs. A small change in one dimension can cascade into a completely different solution.
3. **No incremental solving**: Each scenario is solved from scratch — no way to say "start from this solution and only improve."
4. **WASM limitations**: HiGHS WASM is single-threaded, requires a mutex, and can permanently corrupt on edge-case models.

### CP-SAT Advantages for Scheduling
1. **Constraint-first**: Express rules as hard constraints, not soft penalties. Coverage floors, rest periods, and consecutive-day limits are natural.
2. **Separated-magnitude weighted-sum objective**: tiers (hard-floor proxies, soft constraints, preferences) are encoded with sufficiently large coefficient gaps (`M_C5 = 2_000_000`, `M_SLOT = 1_000_000`, see `solver-tiers.ts`; per-assignment terms stay at `×SCALE` in `cpsat-solver.ts`) that lower-priority terms cannot overpower higher-priority ones. Practically equivalent to lexicographic ordering for our problem sizes, with one solve instead of N. True multi-stage lex (with `add_hint` between phases) is possible but not implemented — the cost (N solves, hint-passing fragility) outweighs the benefit at current model sizes.
3. **Interval variables**: Built-in support for "worker W works from 9-17 on Monday" — handles overlaps, rest periods, and daily limits natively.
4. **Solution hints**: Pass a baseline solution as a hint, biasing the solver to explore improvements near the known-good solution.
5. **Multi-objective**: Handle "don't degrade any role" naturally through constraint propagation.

## Architecture Options

### Option A: `dabke` library (recommended for POC)
- **Pros**: TypeScript API, purpose-built for staff scheduling, handles shifts/coverage/rules declaratively
- **Cons**: Requires solver sidecar (Docker or binary), young project (v0.83), abstracts away some control
- **Solver**: `christianklotz/dabke-solver` Docker image or self-hosted binary

### Option B: `ts-ortools` native bindings
- **Pros**: Direct access to CP-SAT API, no Docker dependency
- **Cons**: Last published 2024, may have Node version compatibility issues, 17MB binary

### Option C: Python subprocess (`ortools` pip package)
- **Pros**: Most mature OR-Tools bindings, massive community, Google-supported
- **Cons**: Python dependency, subprocess IPC overhead, model serialization complexity

### Shipped architecture (2026-04-24): hybrid Option C runtime + dabke type contract

Custom Python sidecar at `packages/api/solver/cpsat_server.py` uses `ortools.sat.python.cp_model` directly via Flask — **Option C runtime**, no `dabke` Python library involved (the sidecar has no dabke import). On the TS side, dabke's `SolverRequest` / `SolverResponse` types are reused as the JSON wire-format contract between client and sidecar (`import type { SolverRequest, SolverResponse } from "dabke"` at `cpsat-solver.ts:27` and `solver-circuit.ts:12` — the only two dabke references in `packages/api/src/`). Dabke is type-only on the TS side; the sidecar does not depend on dabke.

## Migration Strategy

### Phase 1: Parallel solver (this branch)
- Build a CP-SAT model builder that maps our existing data structures to dabke's API
- Run both HiGHS and CP-SAT in parallel, log result comparison
- No user-facing changes yet

### Phase 2: Feature parity
- Port all constraints (C0-C10) to CP-SAT equivalents
- Port the piecewise-linear bucket system for OT distribution
- Validate: CP-SAT results must be >= HiGHS results on all test cases

### Phase 3: Solver switch
- Replace HiGHS calls with CP-SAT
- Remove ILP model builder
- Retire HiGHS WASM dependency

## Constraint Mapping: HiGHS ILP → dabke CP-SAT

**Historical:** this table sketches the original dabke-based migration plan. The shipped sidecar implements each constraint directly via `cp_model` — see `cpsat-solver.ts:343-809` for the TS-side model construction and `cpsat_server.py` for the sidecar's `cp_model` calls. The "dabke Equivalent" column describes a hypothetical dabke encoding and is **not** an accurate map of the runtime.

| ILP Constraint | dabke Equivalent | Notes |
|---|---|---|
| C0: Bucket linking (OT fairness) | `minimizeCost()` + `overtimeMultiplier()` | dabke has built-in cost optimization |
| C1: Slot capacity | `cover()` | Coverage requirements are first-class |
| C1b: Slot fill floors | *Not needed* — CP-SAT with solution hints doesn't degrade | The whole reason for this migration |
| C2: Compound pairing | `shift("coupure", ...)` | Split shifts are a native concept |
| C3: No time overlap | *Automatic* — dabke handles this | Shifts can't overlap by construction |
| C4: Max daily hours | `maxHoursPerDay()` | Built-in rule |
| C5: Weekly hours cap | `maxHoursPerWeek()` | Built-in rule |
| C6: Min rest between shifts | `minRestBetweenShifts()` | Built-in rule |
| C7: Max consecutive days | `maxConsecutiveDays()` | Built-in rule |
| C8: Rolling rest (5 in 7) | Custom constraint via `rule()` | May need extension |
| C9: 12-week rolling average | Custom constraint | Not built-in, needs custom model extension |
| C10: Role-based staffing | `cover("zone", "subrole", N)` | Coverage per role per zone |

## Data Model Mapping

```typescript
// Current ILP
interface ILPWorker { id, name, role, priority, contractHours, subRoles, ... }
interface ILPSlot { id, date, dow, zone, role, startTime, endTime, hours, target, existingFill, ... }

// dabke
interface Member { id, roleIds, pay, ... }
// Times = named periods (our zones/services)
// Shifts = worker schedule patterns (our slots)
// Coverage = how many workers per time per role (our targets)
```

## Open Questions
- How does dabke handle multi-week solving? (Our current model solves 4 weeks simultaneously)
- Can we express the 12-week rolling average constraint in dabke?
- What's the solver performance comparison for our model size (~50 workers, ~100 slots, 4 weeks)?
- How to handle virtual workers (hire scenarios) in dabke?
