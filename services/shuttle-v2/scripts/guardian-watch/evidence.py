"""Private incident snapshots. Routine rider storage remains independently rolling."""
import contextlib
import errno
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import time
import uuid

MIB = 1024 * 1024
DAY = 86400
MAX_SELECTED_BYTES = 64 * MIB
MAX_BUNDLE_BYTES = 32 * MIB


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def atomic_json(path, value):
    path = Path(path)
    tmp = path.with_name(path.name + "." + uuid.uuid4().hex + ".partial")
    try:
        with open(tmp, "xb") as handle:
            os.chmod(tmp, 0o600)
            handle.write(encoded(value))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


@contextlib.contextmanager
def rider_lock(watch, timeout=10):
    """Same O_EXCL PID lock as retention/storage.mjs; never read across rotation."""
    lock = Path(watch) / "storage.lock"
    deadline = time.monotonic() + timeout
    while True:
        try:
            fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.write(fd, str(os.getpid()).encode())
            break
        except FileExistsError:
            try:
                before = lock.stat()
                owner = int(lock.read_text())
                try:
                    os.kill(owner, 0)
                except ProcessLookupError:
                    if lock.stat().st_ino == before.st_ino:
                        lock.unlink()
                    continue
                except PermissionError:
                    pass
            except (ValueError, FileNotFoundError):
                pass
            if time.monotonic() >= deadline:
                raise TimeoutError("Rider storage is busy")
            time.sleep(0.05)
    try:
        yield
    finally:
        inode = os.fstat(fd).st_ino
        os.close(fd)
        if lock.exists() and lock.stat().st_ino == inode:
            lock.unlink()


def regular(path):
    try:
        return stat.S_ISREG(Path(path).lstat().st_mode)
    except FileNotFoundError:
        return False


def checked_file(directory, name):
    path = Path(directory) / name
    if Path(name).is_absolute() or ".." in Path(name).parts or not regular(path):
        raise ValueError("Invalid evidence file: " + str(name))
    current = Path(directory)
    if current.is_symlink():
        raise ValueError("Evidence directory is a symlink")
    for part in Path(name).parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("Evidence path contains a symlink")
    return path


def verify_bundle(directory):
    directory = Path(directory)
    raw = checked_file(directory, "manifest.json").read_bytes()
    manifest = json.loads(raw)
    for item in manifest["files"]:
        data = checked_file(directory, item["file"]).read_bytes()
        if len(data) != item["bytes"] or digest(data) != item["sha256"]:
            raise ValueError("Incident evidence checksum mismatch")
    return {"directory": str(directory), "manifestSha256": digest(raw),
            "sampleCoverage": manifest["sampleCoverage"], "capturedAt": manifest["capturedAt"]}


