"""VeriFin API: invoice financing with hybrid (off-chain + on-chain) audit."""
import json
import os
import time
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import audit
import dupes
import evidence
import forensics
import reconcile
import risk
import seed
import verify
from chain import chain
from core import (BASE, DB_PATH, LENDERS, SAMPLES, STORE, db, init_db, now_iso, row_to_dict, sha256_hex,
                  vault_get, vault_overwrite, vault_put)
from disclosure import commit, disclose
from disclosure import verify as verify_disclosure
from extract import claude_available, extract

app = FastAPI(title="VeriFin")
SCENARIOS = {}


@app.on_event("startup")
def startup():
    global SCENARIOS
    init_db()
    with db() as c:
        empty = c.execute("SELECT COUNT(*) n FROM companies").fetchone()["n"] == 0
    if empty:
        seed.seed_db()
    if chain.fresh_deploy:  # chain was restarted: old anchors/registrations are gone, so start clean
        with db() as c:
            for t in ("applications", "documents", "audit_events", "anchors"):
                c.execute(f"DELETE FROM {t}")
        for p in STORE.glob("*"):
            p.unlink()
        print("[startup] New contract deployed; cleared previous applications to stay consistent with the chain")
    SCENARIOS = seed.generate_samples()


def J(s):
    return json.loads(s) if s else None


def companies_map(c):
    return {r["gstin"]: dict(r) for r in c.execute("SELECT * FROM companies")}


def app_detail(c, app_id):
    a = row_to_dict(c.execute("SELECT * FROM applications WHERE id=?", (app_id,)).fetchone())
    if not a:
        raise HTTPException(404, "Application not found")
    for k in ("extracted_json", "checks_json", "dup_json", "forensics_json", "risk_json", "decision_json", "chain_json"):
        a[k.removesuffix("_json")] = J(a.pop(k))
    a.pop("salts_json", None)
    cm = companies_map(c)
    a["seller_name"] = cm.get(a["seller_gstin"], {}).get("name", a["seller_gstin"])
    a["buyer_name"] = cm.get(a["buyer_gstin"], {}).get("name", a["buyer_gstin"])
    a["lender"] = LENDERS.get(a["lender_id"])
    a["documents"] = [dict(r) for r in c.execute("SELECT id,kind,filename,sha256,size,created_at FROM documents WHERE app_id=?", (app_id,))]
    a["events"] = [dict(r) for r in c.execute("SELECT * FROM audit_events WHERE app_id=? ORDER BY id", (app_id,))]
    for e in a["events"]:
        e["payload"] = J(e["payload"])
    a["onchain"] = chain.lookup(a["fingerprint"]) if a["fingerprint"] else None
    return a


def set_app(c, app_id, **fields):
    fields["updated_at"] = now_iso()
    cols = ", ".join(f"{k}=?" for k in fields)
    c.execute(f"UPDATE applications SET {cols} WHERE id=?", (*fields.values(), app_id))


