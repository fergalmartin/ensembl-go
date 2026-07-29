"""Aggregated problem reporting.

Issues are collected by code rather than per-occurrence: a file with 40 000 orphan
``Parent`` references produces one issue with ``count=40000`` and a handful of
examples, not 40 000 messages.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional

ERROR = "error"      # a valid gene/transcript/exon model cannot be produced
WARNING = "warning"  # conversion will proceed but has to guess
INFO = "info"        # recorded for transparency, no action needed

_SEVERITY_ORDER = {ERROR: 0, WARNING: 1, INFO: 2}


@dataclass
class Issue:
    code: str
    severity: str
    message: str
    count: int = 0
    examples: List[str] = field(default_factory=list)

    def as_dict(self) -> Dict[str, object]:
        return {
            "code": self.code,
            "severity": self.severity,
            "message": self.message,
            "count": self.count,
            "examples": list(self.examples),
        }


class IssueCollector:
    """Accumulates issues, keeping at most ``example_limit`` examples per code."""

    def __init__(self, example_limit: int = 20):
        self.example_limit = max(0, int(example_limit))
        self._issues: Dict[str, Issue] = {}

    def add(
        self,
        code: str,
        severity: str,
        message: str,
        example: Optional[str] = None,
        increment: int = 1,
    ) -> None:
        issue = self._issues.get(code)
        if issue is None:
            issue = Issue(code=code, severity=severity, message=message)
            self._issues[code] = issue
        elif _SEVERITY_ORDER.get(severity, 3) < _SEVERITY_ORDER.get(issue.severity, 3):
            # Keep the most serious severity seen for a code.
            issue.severity = severity
        issue.count += max(0, int(increment))
        if example and len(issue.examples) < self.example_limit:
            issue.examples.append(str(example))

    def count_for(self, code: str) -> int:
        issue = self._issues.get(code)
        return issue.count if issue else 0

    def has_errors(self) -> bool:
        return any(issue.severity == ERROR for issue in self._issues.values())

    def to_list(self) -> List[Issue]:
        return sorted(
            self._issues.values(),
            key=lambda i: (_SEVERITY_ORDER.get(i.severity, 3), -i.count, i.code),
        )
