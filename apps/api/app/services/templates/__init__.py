"""Jinja2 environment for transactional email.

One ``base.html`` carries the BuildCo header, chrome, and footer; every notification
extends it. The legacy code repeated that wrapper as an inline template literal in four
separate files, which is how the three different logo hosts crept in.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader, StrictUndefined, select_autoescape

from app.config import get_settings

EMAIL_TEMPLATE_DIR = Path(__file__).parent / "email"


@lru_cache(maxsize=1)
def get_email_environment() -> Environment:
    env = Environment(
        loader=FileSystemLoader(EMAIL_TEMPLATE_DIR),
        autoescape=select_autoescape(["html", "xml"]),
        # Fail loudly on a missing variable rather than emailing a customer a blank.
        undefined=StrictUndefined,
        trim_blocks=True,
        lstrip_blocks=True,
    )
    env.filters["money"] = _money_filter
    return env


def render_email(template: str, context: dict[str, Any]) -> str:
    """Render ``templates/email/<template>`` with the shared brand context merged in."""
    settings = get_settings()
    merged: dict[str, Any] = {
        "site_url": settings.site_url,
        "logo_url": settings.logo_url,
        "brand_name": "BuildCo",
        **context,
    }
    return get_email_environment().get_template(template).render(**merged)


def _money_filter(value: Any) -> str:
    """Format a number as ``1,234.56``. Used throughout the estimate tables."""
    try:
        return f"{float(value):,.2f}"
    except (TypeError, ValueError):
        return "0.00"