# ---------------- core pipeline ----------------
def process(lender_id: str, files: dict[str, tuple[str, bytes]]):
    if lender_id not in LENDERS:
        raise HTTPException(400, "Unknown lender")
    if "invoice" not in files:
        raise HTTPException(400, "Invoice document is required")
    t0 = time.perf_counter()
    with db() as c:
        cur = c.execute("INSERT INTO applications(lender_id,status,created_at,updated_at) VALUES(?,?,?,?)",
                        (lender_id, "SUBMITTED", now_iso(), now_iso()))
        app_id = cur.lastrowid
        audit.append_event(c, app_id, "APPLICATION_SUBMITTED", "sme", {"lender": lender_id, "documents": sorted(files)})

        # 1. store encrypted off-chain, log hashes
        hashes, extracted = {}, {}
        for kind, (fname, data) in files.items():
            h = sha256_hex(data)
            hashes[kind] = h
            path = vault_put(f"app{app_id}_{kind}_{h[:12]}", data)
            c.execute("INSERT INTO documents(app_id,kind,filename,sha256,stored_path,size,created_at) VALUES(?,?,?,?,?,?,?)",
                      (app_id, kind, fname, h, path, len(data), now_iso()))
            audit.append_event(c, app_id, "DOCUMENT_STORED", "platform", {"kind": kind, "sha256": h, "bytes": len(data), "encrypted": True})
        # 2. extract
        for kind, (fname, data) in files.items():
            try:
                extracted[kind] = extract(data, fname, kind)
            except Exception as e:  # noqa: BLE001
                extracted[kind] = {"doc_type": kind, "error": str(e), "items": [], "confidence": 0}
        inv = extracted["invoice"]
        audit.append_event(c, app_id, "DATA_EXTRACTED", "platform",
                           {k: {"method": v.get("method"), "confidence": v.get("confidence")} for k, v in extracted.items()})
        if not inv.get("invoice_no") or not inv.get("total"):
            set_app(c, app_id, status="REJECTED", extracted_json=json.dumps(extracted),
                    decision_json=json.dumps({"decision": "REJECTED", "memo": "Could not read the invoice."}))
            audit.anchor_pending(c)
            return app_id

        cm = companies_map(c)
        seller = cm.get(inv.get("seller_gstin"), {})
        # 3. forensics
        fx = forensics.analyze(files["invoice"][1], seller.get("usual_producer"))
        audit.append_event(c, app_id, "FORENSICS_COMPLETED", "platform", {"verdict": fx["verdict"], "flags": len(fx["flags"])})
        # 4. three-way match (+ PO ledger from this lender's books)
        po, grn = extracted.get("po"), extracted.get("grn")
        ledger = {"billed": 0, "invoices": []}
        if po and po.get("po_number"):
            for r in c.execute("SELECT invoice_no, subtotal FROM applications WHERE lender_id=? AND id<>? AND seller_gstin=? AND upper(po_number)=upper(?) AND status NOT IN ('REJECTED','SUBMITTED')",
                               (lender_id, app_id, inv.get("seller_gstin"), po["po_number"])):
                ledger["billed"] += r["subtotal"] or 0
                ledger["invoices"].append(r["invoice_no"])
        checks = verify.three_way_match(inv, po, grn, cm, ledger)
        rc = reconcile.check(inv, extracted.get("bank"), extracted.get("soa"),
                             cm.get(inv.get("buyer_gstin"), {}).get("name", inv.get("buyer_name") or ""))
        if rc:
            checks.insert(4, rc)
        audit.append_event(c, app_id, "VERIFICATION_COMPLETED", "platform",
                           {s: sum(1 for k in checks if k["status"] == s) for s in ("pass", "warn", "fail")})
        # 5. duplicate shield
        dup = dupes.check(c, app_id, lender_id, inv, [hashes["invoice"]])
        audit.append_event(c, app_id, "DUPLICATE_CHECK_COMPLETED", "platform", {"verdict": dup["verdict"], "fingerprint": dup["fingerprint"]})
        # 6. selective-disclosure commitment
        root, salts = commit(inv)
        audit.append_event(c, app_id, "COMMITMENT_CREATED", "platform", {"commitment_root": root})
        # 7. risk + decision
        buyer_name = cm.get(inv.get("buyer_gstin"), {}).get("name", inv.get("buyer_name") or "the buyer")
        rk = risk.score(c, inv, checks, dup, fx, dup["onchain"]["confirmed"], buyer_name)
        audit.append_event(c, app_id, "RISK_SCORED", "risk-engine", {"score": rk["score"], "grade": rk["grade"]})
        audit.append_event(c, app_id, "DECISION_MADE", "risk-engine", {"decision": rk["decision"], "hard_stops": rk["hard_stops"],
                                                                      "advance": (rk["offer"] or {}).get("advance")})
        set_app(c, app_id, seller_gstin=inv.get("seller_gstin"), buyer_gstin=inv.get("buyer_gstin"), invoice_no=inv.get("invoice_no"),
                po_number=inv.get("po_number"), amount=inv.get("total"), subtotal=inv.get("subtotal"),
                invoice_date=inv.get("invoice_date"), due_date=inv.get("due_date"), status=rk["decision"],
                fingerprint=dup["fingerprint"], commitment=root, salts_json=json.dumps(salts),
                extracted_json=json.dumps(extracted), checks_json=json.dumps(checks), dup_json=json.dumps(dup),
                forensics_json=json.dumps(fx), risk_json=json.dumps(rk),
                decision_json=json.dumps({"processing_ms": round((time.perf_counter() - t0) * 1000)}))
        audit.anchor_pending(c)
    return app_id


