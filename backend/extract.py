"""Document -> structured data. Offline layout parser first; Claude (vision/PDF) when a key is configured
and the parser isn't confident, or when VERBIL_EXTRACTOR=claude."""
import base64
import io
import json
import os
import re

import pdfplumber

KV = re.compile(r"^([A-Za-z][A-Za-z0-9 .%@/]*?)\s*:\s*(.+)$")
ITEM_PRICED = re.compile(r"^(?P<desc>[A-Za-z][^:]*?)\s+(?P<qty>\d+)\s+(?P<price>[\d,]+\.\d{2})\s+(?P<amt>[\d,]+\.\d{2})$")
ITEM_GRN = re.compile(r"^(?P<desc>[A-Za-z][^:]*?)\s+(?P<ordered>\d+)\s+(?P<received>\d+)$")

REQUIRED = {
    "invoice": ["invoice_no", "invoice_date", "due_date", "seller_gstin", "buyer_gstin", "total", "items"],
    "po": ["po_number", "buyer_gstin", "seller_gstin", "items"],
    "grn": ["grn_no", "po_number", "items"],
}


def num(s):
    try:
        return float(str(s).replace(",", "").replace("₹", "").replace("Rs.", "").strip())
    except ValueError:
        return None


def pdf_text(data: bytes) -> str:
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        return "\n".join((p.extract_text() or "") for p in pdf.pages)


def detect_type(text: str):
    t = text.upper()
    if "STATEMENT OF ACCOUNT" in t:
        return "soa"
    if "BANK ACCOUNT STATEMENT" in t:
        return "bank"
    if "GOODS RECEIPT NOTE" in t or "DELIVERY RECEIPT" in t:
        return "grn"
    if "PURCHASE ORDER" in t:
        return "po"
    if "INVOICE" in t:
        return "invoice"
    return None


def parse_text(text: str, doc_type: str | None = None) -> dict:
    doc_type = doc_type or detect_type(text)
    if doc_type in ("bank", "soa"):
        from reconcile import parse_ledger
        return parse_ledger(text, doc_type)
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    kv, items, in_items = {}, [], False
    for line in lines:
        low = line.lower()
        if low.startswith("description"):
            in_items = True
            continue
        if in_items and re.match(r"^(subtotal|total|received by|gst|remarks)", low):
            in_items = False
        if in_items:
            m = ITEM_GRN.match(line) if doc_type == "grn" else ITEM_PRICED.match(line)
            if m:
                g = m.groupdict()
                if doc_type == "grn":
                    items.append({"description": g["desc"].strip(), "ordered_qty": int(g["ordered"]), "received_qty": int(g["received"])})
                else:
                    items.append({"description": g["desc"].strip(), "qty": int(g["qty"]), "unit_price": num(g["price"]), "amount": num(g["amt"])})
            continue
        m = KV.match(line)
        if m:
            kv.setdefault(m.group(1).strip().lower(), m.group(2).strip())

    def g(*keys):
        for k in keys:
            if k in kv:
                return kv[k]
        return None

    tax_key = next((k for k in kv if k.startswith("gst @")), None)
    out = {"doc_type": doc_type, "items": items}
    if doc_type == "invoice":
        out.update(invoice_no=g("invoice no", "invoice number"), invoice_date=g("invoice date"), due_date=g("due date"),
                   po_number=g("po number", "po no"), seller_name=g("seller", "supplier"),
                   seller_gstin=g("seller gstin", "supplier gstin"), buyer_name=g("buyer", "bill to"),
                   buyer_gstin=g("buyer gstin"), subtotal=num(g("subtotal") or ""),
                   tax_rate=num(re.sub(r"[^\d.]", "", tax_key)) if tax_key else None,
                   tax=num(kv[tax_key]) if tax_key else None, total=num(g("total", "grand total") or ""),
                   currency="INR")
    elif doc_type == "po":
        out.update(po_number=g("po number"), po_date=g("po date"), buyer_name=g("buyer"), buyer_gstin=g("buyer gstin"),
                   seller_name=g("supplier", "seller"), seller_gstin=g("supplier gstin", "seller gstin"),
                   subtotal=num(g("subtotal") or ""), total=num(g("total") or ""), payment_terms=g("payment terms"))
    elif doc_type == "grn":
        out.update(grn_no=g("grn no", "grn number"), grn_date=g("grn date", "received date"), po_number=g("po number"),
                   buyer_name=g("buyer"), buyer_gstin=g("buyer gstin"), seller_gstin=g("supplier gstin", "seller gstin"),
                   received_by=g("received by"), condition=g("condition"))
    for k in ("seller_gstin", "buyer_gstin"):
        if out.get(k):
            out[k] = out[k].upper().replace(" ", "")
    req = REQUIRED.get(doc_type, [])
    found = sum(1 for k in req if out.get(k))
    out["confidence"] = round(found / len(req), 2) if req else 0
    return out


