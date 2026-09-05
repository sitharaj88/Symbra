"""User service."""
import os
from ..models import User
from .store import Store


class UserService:
    def __init__(self, store: Store):
        self.store = store

    def greet(self, name: str) -> str:
        user = User(name)
        self.store.save(user)
        return user.display()

    def token(self) -> str:
        return os.environ["API_TOKEN"]
