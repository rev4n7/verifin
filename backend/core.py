"""Shared config, storage, crypto helpers."""
import datetime as dt
import hashlib
import hmac
import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from cryptography.fernet import Fernet

BASE = Path(__file__).resolve().parent.parent
DATA = BASE / "data"
STORE = DATA / "store"
SAMPLES = BASE / "samples"
DATA.mkdir(exist_ok=True)
STORE.mkdir(exist_ok=True)

DB_PATH = DATA / "verbil.db"
# Shared secret held by the lender consortium. Fingerprints on-chain are HMACs under this key,
# so nobody outside the network can brute-force invoice details from them.
CONSORTIUM_KEY = os.environ.get("VERBIL_CONSORTIUM_KEY", "verbil-lender-consortium-demo-key").encode()

LENDERS = {
    "lender_a": {"id": "lender_a", "name": "Shakti Bank", "short": "Lender A", "account": 1},
    "lender_b": {"id": "lender_b", "name": "Kaveri Capital NBFC", "short": "Lender B", "account": 2},
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS companies(
  gstin TEXT PRIMARY KEY, name TEXT, role TEXT, city TEXT, usual_producer TEXT, chain_account INTEGER);
CREATE TABLE IF NOT EXISTS payment_history(
  id INTEGER PRIMARY KEY, seller_gstin TEXT, buyer_gstin TEXT, invoice_no TEXT, amount REAL,
  invoice_date TEXT, due_date TEXT, paid_date TEXT);
CREATE TABLE IF NOT EXISTS applications(
  id INTEGER PRIMARY KEY, lender_id TEXT, seller_gstin TEXT, buyer_gstin TEXT, invoice_no TEXT,
  po_number TEXT, amount REAL, subtotal REAL, invoice_date TEXT, due_date TEXT, status TEXT,
  fingerprint TEXT, commitment TEXT, salts_json TEXT, extracted_json TEXT, checks_json TEXT,
  dup_json TEXT, forensics_json TEXT, risk_json TEXT, decision_json TEXT, chain_json TEXT,
  created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS documents(
  id INTEGER PRIMARY KEY, app_id INTEGER, kind TEXT, filename TEXT, sha256 TEXT, stored_path TEXT,
  size INTEGER, created_at TEXT);
CREATE TABLE IF NOT EXISTS audit_events(
  id INTEGER PRIMARY KEY, app_id INTEGER, type TEXT, actor TEXT, payload TEXT, prev_hash TEXT,
  hash TEXT, ts TEXT, anchor_id INTEGER);
CREATE TABLE IF NOT EXISTS anchors(
  id INTEGER PRIMARY KEY, chain_index INTEGER, root TEXT, from_event INTEGER, to_event INTEGER,
  tx_hash TEXT, block INTEGER, mode TEXT, ts TEXT);
"""


@contextmanager
def db():
    c = sqlite3.connect(DB_PATH, timeout=30)
    c.row_factory = sqlite3.Row
    try:
        yield c
        c.commit()
    finally:
        c.close()


def init_db():
    with db() as c:
        c.executescript(SCHEMA)


def now_iso():
    return dt.datetime.now().isoformat(timespec="seconds")


def today():
    return dt.date.today()


def canonical(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str)


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hmac_hex(msg: str) -> str:
    return hmac.new(CONSORTIUM_KEY, msg.encode(), hashlib.sha256).hexdigest()


def row_to_dict(r):
    return dict(r) if r is not None else None


# ---------- encrypted off-chain document vault ----------
_KEY_FILE = DATA / "vault.key"


def _fernet():
    if not _KEY_FILE.exists():
        _KEY_FILE.write_bytes(Fernet.generate_key())
    return Fernet(_KEY_FILE.read_bytes())


def vault_put(name: str, data: bytes) -> str:
    path = STORE / f"{name}.enc"
    path.write_bytes(_fernet().encrypt(data))
    return str(path.relative_to(BASE))


def vault_get(rel_path: str) -> bytes:
    """Decrypt a stored document. Raises InvalidToken if the ciphertext was modified."""
    return _fernet().decrypt((BASE / rel_path).read_bytes())


def vault_overwrite(rel_path: str, data: bytes):
    (BASE / rel_path).write_bytes(_fernet().encrypt(data))


def fmt_inr(x: float) -> str:
    """Indian digit grouping: 590000 -> 5,90,000.00"""
    neg = x < 0
    s = f"{abs(x):.2f}"
    whole, frac = s.split(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        parts = []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        if head:
            parts.insert(0, head)
        whole = ",".join(parts + [tail])
    return ("-" if neg else "") + whole + "." + frac
