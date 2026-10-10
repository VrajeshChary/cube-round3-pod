"""Optional HTTP front door for the orchestrator (useful for a deployed demo).

  uvicorn orchestration.api:app --port 8100
  POST /workflows                 {"org_id": "org_demo_alpha", "unit_id": "UNIT-0002"}   -> Workflow State (runs it)
  GET  /workflows/{id}            -> Workflow State
  GET  /workflows/{id}/evidence   -> the workflow plus all its evidence records
  POST /workflows/{id}/resume     -> continue after a halt / decision / failure
  POST /workflows/{id}/overrides  {"record_id": "...", "new_verdict": "PASS", "actor": "...", "reason": "..."}
  GET  /health                    -> orchestrator and every agent in the flow
No authentication is included. Add it before you deploy anywhere public.
"""
from __future__ import annotations

import csv
import hashlib
import json
import os
import shutil
import time
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

from agents.returns.core.catalog import (
    get_product,
    get_product_by_asin,
    get_product_by_sku,
    list_catalogue_products,
)
from shared.utils import sample_data

from .clients import HttpClient, client_for, load_manifest
from .orchestrator import (
    ROOT,
    advance,
    apply_override,
    bundle,
    default_flow_path,
    flow_stages,
    load_flow,
    new_workflow,
    resume,
    run_workflow,
)
from .store import EvidenceConflict, FileStore

app = FastAPI(title="CUBE Round 3 orchestrator")

# Configure CORS for local development and deployed frontend origins (e.g. Vercel)
raw_cors = os.environ.get("CORS_ORIGINS", "")
cors_origins = [o.strip() for o in raw_cors.split(",") if o.strip()]
if not cors_origins:
    cors_origins = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
        "http://localhost:5175",
        "http://127.0.0.1:5175",
        "http://localhost:3000",
        "http://localhost:8100",
        "http://127.0.0.1:8100",
    ]

# Allow any local development origin (Vite/React on any port) and Vercel production/preview deployments
cors_regex = r"^https?:\/\/(localhost|127\.0\.0\.1)(:[0-9]+)?$|^https:\/\/.*\.vercel\.app$"

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_origin_regex=cors_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

FLOW = os.environ.get("ORCH_FLOW") or default_flow_path()
STORE = FileStore()


@app.get("/")
@app.head("/")
def root() -> dict:
    return {
        "name": "CUBE Round 3 Orchestrator",
        "status": "online",
        "pod": "pod-15 (Specialist)",
        "docs": "/docs",
        "health": "/health",
    }


@app.get("/health")
@app.head("/health")
def health() -> dict:
    agents = {}
    for stage in flow_stages(load_flow(FLOW)):
        client = client_for(stage)
        try:
            agents[stage] = client.health() if isinstance(client, HttpClient) else {"status": "ok", "mode": "inproc"}
        except Exception as exc:
            agents[stage] = {"status": "down", "error": str(exc)[:200], "owner": load_manifest(stage)["owner"]}
    ok = all(a["status"] == "ok" for a in agents.values())
    return {"status": "ok" if ok else "degraded", "flow": load_flow(FLOW)["flow_id"], "agents": agents}


@app.get("/pod")
def pod_info() -> dict:
    pod = ROOT / "pod.json"
    if pod.exists():
        import json
        return json.loads(pod.read_text())
    return {"pod_type": "specialist", "flow": "orchestration/flow.specialist.json"}


@app.get("/flow")
def flow_info() -> dict:
    return load_flow(FLOW)


@app.post("/workflows")
def create(body: dict) -> dict:
    org, subject = body.get("org_id"), body.get("subject_id") or body.get("unit_id")
    if not org or not subject:
        raise HTTPException(422, "org_id and unit_id (or subject_id) are required")
    case = {"org_id": org, "unit_id": subject, "route": body.get("route") or sample_data.route(subject, org),
            "returned": body.get("returned", sample_data.has("returns", subject, org))}
    try:
        return run_workflow(case, load_flow(FLOW), STORE)
    except EvidenceConflict as exc:
        raise HTTPException(409, f"Evidence conflict: {exc}") from exc
    except Exception as exc:
        raise HTTPException(500, f"Workflow execution failed: {exc}") from exc


