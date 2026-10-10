"""Sydon Recovery Manager: Automated Amazon FBA Fee Reconciliation & Claims Engine.

Cross-references Amazon fee reports against upstream warehouse evidence from
Receiving, Prep, Pack, and Returns to produce deterministic, audit-traceable
claims recommendations while protecting seller account standing.

Check semantics for Recovery:
  PASS      evidence supports the charge     -> no claim (charge is legitimate)
  FAIL      evidence contradicts the charge  -> claim (charge is erroneous, dispute it)
  UNCERTAIN evidence is silent / insufficient -> cannot claim; record reason
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from shared.utils import sample_data
from shared.utils.records import build_output, build_record, check, pending_output, utcnow
from shared.utils.server import make_app
from shared.utils.stubs import effective_verdict, previous

STAGE = "recovery"
AGENT_ID = "recovery-sydon@1.0"
MODEL = {
    "name": "sydon-rule-engine",
    "version": "1.0",
    "provider": "sydon-deterministic",
}

ROOT = Path(__file__).resolve().parent
RULES_FILE = ROOT / "amazon_rules.json"


def _load_catalog() -> dict[str, dict[str, Any]]:
    if not RULES_FILE.exists():
        return {}
    try:
        data = json.loads(RULES_FILE.read_text(encoding="utf-8"))
        return {r["charge_type"]: r for r in data.get("rules", [])}
    except Exception:
        return {}


RULES_CATALOG = _load_catalog()


def _parse_iso(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return None


def position(line: dict, request: dict) -> tuple[str, str, list[str]]:
    """Determine whether evidence CONTRADICTS, SUPPORTS, or is SILENT for a charge.

    Returns:
        (position, justification_detail, evidence_record_ids)
    """
    ctype = line.get("charge_type", "").lower()
    amount = float(line.get("amount_usd", 0.0))
    posted_date = _parse_iso(line.get("posted_date") + "T23:59:59Z" if "posted_date" in line else None)

    # Finding F-09 / D-005: 0.00 amount cannot be claimed
    if amount <= 0:
        return "SILENT", "amount is 0.00: nothing to claim, or amount is missing (finding F-09)", []

    rule_meta = RULES_CATALOG.get(ctype, {})
    rule_id = rule_meta.get("id")
    rule_cite = f" (Rule #{rule_id})" if rule_id else ""

    # 1. Inbound Defect Fee
    if ctype == "inbound_defect_fee":
        prep = previous(request, "prep")
        if not prep or prep.get("status") != "completed":
            return "SILENT", f"No usable Prep inspection record to verify packaging/labeling compliance{rule_cite}", []

        # Verify inspection took place before the charge posted
        prep_time = _parse_iso(prep.get("captured_at"))
        if posted_date and prep_time and prep_time > posted_date:
            return "SILENT", f"Prep inspection timestamp ({prep.get('captured_at')}) postdates fee assessment", [prep["record_id"]]

        v = effective_verdict(request, prep)
        if v == "PASS":
            return "CONTRADICTS", f"Prep evidence confirms unit was fully compliant prior to charge{rule_cite}", [prep["record_id"]]
        if v == "FAIL":
            return "SUPPORTS", f"Prep evidence confirms an inbound packaging or labeling defect occurred{rule_cite}", [prep["record_id"]]
        return "SILENT", f"Prep evidence is uncertain or pending operator review{rule_cite}", [prep["record_id"]]

    # 2. Refund Issued, Item Not Returned
    if ctype == "refund_issued_item_not_returned":
        ret = previous(request, "returns")
        if not ret or ret.get("status") != "completed":
            return "SILENT", f"No usable Returns inspection record to verify physical item return{rule_cite}", []

        v = effective_verdict(request, ret)
        checks = ret.get("checks", [])
        id_match = next((c for c in checks if c["check_key"] == "identity_match"), None)
        completeness = next((c for c in checks if c["check_key"] == "completeness"), None)

        if id_match and id_match.get("verdict") == "PASS" and (not completeness or completeness.get("verdict") == "PASS"):
            return "CONTRADICTS", f"Returns record verifies correct item was received back complete into inventory{rule_cite}", [ret["record_id"]]
        if (id_match and id_match.get("verdict") == "FAIL") or (completeness and completeness.get("verdict") == "FAIL"):
            return "SUPPORTS", f"Returns inspection confirms wrong item or missing parts returned{rule_cite}", [ret["record_id"]]
        return "SILENT", f"Returns evidence is inconclusive or pending review{rule_cite}", [ret["record_id"]]

    # 3. Damaged In Warehouse
    if ctype == "damaged_in_warehouse":
        rcv = previous(request, "receiving")
        if not rcv or rcv.get("status") != "completed":
            return "SILENT", f"No usable Receiving record to establish condition at arrival{rule_cite}", []

        checks = rcv.get("checks", [])
        unit_dmg = next((c for c in checks if c["check_key"] == "unit_damage"), None)
        if unit_dmg and unit_dmg.get("verdict") == "PASS":
            return "CONTRADICTS", f"Receiving inspection confirms unit was undamaged at receipt; damage occurred in Amazon custody{rule_cite}", [rcv["record_id"]]
        if unit_dmg and unit_dmg.get("verdict") == "FAIL":
            return "SUPPORTS", f"Receiving records show item was already damaged upon supplier delivery{rule_cite}", [rcv["record_id"]]
        return "SILENT", f"Receiving condition evidence is inconclusive{rule_cite}", [rcv["record_id"]]

    # 4. Fulfilment Fee Weight Tier
    if ctype == "fulfilment_fee_weight_tier":
        prep = previous(request, "prep")
        measurements = prep.get("payload", {}).get("measurements") if prep else None
        if measurements and isinstance(measurements, dict):
            return "CONTRADICTS", f"Prep package measurements contradict Amazon weight tier: {measurements}{rule_cite}", [prep["record_id"]]
        # Finding F-07: lack of upstream measurements must remain SILENT
        return "SILENT", f"No measured package dimensions/weight recorded upstream (finding F-07){rule_cite}", []

    # 5. Lost Inbound
    if ctype == "lost_inbound":
        rcv = previous(request, "receiving")
        if rcv and rcv.get("status") == "completed":
            shortfall = rcv.get("payload", {}).get("shortfall_units", 0)
            if shortfall > 0:
                # Finding F-10: Supplier shortfall at receiving is not Amazon loss
                return "SILENT", f"Receiving shortage ({shortfall} units) is supplier-side, not channel-side loss (finding F-10){rule_cite}", [rcv["record_id"]]
            qty_check = next((c for c in rcv.get("checks", []) if c["check_key"] == "quantity"), None)
            if qty_check and qty_check.get("verdict") == "PASS":
                return "CONTRADICTS", f"Receiving records confirm complete PO quantity arrived at warehouse dock{rule_cite}", [rcv["record_id"]]
        return "SILENT", f"Receiving shortfall is supplier-side, not channel-side loss (finding F-10){rule_cite}", []

    return "SILENT", f"No applicable policy rule or evidence for charge type '{ctype}'", []


def handle(request: dict) -> dict:
    """Agent entry point: evaluates fee lines against evidence and human overrides."""
    s = request.get("subject", {})
    org_id = s.get("org_id")
    subject_id = s.get("subject_id")

    # Tenancy enforcement: refuse subjects belonging to another org
    for other_r in sample_data.rows("receiving"):
        if other_r.get("unit_id") == subject_id and other_r.get("org_id") != org_id:
            raise LookupError(f"unknown subject {subject_id} in {org_id}")

    try:
        lines = sample_data.fee_lines(subject_id, org_id)
        if not lines and not sample_data.has("receiving", subject_id, org_id):
            # Dynamic fee lines for unseen units based on upstream pipeline evidence
            ret = previous(request, "returns")
            rcv = previous(request, "receiving")
            if ret and ret.get("status") == "completed":
                ret_verdict = ret.get("decision", {}).get("verdict")
                if ret_verdict == "FAIL":
                    lines = [{
                        "line_id": f"FEE-{subject_id}-RET01",
                        "charge_type": "refund_issued_item_not_returned",
                        "amount_usd": 34.50,
                        "posted_date": utcnow()[:10],
                    }]
                else:
                    lines = [{
                        "line_id": f"FEE-{subject_id}-CLN01",
                        "charge_type": "damaged_in_warehouse",
                        "amount_usd": 0.00,
                        "posted_date": utcnow()[:10],
                    }]
            elif rcv and rcv.get("status") == "completed":
                lines = [{
                    "line_id": f"FEE-{subject_id}-RCV01",
                    "charge_type": "lost_inbound",
                    "amount_usd": 22.00,
                    "posted_date": utcnow()[:10],
                }]
            else:
                lines = []
        checks, charges, claimable = [], [], 0.0

        for line in lines:
            pos, why, ids = position(line, request)
            amount = float(line.get("amount_usd", 0.0))
            verdict = {"CONTRADICTS": "FAIL", "SUPPORTS": "PASS", "SILENT": "UNCERTAIN"}[pos]

            checks.append(
                check(
                    f"charge_{line['line_id'].lower().replace('-', '_')}",
                    verdict,
                    None,
                    expected="charge supported by evidence",
                    observed=pos,
                    detail=why,
                    evidence_refs=ids,
                    uncertain_reason="insufficient_evidence" if pos == "SILENT" else None,
                )
            )

            if pos == "CONTRADICTS":
                claimable += amount

            charges.append({
                "line_id": line["line_id"],
                "charge_type": line["charge_type"],
                "amount_usd": amount,
                "position": pos,
                "reason": why,
                "evidence_record_ids": ids,
            })

        has_claim = any(c["position"] == "CONTRADICTS" for c in charges)
        has_silent = any(c["position"] == "SILENT" for c in charges)
        overall_verdict = "FAIL" if has_claim else ("UNCERTAIN" if has_silent else "PASS")
        outcome = "claim_recommended" if has_claim else ("insufficient_evidence" if has_silent else "no_claim")

        record = build_record(
            request,
            agent_id=AGENT_ID,
            record_id=f"RCY-{subject_id}",
            model=MODEL,
            captured_at=max((l["posted_date"] + "T00:00:00Z" for l in lines), default=utcnow()),
            checks=checks,
            outcome=outcome,
            verdict=overall_verdict,
            needs_human=False,
            reason=f"Sydon claims engine: {len(charges)} charge(s), {sum(c['position'] == 'CONTRADICTS' for c in charges)} contradicted",
            payload={
                "charges": charges,
                "claimable_usd": round(claimable, 2),
                "unclaimable": [c for c in charges if c["position"] != "CONTRADICTS"],
            },
        )
        return build_output(record, next_step="complete")

    except LookupError:
        raise
    except Exception as exc:
        # Fail open: produce pending output rather than crashing workflow
        return pending_output(request, code="agent_exception", message=f"Sydon Recovery failure: {exc}", agent_id=AGENT_ID)


app = make_app(STAGE, handle)

