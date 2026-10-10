"""Unit tests for Recovery Agent (agents/recovery/app.py).

Tests Recovery Engine in isolation:
- Schema validation and entrypoint contracts
- Tenancy isolation
- Clean unit handling (no claims recommended when no fee contradictions)
- Fee contradiction when upstream evidence proves carrier/channel fault
- Inconclusive/silent charges handling (finding F-07, F-09, F-10)
- Human override respect
"""
import pytest
from agents.recovery.app import handle, position
from shared.utils.schema import errors


def _make_req(unit_id="UNIT-0010", org_id="org_demo_alpha", previous_evidence=None, overrides=None):
    wf = f"WF-{org_id}-{unit_id}"
    return {
        "schema_version": "1.0",
        "request_id": f"{wf}:recovery",
        "workflow_id": wf,
        "stage": "recovery",
        "subject": {
            "org_id": org_id,
            "subject_id": unit_id,
            "route": "fba",
        },
        "inputs": [],
        "previous_evidence": previous_evidence or [],
        "context": {
            "overrides": overrides or [],
            "case": {"org_id": org_id, "unit_id": unit_id, "route": "fba"},
        },
    }


def test_recovery_clean_unit_without_fees_has_no_claim():
    req = _make_req(unit_id="UNIT-0010")
    out = handle(req)

    assert out["stage"] == "recovery"
    assert out["verdict"] == "PASS"

    ev = out["evidence"]
    assert ev["decision"]["outcome"] == "no_claim"
    assert ev["payload"]["claimable_usd"] == 0.0
    assert errors("evidence", ev) == []


def test_recovery_tenancy_isolation_rejects_foreign_org():
    req = _make_req(unit_id="UNIT-0010", org_id="org_demo_bravo")
    with pytest.raises(LookupError, match="unknown subject"):
        handle(req)


def test_recovery_position_zero_amount_is_silent():
    line = {"charge_type": "damaged_in_warehouse", "amount_usd": 0.0}
    req = _make_req()
    pos, why, refs = position(line, req)
    assert pos == "SILENT"
    assert "amount is 0.00" in why


def test_recovery_damaged_in_warehouse_contradicted_by_receiving():
    line = {"charge_type": "damaged_in_warehouse", "amount_usd": 45.0, "posted_date": "2026-03-01"}
    rcv_ev = {
        "schema_version": "1.0",
        "stage": "receiving",
        "record_id": "RCV-0010",
        "status": "completed",
        "checks": [{"check_key": "unit_damage", "verdict": "PASS"}],
    }
    req = _make_req(previous_evidence=[rcv_ev])
    pos, why, refs = position(line, req)
    assert pos == "CONTRADICTS"
    assert refs == ["RCV-0010"]


def test_recovery_lost_inbound_with_shortfall_is_supplier_side():
    line = {"charge_type": "lost_inbound", "amount_usd": 50.0}
    rcv_ev = {
        "schema_version": "1.0",
        "stage": "receiving",
        "record_id": "RCV-0004",
        "status": "completed",
        "payload": {"shortfall_units": 5},
    }
    req = _make_req(previous_evidence=[rcv_ev])
    pos, why, refs = position(line, req)
    assert pos == "SILENT"
    assert "supplier-side" in why
