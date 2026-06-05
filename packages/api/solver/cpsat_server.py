#!/usr/bin/env python3
"""
CP-SAT solver HTTP server — speaks the dabke solver protocol.

Accepts POST /solve with a SolverRequest JSON payload,
builds a CP-SAT model, solves, returns SolverResponse.

Run via gunicorn (single-worker):
  gunicorn -w 1 -t 60 -b 127.0.0.1:8090 cpsat_server:app

For parallel solves, bump worker count (each worker is a separate process
with its own ortools instance; the threading.Lock below stays correct since
it scopes to a single process). When raising -w, lower CPSAT_NUM_WORKERS so
the total core demand stays bounded — e.g. -w 4 + CPSAT_NUM_WORKERS=1 on a
4-core host serves 4 concurrent solves at 1 core each:
  CPSAT_NUM_WORKERS=1 gunicorn -w 4 -t 60 -b 127.0.0.1:8090 cpsat_server:app
"""

import os
import threading
import time
from flask import Flask, jsonify, request as flask_request
from ortools.sat.python import cp_model

# Determinism knobs (env-overridable, per-request-overridable).
# Reproducibility requires BOTH a fixed seed AND a fixed (non-zero) num_workers
# plus max_deterministic_time (already the default — see timeout wiring below).
# num_workers=0 lets OR-Tools auto-detect cores, which varies by machine and
# breaks cross-machine reproducibility. Set CPSAT_NUM_WORKERS=0 to use all
# cores (faster but non-reproducible).
DEFAULT_RANDOM_SEED = int(os.environ.get("CPSAT_RANDOM_SEED", "42"))
DEFAULT_NUM_WORKERS = int(os.environ.get("CPSAT_NUM_WORKERS", "4"))

# Stop solving once the optimality gap (|objective - bound| / |objective|) drops
# below this fraction. Big-team /optimize runs (e.g. 32-employee restaurants)
# routinely plateau at ~5–10% gap within 1–2 s but keep grinding to the wall
# clock without further improvement. Bailing at 5% saves the trailing 6–9 s
# per solve while leaving recommendation comparisons within noise. Set to 0 to
# disable (run to wall-clock or bound-proof). Per-request override via the
# `relativeGapLimit` option.
DEFAULT_RELATIVE_GAP_LIMIT = float(os.environ.get("CPSAT_RELATIVE_GAP_LIMIT", "0.05"))

# `interleave_search` is flagged Experimental in sat_parameters.proto and tends
# to hurt objective quality on non-trivial models. Off by default; set
# CPSAT_INTERLEAVE_SEARCH=1 to re-enable (historical behaviour, kept as a
# rollback switch).
INTERLEAVE_SEARCH_ENABLED = os.environ.get("CPSAT_INTERLEAVE_SEARCH") == "1"

# Wall-seconds to deterministic-time units. Calibration starting point —
# 1 wall-second on a typical sidecar host ≈ 10 deterministic units.
# Tune by comparing actual sweep durations before/after.
WALL_TO_DET_RATIO = 10.0

# OR-Tools CP-SAT has known shared C++ state across concurrent Solve() calls
# (issue #1958). Gunicorn runs with -w 1 --threads 1, so at most one solve is
# in-flight per process; the lock is defence-in-depth against future
# configurations that enable threads.
_solve_lock = threading.Lock()

app = Flask(__name__)


@app.get("/health")
def health():
    # Actually exercise CP-SAT so a broken ortools install is detected at
    # liveness time rather than on the first real /solve. Kept tiny (<10ms)
    # so health checks don't block the request queue.
    try:
        model = cp_model.CpModel()
        x = model.new_bool_var("h")
        model.add_bool_or([x])
        solver = cp_model.CpSolver()
        solver.parameters.max_deterministic_time = 1 * WALL_TO_DET_RATIO
        status = solver.solve(model)
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return jsonify({"status": "error", "error": f"trivial solve returned {status}"}), 503
        return jsonify({"status": "ok"})
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 503


class BadModelError(ValueError):
    """Raised when the incoming SolverRequest is malformed. Returned as HTTP 400."""
    pass


# Debug escape hatch: when "1", soft_linear constraints without an "id" field fall
# back to positional ids (`soft_0`, `soft_1`, ...). Off by default — a missing id
# is almost always a caller bug and positional ids make violation reports
# unreadable downstream.
ALLOW_POSITIONAL_SOFT_IDS = os.environ.get("CPSAT_ALLOW_POSITIONAL_SOFT_IDS") == "1"