# ---------- Claude extraction ----------
SCHEMA = {
    "type": "object",
    "properties": {
        "doc_type": {"type": "string", "enum": ["invoice", "po", "grn"]},
        "invoice_no": {"type": ["string", "null"]}, "invoice_date": {"type": ["string", "null"]},
        "due_date": {"type": ["string", "null"]}, "po_number": {"type": ["string", "null"]},
        "po_date": {"type": ["string", "null"]}, "grn_no": {"type": ["string", "null"]},
        "grn_date": {"type": ["string", "null"]}, "seller_name": {"type": ["string", "null"]},
        "seller_gstin": {"type": ["string", "null"]}, "buyer_name": {"type": ["string", "null"]},
        "buyer_gstin": {"type": ["string", "null"]}, "subtotal": {"type": ["number", "null"]},
        "tax_rate": {"type": ["number", "null"]}, "tax": {"type": ["number", "null"]},
        "total": {"type": ["number", "null"]}, "received_by": {"type": ["string", "null"]},
        "items": {"type": "array", "items": {"type": "object", "properties": {
            "description": {"type": "string"}, "qty": {"type": ["number", "null"]},
            "unit_price": {"type": ["number", "null"]}, "amount": {"type": ["number", "null"]},
            "ordered_qty": {"type": ["number", "null"]}, "received_qty": {"type": ["number", "null"]}},
            "required": ["description", "qty", "unit_price", "amount", "ordered_qty", "received_qty"],
            "additionalProperties": False}},
    },
    "required": ["doc_type", "invoice_no", "invoice_date", "due_date", "po_number", "po_date", "grn_no", "grn_date",
                 "seller_name", "seller_gstin", "buyer_name", "buyer_gstin", "subtotal", "tax_rate", "tax", "total",
                 "received_by", "items"],
    "additionalProperties": False,
}

PROMPT = ("Extract this trade document (tax invoice, purchase order, or goods receipt note) into the JSON schema. "
          "Dates as YYYY-MM-DD. Amounts as plain numbers in rupees. GSTINs uppercase without spaces. "
          "For a goods receipt note, fill ordered_qty and received_qty per line. Use null for anything not present.")


def claude_available():
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def extract_with_claude(data: bytes, media_type: str) -> dict:
    import anthropic

    client = anthropic.Anthropic()
    b64 = base64.standard_b64encode(data).decode()
    block = ({"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": b64}}
             if media_type == "application/pdf" else
             {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}})
    resp = client.beta.messages.create(
        model="claude-opus-5-5",
        max_tokens=16000,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
        messages=[{"role": "user", "content": [block, {"type": "text", "text": PROMPT}]}],
    )
    if resp.stop_reason == "refusal":
        raise RuntimeError("model declined to extract")
    text = next(b.text for b in resp.content if b.type == "text")
    out = json.loads(text)
    out = {k: v for k, v in out.items() if v is not None}
    req = REQUIRED.get(out.get("doc_type"), [])
    out["confidence"] = round(sum(1 for k in req if out.get(k)) / len(req), 2) if req else 0
    return out


def extract(data: bytes, filename: str, expected_type: str | None = None) -> dict:
    is_pdf = data[:4] == b"%PDF"
    media = "application/pdf" if is_pdf else ("image/png" if filename.lower().endswith(".png") else "image/jpeg")
    force_claude = os.environ.get("VERBIL_EXTRACTOR") == "claude"
    parsed = None
    if is_pdf and not force_claude:
        parsed = parse_text(pdf_text(data), expected_type)
        parsed["method"] = "layout-parser"
        if parsed["confidence"] >= 0.85:
            return parsed
    if claude_available():
        try:
            out = extract_with_claude(data, media)
            out["method"] = "claude-opus-5-5"
            return out
        except Exception as e:  # noqa: BLE001
            if parsed:
                parsed["method_note"] = f"AI extraction failed: {e}"
                return parsed
            raise
    if parsed:
        return parsed
    raise ValueError("Non-PDF documents need AI extraction: set ANTHROPIC_API_KEY")