# ---------------- API: meta ----------------
@app.get("/api/meta")
def meta():
    with db() as c:
        comps = [dict(r) for r in c.execute("SELECT * FROM companies")]
        stats = dict(c.execute("""SELECT COUNT(*) total,
              SUM(status='FUNDED' OR status='REPAID') funded,
              SUM(CASE WHEN status IN ('FUNDED','REPAID') THEN json_extract(risk_json,'$.offer.net_disbursal') END) disbursed,
              SUM(status='REJECTED') rejected,
              SUM(status='MANUAL_REVIEW') review FROM applications""").fetchone())
        stats["events"] = c.execute("SELECT COUNT(*) n FROM audit_events").fetchone()["n"]
        stats["anchors"] = c.execute("SELECT COUNT(*) n FROM anchors").fetchone()["n"]
    try:
        cs = chain.status()
    except Exception as e:  # noqa: BLE001
        cs = {"mode": "error", "error": str(e)}
    return {"lenders": list(LENDERS.values()), "companies": comps, "chain": cs, "stats": stats,
            "scenarios": SCENARIOS, "ai_extraction": claude_available()}


# ---------------- API: applications ----------------
@app.post("/api/applications")
async def submit(lender_id: str = Form(...), invoice: UploadFile = File(...),
                 po: UploadFile | None = File(None), grn: UploadFile | None = File(None),
                 bank: UploadFile | None = File(None), soa: UploadFile | None = File(None)):
    files = {"invoice": (invoice.filename, await invoice.read())}
    if po and po.filename:
        files["po"] = (po.filename, await po.read())
    if grn and grn.filename:
        files["grn"] = (grn.filename, await grn.read())
    for k, f in (("bank", bank), ("soa", soa)):
        if f and f.filename:
            files[k] = (f.filename, await f.read())
    app_id = process(lender_id, files)
    with db() as c:
        return app_detail(c, app_id)


def _find_funded(c, invoice_no):
    return c.execute("SELECT id FROM applications WHERE invoice_no=? AND status IN ('FUNDED')", (invoice_no,)).fetchone()


@app.post("/api/scenarios/{name}/run")
def run_scenario(name: str, lender_id: str | None = None):
    if name not in SCENARIOS:
        raise HTTPException(404, "Unknown scenario")
    sc = SCENARIOS[name]
    prep = []
    if sc.get("requires") == "01_clean":
        with db() as c:
            funded = _find_funded(c, "INV-2026-1001")
        with db() as c:
            pending = c.execute("SELECT id FROM applications WHERE invoice_no='INV-2026-1001' AND lender_id='lender_a' "
                                "AND status IN ('AUTO_APPROVED','APPROVED') ORDER BY id LIMIT 1").fetchone()
        if not funded and pending:  # original was approved but never disbursed: fund it so it's on-chain
            disburse(pending["id"])
            prep.append(f"Disbursed application #{pending['id']} (INV-2026-1001 at Shakti Bank) first, registering it on-chain.")
        elif not funded:  # make sure the original invoice is funded at Lender A first
            first = process("lender_a", _scenario_files("01_clean"))
            with db() as c:
                st = c.execute("SELECT status FROM applications WHERE id=?", (first,)).fetchone()["status"]
            if st in ("AUTO_APPROVED", "APPROVED"):
                disburse(first)
            prep.append(f"Submitted and funded INV-2026-1001 at Shakti Bank first (application #{first}).")
    app_id = process(lender_id or sc["lender"], _scenario_files(name))
    with db() as c:
        d = app_detail(c, app_id)
    d["prep"] = prep
    return d


def _scenario_files(name):
    folder = SAMPLES / name
    return {k: (f"{name}_{k}.pdf", (folder / f"{k}.pdf").read_bytes()) for k in ("invoice", "po", "grn", "bank", "soa")
            if (folder / f"{k}.pdf").exists()}


