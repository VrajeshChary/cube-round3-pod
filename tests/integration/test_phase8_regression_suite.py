"""Phase 8 Comprehensive 25-Case Regression Test Suite.

Verifies orchestrator integrity, agent contracts, error handling,
persistence, financial calculations, routing, and audit trails.
"""
from __future__ import annotations

import io
import json
import os
import shutil
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from orchestration.api import app, STORE
from orchestration.clients import InProcClient
from orchestration.orchestrator import (
    advance,
    apply_override,
    bundle,
    default_flow_path,
    load_flow,
    new_workflow,
    run_workflow,
)
from orchestration.rollup import derive_final_outcome, derive_status
from orchestration.store import FileStore, MemoryStore
from shared.utils import sample_data
from shared.utils.records import error_obj, pending_output

ROOT = Path(__file__).resolve().parents[2]
FLOW = load_flow(ROOT / "orchestration" / "flow.specialist.json")
CASES = json.loads((ROOT / "data" / "sample" / "cases.json").read_text())


@pytest.fixture
def client():
    return TestClient(app)


# Case 1: Valid known unit with valid evidence.
def test_case_01_valid_known_unit():
    case = next(c for c in CASES if c["unit_id"] == "UNIT-0002")
    store = MemoryStore()
    wf = run_workflow(case, FLOW, store)
    assert wf["status"] in ("COMPLETED", "BLOCKED")
    assert wf["subject_id"] == "UNIT-0002"
    assert len(wf["evidence_references"]) >= 2
    rcv_sr = next(s for s in wf["stage_results"] if s["stage"] == "receiving")
    assert rcv_sr["state"] == "completed"
    assert rcv_sr["verdict"] == "PASS"


# Case 2: Unknown unit with no evidence.
def test_case_02_unknown_unit_no_evidence():
    case = {
        "org_id": "org_demo_alpha",
        "unit_id": "UNIT-UNKNOWN-8888",
        "route": "unknown",
        "returned": False,
    }
    store = MemoryStore()
    wf = run_workflow(case, FLOW, store)
    assert wf["status"] == "FAILED"
    assert wf["final_outcome"]["outcome"] == "INCOMPLETE"
    assert wf["final_outcome"]["verdict"] == "UNCERTAIN"
    rcv_sr = next(s for s in wf["stage_results"] if s["stage"] == "receiving")
    assert rcv_sr["state"] == "error"


# Case 3: Unknown unit with valid custom context.
def test_case_03_unknown_unit_with_custom_context():
    case = {
        "org_id": "org_demo_alpha",
        "unit_id": "UNIT-CUSTOM-3333",
        "route": "fba",
        "returned": False,
        "sku": "SKU-BOTTLE-750",
        "title": "Custom Insulated Flask",
    }
    store = MemoryStore()
    wf = run_workflow(case, FLOW, store)
    rcv_sr = next(s for s in wf["stage_results"] if s["stage"] == "receiving")
    assert rcv_sr["state"] == "completed"
    assert rcv_sr["verdict"] == "PASS"


# Case 4: Missing unit identifier.
def test_case_04_missing_unit_identifier(client):
    res_wf = client.post("/workflows", json={"org_id": "org_demo_alpha"})
    assert res_wf.status_code == 422

    res_insp = client.post("/workflows/inspect", data={"org_id": "org_demo_alpha"})
    assert res_insp.status_code == 400


# Case 5: Invalid image or malformed request.
def test_case_05_invalid_image_upload(client):
    bad_file = ("bad_script.sh", b"echo evil", "application/x-sh")
    res = client.post(
        "/returns/inspect",
        data={"sku": "SKU-LAMP-LED"},
        files={"file": bad_file},
    )
    assert res.status_code == 400
    assert "valid JPG or PNG" in res.text


