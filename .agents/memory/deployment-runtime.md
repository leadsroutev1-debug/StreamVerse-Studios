---
name: Deployment runtime constraints
description: Runtime and deployment constraints for the combined Node and Python video engine.
---

Published startup must not download Python packages at runtime because the deployment runtime may have no PyPI/DNS access. Python dependencies need to be available through the project runtime or a publish-time build step. The combined launcher exposes the Node dashboard on port 5000 while the Python video engine stays internal on port 8000; an explicit 5000-to-80 port mapping is required so the public URL does not route to FastAPI.

**Why:** A deployment entered a crash loop when startup attempted to install `uvicorn[standard]` and could not resolve PyPI, and a successful deployment initially served FastAPI's 404 instead of the dashboard because port 8000 was selected.

**How to apply:** Keep `start.sh` offline-safe, use plain `uvicorn` unless the standard extra is explicitly provisioned, and preserve the deployment port mapping whenever the internal video engine runs alongside Node.