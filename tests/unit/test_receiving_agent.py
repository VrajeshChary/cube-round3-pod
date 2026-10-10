"""Unit tests for Receiving Agent (agents/receiving/app.py).

Tests Receiving in isolation:
- Schema validation and entrypoint contracts
- Product and unit identification
- Carton and unit damage classification
- Quantity shortages and quality discrepancies
- Tenancy isolation
- Offline determinism without Gemini credentials
- Exception handling and fail-open behavior
"""
import pytest
from agents.receiving.app import handle
from shared.utils.schema import errors


def _make_req(unit_id="UNIT-0010", org_id="org_demo_alpha", inputs=None, overrides=None):
    wf = f"WF-{org_id}-{unit_id}"
    return {
        "schema_version": "1.0",
        "request_id": f"{wf}:receiving",
        "workflow_id": wf,
        "stage": "receiving",
        "subject": {
            "org_id": org_id,
            "subject_id": unit_id,
            "route": "fba",
        },
        "inputs": inputs or [],
        "previous_evidence": [],
        "context": {
            "overrides": overrides or [],
            "case": {"org_id": org_id, "unit_id": unit_id, "route": "fba"},
        },
    }


def test_receiving_clean_unit_passes():
    req = _make_req(unit_id="UNIT-0010")
    out = handle(req)

    assert out["schema_version"] == "1.0"
    assert out["stage"] == "receiving"
    assert out["verdict"] == "PASS"

    ev = out["evidence"]
    assert ev["decision"]["verdict"] == "PASS"
    assert ev["decision"]["outcome"] == "accept"
    assert ev["subject"]["subject_id"] == "UNIT-0010"
    assert ev["record_id"].startswith("RCV-")
    assert errors("evidence", ev) == []

    # Check sub-checks
    check_keys = {c["check_key"] for c in ev["checks"]}
    assert {"identity_match", "carton_count", "quantity", "carton_damage", "unit_damage", "quality_flags"} <= check_keys
    for c in ev["checks"]:
        assert c["verdict"] == "PASS"


def test_receiving_damaged_or_shortfall_unit_flags_exception():
    # UNIT-0004 has damage/shortfall
    req = _make_req(unit_id="UNIT-0004")
    out = handle(req)

    assert out["stage"] == "receiving"
    assert out["verdict"] == "FAIL"

    ev = out["evidence"]
    assert ev["decision"]["verdict"] == "FAIL"
    assert ev["decision"]["outcome"] == "accept_with_exceptions"
    assert errors("evidence", ev) == []

    failed_checks = [c for c in ev["checks"] if c["verdict"] == "FAIL"]
    assert len(failed_checks) > 0


def test_receiving_tenant_isolation_rejects_cross_tenant_request():
    # UNIT-0010 belongs to org_demo_alpha; requesting under org_demo_bravo must raise LookupError
    req = _make_req(unit_id="UNIT-0010", org_id="org_demo_bravo")
    with pytest.raises(LookupError, match="no receiving record"):
        handle(req)


def test_receiving_offline_mode_does_not_call_external_api(monkeypatch):
    monkeypatch.setenv("GEMINI_OFFLINE", "1")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)

    req = _make_req(unit_id="UNIT-0010")
    out = handle(req)
    assert out["verdict"] == "PASS"
    assert out["evidence"]["model"]["provider"] == "deterministic-rules"
    assert out["evidence"]["model"]["cost_usd"] == 0.0


def test_receiving_malformed_input_handles_safely():
    # Minimal empty request
    req = {
        "schema_version": "1.0",
        "request_id": "WF-test:receiving",
        "workflow_id": "WF-test",
        "stage": "receiving",
        "subject": {
            "org_id": "org_demo_alpha",
            "subject_id": "UNIT-NONEXISTENT-9999",
            "route": "fba",
        },
        "inputs": [],
        "previous_evidence": [],
        "context": {},
    }
    # Unseen unit should handle gracefully without crashing
    out = handle(req)
    assert out["stage"] == "receiving"
    assert out["verdict"] in ("PASS", "FAIL", "UNCERTAIN")
    assert errors("evidence", out["evidence"]) == []
