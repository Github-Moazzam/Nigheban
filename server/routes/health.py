"""
Liveness. The one endpoint that must answer before anything else works,
so it depends on nothing and touches no database.
"""

import time

from fastapi import APIRouter


router = APIRouter()


@router.get("/health")
def health():
    return {"ok": True, "t": time.time()}
