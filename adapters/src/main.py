"""Entrypoint of the adapters service. The implementation is the shared package platform/uvp
(uvp.services.adapter_service); this file only starts it, so the service can be run as `python adapters/src/main.py`
or through the Dockerfile CMD. Keep code in platform/uvp - it is shared by every service image."""
import os
import runpy
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "platform"))

if __name__ == "__main__":
    runpy.run_module("uvp.services.adapter_service", run_name="__main__")
