"""Business logic.

Layer rules, enforced by review:

* A service takes an ``AsyncSession`` as an argument and never opens its own — except
  ``notifications``, which runs after the request's session has closed.
* A service never imports FastAPI. It raises ``AppError`` subclasses; the transport
  layer turns those into status codes.
* A service never calls ``commit()``. The request boundary owns the transaction, which
  is what keeps a multi-step operation atomic.
* Decisions that are pure functions of data belong in ``rules/``, not here. A service
  gathers the data, calls the rule, and applies the answer.
"""
