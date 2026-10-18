import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ledgerlib.report import price_rows

assert price_rows([("tea", 1250)], " eur ") == ["tea: €12,50"], price_rows([("tea", 1250)], " eur ")
assert price_rows([("tea", 1250)], "USD") == ["tea: $12.50"]
print("ok")
