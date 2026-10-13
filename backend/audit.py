"""Hybrid audit: hash-chained event log off-chain, Merkle roots of event batches anchored on-chain."""
import json

from cryptography.fernet import InvalidToken

from chain import chain
from core import canonical, now_iso, sha256_hex, vault_get

GENESIS = "0" * 64


def _event_body(app_id, type_, actor, payload: dict, ts, prev):
    return canonical({"app_id": app_id, "type": type_, "actor": actor, "payload": payload, "ts": ts, "prev": prev})


def append_event(c, app_id, type_, actor, payload: dict):
    prev = c.execute("SELECT hash FROM audit_events ORDER BY id DESC LIMIT 1").fetchone()
    prev_hash = prev["hash"] if prev else GENESIS
    ts = now_iso()
    h = sha256_hex(_event_body(app_id, type_, actor, payload, ts, prev_hash).encode())
    cur = c.execute(
        "INSERT INTO audit_events(app_id,type,actor,payload,prev_hash,hash,ts) VALUES(?,?,?,?,?,?,?)",
        (app_id, type_, actor, canonical(payload), prev_hash, h, ts))
    return {"id": cur.lastrowid, "hash": h}


# ---------- Merkle ----------
def _pair(a, b):
    return sha256_hex(bytes.fromhex(a) + bytes.fromhex(b))


def merkle_root(leaves):
    if not leaves:
        return GENESIS
    level = list(leaves)
    while len(level) > 1:
        if len(level) % 2:
            level.append(level[-1])
        level = [_pair(level[i], level[i + 1]) for i in range(0, len(level), 2)]
    return level[0]


def merkle_proof(leaves, index):
    proof, level, i = [], list(leaves), index
    while len(level) > 1:
        if len(level) % 2:
            level.append(level[-1])
        sib = i ^ 1
        proof.append({"hash": level[sib], "side": "left" if sib < i else "right"})
        level = [_pair(level[k], level[k + 1]) for k in range(0, len(level), 2)]
        i //= 2
    return proof


def verify_proof(leaf, proof, root):
    h = leaf
    for p in proof:
        h = _pair(p["hash"], h) if p["side"] == "left" else _pair(h, p["hash"])
    return h == root


# ---------- anchoring ----------
def anchor_pending(c):
    rows = c.execute("SELECT id, hash FROM audit_events WHERE anchor_id IS NULL ORDER BY id").fetchall()
    if not rows:
        return None
    root = merkle_root([r["hash"] for r in rows])
    tx = chain.anchor(root, rows[0]["id"], rows[-1]["id"])
    cur = c.execute(
        "INSERT INTO anchors(chain_index,root,from_event,to_event,tx_hash,block,mode,ts) VALUES(?,?,?,?,?,?,?,?)",
        (tx["index"], root, rows[0]["id"], rows[-1]["id"], tx["tx_hash"], tx["block"], tx["mode"], now_iso()))
    c.execute("UPDATE audit_events SET anchor_id=? WHERE id BETWEEN ? AND ? AND anchor_id IS NULL",
              (cur.lastrowid, rows[0]["id"], rows[-1]["id"]))
    return {"anchor_id": cur.lastrowid, "root": root, "events": len(rows), **tx}


def event_proof(c, event_id):
    ev = c.execute("SELECT * FROM audit_events WHERE id=?", (event_id,)).fetchone()
    if not ev:
        return None
    if ev["anchor_id"] is None:
        return {"event_id": event_id, "anchored": False}
    an = c.execute("SELECT * FROM anchors WHERE id=?", (ev["anchor_id"],)).fetchone()
    rows = c.execute("SELECT id, hash FROM audit_events WHERE anchor_id=? ORDER BY id", (an["id"],)).fetchall()
    leaves = [r["hash"] for r in rows]
    idx = [r["id"] for r in rows].index(event_id)
    # recompute this event's hash from its content (not the stored column)
    recomputed = sha256_hex(_event_body(ev["app_id"], ev["type"], ev["actor"], json.loads(ev["payload"]), ev["ts"], ev["prev_hash"]).encode())
    proof = merkle_proof(leaves, idx)
    try:
        onchain_root = chain.get_anchor_root(an["chain_index"])
    except Exception:  # noqa: BLE001
        onchain_root = None
    return {"event_id": event_id, "anchored": True, "event_hash": ev["hash"], "recomputed_hash": recomputed,
            "content_intact": recomputed == ev["hash"], "proof": proof, "root": an["root"],
            "onchain_root": onchain_root, "anchor": dict(an),
            "verified": recomputed == ev["hash"] and verify_proof(recomputed, proof, onchain_root or "")}


# ---------- full integrity verification ----------
def verify_all(c):
    events = c.execute("SELECT * FROM audit_events ORDER BY id").fetchall()
    broken, prev = [], GENESIS
    for ev in events:
        recomputed = sha256_hex(_event_body(ev["app_id"], ev["type"], ev["actor"], json.loads(ev["payload"]), ev["ts"], ev["prev_hash"]).encode())
        problems = []
        if recomputed != ev["hash"]:
            problems.append("content does not match its hash (record edited)")
        if ev["prev_hash"] != prev:
            problems.append("link to previous event broken")
        if problems:
            broken.append({"event_id": ev["id"], "type": ev["type"], "app_id": ev["app_id"], "problems": problems})
        prev = ev["hash"]

    anchors = []
    for an in c.execute("SELECT * FROM anchors ORDER BY id").fetchall():
        rows = c.execute("SELECT * FROM audit_events WHERE anchor_id=? ORDER BY id", (an["id"],)).fetchall()
        leaves = [sha256_hex(_event_body(r["app_id"], r["type"], r["actor"], json.loads(r["payload"]), r["ts"], r["prev_hash"]).encode()) for r in rows]
        local = merkle_root(leaves)
        try:
            onchain = chain.get_anchor_root(an["chain_index"])
        except Exception:  # noqa: BLE001
            onchain = None
        anchors.append({"anchor_id": an["id"], "events": f"{an['from_event']}–{an['to_event']}", "tx_hash": an["tx_hash"],
                        "block": an["block"], "onchain_root": onchain, "recomputed_root": local,
                        "ok": onchain == local})

    docs = []
    for d in c.execute("SELECT * FROM documents ORDER BY id").fetchall():
        ev = c.execute("SELECT payload FROM audit_events WHERE type='DOCUMENT_STORED' AND app_id=? AND payload LIKE ?",
                       (d["app_id"], f'%"{d["sha256"]}"%')).fetchone()
        try:
            actual = sha256_hex(vault_get(d["stored_path"]))
            ok = actual == d["sha256"]
            reason = "hash matches anchored record" if ok else "file content changed since submission"
        except InvalidToken:
            actual, ok, reason = None, False, "encrypted blob corrupted / modified"
        except FileNotFoundError:
            actual, ok, reason = None, False, "file missing from vault"
        docs.append({"doc_id": d["id"], "app_id": d["app_id"], "kind": d["kind"], "filename": d["filename"],
                     "recorded_sha256": d["sha256"], "actual_sha256": actual, "in_audit_log": ev is not None,
                     "ok": ok, "reason": reason})

    ok = not broken and all(a["ok"] for a in anchors) and all(d["ok"] for d in docs)
    return {"ok": ok, "events_checked": len(events), "broken_events": broken, "anchors": anchors,
            "documents": docs, "checked_at": now_iso()}
