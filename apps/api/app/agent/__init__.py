"""BuildCo Assistant: the live voice conversation.

Everything here runs on the ``buildco-agent`` service, behind one WebSocket. The API
service imports none of it except ``live`` when ``AGENT_SERVE_LIVE`` is set, so ADK is
never loaded where it is not used.

* ``model``         what the rest of this package needs from a live model, as an
                    interface. Tests script it; nothing else here knows about ADK.
* ``adk_model``     that interface over Google ADK and Gemini Live. The only module
                    that imports ``google.adk``.
* ``proposals``     propose, then commit: the mechanism behind "nothing is written
                    until the user approves the exact values".
* ``conversation``  one conversation over one socket: audio both ways, the tools the
                    model may call, approvals, and recovery when the model session dies.
* ``live``          the WebSocket route: ticket, origin, and handing off to the above.

**The transaction boundary is here.** A conversation lasts up to half an hour and an
instance has a handful of database connections, so the socket never holds a session
open. Each tool call, each transcript line and each commit opens a short session, does
its work and commits, which is the role ``get_db`` plays for an HTTP request. Services
still never commit.
"""
