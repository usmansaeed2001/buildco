"""Pure business rules.

Nothing in this package may import FastAPI, SQLAlchemy, or perform I/O of any kind.
Every function here takes plain data and returns plain data, which is what makes the
riskiest logic in the system — the project auto-transitions — exhaustively testable
without a database.

Services translate ORM objects into these snapshots, call a rule, and apply the
returned decision. The rules never mutate anything themselves.
"""
