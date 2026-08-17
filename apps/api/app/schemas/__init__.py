"""Pydantic request and response models — the API's boundary contract.

Convention:

* ``*Create`` / ``*Update`` are request bodies. They inherit ``Schema``, which forbids
  unknown keys.
* ``*Out`` are responses. They inherit ``ORMSchema`` and are built from ORM objects
  with ``model_validate``.
* A field a client must never set (``status``, ``created_by``, ``approval_token``)
  simply does not exist on the request model, rather than being stripped in a handler.
"""