def capture_bundle(store, incident_id, event, evidence, allowed_watchers):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", incident_id):
        raise ValueError("Invalid incident identity")
    watch = Path(evidence["watcherDir"]).absolute()
    if watch not in {Path(p).absolute() for p in allowed_watchers} or watch.is_symlink():
        raise ValueError("Unrecognized rider evidence source")
    run = evidence.get("runId")
    key = digest(encoded({"watcher": str(watch), "run": run, "event": event}))[:24]
    parent = Path(store) / incident_id
    parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = parent / key
    if target.exists():
        return verify_bundle(target)
    staging = parent / (".incoming-" + str(os.getpid()) + "-" + uuid.uuid4().hex)
    staging.mkdir(mode=0o700)
    files, sources, gaps = [], [], []
    selected_bytes, malformed, partial = 0, 0, 0
    counts, last_journey = {}, None
    try:
        def save(name, data):
            path = staging / name
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with open(path, "xb") as handle:
                os.chmod(path, 0o600)
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            files.append({"file": name, "bytes": len(data), "sha256": digest(data)})
            if sum(i["bytes"] for i in files) > MAX_BUNDLE_BYTES:
                raise ValueError("Incident bundle exceeds 32 MiB; original records preserved, capture must retry")

        with rider_lock(watch):
            save("event.json", encoded(event))
            for name in ["status.json", "resume.json"]:
                source = watch / name
                if regular(source):
                    save("capture-" + name, source.read_bytes())
            for kind in ["samples", "events", "journeys"]:
                lines = []
                for source in sorted(watch.iterdir()):
                    if not re.fullmatch(kind + r"(?:-\d+)?\.jsonl(?:\.gz)?", source.name) or not regular(source):
                        continue
                    matched = 0
                    opener = gzip.open if source.suffix == ".gz" else open
                    with opener(source, "rb") as handle:
                        for raw in handle:
                            if not raw.endswith(b"\n"):
                                partial += 1
                                continue
                            try:
                                row = json.loads(raw)
                            except (ValueError, UnicodeError):
                                malformed += 1
                                continue
                            if not isinstance(row, dict):
                                malformed += 1
                                continue
                            identity = row.get("id" if kind == "journeys" else "runId")
                            if run is None or identity != run:
                                continue
                            selected_bytes += len(raw)
                            if selected_bytes > MAX_SELECTED_BYTES:
                                raise ValueError("Incident selected logs exceed 64 MiB; capture must retry")
                            lines.append(raw)
                            matched += 1
                            if kind == "journeys":
                                last_journey = row
                    if matched:
                        sources.append({"file": str(source), "rows": matched})
                counts[kind] = len(lines)
                save(kind + ".jsonl.gz", gzip.compress(b"".join(lines), mtime=0))
            # Keep the referenced screenshots and pickup/start context. Only
            # known JPEG basenames in this rider's manifest may be copied.
            images = []
            manifest = watch / "images.jsonl"
            if regular(manifest):
                for raw in manifest.read_text().splitlines():
                    try:
                        item = json.loads(raw)
                    except ValueError:
                        continue
                    if run is not None and item.get("runId") == run:
                        images.append(item)
            names = []
            for supplied in evidence.get("screenshots", []):
                source = Path(supplied)
                if source.parent == watch / "images":
                    names.append(source.name)
            if images:
                names.append(images[0].get("name"))
                pickup = next((i for i in images if str(i.get("label", "")).startswith("pickup-")), None)
                if pickup:
                    names.append(pickup.get("name"))
            seen = set()
            for name in names[:5]:
                if name in seen:
                    continue
                seen.add(name)
                if not isinstance(name, str) or Path(name).name != name or not name.endswith(".jpg"):
                    gaps.append("Invalid screenshot name")
                    continue
                source = watch / "images" / name
                if not regular(source) or source.is_symlink() or (watch / "images").is_symlink():
                    gaps.append("Unavailable screenshot: " + name)
                    continue
                save("images/" + name, source.read_bytes())
        expected = last_journey.get("samples") if last_journey else None
        complete = isinstance(expected, int) and counts["samples"] == expected and not malformed and not partial
        manifest = {"v": 1, "incidentId": incident_id, "capturedAt": time.time(), "event": event,
                    "watcher": str(watch), "runId": run, "sources": sources, "files": files,
                    "sampleCoverage": {"rows": counts["samples"], "expectedFromJourney": expected,
                                       "complete": complete, "malformedSourceRows": malformed,
                                       "partialSourceRows": partial}, "counts": counts, "gaps": gaps,
                    "scope": "Available original virtual-rider records only. Missing historical data is not reconstructed. No physical boarding or independent ETA accuracy claim."}
        atomic_json(staging / "manifest.json", manifest)
        os.rename(staging, target)
        return verify_bundle(target)
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def maintain_bundles(store, pending, max_bytes=256 * MIB, max_age=7 * DAY, now=None):
    now = time.time() if now is None else now
    protected = set()
    # A damaged pending queue must never make its evidence appear disposable.
    for file in Path(pending).glob("*.json"):
        protected.add(json.loads(file.read_text())["id"])
    inventory = []
    abandoned = 0
    store = Path(store)
    if store.exists():
        for parent in store.iterdir():
            if parent.is_symlink() or not parent.is_dir():
                raise ValueError("Unrecognized evidence directory")
            for directory in parent.iterdir():
                if directory.is_symlink() or not directory.is_dir():
                    raise ValueError("Unrecognized evidence bundle")
                incoming = re.fullmatch(r"\.incoming-(\d+)-[a-f0-9]{32}", directory.name)
                if incoming:
                    owner_alive = True
                    try:
                        os.kill(int(incoming[1]), 0)
                    except ProcessLookupError:
                        owner_alive = False
                    if any(p.is_symlink() for p in directory.rglob("*")):
                        raise ValueError("Unrecognized partial evidence symlink")
                    if not owner_alive:
                        shutil.rmtree(directory)
                        abandoned += 1
                    else:
                        size = sum(p.stat().st_size for p in directory.rglob("*") if p.is_file())
                        inventory.append({"directory": directory, "bytes": size, "at": directory.stat().st_mtime,
                                          "protected": True, "coverage": {"expectedFromJourney": None, "complete": False},
                                          "incidentId": parent.name})
                    continue
                receipt = verify_bundle(directory)
                manifest = json.loads((directory / "manifest.json").read_text())
                size = 0
                for path in directory.rglob("*"):
                    if path.is_symlink():
                        raise ValueError("Unrecognized evidence symlink")
                    if path.is_file():
                        size += path.stat().st_size
                inventory.append({"directory": directory, "bytes": size,
                                  "at": receipt["capturedAt"], "protected": parent.name in protected,
                                  "coverage": manifest["sampleCoverage"], "incidentId": parent.name})
    total = sum(i["bytes"] for i in inventory)
    protected_bytes = sum(i["bytes"] for i in inventory if i["protected"])
    removed = 0
    for item in sorted(inventory, key=lambda i: i["at"]):
        if item["protected"] or (total <= max_bytes and now - item["at"] <= max_age):
            continue
        shutil.rmtree(item["directory"])
        total -= item["bytes"]
        removed += 1
    gaps = [{"incidentId": i["incidentId"], **i["coverage"]} for i in inventory
            if i["directory"].exists() and i["coverage"]["expectedFromJourney"] is not None and not i["coverage"]["complete"]]
    return {"bundleCount": len(inventory) - removed, "historicalSampleGaps": gaps[:100],
            "retainedBytes": total, "protectedBytes": protected_bytes, "maxBytes": max_bytes,
            "maxAgeDays": max_age / DAY, "protectedOverageBytes": max(0, protected_bytes - max_bytes),
            "removedBundles": removed, "abandonedPartialBundlesRemoved": abandoned}
