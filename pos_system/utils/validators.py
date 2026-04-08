"""
Input validation utilities for POS System
"""
import re
from typing import Optional, Tuple


class ValidationError(Exception):
    """Custom exception for validation errors"""
    pass


def validate_price(value: float, allow_zero: bool = False) -> Tuple[bool, Optional[str]]:
    """
    Validate price value
    
    Args:
        value: Price to validate
        allow_zero: Whether to allow zero prices
        
    Returns:
        Tuple of (is_valid, error_message)
    """
    if value is None:
        return False, "El precio no puede estar vacío"
    
    if not isinstance(value, (int, float)):
        return False, "El precio debe ser un número"
    
    if not allow_zero and value <= 0:
        return False, "El precio debe ser mayor que cero"
    
    if value < 0:
        return False, "El precio no puede ser negativo"
    
    if value > 999999.99:
        return False, "El precio es demasiado alto"
    
    return True, None


def validate_stock(value: int) -> Tuple[bool, Optional[str]]:
    """Validate stock value"""
    if value is None:
        return False, "El stock no puede estar vacío"
    
    if not isinstance(value, int):
        return False, "El stock debe ser un número entero"
    
    if value < 0:
        return False, "El stock no puede ser negativo"
    
    if value > 999999:
        return False, "El stock es demasiado alto"
    
    return True, None


def validate_product_name(name: str) -> Tuple[bool, Optional[str]]:
    """Validate product name"""
    if not name or not name.strip():
        return False, "El nombre del producto es obligatorio"
    
    if len(name.strip()) < 2:
        return False, "El nombre debe tener al menos 2 caracteres"
    
    if len(name) > 200:
        return False, "El nombre es demasiado largo (máximo 200 caracteres)"
    
    return True, None


def validate_barcode(barcode: Optional[str]) -> Tuple[bool, Optional[str]]:
    """Validate product barcode"""
    if not barcode:
        return True, None  # Barcode is optional
    
    barcode = barcode.strip()
    
    if len(barcode) < 3:
        return False, "El código de barras debe tener al menos 3 caracteres"
    
    if len(barcode) > 50:
        return False, "El código de barras es demasiado largo"
    
    if not re.match(r'^[A-Za-z0-9\-_]+$', barcode):
        return False, "El código de barras solo puede contener letras, números, guiones y guiones bajos"
    
    return True, None


def validate_category(category: Optional[str]) -> Tuple[bool, Optional[str]]:
    """Validate category name"""
    if not category:
        return True, None  # Category is optional
    
    category = category.strip()
    
    if len(category) > 100:
        return False, "El nombre de categoría es demasiado largo"
    
    return True, None


def validate_payment_amount(amount: float, total: float) -> Tuple[bool, Optional[str]]:
    """Validate payment amount against total"""
    if amount is None:
        return False, "El monto de pago es obligatorio"
    
    if not isinstance(amount, (int, float)):
        return False, "El monto debe ser un número"
    
    if amount < total:
        return False, f"El monto pagado (${amount:.2f}) es menor que el total (${total:.2f})"
    
    return True, None


def validate_withdrawal_amount(amount: float, available: float) -> Tuple[bool, Optional[str]]:
    """Validate withdrawal amount against available cash"""
    if amount is None:
        return False, "El monto de retiro es obligatorio"
    
    if not isinstance(amount, (int, float)):
        return False, "El monto debe ser un número"
    
    if amount <= 0:
        return False, "El monto debe ser mayor que cero"
    
    if amount > available:
        return False, f"No hay suficiente efectivo disponible (disponible: ${available:.2f})"
    
    return True, None


def sanitize_string(value: str, max_length: int = None) -> str:
    """
    Sanitize string input
    
    Args:
        value: String to sanitize
        max_length: Maximum allowed length
        
    Returns:
        Sanitized string
    """
    if not value:
        return ""
    
    sanitized = value.strip()
    
    if max_length and len(sanitized) > max_length:
        sanitized = sanitized[:max_length]
    
    return sanitized
