import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402


class GenomeAnalysisConfigTests(unittest.TestCase):
    def test_analysis_reports_are_persisted_with_config(self):
        reports = {
            "manual::mouse::v1": {
                "fasta": {
                    "kind": "genome",
                    "path": "/data/mouse.fa.gz",
                    "fasta_path": "",
                    "analysed_at": "2026-07-29T12:00:00Z",
                    "report": {"sequence_count": 21},
                }
            }
        }

        with tempfile.TemporaryDirectory() as tmpdir:
            config_file = Path(tmpdir) / "config.json"
            with patch.object(main, "CONFIG_FILE", config_file):
                response = main.update_config(main.ConfigUpdate(
                    genome_analysis_reports=reports,
                ))

            self.assertEqual(response["config"]["genome_analysis_reports"], reports)
            saved = json.loads(config_file.read_text(encoding="utf-8"))
            self.assertEqual(saved["genome_analysis_reports"], reports)


if __name__ == "__main__":
    unittest.main()
