"""
Tests for validators module
Run with: python -m pytest tests/ -v
"""
import pytest
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from pos_system.utils.validators import (
    validate_price, validate_stock, validate_product_name,
    validate_barcode, validate_category, validate_payment_amount,
    validate_withdrawal_amount, sanitize_string, ValidationError
)


class TestValidatePrice:
    def test_valid_price(self):
        ok, err = validate_price(10.0)
        assert ok and err is None

    def test_zero_not_allowed(self):
        ok, err = validate_price(0)
        assert not ok

    def test_zero_allowed(self):
        ok, err = validate_price(0, allow_zero=True)
        assert ok and err is None

    def test_negative_price(self):
        ok, err = validate_price(-5)
        assert not ok

    def test_none_price(self):
        ok, err = validate_price(None)
        assert not ok

    def test_too_large(self):
        ok, err = validate_price(9999999.99)
        assert not ok

    def test_string_price(self):
        ok, err = validate_price("abc")
        assert not ok

    def test_decimal_price(self):
        ok, err = validate_price(19.99)
        assert ok


class TestValidateStock:
    def test_valid_stock(self):
        ok, err = validate_stock(100)
        assert ok and err is None

    def test_zero_stock(self):
        ok, err = validate_stock(0)
        assert ok  # zero stock is allowed

    def test_negative_stock(self):
        ok, err = validate_stock(-1)
        assert not ok

    def test_none_stock(self):
        ok, err = validate_stock(None)
        assert not ok

    def test_too_large_stock(self):
        ok, err = validate_stock(9999999)
        assert not ok


class TestValidateProductName:
    def test_valid_name(self):
        ok, err = validate_product_name('Coca Cola')
        assert ok and err is None

    def test_empty_name(self):
        ok, err = validate_product_name('')
        assert not ok

    def test_none_name(self):
        ok, err = validate_product_name(None)
        assert not ok

    def test_too_short(self):
        ok, err = validate_product_name('A')
        assert not ok

    def test_exactly_two_chars(self):
        ok, err = validate_product_name('AB')
        assert ok

    def test_too_long(self):
        ok, err = validate_product_name('X' * 201)
        assert not ok

    def test_whitespace_only(self):
        ok, err = validate_product_name('   ')
        assert not ok


class TestValidateBarcode:
    def test_none_barcode(self):
        ok, err = validate_barcode(None)
        assert ok  # optional

    def test_empty_barcode(self):
        ok, err = validate_barcode('')
        assert ok  # optional

    def test_valid_barcode(self):
        ok, err = validate_barcode('ABC-123')
        assert ok and err is None

    def test_numeric_barcode(self):
        ok, err = validate_barcode('7891234567890')
        assert ok

    def test_invalid_chars(self):
        ok, err = validate_barcode('ABC$%^')
        assert not ok

    def test_too_short(self):
        ok, err = validate_barcode('AB')
        assert not ok

    def test_too_long(self):
        ok, err = validate_barcode('A' * 51)
        assert not ok


class TestValidateCategory:
    def test_none_category(self):
        ok, err = validate_category(None)
        assert ok

    def test_valid_category(self):
        ok, err = validate_category('Bebidas')
        assert ok

    def test_too_long(self):
        ok, err = validate_category('A' * 101)
        assert not ok


class TestValidatePaymentAmount:
    def test_exact_amount(self):
        ok, err = validate_payment_amount(100.0, 100.0)
        assert ok

    def test_more_than_total(self):
        ok, err = validate_payment_amount(150.0, 100.0)
        assert ok

    def test_less_than_total(self):
        ok, err = validate_payment_amount(50.0, 100.0)
        assert not ok

    def test_none_amount(self):
        ok, err = validate_payment_amount(None, 100.0)
        assert not ok


class TestValidateWithdrawalAmount:
    def test_valid_withdrawal(self):
        ok, err = validate_withdrawal_amount(50.0, 100.0)
        assert ok

    def test_zero_withdrawal(self):
        ok, err = validate_withdrawal_amount(0, 100.0)
        assert not ok

    def test_exceeds_available(self):
        ok, err = validate_withdrawal_amount(150.0, 100.0)
        assert not ok

    def test_none_amount(self):
        ok, err = validate_withdrawal_amount(None, 100.0)
        assert not ok


class TestSanitizeString:
    def test_strips_whitespace(self):
        assert sanitize_string('  hello  ') == 'hello'

    def test_empty_string(self):
        assert sanitize_string('') == ''

    def test_none_string(self):
        assert sanitize_string(None) == ''

    def test_max_length(self):
        result = sanitize_string('A' * 100, max_length=10)
        assert len(result) == 10