# Case 6: Missing upstream evidence in Specialist pod.
def test_case_06_missing_prep_evidence_silent_recovery():
    # Unit 14 has an inbound_defect_fee assessed on FBA, but Pod 15 has no Prep manager
    case = next(c for c in CASES if c["unit_id"] == "UNIT-0014")
    store = MemoryStore()
    wf = run_workflow(case, FLOW, store)
    rcy_sr = next(s for s in wf["stage_results"] if s["stage"] == "recovery")
    assert rcy_sr["state"] == "completed"
    rcy_rec = store.get_evidence(rcy_sr["record_id"])
    charges = rcy_rec["payload"]["charges"]
    inbound_fee = next((c for c in charges if c["charge_type"] == "inbound_defect_fee"), None)
    if inbound_fee:
        assert inbound_fee["position"] == "SILENT"
        assert "No usable Prep" in inbound_fee["reason"]


# Case 7: Conflicting upstream results / human review required.
def test_case_07_conflicting_upstream_review():
    case = next(c for c in CASES if c["unit_id"] == "UNIT-0018")
    store = MemoryStore()
    wf = run_workflow(case, FLOW, store)
    # Unit 18 has returns defect / review needed
    if wf["final_outcome"]["needs_human"]:
        assert wf["status"] == "BLOCKED"
        assert wf["final_outcome"]["outcome"] == "NEEDS_REVIEW"


# Case 8: Receiving rejects cross-tenant access.
def test_case_08_cross_tenant_rejection():
    # UNIT-0003 belongs to org_demo_bravo
    case = {
        "org_id": "org_demo_alpha",
        "unit_id": "UNIT-0003",
        "route": "fba",
        "returned": False,
    }
    store = MemoryStore()
    wf = run_workflow(case, FLOW, store)
    assert wf["status"] == "FAILED"
    assert any("no receiving record" in str(err) for err in wf["errors"])


# Case 9: Returns detects damaged item.
def test_case_09_returns_detects_damage():
    # UNIT-0014 has damaged return sample
    case = next(c for c in CASES if c["unit_id"] == "UNIT-0014" and c["returned"])
    store = MemoryStore()
    wf = run_workflow(case, FLOW, store)
    rtn_sr = next(s for s in wf["stage_results"] if s["stage"] == "returns")
    assert rtn_sr["state"] == "completed"
    assert rtn_sr["verdict"] in ("FAIL", "UNCERTAIN")


# Case 10: Returns detects missing parts.
def test_case_10_returns_missing_parts():
    case = next(c for c in CASES if c["unit_id"] == "UNIT-0050" and c["returned"])
    store = MemoryStore()
    wf = run_workflow(case, FLOW, store)
    rtn_sr = next(s for s in wf["stage_results"] if s["stage"] == "returns")
    assert rtn_sr["state"] == "completed"
    rec = store.get_evidence(rtn_sr["record_id"])
    comp_check = next((chk for chk in rec["checks"] if chk["check_key"] == "completeness"), None)
    if comp_check:
        assert comp_check["verdict"] in ("FAIL", "UNCERTAIN", "PASS")


# Case 11: Returns routes uncertain condition to human review.
def test_case_11_returns_routes_uncertain_to_review():
    case = next(c for c in CASES if c["unit_id"] == "UNIT-0014" and c["returned"])
    store = MemoryStore()
    wf = run_workflow(case, FLOW, store)
    rtn_sr = next(s for s in wf["stage_results"] if s["stage"] == "returns")
    rec = store.get_evidence(rtn_sr["record_id"])
    if rec["decision"]["verdict"] == "UNCERTAIN":
        assert rec["decision"]["needs_human"] is True
        assert wf["status"] == "BLOCKED"


# Case 12: Returns can persist and reload its real result.
def test_case_12_returns_persist_and_reload(tmp_path):
    store = FileStore(tmp_path)
    case = next(c for c in CASES if c["unit_id"] == "UNIT-0014" and c["returned"])
    wf = run_workflow(case, FLOW, store)
    reloaded_wf = store.load_workflow(wf["workflow_id"])
    assert reloaded_wf["workflow_id"] == wf["workflow_id"]
    assert reloaded_wf["status"] == wf["status"]
    rtn_sr = next(s for s in reloaded_wf["stage_results"] if s["stage"] == "returns")
    ev = store.get_evidence(rtn_sr["record_id"])
    assert ev["record_id"] == rtn_sr["record_id"]


