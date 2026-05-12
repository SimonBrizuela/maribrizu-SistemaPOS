"""
Professional logging configuration for POS System
"""
import logging
import logging.handlers
from pathlib import Path
from pos_system.config import LOG_FILE, LOG_MAX_BYTES, LOG_BACKUP_COUNT, LOG_FORMAT, LOG_DATE_FORMAT


def setup_logger(name: str = None, level: int = logging.INFO) -> logging.Logger:
    """
    Setup and return a configured logger.

    Configura el ROOT logger con file + console handlers. Asi todos los
    modulos que usan `logging.getLogger(__name__)` heredan los handlers
    automaticamente (vienen vacios y propagan hasta root).

    Args:
        name: Logger name (defaults to root logger)
        level: Logging level

    Returns:
        Configured logger instance (el especifico que se pidio o root)
    """
    root = logging.getLogger()

    # Si root ya esta configurado, evitar doble handler
    if not root.handlers:
        root.setLevel(level)

        file_handler = logging.handlers.RotatingFileHandler(
            LOG_FILE,
            maxBytes=LOG_MAX_BYTES,
            backupCount=LOG_BACKUP_COUNT,
            encoding='utf-8'
        )
        file_handler.setLevel(logging.DEBUG)
        file_formatter = logging.Formatter(LOG_FORMAT, LOG_DATE_FORMAT)
        file_handler.setFormatter(file_formatter)

        console_handler = logging.StreamHandler()
        console_handler.setLevel(logging.INFO)
        console_formatter = logging.Formatter('%(levelname)s: %(message)s')
        console_handler.setFormatter(console_formatter)

        root.addHandler(file_handler)
        root.addHandler(console_handler)

    return logging.getLogger(name)


def get_logger(name: str) -> logging.Logger:
    """Get or create a logger for a module"""
    return logging.getLogger(name)
