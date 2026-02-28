"""Structured logging configuration for selftune observability.

All modules use this config to emit structured JSON logs.
Log output goes to stderr (human-readable) and optionally to a JSONL file.
"""

import json
import logging
import sys
from datetime import datetime, timezone


class JSONFormatter(logging.Formatter):
    """Emit structured JSON log lines for machine consumption."""

    def format(self, record: logging.LogRecord) -> str:
        log_entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "module": record.module,
            "message": record.getMessage(),
        }
        if record.exc_info and record.exc_info[0]:
            log_entry["exception"] = self.formatException(record.exc_info)
        return json.dumps(log_entry)


def setup_logging(module_name: str, level: int = logging.INFO) -> logging.Logger:
    """Configure structured logging for a selftune module.

    Args:
        module_name: Name of the calling module (e.g. 'grade_session').
        level: Logging level, defaults to INFO.

    Returns:
        Configured logger instance.
    """
    logger = logging.getLogger(f"selftune.{module_name}")
    logger.setLevel(level)

    if not logger.handlers:
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(JSONFormatter())
        logger.addHandler(handler)

    return logger
