"""Lender credit pack + portable, signed Verification Record (W3C Verifiable-Credential style)."""
import base64
import json

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from core import DATA, canonical, fmt_inr, now_iso, sha256_hex

_KEY = DATA / "issuer_ed25519.pem"
ISSUER_ID = "did:web:verifin.local"


def _priv():
    if not _KEY.exists():
        k = Ed25519PrivateKey.generate()
        _KEY.write_bytes(k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    return serialization.load_pem_private_key(_KEY.read_bytes(), None)


def public_key_b64():
    raw = _priv().public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return base64.b64encode(raw).decode()


# ---------------- credit pack ----------------
def credit_pack(a: dict, history_rows: list, open_rows: list) -> dict:
    """a = app_detail(). Splits evidence into what supports eligibility vs. what still needs review."""
    r, dup, fx, oc = a.get("risk") or {}, a.get("dup") or {}, a.get("forensics") or {}, a.get("onchain") or {}
    supports, review, blocking = [], [], list(r.get("hard_stops") or [])

    for k in a.get("checks") or []:
        item = {"what": k["title"], "evidence": k["detail"], "rule": f"{k['rule']['id']} v{k['rule']['version']}", "confidence": k["confidence"]}
        if k["status"] == "pass":
            supports.append(item)
        elif k["status"] == "warn":
            review.append({**item, "action": "Obtain the missing document or confirm with the buyer."})
        elif not any(k["title"] in b for b in blocking):
            blocking.append(f"{k['title']}: {k['detail']}")
    for l in dup.get("layers") or []:
        if l["status"] == "warn":
            review.append({"what": l["title"], "evidence": l["detail"] + (" " + "; ".join(l.get("evidence") or []) if l.get("evidence") else ""),
                           "action": "Confirm with the seller that this is a separate delivery."})
    if dup.get("verdict") == "clean":
        supports.append({"what": "No duplicate financing", "evidence": "File, fingerprint, near-duplicate and cross-lender on-chain checks are all clear."})
    if fx.get("verdict") == "clean":
        supports.append({"what": "Document integrity", "evidence": f"No edits after creation; produced by {fx['facts'].get('producer')}, the seller's usual software."})
    elif fx.get("verdict") == "suspicious":
        review.append({"what": "Document forensics", "evidence": "; ".join(f["title"] for f in fx["flags"]), "action": "Request the original from the seller's ERP."})
    for f in r.get("factors") or []:
        if f["group"] == "Verification":
            continue
        if f["points"] > 0:
            supports.append({"what": f["label"], "evidence": f["detail"], "points": f["points"]})
        elif f["points"] < 0:
            review.append({"what": f["label"], "evidence": f["detail"], "points": f["points"],
                           "action": {"Average payment delay": "Price for expected delay or require buyer confirmation.",
                                      "Share of late payments": "Consider a lower advance or credit insurance.",
                                      "Past defaults": "Senior credit approval required.",
                                      "Buyer concentration": "Check the seller's exposure limit for this buyer.",
                                      "Invoice size vs. history": "Ask for the contract or order history supporting the size."}.get(f["label"], "Review.")})
    if oc.get("confirmed"):
        supports.append({"what": "Buyer acceptance", "evidence": "The buyer confirmed this invoice on-chain (InvoiceRegistry.confirm)."})
    elif a["status"] not in ("REJECTED",):
        review.append({"what": "Buyer acceptance pending", "evidence": "The buyer hasn't acknowledged this invoice yet.",
                       "action": "Request buyer confirmation. This adds 12 points and usually lifts the advance rate."})

    conditions = []
    if a["status"] not in ("REJECTED",):
        if not oc.get("confirmed") and (r.get("grade") or "D") != "A":
            conditions.append("Buyer confirmation of the invoice before disbursal")
        conditions.append("Notice of assignment sent to the buyer: pay into the lender's escrow account")
        conditions.append("Fingerprint registered in the consortium registry at disbursal (automatic)")

    bp = r.get("buyer_profile") or {}
    sp = r.get("seller_profile") or {}
    eligibility = ("NOT ELIGIBLE" if a["status"] == "REJECTED" else
                   "ELIGIBLE" if a["status"] in ("AUTO_APPROVED", "APPROVED", "FUNDED", "REPAID") and not [x for x in review if x.get("points", 0) <= -8]
                   else "ELIGIBLE, SUBJECT TO REVIEW")
    return {
        "eligibility": eligibility,
        "headline": r.get("memo"),
        "invoice": {"invoice_no": a["invoice_no"], "amount": a["amount"], "invoice_date": a["invoice_date"], "due_date": a["due_date"],
                    "seller": a["seller_name"], "buyer": a["buyer_name"], "po_number": a["po_number"],
                    "status": a["status"], "registry_status": oc.get("status"),
                    "registry_note": {"none": "Not financed by any lender in the network", "financed": "Financed (on-chain record)",
                                      "released": "Previously financed and repaid"}.get(oc.get("status"), "")},
        "buyer_acceptance": {"confirmed": bool(oc.get("confirmed")), "confirmed_at": oc.get("confirmed_at")},
        "payment_history": {**bp, "recent": history_rows},
        "receivables": {**sp, "open_invoices": open_rows},
        "terms": r.get("offer"),
        "supports": supports, "needs_review": review, "blocking": blocking, "conditions": conditions,
        "generated_at": now_iso(),
    }


# ---------------- portable verification record ----------------
def _normalize(o):
    if isinstance(o, float) and o.is_integer():
        return int(o)
    if isinstance(o, dict):
        return {k: _normalize(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_normalize(v) for v in o]
    return o


def build_record(a: dict, docs: list, events: list, anchor_info: dict | None, chain_status: dict) -> dict:
    r = a.get("risk") or {}
    body = {
        "@context": ["https://www.w3.org/ns/credentials/v2", "https://verifin.local/contexts/invoice-verification/v1"],
        "type": ["VerifiableCredential", "InvoiceVerificationRecord"],
        "id": f"urn:verifin:record:{a['id']}:{a['fingerprint'][:12]}",
        "issuer": {"id": ISSUER_ID, "name": "VeriFin verification service", "publicKeyEd25519": public_key_b64()},
        "validFrom": now_iso(),
        "credentialSubject": {
            "invoiceFingerprint": a["fingerprint"],
            "fingerprintScheme": "HMAC-SHA256(consortium key, sellerGSTIN|buyerGSTIN|invoiceNo|total|invoiceDate)",
            "fieldCommitmentRoot": a["commitment"],
            "invoice": {"number": a["invoice_no"], "sellerGSTIN": a["seller_gstin"], "buyerGSTIN": a["buyer_gstin"],
                        "total": a["amount"], "currency": "INR", "invoiceDate": a["invoice_date"], "dueDate": a["due_date"], "poNumber": a["po_number"]},
            "documents": [{"kind": d["kind"], "sha256": d["sha256"], "bytes": d["size"]} for d in docs],
            "rulesApplied": [{"rule": k["rule"]["id"], "version": k["rule"]["version"], "definition": k["rule"]["definition"],
                              "check": k["title"], "result": k["status"], "confidence": k["confidence"], "finding": k["detail"],
                              "discrepancyINR": k.get("discrepancy_inr", 0)} for k in a.get("checks") or []],
            "duplicateScreening": [{"layer": l["title"], "scope": l["scope"], "result": l["status"]} for l in (a.get("dup") or {}).get("layers", [])],
            "documentForensics": {"verdict": (a.get("forensics") or {}).get("verdict"),
                                  "flags": [f["title"] for f in (a.get("forensics") or {}).get("flags", [])]},
            "decision": {"outcome": a["status"], "riskScore": r.get("score"), "grade": r.get("grade"),
                         "hardStops": r.get("hard_stops"), "advanceRate": (r.get("offer") or {}).get("advance_rate")},
            "auditTrail": {"eventIds": [e["id"] for e in events], "lastEventHash": events[-1]["hash"] if events else None},
        },
        "anchoring": {"network": chain_status.get("network"), "contract": chain_status.get("contract")},
    }
    body = _normalize(body)  # whole-number floats -> ints, so JS/Python/other JSON round-trips give identical bytes
    sig = _priv().sign(canonical(body).encode())
    return {**body, "proof": {"type": "Ed25519Signature", "canonicalization": "JSON, sorted keys, compact separators",
                              "verificationMethod": f"{ISSUER_ID}#key-1", "created": now_iso(),
                              "proofValue": base64.b64encode(sig).decode()}}


def record_hash(record: dict) -> str:
    return sha256_hex(canonical({k: v for k, v in record.items() if k not in ("anchorProof",)}).encode())


def check_signature(record: dict) -> bool:
    try:
        body = {k: v for k, v in record.items() if k not in ("proof", "anchorProof")}
        pub = Ed25519PublicKey.from_public_bytes(base64.b64decode(record["issuer"]["publicKeyEd25519"]))
        pub.verify(base64.b64decode(record["proof"]["proofValue"]), canonical(body).encode())
        return True
    except (InvalidSignature, KeyError, ValueError):
        return False


def issuer_trusted(record: dict) -> bool:
    return record.get("issuer", {}).get("publicKeyEd25519") == public_key_b64()


def compare_documents(record: dict, uploads: dict[str, bytes]) -> list:
    """uploads: filename -> bytes. Match by hash; report which recorded documents changed or were not supplied."""
    hashes = {sha256_hex(b): name for name, b in uploads.items()}
    out = []
    for d in record["credentialSubject"]["documents"]:
        if d["sha256"] in hashes:
            out.append({"kind": d["kind"], "status": "unchanged", "file": hashes.pop(d["sha256"])})
        else:
            out.append({"kind": d["kind"], "status": "not supplied" if not uploads else "missing or changed"})
    for h, name in hashes.items():
        out.append({"kind": "?", "status": "not part of this record (altered copy?)", "file": name, "sha256": h})
    return out


def summarize_pack_for_text(pack):  # used in memo exports
    return f"{pack['eligibility']}: {len(pack['supports'])} supporting facts, {len(pack['needs_review'])} items for review, {len(pack['blocking'])} blocking."


def fmt(x):
    return fmt_inr(x) if isinstance(x, (int, float)) else x


__all__ = ["credit_pack", "build_record", "record_hash", "check_signature", "issuer_trusted", "compare_documents", "public_key_b64", "json"]
