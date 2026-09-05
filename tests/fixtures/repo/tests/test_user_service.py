from src.services.user_service import UserService
from src.services.store import Store


def test_greet():
    svc = UserService(Store())
    assert svc.greet("bob") == "Bob"
