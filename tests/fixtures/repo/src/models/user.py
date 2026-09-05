"""User model."""


class User:
    """A user."""

    def __init__(self, name: str):
        self.name = name

    def display(self) -> str:
        return self.name.title()


class Admin(User):
    def display(self) -> str:
        return "admin:" + super().display()
