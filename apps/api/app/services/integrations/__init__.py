"""Adapters over third-party services.

These modules are the *only* place in the application permitted to open a network
connection. Everything else depends on them through their small public functions, which
keeps the rest of the codebase testable by substitution.

Each adapter follows the same contract:

* Configuration is read from ``app.config.get_settings()``.
* When its credential is missing, it logs once at WARNING and returns a neutral result
  instead of raising — the service boots and serves with nothing provisioned.
* When a call genuinely cannot be satisfied without the integration (the AI parser, a
  signed upload URL), it raises ``IntegrationUnavailable`` so the caller gets a 503
  rather than a confusing success.
* Failures are logged and swallowed for fire-and-forget work. A Resend outage must not
  fail a request that already committed its database changes.
"""
