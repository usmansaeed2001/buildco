"""BuildCo Ops Platform API."""

import os

# The release version. Nothing in the repository is bumped by hand: the release build
# passes the number it is about to tag into the image as APP_VERSION (see the Dockerfile),
# and `/livez` reports it so a release can be checked against what is actually running.
# A process started any other way - `make dev`, the tests - reports the placeholder.
__version__ = os.environ.get("APP_VERSION") or "0.0.0.dev0"