@app.post("/workflows/inspect")
async def inspect_workflow_with_images(
    file: UploadFile | None = File(None),
    files: list[UploadFile] = File(None),
    org_id: str | None = Form(None),
    unit_id: str | None = Form(None),
    route: str | None = Form(None),
    returned: str | None = Form(None),
    stage_tags: str | None = Form(None),
) -> dict:
    """Accept multimodal image captures, route to respective agent input folders, and run full workflow."""
    if not unit_id or not unit_id.strip():
        raise HTTPException(400, "unit_id is required")
    input_root = Path(os.environ.get("INPUT_DIR", ROOT / "data" / "input"))
    target_unit_id = unit_id.strip()
    target_org_id = (org_id or "org_demo_alpha").strip()
    target_route = route.strip() if route and route != "auto" else sample_data.route(target_unit_id, target_org_id)

    if returned is None or str(returned).lower() == "auto":
        is_returned = sample_data.has("returns", target_unit_id, target_org_id)
    else:
        is_returned = str(returned).lower() in ("true", "1", "yes")

    uploaded_files: list[UploadFile] = []
    if file and file.filename:
        uploaded_files.append(file)
    if files:
        for f in files:
            if f and f.filename and f not in uploaded_files:
                uploaded_files.append(f)

    # Parse stage mapping if provided
    stage_mapping = {}
    if stage_tags:
        try:
            stage_mapping = json.loads(stage_tags)
        except Exception:
            pass

    for idx, up_file in enumerate(uploaded_files):
        fname = up_file.filename or f"upload_{idx}.jpg"
        ext = Path(fname).suffix.lower()
        if ext not in [".jpg", ".jpeg", ".png", ".webp", ".heic"]:
            continue

        lower_name = fname.lower()
        target_stage = stage_mapping.get(fname)
        if not target_stage:
            if any(k in lower_name for k in ("pack", "box")):
                target_stage = "pack"
            elif any(k in lower_name for k in ("return", "damage", "chassis", "scratch")):
                target_stage = "returns"
            elif any(k in lower_name for k in ("receiving", "carton", "dock", "intake")):
                target_stage = "receiving"
            else:
                target_stage = "returns" if is_returned else "receiving"

        stage_dir = input_root / target_unit_id / target_stage
        stage_dir.mkdir(parents=True, exist_ok=True)
        safe_name = Path(fname).name
        target_path = stage_dir / safe_name
        contents = await up_file.read()
        target_path.write_bytes(contents)

    case = {
        "org_id": target_org_id,
        "unit_id": target_unit_id,
        "route": target_route,
        "returned": is_returned,
    }
    try:
        wf_res = run_workflow(case, load_flow(FLOW), STORE)
        return bundle(wf_res, STORE)
    except EvidenceConflict as exc:
        raise HTTPException(409, f"Evidence conflict: {exc}") from exc
    except Exception as exc:
        raise HTTPException(500, f"Workflow execution failed: {exc}") from exc


def _get(workflow_id: str) -> dict:
    wf = STORE.load_workflow(workflow_id)
    if wf is None:
        raise HTTPException(404, f"no workflow {workflow_id}")
    return wf


@app.get("/workflows/{workflow_id}")
def get(workflow_id: str) -> dict:
    return _get(workflow_id)


@app.get("/workflows/{workflow_id}/evidence")
def evidence(workflow_id: str) -> dict:
    return bundle(_get(workflow_id), STORE)


@app.post("/workflows/{workflow_id}/resume")
def resume_workflow(workflow_id: str) -> dict:
    _get(workflow_id)
    return resume(workflow_id, load_flow(FLOW), STORE)


@app.post("/workflows/{workflow_id}/overrides")
def override(workflow_id: str, body: dict) -> dict:
    _get(workflow_id)
    try:
        return apply_override(workflow_id, STORE, record_id=body.get("record_id", ""), new_verdict=body.get("new_verdict", ""),
                              actor=body.get("actor", ""), reason=body.get("reason", ""), new_outcome=body.get("new_outcome"))
    except (ValueError, EvidenceConflict) as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get("/returns/catalog")
def return_catalog() -> list[dict]:
    """Expose product catalogue for UI product-selection dropdown."""
    return [
        {
            "sku": prod.sku,
            "asin": prod.asin,
            "title": prod.title,
            "display_name": prod.display_name or prod.title,
            "category": prod.category,
            "expected_parts": prod.expected_parts,
            "critical_parts": prod.critical_parts,
            "description": prod.description,
            "brand": prod.brand,
        }
        for prod in list_catalogue_products()
    ]


