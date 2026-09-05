"""Sample module for extractor tests."""
import os
from typing import Optional
from .models import User, Session as Sess
from ..core import base

MAX_RETRIES = 3
logger = None


class BaseRepo:
    """Base repository."""

    def find(self, id: int) -> Optional[User]:
        return None


class UserRepo(BaseRepo, Generic[T]):
    """Finds users."""

    def __init__(self, session: Sess):
        self.session = session
        self.cache = Cache()

    @property
    def size(self) -> int:
        return len(self.session)

    def find(self, id: int) -> Optional[User]:
        user = self.session.get(id)
        self.cache.put(user)
        return _normalize(user)


def _normalize(user):
    return user


@app.get("/users/{id}")
def read_user(id: int):
    repo = UserRepo(None)
    return repo.find(id)


def test_find():
    assert UserRepo(None).find(1) is None


TOKEN = os.environ["API_TOKEN"]