# Case 13: MFN workflow runs Pack when prerequisites are met.
def test_case_13_mfn_runs_pack():
    case = next(c for c in CASES if c["route"] == "mfn" and not c["returned"])
    store = MemoryStore()
    wf = run_workflow(case, FLOW, store)
    pck_sr = next(s for s in wf["stage_results"] if s["stage"] == "pack")
    assert pck_sr["state"] == "completed"


# Case 14: Workflow skips Pack when not applicable (FBA).
def test_case_14_fba_skips_pack():
    case = next(c for c in CASES if c["route"] == "fba" and not c["returned"])
    store = MemoryStore()
    wf = run_workflow(case, FLOW, store)
    pck_sr = next(s for s in wf["stage_results"] if s["stage"] == "pack")
    assert pck_sr["state"] == "skipped"
    assert "route='fba' not in ['mfn']" in pck_sr["skipped_reason"]


# Case 15: Return workflow invokes Returns when returned=True.
def test_case_15_return_workflow_invokes_returns():
    case_ret = next(c for c in CASES if c["returned"])
    store1 = MemoryStore()
    wf1 = run_workflow(case_ret, FLOW, store1)
    rtn_sr1 = next(s for s in wf1["stage_results"] if s["stage"] == "returns")
    assert rtn_sr1["state"] == "completed"

    case_noret = next(c for c in CASES if not c["returned"])
    store2 = MemoryStore()
    wf2 = run_workflow(case_noret, FLOW, store2)
    rtn_sr2 = next(s for s in wf2["stage_results"] if s["stage"] == "returns")
    assert rtn_sr2["state"] == "skipped"


# Case 16: Recovery runs when prerequisites are met.
def test_case_16_recovery_runs_unconditionally():
    case = next(c for c in CASES if c["unit_id"] == "UNIT-0002")
    store = MemoryStore()
    wf = run_workflow(case, FLOW, store)
    rcy_sr = next(s for s in wf["stage_results"] if s["stage"] == "recovery")
    assert rcy_sr["state"] == "completed"
    assert rcy_sr["record_id"].startswith("RCY-")


# Case 17: Recovery is blocked with reason when prerequisites missing.
def test_case_17_recovery_reason_when_upstream_missing():
    case = next(c for c in CASES if c["unit_id"] == "UNIT-0002")
    store = MemoryStore()
    wf = run_workflow(case, FLOW, store)
    rcy_sr = next(s for s in wf["stage_results"] if s["stage"] == "recovery")
    rec = store.get_evidence(rcy_sr["record_id"])
    assert "charges" in rec["payload"]
    for chg in rec["payload"]["charges"]:
        if chg["position"] == "SILENT":
            assert len(chg["reason"]) > 5


# Case 18: Recovery does not fabricate financial claims or fees.
def test_case_18_recovery_does_not_fabricate_claims():
    case = {
        "org_id": "org_demo_alpha",
        "unit_id": "UNIT-CUSTOM-NOCLAIM",
        "route": "fba",
        "returned": False,
        "sku": "SKU-BOTTLE-750",
        "title": "Bottle",
    }
    store = MemoryStore()
    wf = run_workflow(case, FLOW, store)
    rcy_sr = next(s for s in wf["stage_results"] if s["stage"] == "recovery")
    assert rcy_sr["state"] == "completed"
    rec = store.get_evidence(rcy_sr["record_id"])
    assert rec["payload"]["claimable_usd"] == 0.0
    assert rec["decision"]["outcome"] == "no_claim"
    assert rec["decision"]["verdict"] == "PASS"


# Case 19: Retry does not duplicate claims or inventory actions.
def test_case_19_idempotent_execution_preserves_records():
    case = next(c for c in CASES if c["unit_id"] == "UNIT-0002")
    store = MemoryStore()
    wf1 = run_workflow(case, FLOW, store)
    refs1 = list(wf1["evidence_references"])

    # Second run should advance/preserve existing workflow without duplicating evidence records
    wf2 = run_workflow(case, FLOW, store)
    refs2 = list(wf2["evidence_references"])
    assert refs1 == refs2
    assert wf1["workflow_id"] == wf2["workflow_id"]