@app.get("/api/applications")
def list_apps(lender_id: str | None = None, seller_gstin: str | None = None, buyer_gstin: str | None = None):
    with db() as c:
        q = ("SELECT id,lender_id,seller_gstin,buyer_gstin,invoice_no,amount,status,invoice_date,due_date,created_at,"
             "json_extract(risk_json,'$.score') score, json_extract(risk_json,'$.grade') grade, json_extract(dup_json,'$.verdict') dup,"
             "json_extract(risk_json,'$.offer.net_disbursal') net, json_extract(risk_json,'$.offer.advance_rate') adv,"
             "json_extract(risk_json,'$.hard_stops[0]') stop, json_extract(decision_json,'$.processing_ms') ms FROM applications")
        where, args = [], []
        for col, val in (("lender_id", lender_id), ("seller_gstin", seller_gstin), ("buyer_gstin", buyer_gstin)):
            if val:
                where.append(f"{col}=?")
                args.append(val)
        rows = c.execute(q + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY id DESC", args).fetchall()
        cm = companies_map(c)
        out = []
        for r in rows:
            d = dict(r)
            d["seller_name"] = cm.get(d["seller_gstin"], {}).get("name")
            d["buyer_name"] = cm.get(d["buyer_gstin"], {}).get("name")
            d["lender_name"] = LENDERS.get(d["lender_id"], {}).get("name")
            out.append(d)
        return out


@app.get("/api/lenders/{lender_id}/dashboard")
def lender_dashboard(lender_id: str):
    rows = list_apps(lender_id=lender_id)
    decided = [r for r in rows if r["status"] != "SUBMITTED"]
    approved = [r for r in rows if r["status"] in ("AUTO_APPROVED", "APPROVED", "FUNDED", "REPAID")]
    funded = [r for r in rows if r["status"] in ("FUNDED", "REPAID")]
    live = [r for r in rows if r["status"] == "FUNDED"]
    blocked = [r for r in rows if r["status"] in ("REJECTED", "DISPUTED")]
    ms = [r["ms"] for r in rows if r["ms"]]
    exposure = {}
    for r in live:
        exposure[r["buyer_name"]] = exposure.get(r["buyer_name"], 0) + (r["amount"] or 0)
    return {"lender": LENDERS.get(lender_id),
            "kpis": {"applications": len(rows), "approval_rate": (len(approved) / len(decided)) if decided else None,
                     "disbursed": sum(r["net"] or 0 for r in funded), "exposure": sum(r["amount"] or 0 for r in live),
                     "blocked": len(blocked), "blocked_value": sum(r["amount"] or 0 for r in blocked),
                     "avg_decision_ms": round(sum(ms) / len(ms)) if ms else None},
            "attention": [r for r in rows if r["status"] in ("MANUAL_REVIEW", "AUTO_APPROVED", "APPROVED")],
            "blocked": blocked[:8],
            "exposure_by_buyer": sorted(({"buyer": k, "amount": v} for k, v in exposure.items()), key=lambda x: -x["amount"]),
            "recent": rows[:8]}


@app.get("/api/buyers/{gstin}/invoices")
def buyer_invoices(gstin: str):
    rows = [r for r in list_apps(buyer_gstin=gstin) if r["status"] not in ("REJECTED", "SUBMITTED")]
    with db() as c:
        for r in rows:
            fp = c.execute("SELECT fingerprint FROM applications WHERE id=?", (r["id"],)).fetchone()["fingerprint"]
            oc = chain.lookup(fp) if fp else {}
            r["confirmed"] = bool(oc.get("confirmed"))
            r["financed_onchain"] = oc.get("status") == "financed"
            r["requested"] = c.execute("SELECT 1 FROM audit_events WHERE app_id=? AND type='BUYER_CONFIRMATION_REQUESTED'", (r["id"],)).fetchone() is not None
    return rows


@app.post("/api/applications/{app_id}/request-confirmation")
def request_confirmation(app_id: int):
    with db() as c:
        a = app_detail(c, app_id)
        audit.append_event(c, app_id, "BUYER_CONFIRMATION_REQUESTED", a["lender_id"], {"to": a["buyer_name"]})
        audit.anchor_pending(c)
        return app_detail(c, app_id)


class DisputeReq(BaseModel):
    reason: str = "Goods or amount not as agreed"


@app.post("/api/applications/{app_id}/buyer-dispute")
def buyer_dispute(app_id: int, req: DisputeReq):
    with db() as c:
        a = c.execute("SELECT * FROM applications WHERE id=?", (app_id,)).fetchone()
        if not a:
            raise HTTPException(404)
        buyer = c.execute("SELECT name FROM companies WHERE gstin=?", (a["buyer_gstin"],)).fetchone()
        if a["status"] not in ("FUNDED", "REPAID"):
            set_app(c, app_id, status="DISPUTED")
        audit.append_event(c, app_id, "BUYER_DISPUTED", f"buyer:{buyer['name'] if buyer else a['buyer_gstin']}", {"reason": req.reason})
        audit.anchor_pending(c)
        return app_detail(c, app_id)


@app.get("/api/applications/{app_id}")
def get_app(app_id: int):
    with db() as c:
        return app_detail(c, app_id)


def _transition(app_id, allowed, new_status, event, actor, payload=None):
    with db() as c:
        a = c.execute("SELECT * FROM applications WHERE id=?", (app_id,)).fetchone()
        if not a:
            raise HTTPException(404)
        if a["status"] not in allowed:
            raise HTTPException(409, f"Cannot do this while status is {a['status']}")
        set_app(c, app_id, status=new_status)
        audit.append_event(c, app_id, event, actor, payload or {})
        audit.anchor_pending(c)
        return app_detail(c, app_id)


@app.post("/api/applications/{app_id}/approve")
def approve(app_id: int):
    return _transition(app_id, ("MANUAL_REVIEW",), "APPROVED", "MANUAL_APPROVAL", "credit-officer", {"note": "Approved after review"})


@app.post("/api/applications/{app_id}/reject")
def reject(app_id: int):
    return _transition(app_id, ("MANUAL_REVIEW", "AUTO_APPROVED", "APPROVED"), "REJECTED", "MANUAL_REJECTION", "credit-officer")


@app.post("/api/applications/{app_id}/disburse")
def disburse(app_id: int):
    with db() as c:
        a = c.execute("SELECT * FROM applications WHERE id=?", (app_id,)).fetchone()
        if not a or a["status"] not in ("AUTO_APPROVED", "APPROVED"):
            raise HTTPException(409, "Only approved applications can be disbursed")
        rec = chain.lookup(a["fingerprint"])
        if rec["status"] == "financed":  # race: someone financed it between scoring and disbursal
            set_app(c, app_id, status="REJECTED")
            audit.append_event(c, app_id, "DISBURSAL_BLOCKED", "smart-contract", {"reason": "DUPLICATE_FINANCING", "by": rec["lender"]})
            audit.anchor_pending(c)
            raise HTTPException(409, "Blocked by on-chain registry: invoice already financed")
        try:
            tx = chain.register(a["fingerprint"], a["commitment"], a["lender_id"])
        except Exception as e:  # noqa: BLE001
            raise HTTPException(409, f"Smart contract rejected registration: {e}") from e
        offer = (J(a["risk_json"]) or {}).get("offer") or {}
        set_app(c, app_id, status="FUNDED", chain_json=json.dumps({"register_tx": tx}))
        audit.append_event(c, app_id, "FUNDS_DISBURSED", a["lender_id"],
                           {"net_disbursal": offer.get("net_disbursal"), "fingerprint": a["fingerprint"], "tx": tx["tx_hash"], "block": tx["block"]})
        audit.anchor_pending(c)
        return app_detail(c, app_id)


@app.post("/api/applications/{app_id}/repay")
def repay(app_id: int):
    with db() as c:
        a = c.execute("SELECT * FROM applications WHERE id=?", (app_id,)).fetchone()
        if not a or a["status"] != "FUNDED":
            raise HTTPException(409, "Only funded applications can be repaid")
        tx = chain.release(a["fingerprint"], a["lender_id"])
        ch = J(a["chain_json"]) or {}
        ch["release_tx"] = tx
        set_app(c, app_id, status="REPAID", chain_json=json.dumps(ch))
        audit.append_event(c, app_id, "BUYER_PAID_RELEASED", a["lender_id"], {"tx": tx["tx_hash"], "block": tx["block"]})
        audit.anchor_pending(c)
        return app_detail(c, app_id)


@app.post("/api/applications/{app_id}/buyer-confirm")
def buyer_confirm(app_id: int):
    with db() as c:
        a = c.execute("SELECT * FROM applications WHERE id=?", (app_id,)).fetchone()
        if not a or not a["fingerprint"]:
            raise HTTPException(404)
        buyer = c.execute("SELECT * FROM companies WHERE gstin=?", (a["buyer_gstin"],)).fetchone()
        if not buyer or buyer["chain_account"] is None:
            raise HTTPException(400, "Buyer has no on-chain identity")
        tx = chain.confirm(a["fingerprint"], buyer["chain_account"])
        audit.append_event(c, app_id, "BUYER_CONFIRMED", f"buyer:{buyer['name']}", {"tx": tx["tx_hash"], "block": tx["block"]})
        # re-score with the confirmation
        inv = J(a["extracted_json"])["invoice"]
        old = J(a["risk_json"])
        rk = risk.score(c, inv, J(a["checks_json"]), J(a["dup_json"]), J(a["forensics_json"]), True, buyer["name"])
        new_status = a["status"]
        if a["status"] in ("MANUAL_REVIEW", "AUTO_APPROVED"):
            new_status = rk["decision"] if rk["decision"] != "REJECTED" else a["status"]
        set_app(c, app_id, risk_json=json.dumps(rk), status=new_status)
        audit.append_event(c, app_id, "RISK_RESCORED", "risk-engine", {"from": old["score"], "to": rk["score"], "grade": rk["grade"]})
        audit.anchor_pending(c)
        d = app_detail(c, app_id)
        d["rescore"] = {"from": old["score"], "to": rk["score"], "from_grade": old["grade"], "to_grade": rk["grade"]}
        return d


# ---------------- API: selective disclosure ----------------
class DiscReq(BaseModel):
    fields: list[str]


@app.post("/api/applications/{app_id}/disclose")
def make_disclosure(app_id: int, req: DiscReq):
    with db() as c:
        a = c.execute("SELECT * FROM applications WHERE id=?", (app_id,)).fetchone()
        inv = J(a["extracted_json"])["invoice"]
        pkg = disclose(inv, J(a["salts_json"]), req.fields)
        pkg["fingerprint"] = a["fingerprint"]
        audit.append_event(c, app_id, "DISCLOSURE_ISSUED", "sme", {"fields": req.fields})
        audit.anchor_pending(c)
        return pkg


@app.post("/api/disclosure/verify")
def check_disclosure(pkg: dict):
    results = verify_disclosure(pkg)
    rec = chain.lookup(pkg.get("fingerprint", "0" * 64))
    onchain_commit = (rec.get("commitment") or "").removeprefix("0x")
    anchored = None
    with db() as c:
        ev = c.execute("SELECT id FROM audit_events WHERE type='COMMITMENT_CREATED' AND payload LIKE ?", (f'%{pkg["root"]}%',)).fetchone()
        if ev:
            anchored = audit.event_proof(c, ev["id"])
    return {"fields": results, "all_fields_valid": all(r["ok"] for r in results),
            "root_on_chain": onchain_commit == pkg["root"], "onchain_status": rec["status"],
            "root_anchored_in_audit": bool(anchored and anchored.get("verified")),
            "anchor": anchored and {"event_id": anchored["event_id"], "tx_hash": anchored["anchor"]["tx_hash"], "block": anchored["anchor"]["block"]}}


# ---------------- API: credit pack + portable verification record ----------------
@app.get("/api/applications/{app_id}/pack")
def get_pack(app_id: int):
    with db() as c:
        a = app_detail(c, app_id)
        hist = [dict(r) for r in c.execute(
            "SELECT invoice_no, amount, due_date, paid_date, CAST(julianday(paid_date)-julianday(due_date) AS INT) days_late FROM payment_history WHERE buyer_gstin=? AND paid_date IS NOT NULL ORDER BY due_date DESC LIMIT 6",
            (a["buyer_gstin"],))]
        opn = [dict(r) for r in c.execute(
            "SELECT p.invoice_no, p.amount, p.due_date, c2.name buyer FROM payment_history p JOIN companies c2 ON c2.gstin=p.buyer_gstin WHERE p.seller_gstin=? AND p.paid_date IS NULL ORDER BY p.due_date",
            (a["seller_gstin"],))]
        return evidence.credit_pack(a, hist, opn)


@app.post("/api/applications/{app_id}/record")
def issue_record(app_id: int):
    with db() as c:
        a = app_detail(c, app_id)
        if not a.get("fingerprint"):
            raise HTTPException(400, "Nothing to certify")
        rec = evidence.build_record(a, a["documents"], a["events"], None, chain.status())
        rh = evidence.record_hash(rec)
        ev = audit.append_event(c, app_id, "VERIFICATION_RECORD_ISSUED", "platform", {"record_id": rec["id"], "record_sha256": rh})
        audit.anchor_pending(c)
        p = audit.event_proof(c, ev["id"])
        e = c.execute("SELECT * FROM audit_events WHERE id=?", (ev["id"],)).fetchone()
        rec["anchorProof"] = {
            "description": "Record hash is in an audit event; that event is a leaf of a Merkle batch whose root is stored in InvoiceRegistry.anchors(chainIndex).",
            "recordSha256": rh,
            "event": {"app_id": e["app_id"], "type": e["type"], "actor": e["actor"], "payload": json.loads(e["payload"]), "ts": e["ts"], "prev": e["prev_hash"]},
            "eventHash": e["hash"], "merklePath": p["proof"], "merkleRoot": p["root"],
            "chainIndex": p["anchor"]["chain_index"], "txHash": p["anchor"]["tx_hash"], "block": p["anchor"]["block"],
            "rpc": chain.status().get("rpc"), "contract": chain.address,
        }
        return rec


@app.post("/api/records/verify")
async def verify_record(record: UploadFile = File(...), files: list[UploadFile] | None = File(None)):
    try:
        rec = json.loads(await record.read())
    except ValueError as e:
        raise HTTPException(400, "Record is not valid JSON") from e
    uploads = {f.filename: await f.read() for f in (files or []) if f.filename}
    sig_ok = evidence.check_signature(rec)
    ap = rec.get("anchorProof") or {}
    anchored = {"verified": False, "reason": "no anchor proof"}
    if ap:
        ev = ap["event"]
        recomputed_event = sha256_hex(audit._event_body(ev["app_id"], ev["type"], ev["actor"], ev["payload"], ev["ts"], ev["prev"]).encode())
        rh = evidence.record_hash(rec)
        try:
            onchain_root = chain.get_anchor_root(ap["chainIndex"])
        except Exception:  # noqa: BLE001
            onchain_root = None
        steps = {"record_hash_matches_event": ev["payload"].get("record_sha256") == rh,
                 "event_hash_recomputes": recomputed_event == ap["eventHash"],
                 "merkle_path_reaches_root": audit.verify_proof(recomputed_event, ap["merklePath"], ap["merkleRoot"]),
                 "root_matches_contract": onchain_root == ap["merkleRoot"]}
        anchored = {"verified": all(steps.values()), "steps": steps, "block": ap.get("block"), "tx": ap.get("txHash")}
    subj = rec.get("credentialSubject", {})
    live = chain.lookup(subj.get("invoiceFingerprint", "0" * 64))
    return {"signature_valid": sig_ok, "issuer_trusted": evidence.issuer_trusted(rec), "issuer": rec.get("issuer", {}).get("name"),
            "anchored": anchored, "documents": evidence.compare_documents(rec, uploads) if uploads else None,
            "recorded_outcome": subj.get("decision", {}).get("outcome"), "live_registry_status": live["status"],
            "live_buyer_confirmed": live["confirmed"], "record_id": rec.get("id")}


@app.get("/api/issuer")
def issuer():
    return {"id": evidence.ISSUER_ID, "publicKeyEd25519": evidence.public_key_b64(), "contract": chain.address}


# ---------------- API: audit ----------------
@app.get("/api/audit/events")
def events(limit: int = 200):
    with db() as c:
        rows = [dict(r) for r in c.execute("SELECT * FROM audit_events ORDER BY id DESC LIMIT ?", (limit,))]
        for r in rows:
            r["payload"] = J(r["payload"])
        anchors = [dict(r) for r in c.execute("SELECT * FROM anchors ORDER BY id DESC")]
        return {"events": rows, "anchors": anchors}


@app.get("/api/audit/verify")
def verify_integrity():
    with db() as c:
        return audit.verify_all(c)


@app.get("/api/audit/events/{event_id}/proof")
def proof(event_id: int):
    with db() as c:
        p = audit.event_proof(c, event_id)
        if not p:
            raise HTTPException(404)
        return p


@app.post("/api/audit/anchor")
def anchor_now():
    with db() as c:
        return audit.anchor_pending(c) or {"message": "Nothing to anchor"}


@app.post("/api/audit/verify-document")
async def verify_document(file: UploadFile = File(...)):
    data = await file.read()
    h = sha256_hex(data)
    with db() as c:
        d = c.execute("SELECT * FROM documents WHERE sha256=? ORDER BY id LIMIT 1", (h,)).fetchone()
        if not d:
            return {"sha256": h, "found": False, "message": "This exact file was never submitted. If it claims to be a submitted document, it has been altered."}
        ev = c.execute("SELECT id FROM audit_events WHERE type='DOCUMENT_STORED' AND app_id=? AND payload LIKE ?", (d["app_id"], f"%{h}%")).fetchone()
        p = audit.event_proof(c, ev["id"]) if ev else None
        return {"sha256": h, "found": True, "document": {k: d[k] for k in ("id", "app_id", "kind", "created_at")},
                "event_id": ev["id"] if ev else None, "proof": p}


# ---------------- API: red team ----------------
@app.post("/api/redteam/tamper-document")
def tamper_document():
    """Insider edits a stored invoice (changes the amount bytes) and re-encrypts it."""
    with db() as c:
        d = c.execute("SELECT d.* FROM documents d JOIN applications a ON a.id=d.app_id WHERE d.kind='invoice' AND a.status IN ('FUNDED','AUTO_APPROVED','APPROVED') ORDER BY d.id LIMIT 1").fetchone() \
            or c.execute("SELECT * FROM documents WHERE kind='invoice' ORDER BY id LIMIT 1").fetchone()
        if not d:
            raise HTTPException(400, "Submit an application first")
        data = vault_get(d["stored_path"])
        backup = BASE / (d["stored_path"] + ".bak")
        if not backup.exists():
            backup.write_bytes((BASE / d["stored_path"]).read_bytes())
        vault_overwrite(d["stored_path"], data + b"\n% amount changed 590000 -> 950000\n")
        audit.append_event(c, None, "REDTEAM_ACTION", "red-team", {"action": "tamper-document", "doc_id": d["id"]})
        return {"tampered_document": d["id"], "app_id": d["app_id"], "filename": d["filename"]}


@app.post("/api/redteam/tamper-event")
def tamper_event():
    """Insider edits an audit record directly in the database (e.g. changes a decision)."""
    with db() as c:
        ev = c.execute("SELECT * FROM audit_events WHERE type='DECISION_MADE' ORDER BY id LIMIT 1").fetchone()
        if not ev:
            raise HTTPException(400, "Submit an application first")
        p = json.loads(ev["payload"])
        backup = DB_PATH.parent / f"event_{ev['id']}.bak"
        if not backup.exists():
            backup.write_text(ev["payload"])
        p["decision"] = "AUTO_APPROVED" if p.get("decision") != "AUTO_APPROVED" else "REJECTED"
        p["advance"] = 999999
        c.execute("UPDATE audit_events SET payload=? WHERE id=?", (json.dumps(p, sort_keys=True, separators=(",", ":")), ev["id"]))
        return {"tampered_event": ev["id"], "app_id": ev["app_id"], "new_payload": p}


@app.post("/api/redteam/restore")
def restore():
    restored = []
    for bak in STORE.glob("*.enc.bak"):
        bak.replace(bak.with_suffix(""))
        restored.append(bak.name)
    with db() as c:
        for bak in DB_PATH.parent.glob("event_*.bak"):
            eid = int(bak.stem.split("_")[1])
            c.execute("UPDATE audit_events SET payload=? WHERE id=?", (bak.read_text(), eid))
            bak.unlink()
            restored.append(f"event {eid}")
    return {"restored": restored}


@app.post("/api/demo/reset")
def reset():
    for p in STORE.glob("*"):
        p.unlink()
    for p in DB_PATH.parent.glob("event_*.bak"):
        p.unlink()
    with db() as c:
        for t in ("applications", "documents", "audit_events", "anchors"):
            c.execute(f"DELETE FROM {t}")
    chain.reset()
    seed.seed_db()
    return {"ok": True, "chain": chain.status()}


@app.get("/api/samples/{name}/{kind}")
def sample_file(name: str, kind: str):
    p = SAMPLES / name / f"{kind}.pdf"
    if not p.exists() or kind not in ("invoice", "po", "grn", "bank", "soa"):
        raise HTTPException(404)
    return FileResponse(p, media_type="application/pdf", filename=f"{name}_{kind}.pdf")


FRONT = Path(__file__).resolve().parent.parent / "frontend"
app.mount("/static", StaticFiles(directory=FRONT), name="static")


@app.get("/")
def index():
    return FileResponse(FRONT / "index.html")
