# def ghost_line(): pass
"""def ghost_docstring(): pass"""
import os


def top(a, b=1) -> int:
    """Adds things.

    Second line.
    """
    def inner(x):
        return x
    return a + b


async def fetch(url: str):
    return url


@decorator
def decorated():
    pass


@dataclass
class Point(Base):
    """A point."""

    x: int = 0

    def __init__(self, x):
        self.x = x

    async def move(self, dx):
        def helper():
            pass
        return dx

    @staticmethod
    def make():
        return Point(0)

    class Meta:
        pass


decoy = "def fake_in_string(): pass"
CONST = 1