@app.get("/returns/warehouse-records")
def return_warehouse_records() -> list[dict]:
    """Expose warehouse sample returns records from returns_sample.csv."""
    csv_path = ROOT / "data" / "sample" / "returns_sample.csv"
    if not csv_path.is_file():
        return []
    input_root = Path(os.environ.get("INPUT_DIR", ROOT / "data" / "input"))
    records = []
    with open(csv_path, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            unit_id = row.get("unit_id", "")
            ordered_sku = row.get("ordered_sku", "")
            ordered_asin = row.get("ordered_asin", "")
            prod = get_product_by_sku(ordered_sku) or get_product_by_asin(ordered_asin)

            # Check physical captures on disk for this unit
            available_images = []
            unit_returns_dir = input_root / unit_id / "returns"
            unit_backup_dir = input_root / unit_id / "returns_samples_backup"
            check_dir = unit_backup_dir if unit_backup_dir.is_dir() else unit_returns_dir
            if check_dir.is_dir():
                for p in sorted(check_dir.iterdir()):
                    if p.is_file() and not p.name.startswith("."):
                        available_images.append({
                            "filename": p.name,
                            "url": f"/returns/image/{unit_id}/{p.name}",
                            "size_bytes": p.stat().st_size,
                        })

            records.append({
                "record_id": row.get("record_id", ""),
                "unit_id": unit_id,
                "org_id": row.get("org_id", "org_demo_alpha"),
                "order_id": row.get("order_id", ""),
                "sku": ordered_sku,
                "asin": ordered_asin,
                "product_name": prod.title if prod else ordered_sku,
                "display_name": prod.display_name if prod and prod.display_name else (prod.title if prod else ordered_sku),
                "category": prod.category if prod else "General Merchandise",
                "expected_components": prod.expected_parts if prod else [p.strip() for p in (row.get("parts_list") or "").split(";") if p.strip()],
                "parts_missing": [p.strip() for p in (row.get("parts_missing") or "").split(";") if p.strip()],
                "observed_state": row.get("observed_state", ""),
                "operator_disposition": row.get("operator_disposition", ""),
                "photo_refs": [p.strip() for p in (row.get("photo_refs") or "").split(";") if p.strip()],
                "images_available": len(available_images) > 0,
                "available_images": available_images,
                "operator_id": row.get("operator_id", ""),
                "captured_at": row.get("captured_at", ""),
            })
    return records


@app.get("/returns/samples")
def return_samples() -> list[dict]:
    input_root = Path(os.environ.get("INPUT_DIR", ROOT / "data" / "input"))
    returns_dir = input_root / "UNIT-0014" / "returns"
    backup_dir = input_root / "UNIT-0014" / "returns_samples_backup"
    source_dir = backup_dir if backup_dir.is_dir() else returns_dir
    if not source_dir.is_dir():
        return []
    items = []
    for p in sorted(source_dir.iterdir()):
        if p.is_file() and not p.name.startswith("."):
            items.append({
                "filename": p.name,
                "size_bytes": p.stat().st_size,
                "url": f"/returns/image/UNIT-0014/{p.name}",
            })
    return items


@app.get("/returns/image/{filename}")
@app.get("/api/returns/image/{filename}")
def return_image_default(filename: str):
    return return_image(unit_id="UNIT-0014", filename=filename)


@app.get("/returns/image/{unit_id}/{filename}")
@app.get("/api/returns/image/{unit_id}/{filename}")
def return_image(unit_id: str, filename: str):
    input_root = Path(os.environ.get("INPUT_DIR", ROOT / "data" / "input")).resolve()
    target = (input_root / unit_id / "returns" / filename).resolve()
    if not target.is_file():
        target = (input_root / unit_id / "returns_samples_backup" / filename).resolve()
    if not target.is_file():
        raise HTTPException(404, f"Image {filename} for unit {unit_id} not found")
    try:
        target.relative_to(input_root)
    except ValueError:
        raise HTTPException(403, "Access denied")

    suffix = target.suffix.lower()
    media_type = "image/png" if suffix == ".png" else "image/jpeg"
    return FileResponse(path=str(target), media_type=media_type)


@app.post("/returns/inspect")
async def inspect_return(
    file: UploadFile | None = File(None),
    files: list[UploadFile] = File(None),
    unit_id: str | None = Form(None),
    sku: str | None = Form(None),
    asin: str | None = Form(None),
    order_id: str | None = Form(None),
    org_id: str | None = Form(None),
    title: str | None = Form(None),
    category: str | None = Form(None),
    expected_parts: str | None = Form(None),
) -> dict:
    input_root = Path(os.environ.get("INPUT_DIR", ROOT / "data" / "input"))

    # Resolve uploaded files
    uploaded_files: list[UploadFile] = []
    if file and file.filename:
        uploaded_files.append(file)
    if files:
        for f in files:
            if f and f.filename and f not in uploaded_files:
                uploaded_files.append(f)

    # Resolve product identity: authoritative expected product
    cat_prod = get_product_by_sku(sku) or get_product_by_asin(asin) or get_product(sku)
    if cat_prod:
        target_sku = cat_prod.sku
        target_asin = asin or cat_prod.asin
        target_title = title or cat_prod.title
        target_category = category or cat_prod.category
        parts_list = list(cat_prod.expected_parts)
    elif sku:
        target_sku = sku.strip()
        target_asin = asin or "B0-CUSTOM"
        target_title = title or target_sku.replace("SKU-", "").replace("-", " ").title()
        target_category = category or "General Merchandise"
        parts_list = []
    elif title:
        target_title = title.strip()
        slug = "".join(c if c.isalnum() else "-" for c in target_title.upper())[:16].strip("-")
        target_sku = f"SKU-{slug}" if slug else "SKU-CUSTOM"
        target_asin = asin or "B0-CUSTOM"
        target_category = category or "General Merchandise"
        parts_list = []
    else:
        # User did not select an item; do NOT fallback to lamp
        raise HTTPException(400, "Select the returned item first to continue.")

    if expected_parts:
        try:
            parsed = json.loads(expected_parts)
            if isinstance(parsed, list):
                parts_list = [str(p) for p in parsed]
        except Exception:
            parts_list = [p.strip() for p in expected_parts.split(";") if p.strip()]

    # Resolve unit and tenant context
    target_unit_id = unit_id.strip() if unit_id and unit_id.strip() else f"UNIT-RET-{hashlib.sha256((target_sku or 'CUSTOM').encode()).hexdigest()[:6].upper()}"
    is_demo_fixture = target_unit_id == "UNIT-0014"
    target_org_id = org_id or "org_demo_alpha"
    target_order_id = order_id or f"ORD-DEMO-{target_unit_id}"

    returns_dir = input_root / target_unit_id / "returns"
    backup_dir = input_root / target_unit_id / "returns_samples_backup"

    # Backup original sample captures once if needed for demo fixture UNIT-0014
    if is_demo_fixture and not backup_dir.is_dir() and returns_dir.is_dir():
        backup_dir.mkdir(parents=True, exist_ok=True)
        for p in returns_dir.iterdir():
            if p.is_file() and not p.name.startswith("."):
                shutil.copy2(p, backup_dir / p.name)

    if uploaded_files:
        # Clear existing returns directory for this unit
        returns_dir.mkdir(parents=True, exist_ok=True)
        for p in returns_dir.iterdir():
            if p.is_file() and not p.name.startswith("."):
                try:
                    p.unlink()
                except OSError:
                    pass

        # Write each uploaded image
        for idx, up_file in enumerate(uploaded_files):
            ext = Path(up_file.filename or "").suffix.lower()
            if ext not in [".jpg", ".jpeg", ".png", ".webp"]:
                raise HTTPException(400, f"Please upload a valid JPG or PNG image. Invalid file: {up_file.filename}")
            safe_name = Path(up_file.filename or f"upload_{idx}.jpg").name
            target_path = returns_dir / safe_name
            contents = await up_file.read()
            target_path.write_bytes(contents)
    else:
        # If no new file uploaded and demo fixture UNIT-0014, ensure samples present
        if is_demo_fixture and backup_dir.is_dir():
            returns_dir.mkdir(parents=True, exist_ok=True)
            for p in backup_dir.iterdir():
                if p.is_file() and not p.name.startswith("."):
                    target = returns_dir / p.name
                    if not target.exists():
                        shutil.copy2(p, target)

    case = {
        "org_id": target_org_id,
        "unit_id": target_unit_id,
        "route": "fba",
        "returned": True,
        "sku": target_sku,
        "asin": target_asin,
        "order_id": target_order_id,
        "title": target_title,
        "product_title": target_title,
        "category": target_category,
        "expected_parts": parts_list,
        "components": parts_list,
    }
    inspect_flow = {"flow_id": "returns-inspection", "steps": [{"stage": "returns"}]}
    wf = new_workflow(case, inspect_flow)
    wf["workflow_id"] = f"WF-INSPECT-{int(time.time()*1000)}"
    try:
        wf = advance(wf, inspect_flow, STORE)
        return bundle(wf, STORE)
    except Exception as exc:
        err_str = str(exc).lower()
        if "429" in err_str or "quota" in err_str or "resource_exhausted" in err_str:
            raise HTTPException(429, "Vision analysis is temporarily unavailable. Human review is required.") from exc
        if "timeout" in err_str or "timed out" in err_str:
            raise HTTPException(504, "Analysis timed out. Please try again.") from exc
        raise HTTPException(500, f"Analysis could not be completed: {exc}") from exc
    finally:
        if is_demo_fixture and backup_dir.is_dir():
            for p in backup_dir.iterdir():
                if p.is_file() and not p.name.startswith("."):
                    target = returns_dir / p.name
                    if not target.exists():
                        shutil.copy2(p, target)


@app.post("/pack/inspect")
async def inspect_pack(
    file: UploadFile | None = File(None),
    files: list[UploadFile] = File(None),
    unit_id: str | None = Form(None),
    sku: str | None = Form(None),
    org_id: str | None = Form(None),
) -> dict:
    input_root = Path(os.environ.get("INPUT_DIR", ROOT / "data" / "input"))

    uploaded_files: list[UploadFile] = []
    if file and file.filename:
        uploaded_files.append(file)
    if files:
        for f in files:
            if f and f.filename and f not in uploaded_files:
                uploaded_files.append(f)

    target_unit_id = unit_id or "UNIT-0008"
    target_org_id = org_id or "org_demo_alpha"
    target_sku = sku or "SKU-BOTTLE-750"

    pack_dir = input_root / target_unit_id / "pack"
    backup_dir = input_root / target_unit_id / "pack_samples_backup"

    if not backup_dir.is_dir() and pack_dir.is_dir():
        backup_dir.mkdir(parents=True, exist_ok=True)
        for p in pack_dir.iterdir():
            if p.is_file() and not p.name.startswith("."):
                shutil.copy2(p, backup_dir / p.name)

    if uploaded_files:
        pack_dir.mkdir(parents=True, exist_ok=True)
        for p in pack_dir.iterdir():
            if p.is_file() and not p.name.startswith("."):
                try:
                    p.unlink()
                except OSError:
                    pass
        for idx, up_file in enumerate(uploaded_files):
            ext = Path(up_file.filename or "").suffix.lower()
            if ext not in [".jpg", ".jpeg", ".png", ".webp"]:
                raise HTTPException(400, f"Please upload a valid JPG or PNG image. Invalid file: {up_file.filename}")
            safe_name = Path(up_file.filename or f"upload_{idx}.jpg").name
            target_path = pack_dir / safe_name
            contents = await up_file.read()
            target_path.write_bytes(contents)
    else:
        if backup_dir.is_dir():
            pack_dir.mkdir(parents=True, exist_ok=True)
            for p in backup_dir.iterdir():
                if p.is_file() and not p.name.startswith("."):
                    target = pack_dir / p.name
                    if not target.exists():
                        shutil.copy2(p, target)

    case = {
        "org_id": target_org_id,
        "unit_id": target_unit_id,
        "route": "mfn",
        "returned": False,
        "order_lines": [{"sku": target_sku, "quantity": 1}],
    }
    inspect_flow = {"flow_id": "pack-inspection", "steps": [{"stage": "pack"}]}
    wf = new_workflow(case, inspect_flow)
    wf["workflow_id"] = f"WF-PACK-INSPECT-{int(time.time()*1000)}"
    try:
        wf = advance(wf, inspect_flow, STORE)
        return bundle(wf, STORE)
    except Exception as exc:
        raise HTTPException(500, f"Analysis could not be completed: {exc}") from exc
    finally:
        if backup_dir.is_dir():
            for p in backup_dir.iterdir():
                if p.is_file() and not p.name.startswith("."):
                    target = pack_dir / p.name
                    if not target.exists():
                        shutil.copy2(p, target)


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8100))
    host = os.environ.get("HOST", "0.0.0.0")
    uvicorn.run("orchestration.api:app", host=host, port=port)