@app.post("/solve")
def solve_endpoint():
    try:
        payload = flask_request.get_json(force=True, silent=False)
        response = solve(payload)
        return jsonify(response)
    except BadModelError as e:
        return jsonify({"status": "ERROR", "error": str(e)}), 400
    except Exception as e:
        return jsonify({"status": "ERROR", "error": str(e)}), 500


def solve(request: dict) -> dict:
    """Build and solve a CP-SAT model from a dabke SolverRequest."""
    start = time.time()
    model = cp_model.CpModel()

    variables = request.get("variables", [])
    constraints = request.get("constraints", [])
    objective = request.get("objective")
    options = request.get("options", {})

    # ── Build variables ──
    var_map: dict[str, cp_model.IntVar] = {}
    interval_map: dict[str, cp_model.IntervalVar] = {}
    # Per-variable (lb, ub) snapshot used to compute per-constraint slack
    # upper bounds for soft_linear below. Intervals don't participate in
    # soft_linear terms so they're omitted.
    var_bounds: dict[str, tuple[int, int]] = {}

    for v in variables:
        vtype = v.get("type", "bool")
        name = v["name"]
        if vtype == "bool":
            var_map[name] = model.new_bool_var(name)
            var_bounds[name] = (0, 1)
        elif vtype == "int":
            var_map[name] = model.new_int_var(v["min"], v["max"], name)
            var_bounds[name] = (int(v["min"]), int(v["max"]))
        elif vtype == "interval":
            presence = var_map.get(v.get("presenceVar")) if v.get("presenceVar") else None
            if presence is not None:
                iv = model.new_optional_fixed_size_interval_var(
                    start=v["start"], size=v["size"], is_present=presence, name=name
                )
            else:
                iv = model.new_fixed_size_interval_var(
                    start=v["start"], size=v["size"], name=name
                )
            interval_map[name] = iv

    # ── Build constraints ──
    # Track soft constraint slack variables for violation reporting.
    # Tuple: (slack_var, penalty, constraint_id, slack_upper_bound).
    # slack_upper_bound is the computed per-constraint cap (not a global
    # 10000 floor); we keep it so the post-solve guard can warn when slack
    # hits the ceiling.
    soft_slacks: dict[str, tuple[cp_model.IntVar, int, str, int]] = {}

    for c in constraints:
        ctype = c["type"]

        if ctype == "linear":
            terms = c["terms"]
            op = c["op"]
            rhs = c["rhs"]
            expr = sum(var_map[t["var"]] * t["coeff"] for t in terms)
            if op == "<=":
                model.add(expr <= rhs)
            elif op == ">=":
                model.add(expr >= rhs)
            elif op == "==":
                model.add(expr == rhs)

        elif ctype == "soft_linear":
            terms = c["terms"]
            op = c["op"]
            rhs = c["rhs"]
            penalty = c["penalty"]
            cid = c.get("id")
            if cid is None:
                if not ALLOW_POSITIONAL_SOFT_IDS:
                    raise BadModelError(
                        f"soft_linear constraint missing required 'id' field "
                        f"(index {len(soft_slacks)}). Set CPSAT_ALLOW_POSITIONAL_SOFT_IDS=1 to opt in to positional ids."
                    )
                cid = f"soft_{len(soft_slacks)}"
            expr = sum(var_map[t["var"]] * t["coeff"] for t in terms)

            # Compute per-constraint slack upper bound from this constraint's
            # own coefficient/variable domains. A global cap (previously
            # [0, 10000]) silently forces UNSAT when a feasible soft
            # relaxation needs more slack than the cap allows — the model
            # becomes infeasible not because the schedule is impossible but
            # because slack can't grow large enough to absorb the violation.
            # E.g. C5 (weekly hours cap, coeffs in minutes): one worker
            # eligible for 25 × 8h slots contributes 25 × 480 = 12000 minutes
            # to expr; with rhs=45×60=2700, max violation = 9300 stays under
            # the old ceiling — but 30 × 8h slots = 14400, violation = 11700,
            # hits the 10000 ceiling and produces spurious INFEASIBLE.
            expr_lb = 0
            expr_ub = 0
            for t in terms:
                coeff = t["coeff"]
                vlb, vub = var_bounds[t["var"]]
                if coeff >= 0:
                    expr_lb += coeff * vlb
                    expr_ub += coeff * vub
                else:
                    expr_lb += coeff * vub
                    expr_ub += coeff * vlb
            if op == "<=":
                slack_ub = max(0, expr_ub - rhs)
            elif op == ">=":
                slack_ub = max(0, rhs - expr_lb)
            else:
                raise BadModelError(
                    f"soft_linear constraint {cid!r} has unsupported op {op!r} (expected '<=' or '>=')"
                )

            # Create slack variable for the soft constraint.
            # For <=: expr <= rhs + slack (slack >= 0, penalize slack)
            # For >=: expr >= rhs - slack (slack >= 0, penalize slack)
            slack = model.new_int_var(0, slack_ub, f"slack_{cid}")
            if op == "<=":
                model.add(expr <= rhs + slack)
            else:  # ">="
                model.add(expr >= rhs - slack)
            soft_slacks[cid] = (slack, penalty, cid, slack_ub)

        elif ctype == "exactly_one":
            model.add_exactly_one(var_map[v] for v in c["vars"])

        elif ctype == "at_most_one":
            model.add_at_most_one(var_map[v] for v in c["vars"])

        elif ctype == "implication":
            model.add_implication(var_map[c["if"]], var_map[c["then"]])

        elif ctype == "bool_or":
            model.add_bool_or(var_map[v] for v in c["vars"])

        elif ctype == "bool_and":
            model.add_bool_and(var_map[v] for v in c["vars"])

        elif ctype == "no_overlap":
            intervals = [interval_map[name] for name in c["intervals"] if name in interval_map]
            if intervals:
                model.add_no_overlap(intervals)

    # ── Build objective ──
    if objective:
        terms = objective["terms"]
        sense = objective.get("sense", "minimize")
        # Unknown vars are a client bug and must surface as BadModelError, same
        # as the linear-constraint parser above. The previous `if t["var"] in
        # var_map` filter silently dropped terms and masked model-build bugs
        # asymmetrically between constraints (loud) and objective (silent).
        missing = [t["var"] for t in terms if t["var"] not in var_map]
        if missing:
            sample = ", ".join(missing[:5])
            raise BadModelError(
                f"objective references {len(missing)} unknown variable(s): {sample}"
                + ("..." if len(missing) > 5 else "")
            )
        obj_expr = sum(var_map[t["var"]] * t["coeff"] for t in terms)

        # Subtract soft constraint penalties from the objective
        for cid, (slack, penalty, _, _) in soft_slacks.items():
            obj_expr -= slack * penalty

        if sense == "minimize":
            model.minimize(obj_expr)
        else:
            model.maximize(obj_expr)
    elif soft_slacks:
        # No explicit objective but has soft constraints — minimize total penalty
        penalty_expr = sum(slack * penalty for slack, penalty, _, _ in soft_slacks.values())
        model.minimize(penalty_expr)

    # ── Solve ──
    build_ms = (time.time() - start) * 1000
    solver = cp_model.CpSolver()
    timeout = options.get("timeLimitSeconds", 30)
    det_budget = timeout * WALL_TO_DET_RATIO
    print(f"[CP-SAT] model built in {build_ms:.0f}ms, timeout={timeout}s wall + {det_budget} det, {len(variables)} vars, {len(constraints)} constraints, raw_options={options}", flush=True)
    solver.parameters.max_deterministic_time = det_budget
    solver.parameters.max_time_in_seconds = float(timeout)
    gap_limit = float(options.get("relativeGapLimit", DEFAULT_RELATIVE_GAP_LIMIT))
    if gap_limit > 0:
        solver.parameters.relative_gap_limit = gap_limit
    solution_limit = options.get("solutionLimit")
    if solution_limit:
        solver.parameters.solution_limit = solution_limit

    # Determinism: reproducible results require fixed seed + fixed non-zero
    # num_workers + max_deterministic_time (set above). num_workers=0
    # (auto-detect) varies by machine and breaks cross-machine reproducibility.
    # Calibration may override via request options.
    solver.parameters.random_seed = int(options.get("randomSeed", DEFAULT_RANDOM_SEED))
    solver.parameters.num_workers = int(options.get("numWorkers", DEFAULT_NUM_WORKERS))
    if INTERLEAVE_SEARCH_ENABLED and solver.parameters.num_workers != 1:
        solver.parameters.interleave_search = True
        # Batch size ≈ 2× workers gives good utilisation of interleaved search.
        effective_workers = solver.parameters.num_workers or 4  # treat 0 (auto) as ~4
        solver.parameters.interleave_batch_size = 2 * effective_workers

    # Warm-start hints: caller passes `solutionHints: {varName: 0|1}` (typically
    # the assignment-variable snapshot from a recent baseline solve). Each hint
    # that names a known variable becomes `model.add_hint(var, value)`; unknown
    # names (e.g. eligibility changed and the var no longer exists) are silently
    # skipped. `repairHint` is opt-in (default off): the underlying mechanism
    # only triggers in multi-worker mode via a race between workers (Perron,
    # or-tools#3277) and was a regression driver on économique in the
    # 2026-04-24 cross-preset sweep. With repair off, hints act as a starting
    # point the solver is free to improve on.
    hints = options.get("solutionHints")
    hints_applied = 0
    if isinstance(hints, dict):
        for name, value in hints.items():
            var = var_map.get(name)
            if var is None:
                continue
            model.add_hint(var, int(value))
            hints_applied += 1
    if options.get("repairHint"):
        solver.parameters.repair_hint = True
        solver.parameters.hint_conflict_limit = int(options.get("hintConflictLimit", 50))
    if hints_applied:
        print(f"[CP-SAT] applied {hints_applied} hints (repair_hint={solver.parameters.repair_hint})", flush=True)

    # Track intermediate solutions
    class SolutionLogger(cp_model.CpSolverSolutionCallback):
        def __init__(self, solve_start):
            super().__init__()
            self._start = solve_start
            self.solutions = []  # list of (elapsed_ms, objective)

        def on_solution_callback(self):
            elapsed = (time.time() - self._start) * 1000
            obj = self.objective_value
            self.solutions.append({"timeMs": round(elapsed, 1), "objective": obj})
            best_bound = self.best_objective_bound
            gap = abs(obj - best_bound) / max(abs(obj), 1) * 100
            print(f"[CP-SAT]   #{len(self.solutions)} at {elapsed:.0f}ms — obj={obj:.1f}, bound={best_bound:.1f}, gap={gap:.1f}%", flush=True)

    callback = SolutionLogger(start)
    with _solve_lock:
        status = solver.solve(model, callback)
    solve_time_ms = (time.time() - start) * 1000
    status_label = {cp_model.OPTIMAL: 'OPTIMAL', cp_model.FEASIBLE: 'FEASIBLE', cp_model.INFEASIBLE: 'INFEASIBLE', cp_model.UNKNOWN: 'TIMEOUT'}.get(status, f'OTHER({status})')
    print(f"[CP-SAT] solved in {solve_time_ms:.0f}ms → {status_label}, objective={solver.objective_value if status in (cp_model.OPTIMAL, cp_model.FEASIBLE) else 'N/A'}, {len(callback.solutions)} solutions found", flush=True)

    # ── Map status ──
    status_map = {
        cp_model.OPTIMAL: "OPTIMAL",
        cp_model.FEASIBLE: "FEASIBLE",
        cp_model.INFEASIBLE: "INFEASIBLE",
        cp_model.UNKNOWN: "TIMEOUT",
        cp_model.MODEL_INVALID: "ERROR",
    }
    status_str = status_map.get(status, "ERROR")

    # ── Extract solution ──
    result: dict = {
        "status": status_str,
        "statistics": {
            "solveTimeMs": round(solve_time_ms, 1),
            "conflicts": solver.num_conflicts,
            "branches": solver.num_branches,
        },
        "solutionTrace": callback.solutions,
    }

    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        values = {}
        for name, var in var_map.items():
            values[name] = solver.value(var)
        result["values"] = values
        result["objectiveValue"] = solver.objective_value

        # Report soft constraint violations. Also warn when a slack hits its
        # computed upper bound — that means either the bound is too tight
        # (a bug in the bound derivation) or the model has a real
        # infeasibility being masked by a capped slack (the underlying bug
        # C3 was originally meant to surface).
        violations = []
        for cid, (slack, penalty, constraint_id, slack_ub) in soft_slacks.items():
            slack_val = solver.value(slack)
            if slack_val > 0:
                violations.append({
                    "constraintId": constraint_id,
                    "violationAmount": slack_val,
                    "targetValue": 0,
                    "actualValue": slack_val,
                })
            if slack_ub > 0 and slack_val >= slack_ub:
                print(
                    f"[CP-SAT] WARNING: slack_{constraint_id} hit its upper bound "
                    f"({slack_val}/{slack_ub}); computed bound may be too tight or "
                    f"real infeasibility is being masked",
                    flush=True,
                )
        if violations:
            result["softViolations"] = violations

    return result
