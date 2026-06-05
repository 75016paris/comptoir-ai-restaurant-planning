"""Regression tests for audit finding C3.

Before the fix, `cpsat_server.solve` declared every soft_linear slack with a
hardcoded `[0, 10000]` domain. Any soft constraint whose worst-case violation
exceeded 10000 (in coefficient terms) forced spurious INFEASIBLE — the slack
couldn't grow large enough to absorb the violation.

These tests pin the new behaviour: per-constraint slack bounds are derived
from the constraint's own coefficient/variable domains, not a global cap.

Run with the same venv the sidecar uses:
    ~/.cpsat-venv/bin/python -m unittest packages/api/solver/test_slack_bounds.py
"""

import os
import sys
import unittest

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

from cpsat_server import solve  # noqa: E402


def _make_soft_le_over_ten_thousand():
    """Builds a soft `<=` constraint whose worst-case violation exceeds 10000.

    30 booleans × coeff=480 (one 8-hour slot in minutes) = 14400 minutes max.
    rhs = 2700 (a 45h weekly cap in minutes). Worst-case violation = 11700,
    which breaches the old [0, 10000] ceiling. All 30 vars are forced to 1
    via hard `>=` floors so the only feasible solution has slack = 11700.
    """
    num_vars = 30
    coeff = 480  # minutes in an 8h slot
    rhs_minutes = 2700  # 45h * 60
    expected_violation = num_vars * coeff - rhs_minutes  # 11700

    variables = [{"name": f"x_{i}", "type": "bool"} for i in range(num_vars)]
    constraints = [
        # Force every x_i = 1.
        {
            "type": "linear",
            "terms": [{"var": f"x_{i}", "coeff": 1}],
            "op": ">=",
            "rhs": 1,
        }
        for i in range(num_vars)
    ]
    # Soft <=: expr <= rhs + slack. Feasible iff slack can reach 11700.
    constraints.append({
        "type": "soft_linear",
        "id": "c5_huge",
        "terms": [{"var": f"x_{i}", "coeff": coeff} for i in range(num_vars)],
        "op": "<=",
        "rhs": rhs_minutes,
        "penalty": 1000,
    })

    request = {
        "variables": variables,
        "constraints": constraints,
        "objective": {
            "sense": "minimize",
            "terms": [],
        },
        "options": {"timeLimitSeconds": 5, "numWorkers": 1},
    }
    return request, expected_violation


class SlackBoundTests(unittest.TestCase):
    def test_soft_le_violation_exceeding_old_ceiling_is_satisfiable(self):
        """With per-constraint bounds, a worst-case violation of 11700 > 10000
        no longer produces spurious INFEASIBLE and the slack takes the
        correct non-zero value."""
        request, expected_violation = _make_soft_le_over_ten_thousand()

        result = solve(request)

        self.assertIn(result["status"], ("OPTIMAL", "FEASIBLE"),
                      f"expected feasible solve, got {result['status']}")
        violations = result.get("softViolations", [])
        self.assertEqual(len(violations), 1, f"expected 1 soft violation, got {violations}")
        self.assertEqual(violations[0]["constraintId"], "c5_huge")
        # Slack should equal the full excess; any smaller slack would violate
        # the hard floors.
        self.assertEqual(violations[0]["violationAmount"], expected_violation)

    def test_soft_ge_slack_bound_derived_from_rhs(self):
        """For a `>=` constraint with boolean terms (coeff 1), the max
        violation equals rhs (expr_min = 0). Previously this was also capped
        at 10000 — with rhs=3 (a typical C10 role floor) the bound shrinks
        to 3, which is both correct and tighter-than-10000 (better solver
        performance)."""
        variables = [{"name": f"y_{i}", "type": "bool"} for i in range(5)]
        # Force every y_i = 0 so the >= 3 soft constraint must use slack = 3.
        constraints = [
            {"type": "linear", "terms": [{"var": f"y_{i}", "coeff": 1}], "op": "<=", "rhs": 0}
            for i in range(5)
        ]
        constraints.append({
            "type": "soft_linear",
            "id": "role_floor",
            "terms": [{"var": f"y_{i}", "coeff": 1} for i in range(5)],
            "op": ">=",
            "rhs": 3,
            "penalty": 500,
        })

        result = solve({
            "variables": variables,
            "constraints": constraints,
            "objective": {"sense": "minimize", "terms": []},
            "options": {"timeLimitSeconds": 5, "numWorkers": 1},
        })

        self.assertIn(result["status"], ("OPTIMAL", "FEASIBLE"))
        violations = result.get("softViolations", [])
        self.assertEqual(len(violations), 1)
        self.assertEqual(violations[0]["violationAmount"], 3)

    def test_soft_le_slack_unused_when_feasible(self):
        """Sanity: if the hard constraints allow `expr <= rhs`, slack stays
        at zero and no violation is reported."""
        variables = [{"name": f"z_{i}", "type": "bool"} for i in range(3)]
        # All z_i free; minimizing slack × penalty drives them all to 0.
        constraints = [{
            "type": "soft_linear",
            "id": "easy",
            "terms": [{"var": f"z_{i}", "coeff": 10} for i in range(3)],
            "op": "<=",
            "rhs": 5,
            "penalty": 100,
        }]

        result = solve({
            "variables": variables,
            "constraints": constraints,
            "options": {"timeLimitSeconds": 5, "numWorkers": 1},
        })

        self.assertIn(result["status"], ("OPTIMAL", "FEASIBLE"))
        self.assertNotIn("softViolations", result)


if __name__ == "__main__":
    unittest.main()
