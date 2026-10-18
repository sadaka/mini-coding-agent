from .money import render
from .settings import parse_currency


def price_rows(items, raw_currency):
    code = parse_currency(raw_currency)
    return [f"{name}: {render(cents, code)}" for name, cents in items]
