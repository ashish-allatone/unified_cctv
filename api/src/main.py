"""Entrypoint of the api service. The implementation is the shared package platform/uvp
(uvp.services.api); this file only starts it, so the service can be run as `python api/src/main.py`
or through the Dockerfile CMD. Keep code in platform/uvp - it is shared by every service image."""
import os
import runpy
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "platform"))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("uvp.services.api:app", host="0.0.0.0", port=int(os.environ.get("PORT", "8000")), workers=int(os.environ.get("WEB_CONCURRENCY", "2")))
