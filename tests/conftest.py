import json
from pathlib import Path

import pytest

from orchestration.orchestrator import flow_stages

ROOT = Path(__file__).resolve().parents[1]
AGENTS = flow_stages()  # the stages in this Pod's flow (pod.json)


@pytest.fixture(scope="session")
def cases():
    return json.loads((ROOT / "data/sample/cases.json").read_text())


@pytest.fixture(autouse=True)
def inproc_by_default(monkeypatch):
    """Tests run in-process unless a test opts into HTTP. Remove this if all your agents are HTTP-only."""
    monkeypatch.setenv("ORCH_MODE", "inproc")


@pytest.fixture(autouse=True)
def offline_by_default(monkeypatch):
    """Ensure tests run offline by default without making live paid API calls."""
    monkeypatch.setenv("GEMINI_OFFLINE", "1")
    for k in ("OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr("agents.pack.gemini.client", None, raising=False)


def applies(stage: str, case: dict) -> bool:
    return {"receiving": True, "recovery": True, "prep": case["route"] == "fba",
            "pack": case["route"] == "mfn", "returns": case["returned"]}[stage]


def make_input(stage: str, case: dict, previous=None, overrides=None) -> dict:
    wf = f"WF-{case['org_id']}-{case['unit_id']}"
    return {"schema_version": "1.0", "request_id": f"{wf}:{stage}", "workflow_id": wf, "stage": stage,
            "subject": {"org_id": case["org_id"], "subject_id": case["unit_id"], "route": case["route"]},
            "inputs": [], "previous_evidence": previous or [], "context": {"overrides": overrides or [], "case": case}}
