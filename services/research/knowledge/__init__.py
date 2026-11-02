"""Collection-scoped, rights-aware offline knowledge staging and retrieval."""
from .collections import CollectionAdapters
from .models import COLLECTIONS, KnowledgePlan, RetrievalResult, Segment, SourceInput
from .papers import PaperInput, SSRNAdapter, SuppliedTextParser
from .service import KnowledgeService

__all__ = ["CollectionAdapters", "COLLECTIONS", "KnowledgePlan", "RetrievalResult", "Segment", "SourceInput",
           "PaperInput", "SSRNAdapter", "SuppliedTextParser", "KnowledgeService"]