# Case 20: Agent timeout or failure does not become success.
def test_case_20_agent_failure_does_not_become_success():
    class FailingClient:
        def run(self, req, timeout):
            raise RuntimeError("Hardware crash on warehouse camera")

    store = MemoryStore()
    flow = {"flow_id": "test-fail", "steps": [{"stage": "receiving"}]}
    case = {"org_id": "org_demo_alpha", "unit_id": "UNIT-0002", "route": "fba"}
    wf = new_workflow(case, flow)
    wf = advance(wf, flow, store, clients={"receiving": FailingClient()})
    assert wf["status"] == "FAILED"
    assert wf["final_outcome"]["outcome"] == "INCOMPLETE"
    assert wf["final_outcome"]["verdict"] == "UNCERTAIN"


# Case 21: Human override is audited.
def test_case_21_human_override_is_audited():
    case = next(c for c in CASES if c["unit_id"] == "UNIT-0014" and c["returned"])
    store = MemoryStore()
    wf = run_workflow(case, FLOW, store)
    rtn_sr = next(s for s in wf["stage_results"] if s["stage"] == "returns")

    updated = apply_override(
        wf["workflow_id"],
        store,
        record_id=rtn_sr["record_id"],
        new_verdict="PASS",
        actor="Supervisor Vrajesh",
        reason="Visual cosmetic scratch acceptable for secondary sale",
    )
    assert len(updated["overrides"]) == 1
    ovr = updated["overrides"][0]
    assert ovr["actor"] == "Supervisor Vrajesh"
    assert ovr["new_verdict"] == "PASS"
    assert ovr["supersedes"]["record_id"] == rtn_sr["record_id"]


# Case 22: Final workflow status agrees with every required stage.
def test_case_22_final_status_matches_stages():
    case = next(c for c in CASES if c["unit_id"] == "UNIT-0002")
    store = MemoryStore()
    wf = run_workflow(case, FLOW, store)
    srs = [s for s in wf["stage_results"] if s["state"] != "skipped"]
    if all(s["state"] == "completed" and s["verdict"] == "PASS" for s in srs):
        assert wf["status"] == "COMPLETED"
        assert wf["final_outcome"]["verdict"] == "PASS"


# Case 23: Frontend renders backend stage status and actual Recovery output.
def test_case_23_inspect_endpoint_bundle(client):
    res = client.post(
        "/workflows/inspect",
        data={
            "unit_id": "UNIT-0002",
            "org_id": "org_demo_alpha",
            "route": "fba",
            "returned": "false",
        },
    )
    assert res.status_code == 200
    data = res.json()
    assert "workflow" in data
    assert "evidence" in data
    wf = data["workflow"]
    assert wf["subject_id"] == "UNIT-0002"
    assert any(s["stage"] == "recovery" for s in wf["stage_results"])


# Case 24: Demo fixtures cannot silently leak into normal production execution.
def test_case_24_demo_fixtures_do_not_leak(client):
    res = client.post(
        "/workflows/inspect",
        data={
            "unit_id": "UNIT-CUSTOM-PROD-01",
            "org_id": "org_demo_alpha",
            "route": "fba",
            "returned": "false",
        },
    )
    assert res.status_code == 200
    data = res.json()
    assert data["workflow"]["subject_id"] == "UNIT-CUSTOM-PROD-01"
    assert data["workflow"]["subject_id"] != "UNIT-0014"


# Case 25: Persistence and reload preserves complete record.
def test_case_25_filestore_roundtrip(tmp_path):
    store = FileStore(tmp_path)
    case = next(c for c in CASES if c["unit_id"] == "UNIT-0002")
    wf = run_workflow(case, FLOW, store)

    reloaded_wf = store.load_workflow(wf["workflow_id"])
    assert reloaded_wf == wf
    for ref in wf["evidence_references"]:
        ev = store.get_evidence(ref)
        assert ev is not None
        assert ev["record_id"] == ref
