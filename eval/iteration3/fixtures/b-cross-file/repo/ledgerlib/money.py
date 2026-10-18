SYMBOLS = {"USD": "$", "EUR": "€"}
DECIMAL = {"USD": ".", "EUR": ","}


def render(amount_cents, code):
    sym = SYMBOLS.get(code, "?")
    sep = "." if code != "EUR" else "."
    whole, frac = divmod(amount_cents, 100)
    return f"{sym}{whole}{sep}{frac:02d}"
