"""
@module Request/Response Models
@description FastAPI 엔드포인트에서 사용하는 Pydantic 모델들을 정의한다.

@dependencies pydantic
"""
from pydantic import BaseModel
from typing import List, Dict, Optional, Any

class SentimentRequest(BaseModel):
    news_items: List[Dict[str, Any]] = []

class BriefingRequest(BaseModel):
    symbol: str

class ScenarioRequest(BaseModel):
    symbol: str
    event_calendar: Optional[List[Dict[str, Any]]] = None
    fear_greed: Optional[Dict[str, Any]] = None
    stablecoin: Optional[Dict[str, Any]] = None

class UnifiedPlanRequest(BaseModel):
    symbols: List[str]
    event_calendar: Optional[List[Dict[str, Any]]] = None
    fear_greed: Optional[Dict[str, Any]] = None
    stablecoin: Optional[Dict[str, Any]] = None
    provider: str = "auto"

class UnifiedPlanResolveRequest(BaseModel):
    symbols: List[str]
    selected_id: str = ""
    event_calendar: Optional[List[Dict[str, Any]]] = None
    fear_greed: Optional[Dict[str, Any]] = None
    stablecoin: Optional[Dict[str, Any]] = None
    provider: str = "auto"

class EventRequest(BaseModel):
    symbol: str
    event_text: str

class ValidatePositionRequest(BaseModel):
    symbol: str
    entry_reasoning: Dict[str, Any] = {}

class EmbedRequest(BaseModel):
    text: str

class TestRequest(BaseModel):
    prompt: str = "Say hello and tell me what model you are."
    provider: str = "auto"
