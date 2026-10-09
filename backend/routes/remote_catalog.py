"""The downloadable-genome catalogue: Ensembl species groups and details, file
availability per assembly, NCBI search/featured/browse, and catalogue refresh and
change acknowledgement.
"""

import asyncio
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import app_state
from download_manager import FileInfo, SpeciesSummary
from genome_identity import DEFAULT_PROVIDER, normalize_provider

router = APIRouter()


# ============ Download / Remote Data API ============

@router.get("/api/remote/groups")
async def list_remote_groups(provider: str = DEFAULT_PROVIDER):
    """Return taxonomic groups with species counts."""
    if normalize_provider(provider) == DEFAULT_PROVIDER:
        app_state.download_manager.schedule_catalog_refresh_if_stale()
    return app_state.download_manager.list_groups(provider=provider)


@router.get("/api/remote/species", response_model=List[SpeciesSummary])
async def list_remote_species(
    group: Optional[str] = None,
    sub_group: Optional[str] = None,
    provider: str = DEFAULT_PROVIDER,
):
    """List species, optionally filtered by group/sub_group."""
    if normalize_provider(provider) == DEFAULT_PROVIDER:
        app_state.download_manager.schedule_catalog_refresh_if_stale()
    return app_state.download_manager.list_species(provider=provider, group=group, sub_group=sub_group)


@router.get("/api/remote/species/{key}")
async def get_remote_species_details(key: str, provider: str = DEFAULT_PROVIDER):
    """Get full details for a specific species."""
    if normalize_provider(provider) == DEFAULT_PROVIDER:
        app_state.download_manager.schedule_catalog_refresh_if_stale()
    return app_state.download_manager.get_species_details(key, provider=provider)


@router.get("/api/remote/files/{key}/{assembly}/availability")
async def get_remote_file_availability(
    key: str,
    assembly: str,
    provider: str = DEFAULT_PROVIDER,
    include_directory_listing: bool = False,
):
    """Return assembly files plus dated dataset release file groups."""
    if normalize_provider(provider) == DEFAULT_PROVIDER:
        app_state.download_manager.schedule_catalog_refresh_if_stale()
    return await asyncio.to_thread(
        app_state.download_manager.get_file_availability,
        key,
        assembly,
        provider,
        include_directory_listing,
    )


@router.get("/api/remote/files/{key}/{assembly}", response_model=List[FileInfo])
async def get_remote_files(
    key: str,
    assembly: str,
    provider: str = DEFAULT_PROVIDER,
    file_types: str = "",
):
    """Get download URLs for a specific species assembly."""
    if normalize_provider(provider) == DEFAULT_PROVIDER:
        app_state.download_manager.schedule_catalog_refresh_if_stale()
    requested_types = [part.strip() for part in str(file_types or "").split(",") if part.strip()]
    return await asyncio.to_thread(app_state.download_manager.get_download_urls,
        key,
        assembly,
        file_types=requested_types or None,
        provider=provider,
    )


@router.get("/api/remote/ncbi/search")
async def search_remote_ncbi_species(
    query: str,
    assembly_source: str = "all",
    page_size: int = 100,
):
    """Search NCBI genome assemblies via the Datasets API."""
    try:
        result = await asyncio.to_thread(
            app_state.download_manager.search_ncbi_species,
            query,
            assembly_source,
            page_size,
        )
        return {
            **result,
            "species": [
                item.model_dump() if hasattr(item, "model_dump") else item
                for item in (result.get("species") or [])
            ],
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to search NCBI genomes: {exc}")


@router.get("/api/remote/ncbi/featured")
async def list_featured_remote_ncbi_species(assembly_source: str = "all"):
    """Return a curated set of NCBI genomes, preferring paired RefSeq accessions where possible."""
    try:
        result = await asyncio.to_thread(
            app_state.download_manager.list_featured_ncbi_species,
            assembly_source,
        )
        return {
            **result,
            "species": [
                item.model_dump() if hasattr(item, "model_dump") else item
                for item in (result.get("species") or [])
            ],
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to load featured NCBI genomes: {exc}")


@router.post("/api/remote/ncbi/refresh")
async def refresh_remote_ncbi_cache():
    """Clear cached RefSeq browse metadata so the next requests fetch fresh NCBI results."""
    try:
        return await asyncio.to_thread(app_state.download_manager.refresh_ncbi_cache)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to refresh RefSeq browse cache: {exc}")


@router.get("/api/remote/ncbi/browse")
async def browse_remote_ncbi_group(group: str = "Featured", page_token: Optional[str] = None, page_size: int = 100):
    """Return a paginated list of RefSeq species for the given taxonomic group."""
    try:
        result = await asyncio.to_thread(
            app_state.download_manager.browse_ncbi_group,
            group,
            page_token,
            page_size,
        )
        return {
            **result,
            "species": [
                item.model_dump() if hasattr(item, "model_dump") else item
                for item in (result.get("species") or [])
            ],
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to browse RefSeq group '{group}': {exc}")


class CatalogAcknowledgeRequest(BaseModel):
    token: str = ""


@router.get("/api/remote/catalog/status")
async def get_remote_catalog_status():
    """Return the current remote catalogue refresh status and latest change summary."""
    app_state.download_manager.schedule_catalog_refresh_if_stale()
    return app_state.download_manager.get_catalog_status()


@router.post("/api/remote/catalog/refresh")
async def refresh_remote_catalog():
    """Force a remote catalogue refresh now."""
    try:
        return await asyncio.to_thread(app_state.download_manager.refresh_catalog, True)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to refresh remote catalogue: {exc}")


@router.post("/api/remote/catalog/acknowledge")
async def acknowledge_remote_catalog_change(request: CatalogAcknowledgeRequest):
    """Mark the latest catalogue change notification as seen."""
    return app_state.download_manager.acknowledge_catalog_change(request.token)
