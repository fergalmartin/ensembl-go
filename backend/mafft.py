"""Running MAFFT: pairwise alignment, multiple alignment with a strategy chosen from the
sequences, and multiple alignment with progress reported from MAFFT's own output.
"""

import os
import re
import subprocess
import tempfile
import threading
import time
from collections import deque
from typing import Any, Callable, Dict, List, Optional, Tuple

import app_paths
import file_io


def run_mafft_alignment(seq1: str, seq2: str) -> Tuple[str, str]:
    """Run MAFFT pairwise alignment."""
    file_io.log_progress(f"Running MAFFT alignment ({len(seq1)}bp vs {len(seq2)}bp)...")
    
    with tempfile.NamedTemporaryFile(mode='w', suffix='.fa', delete=False) as f:
        input_file = f.name
        f.write(f">seq1\n{seq1}\n>seq2\n{seq2}\n")
    
    try:
        # --auto automatically converts to the most appropriate method
        # --quiet suppresses output
        cmd = [app_paths.MAFFT_PATH, "--auto", "--quiet", input_file]
        file_io.log_progress(f"  Running MAFFT...")
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=300,
                env={**os.environ, **app_paths.MAFFT_ENV},
            )
        except FileNotFoundError as exc:
            raise app_paths._mafft_missing_error() from exc
        
        if result.returncode != 0:
            raise RuntimeError(f"MAFFT failed: {result.stderr}")
        
        # Parse FASTA output from stdout
        aligned = {}
        current_id = None
        current_seq = []
        
        for line in result.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            if line.startswith(">"):
                if current_id:
                    aligned[current_id] = "".join(current_seq)
                current_id = line[1:].strip()
                current_seq = []
            else:
                current_seq.append(line)
        if current_id:
            aligned[current_id] = "".join(current_seq)
        
        file_io.log_progress(f"  ✓ MAFFT complete ({len(aligned.get('seq1', ''))} positions)")
        return aligned.get("seq1", ""), aligned.get("seq2", "")
    
    finally:
        os.unlink(input_file)


def _normalize_multi_profile(raw_profile: str) -> str:
    token = str(raw_profile or "").strip().lower()
    if token in {"accurate", "balanced", "fast"}:
        return token
    return "balanced"


def _normalize_multi_divergence_mode(raw_mode: str) -> str:
    token = str(raw_mode or "").strip().lower()
    if token in {"auto", "detail", "summary"}:
        return token
    return "auto"


def _choose_msa_strategy(
    profile: str,
    seq_count: int,
    max_seq_len: int,
    total_bp: int,
    strict_balanced: bool = False,
) -> Tuple[str, List[str], List[str]]:
    warnings: List[str] = []
    p = _normalize_multi_profile(profile)

    if p == "accurate":
        if seq_count <= 4 and max_seq_len <= 12_000:
            return "accurate", warnings, ["--localpair", "--maxiterate", "1000", "--quiet"]
        warnings.append("Requested accurate profile exceeds small-job limits; using balanced strategy.")
        return "balanced", warnings, ["--auto", "--quiet"]

    if p == "fast":
        return "fast", warnings, ["--retree", "1", "--maxiterate", "0", "--quiet"]

    # balanced default
    if strict_balanced:
        return "balanced", warnings, ["--auto", "--quiet"]
    if max_seq_len > 30_000 or total_bp > 200_000 or seq_count > 6:
        warnings.append("Input size is large; using fast memory-efficient MAFFT settings.")
        return "fast", warnings, ["--retree", "1", "--maxiterate", "0", "--quiet"]
    return "balanced", warnings, ["--auto", "--quiet"]


def run_mafft_alignment_multi(
    ordered_sequences: List[Tuple[str, str]],
    mafft_args: List[str],
    timeout_sec: int,
) -> Dict[str, str]:
    if len(ordered_sequences) < 2:
        raise RuntimeError("Need at least two sequences for MSA.")

    file_io.log_progress(f"Running MAFFT MSA ({len(ordered_sequences)} sequences)...")
    with tempfile.NamedTemporaryFile(mode='w', suffix='.fa', delete=False) as f:
        input_file = f.name
        for seq_id, seq in ordered_sequences:
            f.write(f">{seq_id}\n{seq}\n")

    try:
        cmd = [app_paths.MAFFT_PATH, *mafft_args, input_file]
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=max(30, int(timeout_sec)),
                env={**os.environ, **app_paths.MAFFT_ENV},
            )
        except FileNotFoundError as exc:
            raise app_paths._mafft_missing_error() from exc
        if result.returncode != 0:
            raise RuntimeError(f"MAFFT failed: {result.stderr}")

        aligned: Dict[str, str] = {}
        current_id: Optional[str] = None
        current_seq: List[str] = []
        for line in result.stdout.splitlines():
            token = str(line or "").strip()
            if not token:
                continue
            if token.startswith(">"):
                if current_id is not None:
                    aligned[current_id] = "".join(current_seq)
                current_id = token[1:].strip()
                current_seq = []
            else:
                current_seq.append(token)
        if current_id is not None:
            aligned[current_id] = "".join(current_seq)

        if len(aligned) != len(ordered_sequences):
            raise RuntimeError("MAFFT output is missing one or more aligned sequences.")
        return aligned
    finally:
        try:
            os.unlink(input_file)
        except Exception:
            pass


_MAFFT_COUNT = re.compile(r"(\d+)\s*/\s*(\d+)")


