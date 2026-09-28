"""Multi-tenancy: a tenant is a named set of departments (config/tenants.yaml). A user's effective
departments are clipped to their tenant; "central" (departments ["*"]) sees everything."""
from __future__ import annotations

from .config import load_yaml, settings


def tenants() -> dict[str, dict]:
    return {t["id"]: t for t in (load_yaml(settings.tenants_file) or {}).get("tenants") or []}


def tenant_for(departments: list[str], explicit: str = "") -> str:
    """Explicit tenant id if valid; else the first non-central tenant containing all the departments;
    else 'central' for wildcard users; else ''."""
    ts = tenants()
    if explicit and explicit in ts:
        return explicit
    if "*" in departments:
        return "central" if "central" in ts else (next(iter(ts), "") if ts else "")
    for tid, t in ts.items():
        if "*" in t.get("departments", []):
            continue
        if set(departments) <= set(t.get("departments", [])):
            return tid
    return ""


def clip_departments(departments: list[str], tenant: str) -> list[str]:
    t = tenants().get(tenant)
    if not t:
        return departments
    td = t.get("departments", [])
    if "*" in td:
        return departments
    if "*" in departments:
        return sorted(td)
    return sorted(set(departments) & set(td))


def branding(tenant: str) -> dict:
    t = tenants().get(tenant) or {}
    return {"id": tenant, "name": t.get("name", ""), **(t.get("branding") or {})}
