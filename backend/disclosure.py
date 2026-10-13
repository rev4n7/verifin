"""Selective disclosure: salted field-level Merkle commitment over the invoice.
Only the root goes on-chain; the SME can reveal any subset of fields with proofs."""
import secrets

from audit import merkle_proof, merkle_root, verify_proof
from core import canonical, sha256_hex

FIELDS = ["invoice_no", "invoice_date", "due_date", "po_number", "seller_name", "seller_gstin",
          "buyer_name", "buyer_gstin", "subtotal", "tax", "total", "items"]


def _value(inv, f):
    v = inv.get(f)
    return canonical(v) if isinstance(v, (list, dict)) else str(v if v is not None else "")


def leaf(field, value, salt):
    return sha256_hex(f"{salt}|{field}|{value}".encode())


def commit(inv: dict):
    salts = {f: secrets.token_hex(16) for f in FIELDS}
    leaves = [leaf(f, _value(inv, f), salts[f]) for f in FIELDS]
    return merkle_root(leaves), salts


def disclose(inv: dict, salts: dict, fields: list[str]):
    leaves = [leaf(f, _value(inv, f), salts[f]) for f in FIELDS]
    out = []
    for f in fields:
        if f not in FIELDS:
            continue
        i = FIELDS.index(f)
        out.append({"field": f, "value": _value(inv, f), "salt": salts[f], "proof": merkle_proof(leaves, i)})
    return {"root": merkle_root(leaves), "revealed": out, "hidden_fields": [f for f in FIELDS if f not in fields]}


def verify(package: dict):
    results = []
    for r in package.get("revealed", []):
        ok = verify_proof(leaf(r["field"], r["value"], r["salt"]), r["proof"], package["root"])
        results.append({"field": r["field"], "value": r["value"], "ok": ok})
    return results
