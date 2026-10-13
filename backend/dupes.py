"""Layered duplicate shield: exact file -> fingerprint -> fuzzy -> cross-lender on-chain registry."""
import re
from datetime import date

from rapidfuzz import fuzz

from chain import chain
from core import LENDERS, fmt_inr, hmac_hex


def norm_invoice_no(s: str) -> str:
    s = re.sub(r"[^A-Z0-9]", "", (s or "").upper())
    return s


def canonical_key(inv: dict) -> str:
    return "|".join([(inv.get("seller_gstin") or "").upper(), (inv.get("buyer_gstin") or "").upper(),
                     norm_invoice_no(inv.get("invoice_no")), f"{float(inv.get('total') or 0):.2f}",
                     str(inv.get("invoice_date") or "")[:10]])


def fingerprint(inv: dict) -> str:
    return hmac_hex(canonical_key(inv))


def check(c, app_id: int, lender_id: str, inv: dict, file_hashes: list[str]) -> dict:
    fp = fingerprint(inv)
    layers = []

    # Layer 1: exact same file (this lender's books)
    hits = c.execute(f"""SELECT DISTINCT a.id, a.invoice_no FROM documents d JOIN applications a ON a.id=d.app_id
                         WHERE a.lender_id=? AND a.id<>? AND d.kind='invoice' AND d.sha256 IN ({','.join('?' * len(file_hashes))})""",
                     (lender_id, app_id, *file_hashes)).fetchall()
    layers.append({"id": "file", "title": "Exact file match", "scope": f"{LENDERS[lender_id]['short']} records",
                   "status": "fail" if hits else "pass",
                   "detail": f"Identical file already submitted in application #{hits[0]['id']}." if hits else "No byte-identical file submitted before."})

    # Layer 2: canonical fingerprint (survives re-scans, re-formatting, INV/2026/1001 vs INV-2026-1001)
    hits = c.execute("SELECT id, invoice_no, status FROM applications WHERE lender_id=? AND id<>? AND fingerprint=?",
                     (lender_id, app_id, fp)).fetchall()
    layers.append({"id": "fingerprint", "title": "Invoice fingerprint match", "scope": f"{LENDERS[lender_id]['short']} records",
                   "status": "fail" if hits else "pass",
                   "detail": f"Same invoice (different file) already in application #{hits[0]['id']}." if hits else
                   "Fingerprint of seller + buyer + invoice no. + amount + date is new."})

    # Layer 3: fuzzy near-duplicates (renumbered / split invoices)
    rows = c.execute("SELECT id, invoice_no, amount, invoice_date FROM applications WHERE lender_id=? AND id<>? AND seller_gstin=? AND buyer_gstin=? AND status NOT IN ('REJECTED')",
                     (lender_id, app_id, inv.get("seller_gstin"), inv.get("buyer_gstin"))).fetchall()
    near = []
    for r in rows:
        try:
            days = abs((date.fromisoformat(r["invoice_date"]) - date.fromisoformat(inv["invoice_date"])).days)
        except (TypeError, ValueError):
            days = 999
        same_amt = r["amount"] and abs(r["amount"] - (inv.get("total") or 0)) <= 0.01 * r["amount"]
        sim = fuzz.ratio(norm_invoice_no(r["invoice_no"]), norm_invoice_no(inv.get("invoice_no")))
        if same_amt and (days <= 10 or sim >= 85):
            near.append(f"#{r['id']} {r['invoice_no']} ₹{fmt_inr(r['amount'])} ({days} days apart, number similarity {sim:.0f}%)")
    layers.append({"id": "fuzzy", "title": "Near-duplicate pattern", "scope": f"{LENDERS[lender_id]['short']} records",
                   "status": "warn" if near else "pass",
                   "detail": "Same seller and buyer, same amount within days, under a different invoice number." if near else "No renumbered or split look-alikes.",
                   "evidence": near})

    # Layer 4: consortium registry on-chain (cross-lender, privacy-preserving)
    rec = chain.lookup(fp)
    if rec["status"] == "financed" and rec["lender"] != lender_id:
        other = LENDERS.get(rec["lender"], {}).get("name", "another lender")
        layers.append({"id": "chain", "title": "Consortium registry (on-chain)", "scope": "All lenders",
                       "status": "fail", "detail": f"Already financed by {other} (registered on-chain). Pledging it again is double financing.",
                       "evidence": [f"fingerprint 0x{fp[:16]}…", f"lender address {rec['lender_address']}"]})
    elif rec["status"] == "financed":
        layers.append({"id": "chain", "title": "Consortium registry (on-chain)", "scope": "All lenders", "status": "fail",
                       "detail": "This invoice is already financed in our own portfolio (on-chain record)."})
    else:
        layers.append({"id": "chain", "title": "Consortium registry (on-chain)", "scope": "All lenders", "status": "pass",
                       "detail": "No lender in the network has financed this invoice." + (" (previous financing was repaid)" if rec["status"] == "released" else "")})

    fails = [l for l in layers if l["status"] == "fail"]
    verdict = "duplicate" if fails else ("suspect" if any(l["status"] == "warn" for l in layers) else "clean")
    return {"fingerprint": fp, "verdict": verdict, "layers": layers, "onchain": rec,
            "canonical_fields": "seller GSTIN | buyer GSTIN | invoice no. (normalised) | total | invoice date"}
