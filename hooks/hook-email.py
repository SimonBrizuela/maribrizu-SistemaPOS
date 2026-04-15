"""
Custom hook para forzar la inclusión completa del módulo email en Python 3.14+
"""
from PyInstaller.utils.hooks import collect_submodules

hiddenimports = collect_submodules('email')
