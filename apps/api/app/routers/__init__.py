"""HTTP transport layer.

Routers are thin. A handler validates its input via a Pydantic model, declares who may
call it with a dependency, delegates to a service, serialises the result, and schedules
any background work. It does not query the database directly, does not decide
permissions inline, and does not contain business rules.
"""