_MAFFT_PASS = re.compile(r"Progressive alignment\s+(\d+)\s*/\s*(\d+)", re.I)


# Where each MAFFT stage falls within one pass of its progressive alignment.
_MAFFT_STAGES = {"distances": (0.0, 0.3), "tree": (0.3, 0.4), "progressive": (0.4, 0.95), "refining": (0.95, 1.0)}


def run_mafft_alignment_multi_progress(
    ordered_sequences: List[Tuple[str, str]],
    mafft_args: List[str],
    timeout_sec: int,
    on_progress: Optional[Callable[[Dict[str, Any]], None]] = None,
    cancelled: Optional[Callable[[], bool]] = None,
) -> Dict[str, str]:
    """:func:`run_mafft_alignment_multi`, reporting MAFFT's own progress and stoppable.

    MAFFT (without ``--quiet``) counts through each stage on stderr: ``Making a distance
    matrix ..  37 / 120``, ``STEP  54 / 119`` in each progressive pass. Those counts become
    ``{stage, pass, passes, done, total, fraction}``; ``cancelled()`` kills the run.
    """
    if len(ordered_sequences) < 2:
        raise RuntimeError("Need at least two sequences for MSA.")
    args = [a for a in mafft_args if a != "--quiet"]
    with tempfile.NamedTemporaryFile(mode="w", suffix=".fa", delete=False) as f:
        input_file = f.name
        for seq_id, seq in ordered_sequences:
            f.write(f">{seq_id}\n{seq}\n")
    state = {"stage": "starting", "pass": 1, "passes": 1, "done": 0, "total": 0, "fraction": 0.0}
    last_report = [0.0]

    def publish(force: bool = False) -> None:
        low, high = _MAFFT_STAGES.get(state["stage"], (0.0, 0.0))
        within = low + (high - low) * (state["done"] / state["total"] if state["total"] else 0.0)
        # Never backwards: a second pass starts again at its distance matrix.
        state["fraction"] = max(state["fraction"], min(1.0, ((state["pass"] - 1) + within) / max(1, state["passes"])))
        now = time.time()
        if on_progress and (force or now - last_report[0] > 0.25):
            last_report[0] = now
            on_progress(dict(state))

    def read_progress(stream) -> None:
        buffer = b""
        while True:
            chunk = stream.read1(4096) if hasattr(stream, "read1") else stream.read(4096)
            if not chunk:
                break
            buffer += chunk
            *lines, buffer = re.split(rb"[\r\n]", buffer)
            for raw in lines:
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                tail.append(line)
                passed = _MAFFT_PASS.search(line)
                lower = line.lower()
                if passed:
                    state.update(stage="progressive", done=0, total=0,
                                 **{"pass": int(passed.group(1)), "passes": max(int(passed.group(2)), state["passes"])})
                elif lower.startswith("progressive alignment"):
                    state.update(stage="progressive", done=0, total=0)
                elif "distance matrix" in lower or "all-to-all" in lower:
                    state.update(stage="distances", done=0, total=0)
                elif "constructing" in lower and "tree" in lower:
                    state.update(stage="tree", done=0, total=0)
                elif lower.startswith("iterative refinement") or lower.startswith("segment"):
                    state.update(stage="refining", done=0, total=0)
                count = _MAFFT_COUNT.search(line)
                if count and not passed:
                    state.update(done=int(count.group(1)), total=max(1, int(count.group(2))))
                publish()

    tail: "deque[str]" = deque(maxlen=40)
    output: List[bytes] = []
    try:
        try:
            proc = subprocess.Popen([app_paths.MAFFT_PATH, *args, input_file], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    env={**os.environ, **app_paths.MAFFT_ENV})
        except FileNotFoundError as exc:
            raise app_paths._mafft_missing_error() from exc
        readers = [threading.Thread(target=lambda: output.append(proc.stdout.read()), daemon=True),
                   threading.Thread(target=read_progress, args=(proc.stderr,), daemon=True)]
        for reader in readers:
            reader.start()
        deadline = time.time() + max(30, int(timeout_sec))
        while proc.poll() is None:
            if cancelled and cancelled():
                proc.kill()
                proc.wait()
                raise InterruptedError("cancelled")
            if time.time() > deadline:
                proc.kill()
                proc.wait()
                raise RuntimeError(f"MAFFT took longer than {int(timeout_sec)} seconds and was stopped.")
            time.sleep(0.2)
        for reader in readers:
            reader.join(timeout=10)
        if proc.returncode != 0:
            raise RuntimeError(f"MAFFT failed: {' / '.join(list(tail)[-5:])}")
        state.update(stage="refining", done=1, total=1, **{"pass": state["passes"]})
        publish(force=True)

        aligned: Dict[str, str] = {}
        current_id: Optional[str] = None
        current_seq: List[str] = []
        for line in b"".join(output).decode("utf-8", "replace").splitlines():
            token = line.strip()
            if not token:
                continue
            if token.startswith(">"):
                if current_id is not None:
                    aligned[current_id] = "".join(current_seq)
                current_id = token[1:].strip()
                current_seq = []
            else:
                current_seq.append(token)
        if current_id is not None:
            aligned[current_id] = "".join(current_seq)
        if len(aligned) != len(ordered_sequences):
            raise RuntimeError("MAFFT output is missing one or more aligned sequences.")
        return aligned
    finally:
        try:
            os.unlink(input_file)
        except Exception:
            pass
